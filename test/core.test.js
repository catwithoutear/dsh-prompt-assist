import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, fold, sanitize, browseHistory, selectedModel, SYSTEM, viewOf } from '../src/core.js';
import { requestCodec } from '../src/remote.js';
const event = (type, data, seq = 1) => ({ type, data, seq });
const user = text => ({ role: 'user', source: { kind: 'user-rpc' }, content: [{ type: 'text', text }] });
const answer = (text, extra = []) => ({ turn: 1, message: { role: 'assistant', content: [{ type: 'text', text }, ...extra] } });
const start = () => [event('turn/start', { turn: 1 }), event('user/message', user('帮我修复这个错误'), 2)];
const foldAll = events => events.reduce(fold, initialState());

test('tool messages and intermediate assistant messages never admit a prediction', () => {
  let state = foldAll(start());
  state = fold(state, event('assistant/message', answer('我先检查', [{ type: 'tool-call' }]), 3));
  assert.equal(state.eligible, false);
  assert.equal(fold(state, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4)).eligible, false);
});
test('only a completed turn containing a complete answer admits a prediction', () => {
  const state = foldAll([...start(), event('assistant/message', answer('已经修复了错误'), 3)]);
  for (const kind of ['aborted', 'error', 'blocked', 'max-tokens', 'interrupted', 'forked'])
    assert.equal(fold(state, event('turn/end', { turn: 1, reason: { kind } }, 4)).eligible, false);
  const end = fold(state, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4));
  assert.equal(end.eligible, true);
  assert.equal(end.endSeq, 4);
  assert.equal(fold(end, event('turn/start', { turn: 2 }, 5)).eligible, false);
  assert.equal(fold(end, event('agent/inbox/spliced', { inserted: [user('还有一个问题')] }, 5)).eligible, false);
});
test('no-op turns and interrupted answers are ineligible', () => {
  assert.equal(foldAll([...start(), event('turn/end', { turn: 1, reason: { kind: 'completed' } })]).eligible, false);
  assert.equal(foldAll([...start(), event('assistant/message', { ...answer('部分答案'), interrupted: true }), event('turn/end', { turn: 1, reason: { kind: 'completed' } })]).eligible, false);
});
test('history uses human sources, keeps full text and survives deterministic replay', () => {
  const injected = { ...user('internal reminder'), source: { kind: 'model-selection' } };
  const entries = [event('user/message', user('第一行\n第二行')), event('user/message', injected), event('user/message', user('第一行\n第二行'))];
  const state = foldAll(entries);
  assert.deepEqual(state.history, ['第一行\n第二行']);
  assert.deepEqual(viewOf(foldAll(entries)), viewOf(state));
  assert.strictEqual(fold(state, event('tool/result', {})), state);
});
test('preview context excludes reasoning and tool outputs and preserves roles', () => {
  const state = foldAll([...start(), event('tool/result', { secret: 'must not be forwarded' }), event('assistant/message', answer('完成', [{ type: 'reasoning', text: 'private thought' }]))]);
  assert.deepEqual(state.recent.map(row => row.role), ['user', 'assistant']);
  assert.doesNotMatch(JSON.stringify(state.recent), /private thought|must not be forwarded/);
  assert.match(SYSTEM, /next USER message/);
});
test('up/down restore the original draft, support prefixes and stop after edits', () => {
  const history = ['请检查A', '请验证B', '请检查C'];
  let browse = browseHistory(null, '请检查', history, 'up');
  assert.equal(browse.last, '请检查C');
  browse = browseHistory(browse, browse.last, history, 'up');
  assert.equal(browse.last, '请检查A');
  browse = browseHistory(browse, browse.last, history, 'down');
  assert.equal(browse.last, '请检查C');
  browse = browseHistory(browse, browse.last, history, 'down');
  assert.equal(browse.last, '请检查');
  assert.equal(browse.index, -1);
  assert.equal(browseHistory(null, '', history, 'down'), null);
  assert.equal(browseHistory(browse, '编辑后的草稿', history, 'up'), null);
});
test('assistant wording and malformed output are rejected, useful user prompts survive', () => {
  for (const text of ['我会继续测试。', '让我检查代码。', 'I will check that.', 'Sure, here you go', '第一行\n第二行', '```text```', '按 Tab 接受建议', '用户：继续']) assert.equal(sanitize(text), '', text);
  assert.equal(sanitize('“请帮我添加一个使用示例。”'), '请帮我添加一个使用示例。');
  assert.equal(sanitize('Please add a regression test.'), 'Please add a regression test.');
});
test('model choice stays session-local', () => {
  const session = { requestHeader: () => ({ config: { provider: 'old', model: 'old' } }) };
  assert.deepEqual(selectedModel({ next: { provider: 'current', model: 'chosen' }, lastUsed: null }, session), { provider: 'current', model: 'chosen' });
  assert.deepEqual(selectedModel(undefined, session), { provider: 'old', model: 'old' });
});
test('wire input rejects model overrides and invalid event cursors', () => {
  assert.throws(() => requestCodec.create().parse({ sessionId: 'a', endSeq: 2, model: 'other' }));
  assert.throws(() => requestCodec.create().parse({ sessionId: 'a', endSeq: -1 }));
});
