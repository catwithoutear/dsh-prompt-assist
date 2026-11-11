import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYSTEM, DIRECTIONS, STYLES, SEED_VERSION, DEFAULT_DIRECTION_ID, DEFAULT_STYLE_ID, LIMITS,
  usedVariables, renderVariables, fragmentProblem, fragmentsProblem, resolveFragment, resolveSelection,
  fragmentIdentity, assembleSystem, assembleMessage, assemblePrompt,
  SESSION_OVERRIDE_LIMIT, sessionOverride, pruneSessionOverrides, withSessionOverride,
} from '../src/core.js';

import { PUBLISHED_1308 as FROZEN_1308 } from './fixtures/published-1308.mjs';

const DATA_LABEL = 'Referenced conversation data (quoted):';
const recent = [
  { role: 'user', text: '我要做每 30 秒一个检查点的 30 秒 RPO' },
  { role: 'assistant', text: '可以按周期检查点加上 WAL 回放来实现' },
];
const direction = (id, instruction, extra = {}) => ({ id, kind: 'direction', name: id, instruction, ...extra });
const style = (id, instruction, extra = {}) => ({ id, kind: 'style', name: id, instruction, ...extra });
const defaults = () => resolveSelection({});
const dataOf = message => JSON.parse(message.slice(message.indexOf(DATA_LABEL) + DATA_LABEL.length).trim());

test('the default selection reproduces the published 1.3.8 prompt byte for byte', () => {
  assert.equal(SYSTEM, FROZEN_1308);
  const natural = DIRECTIONS.find(item => item.id === DEFAULT_DIRECTION_ID);
  const concise = STYLES.find(item => item.id === DEFAULT_STYLE_ID);
  assert.equal(natural.instruction, FROZEN_1308.split('\n').slice(4, 6).join('\n'));
  assert.equal(concise.instruction, '');
  assert.equal(assembleSystem(natural, concise), FROZEN_1308);
  const resolved = defaults();
  assert.equal(resolved.direction.id, 'natural-followup');
  assert.equal(resolved.style.id, 'concise');
  assert.equal(assembleSystem(resolved.direction, resolved.style), FROZEN_1308);
});

test('the default user message stays the quoted transcript, untouched', () => {
  assert.equal(assembleMessage(recent, []), JSON.stringify(recent));
  const resolved = defaults();
  const prompt = assemblePrompt({ recent, direction: resolved.direction, style: resolved.style });
  assert.equal(prompt.error, undefined);
  assert.equal(prompt.message, JSON.stringify(recent));
  assert.equal(prompt.system, FROZEN_1308);
  assert.deepEqual(prompt.variables, []);
});

test('a direction replaces only the middle block', () => {
  const challenge = DIRECTIONS.find(item => item.id === 'challenge');
  const prompt = assemblePrompt({ recent, direction: challenge, style: STYLES[0] });
  assert.match(prompt.system, /Target: the one claim/);
  assert.doesNotMatch(prompt.system, /If the assistant asks a question/);
  assert.match(prompt.system, /^You write the next USER message/);
  assert.match(prompt.system, /If no useful next message is supported by the transcript, output nothing\.$/);
  assert.equal(prompt.message, JSON.stringify(recent));
});

test('a style changes wording only and keeps the direction block', () => {
  const natural = DIRECTIONS.find(item => item.id === DEFAULT_DIRECTION_ID);
  const precise = STYLES.find(item => item.id === 'precise');
  const prompt = assemblePrompt({ recent, direction: natural, style: precise });
  assert.match(prompt.system, /Expression: name the boundary/);
  assert.ok(prompt.system.indexOf('If the assistant asks a question') < prompt.system.indexOf('Expression:'));
  assert.ok(prompt.system.indexOf('Expression:') < prompt.system.indexOf('Do not claim you performed work'));
  assert.equal(prompt.message, JSON.stringify(recent));
});

test('variables become pointers in the system and values only in the user data section', () => {
  const withVariable = direction('probe', 'Ask about {{last_assistant_answer}} only.');
  const prompt = assemblePrompt({ recent, direction: withVariable, style: STYLES[0] });
  assert.match(prompt.system, /Ask about \[data:last_assistant_answer\] only\./);
  assert.doesNotMatch(prompt.system, /WAL 回放/);
  assert.ok(prompt.message.startsWith(JSON.stringify(recent)));
  assert.equal(dataOf(prompt.message).last_assistant_answer, recent[1].text);
  assert.deepEqual(prompt.variables, ['last_assistant_answer']);
});

test('the recent_context placeholder points at the transcript instead of copying it', () => {
  const withVariable = direction('probe', 'Use {{recent_context}}. Also {{ recent_context }}.');
  assert.equal(renderVariables(withVariable.instruction), 'Use the quoted transcript below. Also the quoted transcript below.');
  const prompt = assemblePrompt({ recent, direction: withVariable, style: STYLES[0] });
  assert.equal(prompt.message, JSON.stringify(recent));
  assert.deepEqual(prompt.variables, ['recent_context']);
});

test('a repeated or cross-fragment variable is deduplicated into one data field', () => {
  const repeated = direction('probe', '{{last_user_message}} / {{last_user_message}}');
  assert.deepEqual(usedVariables(repeated.instruction), ['last_user_message']);
  const prompt = assemblePrompt({ recent, direction: repeated, style: STYLES[0] });
  assert.equal((prompt.message.match(/"last_user_message"/gu) ?? []).length, 1);
  const across = assemblePrompt({
    recent,
    direction: direction('a', '{{last_user_message}}?'),
    style: style('b', '{{last_user_message}} again?'),
  });
  assert.deepEqual(across.variables, ['last_user_message']);
  assert.equal(Object.keys(dataOf(across.message)).length, 1);
});

test('template validation rejects empty, oversized and unknown-variable fragments', () => {
  assert.equal(fragmentProblem(direction('ok', 'Ask one question.')), '');
  assert.equal(fragmentProblem(direction('', 'Ask.')), 'invalid-id');
  assert.equal(fragmentProblem({ ...direction('x', 'Ask.'), kind: 'tone' }), 'invalid-kind');
  assert.equal(fragmentProblem(direction('x', '   ')), 'empty-instruction');
  assert.equal(fragmentProblem(direction('x', 'a'.repeat(LIMITS.instruction + 1))), 'instruction-limit');
  assert.equal(fragmentProblem({ ...direction('x', 'Ask.'), name: '' }), 'empty-name');
  assert.equal(fragmentProblem({ ...direction('x', 'Ask.'), name: 'n'.repeat(LIMITS.name + 1) }), 'name-limit');
  assert.equal(fragmentProblem(direction('x', 'Ask about {{secret_value}}.')), 'unknown-variable');
});

test('placeholder syntax is exact: other spellings are rejected, not passed through', () => {
  for (const text of ['{{LAST_USER}}', '{{lastUserMessage}}', '{{last_user_message2}}', '{{bad-var}}', '{{ }}'])
    assert.equal(fragmentProblem(direction('x', text)), 'unknown-variable', text);
  const prompt = assemblePrompt({ recent, direction: direction('x', 'Ask {{LAST_USER}}.'), style: STYLES[0] });
  assert.equal(prompt.error, 'unknown-variable');
});

test('the fragment list enforces the count and uniqueness limits', () => {
  assert.equal(fragmentsProblem([]), '');
  assert.equal(fragmentsProblem('nope'), 'invalid-fragments');
  const many = Array.from({ length: LIMITS.fragments + 1 }, (_, index) => direction(`d${index}`, 'Ask.'));
  assert.equal(fragmentsProblem(many), 'fragments-limit');
  assert.equal(fragmentsProblem([direction('same', 'Ask.'), direction('same', 'Ask.')]), 'duplicate-fragment');
  assert.equal(fragmentsProblem([direction('draft', '', { enabled: false })]), '');
  assert.equal(fragmentsProblem([direction('broken', '')]), 'empty-instruction');
});

test('user fragments shadow seeds, and a disabled fragment never falls back', () => {
  const own = direction('challenge', 'Ask something else.');
  const resolved = resolveFragment([own], 'direction', 'challenge');
  assert.equal(resolved.fragment.source, 'user');
  assert.equal(resolved.fragment.instruction, 'Ask something else.');
  assert.equal(resolveFragment([{ ...own, enabled: false }], 'direction', 'challenge').error, 'fragment-disabled');
  assert.equal(resolveFragment([direction('broken', 'Use {{nope}}.')], 'direction', 'broken').error, 'unknown-variable');
  assert.equal(resolveFragment([], 'direction', 'missing').error, 'fragment-missing');
  assert.equal(resolveFragment([], 'tone', 'challenge').error, 'invalid-kind');
  const seed = resolveFragment([], 'style', 'precise');
  assert.equal(seed.fragment.revision, SEED_VERSION);
  assert.equal(seed.fragment.source, 'seed');
});

test('selection errors propagate and malformed configuration is not silently defaulted', () => {
  assert.equal(resolveSelection({ directionId: 'challenge', fragments: [] }).direction.id, 'challenge');
  assert.equal(resolveSelection({ directionId: 'missing', fragments: [] }).error, 'fragment-missing');
  assert.equal(resolveSelection({
    directionId: 'draft',
    fragments: [direction('draft', 'Ask.', { enabled: false })],
  }).error, 'fragment-disabled');
  assert.equal(resolveSelection({ fragments: { not: 'an array' } }).error, 'invalid-fragments');
  assert.equal(resolveSelection({ directionId: '' }).error, 'fragment-missing',
    'an explicit empty id is a broken selection, not a request for the default');
});

test('a session override wins, inherits per axis and falls back when it breaks', () => {
  const global = { directionId: 'natural-followup', styleId: 'concise' };
  const full = resolveSelection({ ...global, sessionOverrides: [
    { sessionId: 's1', directionId: 'challenge', styleId: 'precise' },
  ] }, 's1');
  assert.equal(full.direction.id, 'challenge');
  assert.equal(full.style.id, 'precise');
  assert.equal(full.sessionFallback, undefined);

  const partial = resolveSelection({ ...global, sessionOverrides: [
    { sessionId: 's1', styleId: 'precise' },
  ] }, 's1');
  assert.equal(partial.direction.id, 'natural-followup');
  assert.equal(partial.style.id, 'precise');

  const other = resolveSelection({ ...global, sessionOverrides: [
    { sessionId: 's1', styleId: 'precise' },
  ] }, 's2');
  assert.equal(other.style.id, 'concise', 'another session keeps the global selection');

  const broken = resolveSelection({ ...global, sessionOverrides: [
    { sessionId: 's1', directionId: 'deleted', styleId: 'gone' },
  ] }, 's1');
  assert.equal(broken.error, undefined);
  assert.equal(broken.direction.id, 'natural-followup');
  assert.equal(broken.style.id, 'concise');
  assert.deepEqual(broken.sessionFallback, { direction: 'fragment-missing', style: 'fragment-missing' });

  const brokenGlobal = resolveSelection({ directionId: 'deleted', sessionOverrides: [] }, 's1');
  assert.equal(brokenGlobal.error, 'fragment-missing');
});

test('session overrides are written per axis, cleared and capped', () => {
  const first = withSessionOverride([], 's1', { directionId: 'challenge' }, 10);
  assert.deepEqual(first, [{ sessionId: 's1', directionId: 'challenge', at: 10 }]);
  const withStyle = withSessionOverride(first, 's1', { styleId: 'precise' }, 20);
  assert.deepEqual(withStyle, [{ sessionId: 's1', directionId: 'challenge', styleId: 'precise', at: 20 }]);
  const clearedAxis = withSessionOverride(withStyle, 's1', { styleId: '' }, 30);
  assert.deepEqual(clearedAxis, [{ sessionId: 's1', directionId: 'challenge', at: 30 }]);
  assert.deepEqual(withSessionOverride(clearedAxis, 's1', { directionId: '' }, 40), []);
  assert.deepEqual(withSessionOverride([], '', { directionId: 'x' }, 1), [],
    'an empty session id never becomes an entry');
});

test('duplicate rows and non-string ids are normalised', () => {
  const duplicated = [
    { sessionId: 's1', directionId: 'action', at: 1 },
    { sessionId: 's1', directionId: 'challenge', at: 2 },
  ];
  assert.equal(pruneSessionOverrides(duplicated).length, 1, 'one row per session survives');
  const merged = withSessionOverride(duplicated, 's1', { styleId: 'precise' }, 3);
  assert.deepEqual(merged, [{ sessionId: 's1', directionId: 'challenge', styleId: 'precise', at: 3 }],
    'the newest duplicate wins and the merge keeps it');
  assert.deepEqual(withSessionOverride([], 's1', { directionId: 42 }, 1), [],
    'a non-string id clears the axis instead of being stored');
});

test('an equal timestamp cannot prune the entry that was just written', () => {
  const full = [];
  for (let index = 0; index < SESSION_OVERRIDE_LIMIT; index += 1) {
    full.push({ sessionId: `s${index}`, directionId: 'challenge', at: 5 });
  }
  const next = withSessionOverride(full, 'fresh', { directionId: 'action' }, 5);
  assert.equal(next.length, SESSION_OVERRIDE_LIMIT);
  assert.equal(next[0].sessionId, 'fresh', 'the fresh entry sorts first on a tie');
  assert.equal(next.find(row => row.sessionId === `s${SESSION_OVERRIDE_LIMIT - 1}`), undefined,
    'the oldest row with the same timestamp is dropped instead');
});

test('oversized override lists keep the newest sessions', () => {
  const many = [];
  for (let index = 0; index < SESSION_OVERRIDE_LIMIT + 5; index += 1) {
    many.push({ sessionId: `s${index}`, directionId: 'challenge', at: index });
  }
  const pruned = pruneSessionOverrides(many);
  assert.equal(pruned.length, SESSION_OVERRIDE_LIMIT);
  assert.equal(pruned.find(row => row.sessionId === `s${SESSION_OVERRIDE_LIMIT + 4}`)?.at, SESSION_OVERRIDE_LIMIT + 4);
  assert.equal(pruned.find(row => row.sessionId === 's0'), undefined, 'the oldest session is dropped');
  assert.equal(sessionOverride({ sessionOverrides: pruned }, `s${SESSION_OVERRIDE_LIMIT}`)?.directionId, 'challenge');
});

test('selection identity covers both fragments and their revisions without delimiter collisions', () => {
  const resolved = defaults();
  assert.equal(fragmentIdentity(resolved.direction, resolved.style),
    JSON.stringify(['seed', 'natural-followup', SEED_VERSION, 'seed', 'concise', SEED_VERSION]));
  const own = { ...direction('challenge', 'Ask.'), revision: 4 };
  const next = resolveSelection({ directionId: 'challenge', styleId: 'precise', fragments: [own] });
  assert.equal(fragmentIdentity(next.direction, next.style),
    JSON.stringify(['user', 'challenge', 4, 'seed', 'precise', SEED_VERSION]));
  assert.notEqual(
    fragmentIdentity({ id: 'a@b', revision: 'c' }, { id: 'd', revision: 'e' }),
    fragmentIdentity({ id: 'a', revision: 'b@c' }, { id: 'd', revision: 'e' }),
  );
  // A user shadow of a seed must not collide with the seed it shadows.
  assert.notEqual(
    fragmentIdentity({ source: 'seed', id: 'challenge', revision: 1 }, { source: 'seed', id: 'concise', revision: 1 }),
    fragmentIdentity({ source: 'user', id: 'challenge', revision: 1 }, { source: 'seed', id: 'concise', revision: 1 }),
  );
});

test('data excerpts stay inside the attached budget even under heavy JSON escaping', () => {
  const quoted = '"'.repeat(3000);
  const quotedRecent = [{ role: 'user', text: quoted }, { role: 'assistant', text: quoted }];
  const prompt = assemblePrompt({
    recent: quotedRecent,
    direction: direction('probe', '{{last_user_message}} {{last_assistant_answer}}'),
    style: STYLES[0],
  });
  assert.equal(prompt.error, undefined);
  const base = JSON.stringify(quotedRecent);
  const instruction = '{{last_user_message}} {{last_assistant_answer}}';
  assert.equal(prompt.attached, renderVariables(instruction).length + (prompt.message.length - base.length));
  assert.ok(prompt.attached <= LIMITS.attached, String(prompt.attached));
  assert.ok(Object.keys(dataOf(prompt.message)).length > 0);
});

test('a field that cannot fit is refused instead of leaving a dangling pointer', () => {
  const placeholder = '{{last_user_message}}';
  const prompt = assemblePrompt({
    recent,
    direction: direction('big', placeholder + 'a'.repeat(LIMITS.instruction - placeholder.length)),
    style: style('big-style', 'b'.repeat(LIMITS.instruction)),
  });
  assert.equal(prompt.error, 'attached-limit');
});

test('a pointer that needs no data still passes when the budget is exhausted', () => {
  const placeholder = '{{recent_context}}';
  const prompt = assemblePrompt({
    recent,
    direction: direction('big', placeholder + 'a'.repeat(LIMITS.instruction - placeholder.length)),
    style: style('big-style', 'b'.repeat(LIMITS.instruction - 10)),
  });
  assert.equal(prompt.error, undefined);
  assert.equal(prompt.message, JSON.stringify(recent));
  assert.ok(prompt.attached <= LIMITS.attached, String(prompt.attached));
});

test('a template longer than the instruction limit is refused without resolveSelection', () => {
  const prompt = assemblePrompt({
    recent,
    direction: direction('x', 'x'.repeat(LIMITS.instruction + 1)),
    style: STYLES[0],
  });
  assert.equal(prompt.error, 'instruction-limit');
});

test('the data budget excludes the fixed data header', () => {
  const base = JSON.stringify(recent);
  const message = assembleMessage(recent, ['last_user_message'], 40);
  const dataLength = message.length - base.length - ('\n\nReferenced conversation data (quoted):\n').length;
  assert.ok(dataLength > 0);
  assert.ok(dataLength <= 40, String(dataLength));
});

test('the data header is charged to the attachment limit', () => {
  // Rendered instructions are exactly 2500, so the data budget is 8000-2500-41.
  // Without that subtraction the payload below fits whole and pushes attached to 8037.
  const rendered = 2500;
  const placeholders = '{{last_user_message}} {{last_assistant_answer}}';
  const pad = 'p'.repeat(rendered - '[data:last_user_message] [data:last_assistant_answer]'.length);
  const prompt = assemblePrompt({
    recent: [{ role: 'user', text: 'u'.repeat(2400) }, { role: 'assistant', text: 'a'.repeat(3046) }],
    direction: direction('edge', placeholders + pad),
    style: STYLES[0],
  });
  assert.equal(prompt.error, undefined);
  assert.ok(prompt.attached <= LIMITS.attached, String(prompt.attached));
});

test('clipping never leaves half of a surrogate pair in the data section', () => {
  const emoji = 'x'.repeat(3199) + '😀';
  const prompt = assemblePrompt({
    recent: [{ role: 'user', text: 'q' }, { role: 'assistant', text: emoji }],
    direction: direction('probe', '{{last_assistant_answer}}'),
    style: STYLES[0],
  });
  const value = dataOf(prompt.message).last_assistant_answer;
  assert.doesNotMatch(value, /[\uD800-\uDBFF]$/u);
  assert.equal(value, 'x'.repeat(3199));
});
