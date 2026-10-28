import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { PromptAssist, inject } from '../src/index.js';
import { initialState } from '../src/core.js';
import { createPreviewController } from '../src/preview-state.js';

function setup(stream, config = {}, extras = {}) {
  const ctx = new Context();
  const state = { ...initialState(), eligible: true, endSeq: 9,
    recent: [{ role: 'user', text: '帮我写测试' }, { role: 'assistant', text: '测试已经写好' }] };
  const agent = { id: 'session-test', status: 'idle', inbox: { nextTurn: [], nextStep: [] }, session: { id: 'session-test' } };
  const selection = { next: { provider: 'chosen-provider', model: 'chosen-model' } };
  const calls = [];
  const modelCalls = [];
  ctx.provide('agents', { get: id => id === agent.id ? agent : undefined });
  ctx.provide('sessionProjections', { stateOf: (_session, key) => key === 'localPromptAssist' ? state : selection });
  if (extras.skills) ctx.provide('skills', extras.skills);
  ctx.provide('llm', {
    resolveModelInfo: extras.resolveModelInfo ?? (async () => ({ reasoning: { efforts: [{ id: 'low' }] } })),
    stream(options) { calls.push(options); return stream(options); },
    listProviders: extras.listProviders ?? (() => []),
    listModels: extras.listModels ?? (async () => []),
    listModelsCalls: modelCalls,
  });
  const service = new PromptAssist(ctx, config);
  return { ctx, state, agent, calls, service, modelCalls };
}
async function* answer() {
  yield { type: 'text-delta', text: '请帮我运行这些测试。' };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
const streamOf = (...texts) => async function* () {
  for (const text of texts) yield { type: 'text-delta', text };
  yield { type: 'finish', reason: { kind: 'stop' } };
};
test('composer controller restores the real Host candidate without another model call', { timeout: 2000 }, async () => {
  const f = setup(answer);
  const c = createPreviewController({ delay: 0, predict: async (request, signal) => ({
    ok: true, value: await f.service.predict(request, signal),
  }) });
  const options = { key: 'session-test:9:chosen-model', valid: true, visible: true, ready: true,
    request: { sessionId: f.agent.id, endSeq: 9 } };
  const ready = new Promise(resolve => {
    const off = c.subscribe(() => {
      if (!c.getSnapshot().text) return;
      off(); resolve();
    });
  });
  try {
    c.sync(options); await ready;
    for (let i = 0; i < 3; i++) {
      c.pause();
      c.sync({ ...options, visible: false });
      assert.equal(c.getSnapshot().text, '');
      c.sync(options);
      assert.equal(c.getSnapshot().text, '请帮我运行这些测试。');
    }
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].provider, 'chosen-provider');
    assert.equal(f.calls[0].model, 'chosen-model');
  } finally { c.dispose(); await f.ctx.fiber.dispose(); }
});

test('Host refuses a running session even when Client supplies a completed cursor', async () => {
  const f = setup(answer);
  try {
    f.agent.status = 'running';
    assert.equal((await f.service.predict({ sessionId: f.agent.id, endSeq: 9 })).status, 'stale');
    assert.equal(f.calls.length, 0);
  } finally { await f.ctx.fiber.dispose(); }
});
test('Host chooses current session route and shares one request across callers', async () => {
  const f = setup(answer);
  try {
    const request = { sessionId: f.agent.id, endSeq: 9 };
    const results = await Promise.all([f.service.predict(request), f.service.predict(request)]);
    assert.equal(results[0].text, '请帮我运行这些测试。');
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(await f.service.predict(request), results[0]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].provider, 'chosen-provider');
    assert.equal(f.calls[0].model, 'chosen-model');
    assert.deepEqual(f.calls[0].tools, []);
    assert.deepEqual(JSON.parse(f.calls[0].messages[0].content[0].text).map(row => row.role), ['user', 'assistant']);
  } finally { await f.ctx.fiber.dispose(); }
});
test('a new turn invalidates a prediction that finishes late', async () => {
  let proceed;
  const gate = new Promise(resolve => { proceed = resolve; });
  const f = setup(async function* () { await gate; yield* answer(); });
  try {
    const pending = f.service.predict({ sessionId: f.agent.id, endSeq: 9 });
    await Promise.resolve(); await Promise.resolve();
    f.state.eligible = false;
    f.agent.status = 'running';
    proceed();
    assert.equal((await pending).status, 'stale');
  } finally { proceed(); await f.ctx.fiber.dispose(); }
});
test('cancelling the last consumer aborts the Host generation', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = setup(async function* (options) {
    started();
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    yield* answer();
  });
  const controller = new AbortController();
  try {
    const pending = f.service.predict({ sessionId: f.agent.id, endSeq: 9 }, controller.signal);
    await ready;
    controller.abort();
    assert.equal((await pending).status, 'stale');
    assert.equal(f.calls[0].signal.aborted, true);
  } finally { controller.abort(); await f.ctx.fiber.dispose(); }
});

test('a canceled cache entry does not prevent generation after the user clears the draft', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let attempt = 0;
  const f = setup(async function* (options) {
    attempt++;
    if (attempt === 1) {
      started();
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    }
    yield* answer();
  });
  const controller = new AbortController();
  try {
    const request = { sessionId: f.agent.id, endSeq: 9 };
    const pending = f.service.predict(request, controller.signal);
    await ready;
    controller.abort();
    assert.equal((await pending).status, 'stale');
    const restored = await f.service.predict(request);
    assert.equal(restored.status, 'ready');
    assert.equal(restored.text, '请帮我运行这些测试。');
    assert.deepEqual(await f.service.predict(request), restored);
    assert.equal(f.calls.length, 2, 'one canceled attempt, one successful attempt, then cache reuse');
  } finally { controller.abort(); await f.ctx.fiber.dispose(); }
});

test('continuation uses the configured auxiliary route and sends only draft fragments', async () => {
  const f = setup(streamOf('并补一个回归测试。'), { provider: 'aux-provider', model: 'aux-model' });
  try {
    const result = await f.service.continueDraft({ sessionId: f.agent.id, endSeq: 9, prefix: '请检查这个修复', suffix: '' });
    assert.deepEqual(result, { status: 'ready', reason: 'none', text: '并补一个回归测试。' });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].provider, 'aux-provider');
    assert.equal(f.calls[0].model, 'aux-model');
    assert.equal(f.calls[0].maxTokens, 256);
    assert.deepEqual(f.calls[0].tools, []);
    const payload = JSON.parse(f.calls[0].messages[0].content[0].text);
    assert.equal(payload.prefix, '请检查这个修复');
    assert.equal(payload.suffix, '');
    assert.deepEqual(payload.transcript.map(row => row.role), ['user', 'assistant']);
  } finally { await f.ctx.fiber.dispose(); }
});

test('continuation refuses a running turn, a mismatched cursor and oversized output', async () => {
  const running = setup(streamOf('不应生成。'));
  try {
    running.agent.status = 'running';
    assert.equal((await running.service.continueDraft({ sessionId: running.agent.id, endSeq: 9, prefix: 'a', suffix: '' })).status, 'stale');
    assert.equal(running.calls.length, 0);
  } finally { await running.ctx.fiber.dispose(); }
  const mismatch = setup(streamOf('不应生成。'));
  try {
    assert.equal((await mismatch.service.continueDraft({ sessionId: mismatch.agent.id, endSeq: 8, prefix: 'a', suffix: '' })).status, 'stale');
  } finally { await mismatch.ctx.fiber.dispose(); }
  const long = setup(streamOf('长'.repeat(450)));
  try {
    const result = await long.service.continueDraft({ sessionId: long.agent.id, endSeq: 9, prefix: 'a', suffix: '' });
    assert.equal(result.status, 'error');
    assert.equal(result.reason, 'limit');
  } finally { await long.ctx.fiber.dispose(); }
});

test('optimize uses the built-in contract and parses the MODE protocol', async () => {
  const replace = setup(streamOf('MODE: replace\n\n请补充一个最小复现。'));
  try {
    const result = await replace.service.optimize({ sessionId: replace.agent.id, endSeq: 9,
      text: '帮我修一下', before: '上下文', after: '' });
    assert.deepEqual(result, { status: 'ready', reason: 'none', mode: 'replace', text: '请补充一个最小复现。' });
    assert.equal(replace.calls[0].maxTokens, 8192);
    assert.match(replace.calls[0].system, /^## Goal/);
    assert.match(replace.calls[0].system, /One-shot application contract/);
    assert.match(replace.calls[0].system, /MODE: replace/);
    assert.doesNotMatch(replace.calls[0].system, /\/clarify/i);
    const payload = JSON.parse(replace.calls[0].messages[0].content[0].text);
    assert.equal(payload.selection, '帮我修一下');
    assert.equal(payload.contextBefore, '上下文');
  } finally { await replace.ctx.fiber.dispose(); }
  const questions = setup(streamOf('MODE: questions\n\n1. 目标平台？\n2. 是否兼容旧版本？'));
  try {
    const result = await questions.service.optimize({ sessionId: questions.agent.id, endSeq: 9,
      text: '优化我', before: '', after: '' });
    assert.equal(result.status, 'ready');
    assert.equal(result.mode, 'questions');
  } finally { await questions.ctx.fiber.dispose(); }
});

test('the Host declares no environment skill-service dependency', () => {
  assert.ok(!inject.includes('skills'));
  assert.ok(!inject.includes('workingDirectory'));
});

test('optimize never reads an environment skill, even when one exists', async () => {
  let reads = 0;
  const f = setup(streamOf('MODE: replace\n\n改写结果'), {}, {
    skills: { get: async () => { reads += 1; return { content: 'MARKER-SKILL-BODY' }; } },
  });
  try {
    const result = await f.service.optimize({ sessionId: f.agent.id, endSeq: 9,
      text: '优化我', before: '', after: '' });
    assert.equal(result.status, 'ready');
    assert.equal(reads, 0);
    assert.doesNotMatch(f.calls[0].system, /MARKER-SKILL-BODY/);
  } finally { await f.ctx.fiber.dispose(); }
});

test('optimize reports an invalid model output', async () => {
  const invalid = setup(streamOf('直接改写，没有模式行'));
  try {
    const result = await invalid.service.optimize({ sessionId: invalid.agent.id, endSeq: 9,
      text: '优化我', before: '', after: '' });
    assert.equal(result.status, 'error');
    assert.equal(result.reason, 'invalid-output');
  } finally { await invalid.ctx.fiber.dispose(); }
});

test('listModels maps providers and caches the catalog for the settings page', async () => {
  let lookups = 0;
  const f = setup(answer, {}, {
    listProviders: () => [{ id: 'provider-a', name: 'Provider A' }],
    listModels: async provider => { lookups += 1; return [{ id: 'model-a', name: 'Model A', description: 'fast' }]; },
  });
  try {
    const first = await f.service.listModels({});
    assert.deepEqual(first, { status: 'ready', reason: 'none', providers: [{
      id: 'provider-a', name: 'Provider A',
      models: [{ id: 'model-a', name: 'Model A', description: 'fast' }],
    }] });
    const second = await f.service.listModels({});
    assert.strictEqual(second, first, 'the successful catalog is reused within its TTL');
    assert.equal(lookups, 1);
  } finally { await f.ctx.fiber.dispose(); }
});

test('predict uses the configured auxiliary route when one is set', async () => {
  const f = setup(answer, { provider: 'aux-provider', model: 'aux-model' });
  try {
    const result = await f.service.predict({ sessionId: f.agent.id, endSeq: 9 });
    assert.equal(result.status, 'ready');
    assert.equal(f.calls[0].provider, 'aux-provider');
    assert.equal(f.calls[0].model, 'aux-model');
  } finally { await f.ctx.fiber.dispose(); }
});

test('a configured but unavailable auxiliary route is reported instead of falling back', async () => {
  const f = setup(answer, { provider: 'missing', model: 'missing' }, {
    resolveModelInfo: async () => { throw new Error('unknown provider'); },
  });
  try {
    const result = await f.service.predict({ sessionId: f.agent.id, endSeq: 9 });
    assert.equal(result.status, 'unavailable');
    assert.equal(f.calls.length, 0);
    const continued = await f.service.continueDraft({ sessionId: f.agent.id, endSeq: 9, prefix: 'a', suffix: '' });
    assert.equal(continued.status, 'unavailable');
    assert.equal(continued.reason, 'model-unavailable');
  } finally { await f.ctx.fiber.dispose(); }
});
