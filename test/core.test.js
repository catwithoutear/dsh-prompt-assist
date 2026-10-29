import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, fold, sanitize, sanitizeContinuation, parseOptimize, OPTIMIZE_SYSTEM,
  OPTIMIZE_STRATEGIES, DEFAULT_OPTIMIZE_STRATEGY, optimizeStrategy, optimizeSystem,
  continueUserMessage,
  browseHistory, selectedModel, routeOf, SYSTEM, CONTINUE_SYSTEM, viewOf, CONTINUE_MAX, OPTIMIZE_REPLACE_MAX } from '../src/core.js';
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
test('model choice stays session-local and never falls back to the request header', () => {
  const session = { requestHeader: () => ({ config: { provider: 'old', model: 'old' } }) };
  assert.deepEqual(selectedModel({ next: { provider: 'current', model: 'chosen' }, lastUsed: null }, session), { provider: 'current', model: 'chosen' });
  assert.deepEqual(selectedModel({ next: null, lastUsed: { provider: 'last', model: 'last-model' } }), { provider: 'last', model: 'last-model' });
  assert.equal(selectedModel(undefined, session), undefined);
  assert.equal(selectedModel({ next: null, lastUsed: null }, session), undefined);
});
test('wire input rejects model overrides and invalid event cursors', () => {
  assert.throws(() => requestCodec.create().parse({ sessionId: 'a', endSeq: 2, model: 'other' }));
  assert.throws(() => requestCodec.create().parse({ sessionId: 'a', endSeq: -1 }));
});
test('routeOf prefers the configured auxiliary route and falls back to the session model', () => {
  const session = { requestHeader: () => ({ config: { provider: 'fallback', model: 'fallback-model' } }) };
  assert.deepEqual(routeOf({ provider: 'aux-provider', model: 'aux-model' }, undefined, session),
    { provider: 'aux-provider', model: 'aux-model', source: 'aux' });
  assert.deepEqual(routeOf({ provider: '', model: '' }, { next: { provider: 'session', model: 'session-model' } }, session),
    { provider: 'session', model: 'session-model', reasoningEffort: undefined, source: 'session' });
  // A session that started without a model and picked one later resolves from
  // the live selection; the stale request-header config must not win.
  assert.deepEqual(routeOf({ provider: '', model: '' }, { next: { provider: 'picked', model: 'picked-model' } },
    { requestHeader: () => ({ config: {} }) }),
    { provider: 'picked', model: 'picked-model', reasoningEffort: undefined, source: 'session' });
  assert.equal(routeOf({ provider: '', model: '' }, undefined, session).provider, undefined);
  const live = { provider: { get: () => 'live-provider' }, model: { get: () => 'live-model' } };
  assert.equal(routeOf(live, undefined, session).provider, 'live-provider');
});
test('continuation text keeps a useful single line and rejects assistant or UI wording', () => {
  assert.equal(sanitizeContinuation('并补一个回归测试。'), '并补一个回归测试。');
  assert.equal(sanitizeContinuation('“请补充错误处理。”'), '请补充错误处理。');
  assert.match(CONTINUE_SYSTEM, /text-completion engine/);
  assert.match(CONTINUE_SYSTEM, /If your output could be the assistant's next message, it is wrong/);
  assert.equal(sanitizeContinuation('以下是我的日志，请帮我分析。'), '以下是我的日志，请帮我分析。');
  assert.equal(sanitizeContinuation('Let me check that.'), 'Let me check that.');
  assert.equal(sanitizeContinuation('以下是修改后的版本。'), '以下是修改后的版本。');
  assert.equal(sanitizeContinuation('<CURSOR>，并补一个测试。'), '，并补一个测试。');
  assert.equal(sanitizeContinuation('<DRAFT>，并补一个测试。</DRAFT>'), '，并补一个测试。');
  for (const text of ['', '第一行\n第二行', '按 Tab 插入', '我会补测试。', '```js', 'x'.repeat(CONTINUE_MAX + 1)])
    assert.equal(sanitizeContinuation(text), '', text);
});
test('parseOptimize accepts the MODE protocol, strips fences and enforces limits', () => {
  assert.deepEqual(parseOptimize('MODE: replace\n\n请补充一个最小复现。'),
    { mode: 'replace', text: '请补充一个最小复现。', reason: 'none' });
  assert.deepEqual(parseOptimize('```\nMODE: questions\n\n1. 目标平台？\n2. 是否兼容旧版本？\n```'),
    { mode: 'questions', text: '1. 目标平台？\n2. 是否兼容旧版本？', reason: 'none' });
  assert.equal(parseOptimize('请直接改写').reason, 'invalid-output');
  assert.equal(parseOptimize('MODE: replace\n').reason, 'empty');
  assert.equal(parseOptimize(`MODE: replace\n\n${'长'.repeat(OPTIMIZE_REPLACE_MAX + 1)}`).reason, 'limit');
  assert.equal(parseOptimize('MODE: replace\n\n按 Tab 应用').reason, 'invalid-output');
  assert.equal(parseOptimize('MODE: replace\n\n我会补一个测试。').reason, 'invalid-output');
});
test('the optimize prompt is self-contained and states the clarification principles', () => {
  assert.match(OPTIMIZE_SYSTEM, /^## Goal/);
  assert.match(OPTIMIZE_SYSTEM, /Evidence first/);
  assert.match(OPTIMIZE_SYSTEM, /blocking ambiguity/i);
  assert.match(OPTIMIZE_SYSTEM, /No AI boilerplate/);
  assert.match(OPTIMIZE_SYSTEM, /One-shot application contract/);
  assert.match(OPTIMIZE_SYSTEM, /MODE: replace/);
  assert.match(OPTIMIZE_SYSTEM, /MODE: questions/);
  assert.doesNotMatch(OPTIMIZE_SYSTEM, /\/clarify|clarify skill/i);
});
test('optimization strategy selects the faithful-expand contract', () => {
  assert.deepEqual(OPTIMIZE_STRATEGIES, ['clarify', 'expand']);
  assert.equal(DEFAULT_OPTIMIZE_STRATEGY, 'expand');
  assert.equal(optimizeStrategy(undefined), 'expand');
  assert.equal(optimizeStrategy('bogus'), 'expand');
  assert.equal(optimizeStrategy('expand'), 'expand');
  assert.match(optimizeSystem('clarify'), /Minimal completion/);
  assert.match(optimizeSystem('expand'), /Enrichment principles/);
  assert.match(optimizeSystem('expand'), /Rewrite, do not echo/);
  assert.match(optimizeSystem('expand'), /Do not add goals/);
  assert.match(optimizeSystem('expand'), /MODE: replace/);
});
test('the continuation request quotes the draft and marks the caret', () => {
  const text = continueUserMessage({
    transcript: [{ role: 'user', text: '请检查修复' }, { role: 'assistant', text: '已修复' }],
    prefix: '先按 P0 收敛',
    suffix: '，然后开 change',
  });
  assert.match(text, /Human: 请检查修复/);
  assert.match(text, /Assistant: 已修复/);
  assert.match(text, /先按 P0 收敛<CURSOR>，然后开 change/);
  assert.match(text, /Continue after <CURSOR>/);
});
