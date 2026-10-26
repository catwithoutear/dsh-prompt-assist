import { z } from 'zod';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { PACKAGE, PROJECTION, SYSTEM, initialState, fold, viewOf, sanitize, selectedModel, lowestEffort, isHuman } from './core.js';
import { descriptor, requestCodec } from './remote.js';

export const inject = ['llm', 'agents', 'sessionProjections', 'typert'];
const PreviewView = z.object({ history: z.array(z.string()), endSeq: z.number().int(),
  eligible: z.boolean(), openTurn: z.number().nullable() });
const PreviewState = PreviewView.extend({
  recent: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() })),
  assistantTurn: z.number().nullable(), finalAnswer: z.boolean(), humanSeq: z.number().int(),
});
const remoteInitializers = [];

export class PromptAssist extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'localPromptAssist');
    for (const initialize of remoteInitializers) initialize.call(this);
    // Keep mutable data behind one shared reference: Cordis rebinds this.ctx on RPC.
    this.runtime = { cache: new Map(), jobs: new Set(), disposed: false };
    ctx.effect(() => async () => {
      this.runtime.disposed = true;
      for (const item of this.runtime.cache.values()) item.controller.abort();
      await Promise.allSettled([...this.runtime.jobs]);
      this.runtime.cache.clear();
    });
    ctx.on('session/event', (session, event) => {
      const invalidated = event.type === 'turn/start'
        || event.type === 'user/message' && isHuman(event.data)
        || event.type === 'agent/inbox/spliced' && event.data.inserted?.some(isHuman);
      if (invalidated) {
        this.runtime.cache.get(session.id)?.controller.abort();
        this.runtime.cache.delete(session.id);
      }
    });
    ctx.on('agent/disposed', ({ agent }) => {
      this.runtime.cache.get(agent.id)?.controller.abort();
      this.runtime.cache.delete(agent.id);
    });
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
    const selection = selectedModel(ctx.sessionProjections.stateOf(session, 'modelSelection'), session);
    if (!selection?.provider || !selection?.model) return { status: 'unavailable', text: '' };
    const key = JSON.stringify([request.endSeq, selection.provider, selection.model]);
    let item = runtime.cache.get(agent.id);
    // Successful candidates remain reusable. Cancellation is not a permanent
    // negative cache: clearing the draft can start a fresh request for this turn.
    if (item?.key !== key || item.controller.signal.aborted) {
      item?.controller.abort();
      item = { key, controller: new AbortController(), consumers: 0, settled: false };
      runtime.cache.set(agent.id, item);
      const owned = item;
      item.promise = (async () => {
        const timeout = setTimeout(() => owned.controller.abort(), 60000);
        try {
          const model = await ctx.llm.resolveModelInfo(selection.provider, selection.model, owned.controller.signal);
          if (!current() || owned.controller.signal.aborted) return { status: 'stale', text: '' };
          const effort = lowestEffort(model, selection.reasoningEffort);
          let raw = '', finished = false;
          for await (const chunk of ctx.llm.stream({
            provider: selection.provider, model: selection.model,
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
          const nextSelection = selectedModel(ctx.sessionProjections.stateOf(session, 'modelSelection'), session);
          if (!current() || owned.controller.signal.aborted || nextSelection?.provider !== selection.provider
            || nextSelection?.model !== selection.model) return { status: 'stale', text: '' };
          const text = finished ? sanitize(raw) : '';
          return { status: text ? 'ready' : 'unavailable', text };
        } catch (error) {
          if (!owned.controller.signal.aborted) ctx.logger.warn('Prompt preview failed: %s', error?.message ?? error);
          return { status: owned.controller.signal.aborted ? 'stale' : 'error', text: '' };
        } finally {
          clearTimeout(timeout);
          owned.settled = true;
        }
      })();
      runtime.jobs.add(item.promise);
      void item.promise.finally(() => runtime.jobs.delete(owned.promise));
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
}
// Apply the public Stage-3 decorator API without requiring a TS build tool.
Remote({ resources: { session: request => request.sessionId } })(PromptAssist.prototype.predict, {
  kind: 'method', name: 'predict', static: false, private: false,
  addInitializer: fn => remoteInitializers.push(fn),
});

export function apply(ctx) {
  ctx.sessionProjections.register({ key: PROJECTION, stateVersion: 1, stateSchema: PreviewState,
    init: initialState, apply: fold, wire: { viewSchema: PreviewView, view: viewOf } });
  new PromptAssist(ctx);
  ctx.typert.register({ package: PACKAGE, face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: [descriptor] });
}
