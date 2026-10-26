import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewController } from '../src/preview-state.js';

const KEY = 'session-a:turn-9:model-a';
const result = text => ({ ok: true, value: { status: 'ready', text } });
const options = (key = KEY, visible = true) => ({ key, valid: true, visible, ready: true,
  request: { sessionId: 'session-a', endSeq: key.includes('10') ? 10 : 9 } });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function candidate(controller) {
  if (controller.getSnapshot().text) return Promise.resolve(controller.getSnapshot());
  return new Promise(resolve => {
    const off = controller.subscribe(() => {
      if (!controller.getSnapshot().text) return;
      off(); resolve(controller.getSnapshot());
    });
  });
}

test('a visible suggestion survives repeated type-and-clear, paste, IME and history cycles', { timeout: 2000 }, async () => {
  let calls = 0;
  const c = createPreviewController({ delay: 0, predict: async () => { calls++; return result('请运行测试。'); } });
  try {
    c.sync(options());
    await candidate(c);
    for (const interaction of ['typing', 'paste', 'composition', 'history', 'typing again']) {
      c.pause();
      assert.equal(c.getSnapshot().text, '', interaction);
      c.sync(options(KEY, false));
      c.sync(options());
      assert.equal(c.getSnapshot().text, '请运行测试。', interaction);
      assert.equal(c.getSnapshot().pending, false, interaction);
    }
    assert.equal(calls, 1, 'clearing a draft restores the same candidate without another model call');
  } finally { c.dispose(); }
});

test('Escape or accepted Tab consumes a candidate until the context changes', { timeout: 2000 }, async () => {
  for (const action of ['Escape', 'accepted Tab']) {
    let calls = 0;
    const c = createPreviewController({ delay: 0, predict: async () => { calls++; return result('继续检查。'); } });
    try {
      c.sync(options()); await candidate(c);
      c.dismiss();
      c.sync(options(KEY, false)); c.sync(options());
      assert.equal(c.getSnapshot().text, '', action);
      assert.equal(c.getSnapshot().pending, false, action);
      assert.equal(calls, 1, action);
      c.sync(options('session-a:turn-10:model-a'));
      await candidate(c);
      assert.equal(calls, 2, 'a new completed turn gets a fresh candidate');
    } finally { c.dispose(); }
  }
});

test('typing cancels pending generation; clearing restarts it and late old output is ignored', { timeout: 2000 }, async () => {
  const first = deferred(), firstStarted = deferred(), secondStarted = deferred();
  let calls = 0, firstSignal;
  const c = createPreviewController({ delay: 0, predict: (_request, signal) => {
    calls++;
    if (calls === 1) { firstSignal = signal; firstStarted.resolve(); return first.promise; }
    secondStarted.resolve(); return Promise.resolve(result('新的有效建议。'));
  } });
  try {
    c.sync(options()); await firstStarted.promise;
    c.pause();
    assert.equal(firstSignal.aborted, true);
    c.sync(options(KEY, false)); c.sync(options());
    await secondStarted.promise; await candidate(c);
    first.resolve(result('已经取消的迟到建议。'));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(c.getSnapshot().text, '新的有效建议。');
    assert.equal(calls, 2);
  } finally { first.resolve(result('late')); c.dispose(); }
});

test('changing session, model or completed turn never restores a previous candidate', { timeout: 2000 }, async () => {
  const requests = [];
  const c = createPreviewController({ delay: 0, predict: async request => {
    requests.push(request); return result(`候选 ${requests.length}`);
  } });
  try {
    for (const [index, key] of [KEY, 'session-b:turn-9:model-a', 'session-b:turn-9:model-b', 'session-b:turn-10:model-b'].entries()) {
      c.sync(options(key));
      assert.equal(c.getSnapshot().text, '', 'no previous text during a context transition');
      await candidate(c);
      assert.equal(c.getSnapshot().text, `候选 ${index + 1}`);
    }
    c.sync({ ...options('session-b:turn-10:model-b'), valid: false });
    assert.equal(c.getSnapshot().text, '', 'a running or invalidated turn clears its candidate');
    assert.equal(c.getSnapshot().pending, false);
  } finally { c.dispose(); }
});

test('unavailable input and missing API never start generation', () => {
  const c = createPreviewController({ delay: 0, predict: () => { throw new Error('must not call'); } });
  try {
    for (const overrides of [{ valid: false }, { visible: false }, { ready: false }]) {
      c.sync({ ...options(), ...overrides });
      assert.equal(c.getSnapshot().pending, false);
      assert.equal(c.getSnapshot().text, '');
    }
  } finally { c.dispose(); }
});

test('failed and empty generations are not automatically retried on every draft clear', { timeout: 2000 }, async () => {
  for (const response of [{ ok: false }, { ok: true, value: { status: 'unavailable', text: '' } }]) {
    let calls = 0;
    const done = deferred();
    const c = createPreviewController({ delay: 0, predict: async () => { calls++; return response; } });
    const off = c.subscribe(() => { if (!c.getSnapshot().pending && calls) done.resolve(); });
    try {
      c.sync(options()); await done.promise;
      c.pause(); c.sync(options());
      assert.equal(c.getSnapshot().pending, false);
      assert.equal(calls, 1);
    } finally { off(); c.dispose(); }
  }
});

test('effect cleanup/setup can restore an existing candidate without another request', { timeout: 2000 }, async () => {
  let calls = 0;
  const c = createPreviewController({ delay: 0, predict: async () => { calls++; return result('保留的建议'); } });
  try {
    c.sync(options()); await candidate(c);
    c.pause(); c.sync(options());
    assert.equal(c.getSnapshot().text, '保留的建议');
    assert.equal(calls, 1);
  } finally { c.dispose(); }
});

test('auto mode off suppresses automatic generation but a manual trigger still requests once', { timeout: 2000 }, async () => {
  let calls = 0;
  const c = createPreviewController({ delay: 0, predict: async () => { calls++; return result('手动建议'); } });
  try {
    c.sync({ ...options(), auto: false });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(calls, 0, 'no automatic request while auto is off');
    assert.equal(c.getSnapshot().text, '');
    c.trigger();
    await candidate(c);
    assert.equal(calls, 1);
    assert.equal(c.getSnapshot().text, '手动建议');
    c.trigger();
    assert.equal(calls, 1, 'a settled manual candidate is reused');
    c.sync({ ...options('session-a:turn-10:model-a'), auto: false });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(calls, 1, 'a new turn with auto off still waits for a manual trigger');
    c.trigger();
    await candidate(c);
    assert.equal(calls, 2);
  } finally { c.dispose(); }
});

test('manual trigger bypasses a settled failure and can retry the same context', { timeout: 2000 }, async () => {
  let calls = 0;
  const c = createPreviewController({ delay: 0, predict: async () => {
    calls++;
    return calls === 1 ? { ok: false } : result('第二次成功');
  } });
  try {
    c.sync(options());
    await new Promise(resolve => { const off = c.subscribe(() => { if (!c.getSnapshot().pending && calls) { off(); resolve(); } }); });
    assert.equal(calls, 1);
    c.pause(); c.sync(options());
    assert.equal(calls, 1, 'an automatic clear does not retry a failed context');
    c.trigger();
    await candidate(c);
    assert.equal(calls, 2);
    assert.equal(c.getSnapshot().text, '第二次成功');
  } finally { c.dispose(); }
});

test('manual trigger restores a candidate hidden by the auto-off pause', { timeout: 2000 }, async () => {
  let calls = 0;
  const c = createPreviewController({ delay: 0, predict: async () => { calls++; return result('手动恢复'); } });
  try {
    c.sync({ ...options(), auto: true });
    await candidate(c);
    c.sync({ ...options(), auto: false });
    c.pause();
    assert.equal(c.getSnapshot().text, '', 'auto-off hides the current candidate');
    c.trigger();
    await candidate(c);
    assert.equal(calls, 1, 'the hidden candidate is restored without another request');
    assert.equal(c.getSnapshot().text, '手动恢复');
  } finally { c.dispose(); }
});
