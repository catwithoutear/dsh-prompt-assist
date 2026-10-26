import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { PromptAssist } from '../src/index.js';
import { initialState } from '../src/core.js';
import { createPreviewController } from '../src/preview-state.js';

function setup(stream) {
  const ctx = new Context();
  const state = { ...initialState(), eligible: true, endSeq: 9,
    recent: [{ role: 'user', text: '帮我写测试' }, { role: 'assistant', text: '测试已经写好' }] };
  const agent = { id: 'session-test', status: 'idle', inbox: { nextTurn: [], nextStep: [] }, session: { id: 'session-test' } };
  const selection = { next: { provider: 'chosen-provider', model: 'chosen-model' } };
  const calls = [];
  ctx.provide('agents', { get: id => id === agent.id ? agent : undefined });
  ctx.provide('sessionProjections', { stateOf: (_session, key) => key === 'localPromptAssist' ? state : selection });
  ctx.provide('llm', {
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
    stream(options) { calls.push(options); return stream(options); },
  });
  const service = new PromptAssist(ctx);
  return { ctx, state, agent, calls, service };
}
async function* answer() {
  yield { type: 'text-delta', text: '请帮我运行这些测试。' };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
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
