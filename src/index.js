import { z } from 'zod';
import Schema from '@deepseek-ai/schemastery';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { PACKAGE, PROJECTION, SYSTEM, CONTINUE_SYSTEM, OPTIMIZE_SYSTEM, initialState, fold, viewOf,
  sanitize, sanitizeContinuation, parseOptimize, lowestEffort,
  routeOf, isHuman } from './core.js';
import { descriptor, continueDescriptor, optimizeDescriptor, modelsDescriptor,
  requestCodec, continueRequestCodec, optimizeRequestCodec, modelsRequestCodec } from './remote.js';

export const inject = ['llm', 'agents', 'sessionProjections', 'typert'];
export const Config = Schema.object({
  provider: Schema.string().default('').volatile(),
  model: Schema.string().default('').volatile(),
  autoPredict: Schema.boolean().default(true).volatile(),
});
const PreviewView = z.object({ history: z.array(z.string()), endSeq: z.number().int(),
  eligible: z.boolean(), openTurn: z.number().nullable() });
const PreviewState = PreviewView.extend({
  recent: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() })),
  assistantTurn: z.number().nullable(), finalAnswer: z.boolean(), humanSeq: z.number().int(),
});
const remoteInitializers = [];
const MODELS_TTL = 60000;

const reasonResult = (status, reason, text = '') => ({ status, reason, text });
const optimizeResult = (status, reason, mode = '', text = '') => ({ status, reason, mode, text });
const modelsResult = (status, reason, providers = []) => ({ status, reason, providers });

/** Attach one AbortSignal and timeout to a request; cleanup always clears the timer. */
function controllerFor(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const forward = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', forward, { once: true });
  return {
    controller, timedOut: () => timedOut,
    cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', forward); },
  };
}

/** Reject when the supplied signal aborts, so a provider call cannot hang a listing. */
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export class PromptAssist extends TypertRemoteService {
  constructor(ctx, config = {}) {
    super(ctx, 'localPromptAssist');
    for (const initialize of remoteInitializers) initialize.call(this);
    this.config = config;
    // Keep mutable data behind one shared reference: Cordis rebinds this.ctx on RPC.
    this.runtime = { cache: new Map(), jobs: new Set(), draft: new Map(),
      optimize: new Map(), models: undefined, disposed: false };
    ctx.effect(() => async () => {
      this.runtime.disposed = true;
      for (const item of this.runtime.cache.values()) item.controller.abort();
      for (const item of this.runtime.draft.values()) item.controller.abort();
      for (const item of this.runtime.optimize.values()) item.controller.abort();
      await Promise.allSettled([...this.runtime.jobs]);
      this.runtime.cache.clear();
      this.runtime.draft.clear();
      this.runtime.optimize.clear();
    });
    const invalidate = agentId => {
      this.runtime.cache.get(agentId)?.controller.abort();
      this.runtime.cache.delete(agentId);
      this.runtime.draft.get(agentId)?.controller.abort();
      this.runtime.draft.delete(agentId);
      this.runtime.optimize.get(agentId)?.controller.abort();
      this.runtime.optimize.delete(agentId);
    };
    ctx.on('session/event', (session, event) => {
      const invalidated = event.type === 'turn/start'
        || event.type === 'user/message' && isHuman(event.data)
        || event.type === 'agent/inbox/spliced' && event.data.inserted?.some(isHuman);
      if (invalidated) invalidate(session.id);
    });
    ctx.on('agent/disposed', ({ agent }) => invalidate(agent.id));
  }

  /** Resolve the effective model route and its cheapest supported reasoning effort. */
  async route(kind, session, signal) {
    const selection = this.ctx.sessionProjections.stateOf(session, 'modelSelection');
    const route = routeOf(this.config, selection, session);
    if (!route.provider || !route.model) return { error: 'no-model' };
    let info;
    try { info = await this.ctx.llm.resolveModelInfo(route.provider, route.model, signal); }
    catch { return { error: signal?.aborted ? 'aborted' : 'model-unavailable' }; }
    if (!info) return { error: 'model-unavailable' };
    const effort = kind === 'optimize' ? undefined : lowestEffort(info, route.reasoningEffort);
    return { provider: route.provider, model: route.model, effort };
  }

  /** Track one in-flight entry per agent; a new request aborts the previous one. */
  start(map, agent, entry) {
    map.get(agent.id)?.controller.abort();
    map.set(agent.id, entry);
    return entry;
  }

  finish(map, agent, entry) {
    if (map.get(agent.id) === entry) map.delete(agent.id);
  }

  track(promise) {
    this.runtime.jobs.add(promise);
    void promise.finally(() => this.runtime.jobs.delete(promise));
    return promise;
  }

  /** Read authoritative Host state; never trust Client transcript text or model overrides. */
  async predict(request, signal) {
    requestCodec.create().parse(request);
    const { ctx, runtime } = this;
    const agent = ctx.agents.get(request.sessionId);
    if (!agent || runtime.disposed || signal?.aborted) return { status: 'unavailable', text: '' };
    const session = agent.session;
    const state = ctx.sessionProjections.stateOf(session, PROJECTION);
    const current = () => {
      const now = ctx.sessionProjections.stateOf(session, PROJECTION);
      return ctx.agents.get(agent.id) === agent && agent.status === 'idle'
        && now?.eligible && now.openTurn === null && now.endSeq === request.endSeq
        && !agent.inbox.nextTurn.length && !agent.inbox.nextStep.length;
    };
    if (!current()) return { status: 'stale', text: '' };
    const route = routeOf(this.config, ctx.sessionProjections.stateOf(session, 'modelSelection'), session);
    if (!route.provider || !route.model) return { status: 'unavailable', text: '' };
    const key = JSON.stringify([request.endSeq, route.provider, route.model]);
    let item = runtime.cache.get(agent.id);
    // Successful candidates remain reusable. Cancellation is not a permanent
    // negative cache: clearing the draft can start a fresh request for this turn.
    if (item?.key !== key || item.controller.signal.aborted) {
      item?.controller.abort();
      item = { key, controller: new AbortController(), consumers: 0, settled: false };
      runtime.cache.set(agent.id, item);
      const owned = item;
      const run = (async () => {
        const timeout = setTimeout(() => owned.controller.abort(), 60000);
        try {
          let model;
          try { model = await ctx.llm.resolveModelInfo(route.provider, route.model, owned.controller.signal); }
          catch { return { status: owned.controller.signal.aborted ? 'stale' : 'unavailable', text: '' }; }
          if (!current() || owned.controller.signal.aborted) return { status: 'stale', text: '' };
          if (!model) return { status: 'unavailable', text: '' };
          const effort = lowestEffort(model, route.reasoningEffort);
          let raw = '', finished = false;
          for await (const chunk of ctx.llm.stream({
            provider: route.provider, model: route.model,
            ...(effort === undefined ? {} : { reasoningEffort: effort }),
            maxTokens: 2048, system: SYSTEM, tools: [],
            messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(state.recent) }] }],
            signal: owned.controller.signal, sessionId: session.id,
          })) {
            if (owned.controller.signal.aborted || !current()) return { status: 'stale', text: '' };
            if (chunk.type === 'text-delta') raw += chunk.text;
            if (raw.length > 500) return { status: 'unavailable', text: '' };
            if (chunk.type === 'finish') {
              if (chunk.reason.kind !== 'stop') return { status: 'error', text: '' };
              finished = true;
            }
          }
          const nextRoute = routeOf(this.config, ctx.sessionProjections.stateOf(session, 'modelSelection'), session);
          if (!current() || owned.controller.signal.aborted
            || nextRoute.provider !== route.provider || nextRoute.model !== route.model) return { status: 'stale', text: '' };
          const text = finished ? sanitize(raw) : '';
          return { status: text ? 'ready' : 'unavailable', text };
        } catch (error) {
          if (!owned.controller.signal.aborted) ctx.logger?.warn?.('Prompt preview failed: %s', error?.message ?? error);
          return { status: owned.controller.signal.aborted ? 'stale' : 'error', text: '' };
        } finally {
          clearTimeout(timeout);
          owned.settled = true;
        }
      })();
      // A failed or empty candidate is not a permanent negative cache: a manual
      // trigger (or a later automatic transition) may request this context again.
      item.promise = this.track(run.then(result => {
        if (result?.status !== 'ready' && runtime.cache.get(agent.id) === owned) runtime.cache.delete(agent.id);
        return result;
      }));
      // Completed entries have bounded retention; never evict an active request.
      for (const [id, cached] of runtime.cache) {
        if (runtime.cache.size <= 128) break;
        if (cached.settled && id !== agent.id) runtime.cache.delete(id);
      }
    }
    const shared = item;
    shared.consumers++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      shared.consumers--;
      if (!shared.settled && shared.consumers === 0) shared.controller.abort();
    };
    signal?.addEventListener('abort', release, { once: true });
    try { return await shared.promise; }
    finally { signal?.removeEventListener('abort', release); release(); }
  }

  /** Continue the current draft at the caret; returns text only, never applies it. */
  async continueDraft(request, signal) {
    continueRequestCodec.create().parse(request);
    const { ctx, runtime } = this;
    const agent = ctx.agents.get(request.sessionId);
    if (!agent || runtime.disposed) return reasonResult('unavailable', 'stale');
    const session = agent.session;
    const state = ctx.sessionProjections.stateOf(session, PROJECTION);
    if (agent.status !== 'idle' || state?.endSeq !== request.endSeq || state.openTurn !== null) {
      return reasonResult('stale', 'stale');
    }
    const running = controllerFor(signal, 30000);
    const entry = this.start(runtime.draft, agent, running);
    const current = () => ctx.agents.get(agent.id) === agent
      && ctx.sessionProjections.stateOf(session, PROJECTION)?.endSeq === request.endSeq;
    const promise = (async () => {
      try {
        const route = await this.route('continue', session, entry.controller.signal);
        if (entry.controller.signal.aborted) return reasonResult('stale', 'stale');
        if (route.error) return reasonResult('unavailable', route.error === 'aborted' ? 'stale' : route.error);
        let raw = '', finished = false;
        for await (const chunk of ctx.llm.stream({
          provider: route.provider, model: route.model,
          ...(route.effort === undefined ? {} : { reasoningEffort: route.effort }),
          maxTokens: 256, system: CONTINUE_SYSTEM, tools: [],
          messages: [{ role: 'user', content: [{ type: 'text',
            text: JSON.stringify({ transcript: state.recent, prefix: request.prefix, suffix: request.suffix }) }] }],
          signal: entry.controller.signal, sessionId: session.id,
        })) {
          if (entry.controller.signal.aborted) return reasonResult('stale', 'stale');
          if (chunk.type === 'text-delta') raw += chunk.text;
          if (raw.length > 400) { entry.controller.abort(); return reasonResult('error', 'limit'); }
          if (chunk.type === 'finish') {
            if (chunk.reason.kind !== 'stop') return reasonResult('error', 'provider-error');
            finished = true;
          }
        }
        if (!current()) return reasonResult('stale', 'stale');
        const nextRoute = routeOf(this.config, ctx.sessionProjections.stateOf(session, 'modelSelection'), session);
        if (nextRoute.provider !== route.provider || nextRoute.model !== route.model) {
          return reasonResult('stale', 'stale');
        }
        const text = finished ? sanitizeContinuation(raw) : '';
        if (!text) return reasonResult('unavailable', 'empty');
        return reasonResult('ready', 'none', text);
      } catch (error) {
        if (!entry.controller.signal.aborted) ctx.logger?.warn?.('Continuation failed: %s', error?.message ?? error);
        return reasonResult(entry.timedOut() ? 'error' : entry.controller.signal.aborted ? 'stale' : 'error',
          entry.timedOut() ? 'timeout' : entry.controller.signal.aborted ? 'stale' : 'provider-error');
      } finally {
        entry.cleanup();
        this.finish(runtime.draft, agent, entry);
      }
    })();
    return this.track(promise);
  }

  /** Rewrite one selected instruction into an unambiguous request; returns a preview only. */
  async optimize(request, signal) {
    optimizeRequestCodec.create().parse(request);
    const { ctx, runtime } = this;
    const agent = ctx.agents.get(request.sessionId);
    if (!agent || runtime.disposed) return optimizeResult('unavailable', 'stale');
    const session = agent.session;
    const state = ctx.sessionProjections.stateOf(session, PROJECTION);
    if (state && state.endSeq !== request.endSeq) return optimizeResult('stale', 'stale');
    const entry = this.start(runtime.optimize, agent, controllerFor(signal, 60000));
    const promise = (async () => {
      try {
        const route = await this.route('optimize', session, entry.controller.signal);
        if (entry.controller.signal.aborted) return optimizeResult('stale', 'stale');
        if (route.error) return optimizeResult('unavailable', route.error === 'aborted' ? 'stale' : route.error);
        let raw = '', finished = false;
        for await (const chunk of ctx.llm.stream({
          provider: route.provider, model: route.model,
          ...(route.effort === undefined ? {} : { reasoningEffort: route.effort }),
          maxTokens: 8192, system: OPTIMIZE_SYSTEM, tools: [],
          messages: [{ role: 'user', content: [{ type: 'text',
            text: JSON.stringify({ selection: request.text, contextBefore: request.before, contextAfter: request.after }) }] }],
          signal: entry.controller.signal, sessionId: session.id,
        })) {
          if (entry.controller.signal.aborted) return optimizeResult('stale', 'stale');
          if (chunk.type === 'text-delta') raw += chunk.text;
          if (raw.length > 8000) { entry.controller.abort(); return optimizeResult('error', 'limit'); }
          if (chunk.type === 'finish') {
            if (chunk.reason.kind !== 'stop') return optimizeResult('error', 'provider-error');
            finished = true;
          }
        }
        if (entry.controller.signal.aborted) return optimizeResult('stale', 'stale');
        if (!finished) return optimizeResult('unavailable', 'empty');
        const nextRoute = routeOf(this.config, ctx.sessionProjections.stateOf(session, 'modelSelection'), session);
        if (nextRoute.provider !== route.provider || nextRoute.model !== route.model) {
          return optimizeResult('stale', 'stale');
        }
        const parsed = parseOptimize(raw);
        if (parsed.reason !== 'none') {
          const status = parsed.reason === 'empty' ? 'unavailable' : 'error';
          return optimizeResult(status, parsed.reason);
        }
        return optimizeResult('ready', 'none', parsed.mode, parsed.text);
      } catch (error) {
        if (!entry.controller.signal.aborted) ctx.logger?.warn?.('Optimize failed: %s', error?.message ?? error);
        return optimizeResult(entry.timedOut() ? 'error' : entry.controller.signal.aborted ? 'stale' : 'error',
          entry.timedOut() ? 'timeout' : entry.controller.signal.aborted ? 'stale' : 'provider-error');
      } finally {
        entry.cleanup();
        this.finish(runtime.optimize, agent, entry);
      }
    })();
    return this.track(promise);
  }

  /** List configured provider/model routes for the settings page. */
  async listModels(request, signal) {
    modelsRequestCodec.create().parse(request ?? {});
    const { ctx, runtime } = this;
    const cached = runtime.models;
    if (cached && Date.now() - cached.at < MODELS_TTL) return cached.value;
    const running = controllerFor(signal, 15000);
    try {
      let providers;
      try { providers = ctx.llm.listProviders(); }
      catch { return modelsResult('error', 'provider-error'); }
      const rows = [];
      for (const provider of Array.isArray(providers) ? providers : []) {
        if (!provider?.id) continue;
        let models = [];
        try { models = await abortable(ctx.llm.listModels(provider.id), running.controller.signal); }
        catch { models = []; }
        if (running.controller.signal.aborted) return modelsResult('stale', 'stale', rows);
        rows.push({
          id: provider.id, name: provider.name || provider.id,
          models: (Array.isArray(models) ? models : []).map(model => ({
            id: model.id, name: model.name || model.id, description: model.description || '',
          })),
        });
      }
      const value = modelsResult('ready', 'none', rows);
      runtime.models = { at: Date.now(), value };
      return value;
    } catch {
      return modelsResult('error', 'provider-error');
    } finally {
      running.cleanup();
    }
  }
}

function remoteMethod(method, name, resources) {
  const context = { kind: 'method', name, static: false, private: false,
    addInitializer: fn => remoteInitializers.push(fn) };
  if (resources) Remote({ resources })(method, context);
  else Remote(method, context);
}
// Apply the public Stage-3 decorator API without requiring a TS build tool.
remoteMethod(PromptAssist.prototype.predict, 'predict', { session: request => request.sessionId });
remoteMethod(PromptAssist.prototype.continueDraft, 'continueDraft', { session: request => request.sessionId });
remoteMethod(PromptAssist.prototype.optimize, 'optimize', { session: request => request.sessionId });
remoteMethod(PromptAssist.prototype.listModels, 'listModels');

export function apply(ctx, config = {}) {
  ctx.sessionProjections.register({ key: PROJECTION, stateVersion: 1, stateSchema: PreviewState,
    init: initialState, apply: fold, wire: { viewSchema: PreviewView, view: viewOf } });
  new PromptAssist(ctx, config);
  ctx.typert.register({ package: PACKAGE, face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [descriptor, continueDescriptor, optimizeDescriptor, modelsDescriptor] });
}
