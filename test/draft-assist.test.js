import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftAssist } from '../src/draft-assist.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const visible = () => ({ valid: true, visible: true });
const ready = text => ({ ok: true, value: { status: 'ready', reason: 'none', mode: '', text } });
function waitFor(store, predicate) {
  if (predicate(store.getSnapshot())) return Promise.resolve(store.getSnapshot());
  return new Promise(resolve => {
    const off = store.subscribe(() => {
      if (!predicate(store.getSnapshot())) return;
      off();
      resolve(store.getSnapshot());
    });
  });
}

test('a request needs valid, visible input and publishes pending then ready', async () => {
  const gate = deferred();
  const calls = [];
  const store = createDraftAssist({ call: (kind, request, signal) => {
    calls.push({ kind, request, signal });
    return gate.promise;
  } });
  try {
    await store.startContinuation({ sessionId: 's', endSeq: 1, prefix: 'p', suffix: '' });
    assert.equal(calls.length, 0, 'hidden input never starts a request');
    store.sync(visible());
    const running = store.startContinuation({ sessionId: 's', endSeq: 1, prefix: 'p', suffix: '' });
    assert.deepEqual(store.getSnapshot(), { kind: 'continuation', phase: 'pending', text: '', mode: '', reason: '' });
    gate.resolve(ready('继续完成。'));
    await running;
    assert.deepEqual(store.getSnapshot(), { kind: 'continuation', phase: 'ready', text: '继续完成。', mode: '', reason: 'none' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'continuation');
  } finally { store.dispose(); }
});

test('a newer request aborts the older one and its late result is ignored', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const store = createDraftAssist({ call: () => {
    calls += 1;
    return calls === 1 ? first.promise : second.promise;
  } });
  try {
    store.sync(visible());
    const one = store.startContinuation({ sessionId: 's', endSeq: 1, prefix: 'a', suffix: '' });
    const two = store.startOptimize({ sessionId: 's', endSeq: 1, text: 'b', before: '', after: '' });
    first.resolve(ready('旧结果'));
    await one;
    assert.equal(store.getSnapshot().phase, 'pending');
    second.resolve({ ok: true, value: { status: 'ready', reason: 'none', mode: 'replace', text: '新结果' } });
    await two;
    assert.deepEqual(store.getSnapshot(), { kind: 'optimize', phase: 'ready', text: '新结果', mode: 'replace', reason: 'none' });
  } finally { store.dispose(); }
});

test('failures map to a visible reason and stale clears the preview', async () => {
  const store = createDraftAssist({ call: async kind => kind === 'continuation'
    ? { ok: true, value: { status: 'error', reason: 'timeout', text: '' } }
    : { ok: true, value: { status: 'stale', reason: 'stale', text: '' } } });
  try {
    store.sync(visible());
    await store.startContinuation({ sessionId: 's', endSeq: 1, prefix: 'a', suffix: '' });
    assert.deepEqual(store.getSnapshot(), { kind: 'continuation', phase: 'error', text: '', mode: '', reason: 'timeout' });
    await store.startOptimize({ sessionId: 's', endSeq: 1, text: 'b', before: '', after: '' });
    assert.deepEqual(store.getSnapshot(), { kind: '', phase: 'idle', text: '', mode: '', reason: '' });
  } finally { store.dispose(); }
});

test('dismiss aborts the active request and invalid input clears the preview', async () => {
  const gate = deferred();
  let signal;
  const store = createDraftAssist({ call: (_kind, _request, supplied) => { signal = supplied; return gate.promise; } });
  try {
    store.sync(visible());
    const running = store.startContinuation({ sessionId: 's', endSeq: 1, prefix: 'a', suffix: '' });
    store.dismiss();
    assert.equal(signal.aborted, true);
    gate.resolve(ready('迟到结果'));
    await running;
    assert.deepEqual(store.getSnapshot(), { kind: '', phase: 'idle', text: '', mode: '', reason: '' });
    store.sync({ valid: false, visible: false });
    assert.equal(store.getSnapshot().phase, 'idle');
  } finally { store.dispose(); }
});

test('an optimize result keeps its mode for the apply/questions branch', async () => {
  const store = createDraftAssist({ call: async () => ({
    ok: true, value: { status: 'ready', reason: 'none', mode: 'questions', text: '1. 目标平台？' },
  }) });
  try {
    store.sync(visible());
    await store.startOptimize({ sessionId: 's', endSeq: 1, text: '优化我', before: '', after: '' });
    const snapshot = await waitFor(store, value => value.phase === 'ready');
    assert.equal(snapshot.mode, 'questions');
    assert.equal(snapshot.kind, 'optimize');
  } finally { store.dispose(); }
});
