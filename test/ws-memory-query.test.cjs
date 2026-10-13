'use strict';

/**
 * Exact-match search for the Memory screen: query parsing, scoring and the
 * snippets with their match marks (src/shared/workspace/memoryQuery.ts).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  fold, prepare, parseQuery, needlesOf, occurrences, scoreUnit, makeSnippet, leadSnippet, mergeMarks, findMarks
} = loadTs('src/shared/workspace/memoryQuery.ts');

const marked = (snip) => snip.marks.map(([a, b]) => snip.text.slice(a, b));

test('fold lower-cases without ever changing the length', () => {
  assert.equal(fold('Login TEST'), 'login test');
  const tricky = 'İstanbul Login';
  assert.equal(fold(tricky).length, tricky.length);
  assert.equal(fold(tricky).slice(1), 'stanbul login');
});

test('parseQuery splits terms, keeps quoted phrases and trims edge punctuation', () => {
  const q = parseQuery('  Flaky "login test",  Safari?  ');
  assert.equal(q.raw, 'Flaky "login test", Safari?');
  assert.deepEqual(q.phrases, ['login test']);
  assert.deepEqual(q.terms, ['flaky', 'safari']);
  assert.equal(q.whole, 'flaky login test, safari?');
  assert.deepEqual(needlesOf(q), ['login test', 'flaky', 'safari']);
});

test('parseQuery keeps inner punctuation people search for verbatim', () => {
  assert.deepEqual(parseQuery('bmt-12 auth.ts C++').terms, ['bmt-12', 'auth.ts', 'c++']);
});

test('parseQuery drops one-letter latin terms but keeps a single CJK character', () => {
  assert.deepEqual(parseQuery('a cookie').terms, ['cookie']);
  assert.deepEqual(parseQuery('猫').terms, ['猫']);
  assert.equal(parseQuery('a'), null);
  assert.equal(parseQuery('   '), null);
  assert.equal(parseQuery(42), null);
});

test('parseQuery dedupes and caps the number of terms', () => {
  const many = Array.from({ length: 30 }, (_, i) => `term${i}`).join(' ');
  assert.equal(parseQuery(many).terms.length, 12);
  assert.deepEqual(parseQuery('Cookie cookie COOKIE').terms, ['cookie']);
});

test('parseQuery caps the raw query length', () => {
  const long = 'x'.repeat(500);
  assert.equal(parseQuery(long).raw.length, 200);
});

test('occurrences counts up to the cap and notices whole-word hits', () => {
  assert.deepEqual(occurrences('log login log', 'log', 10), { count: 3, whole: true, first: 0 });
  assert.equal(occurrences('login logout', 'log', 10).whole, false);
  assert.equal(occurrences('aaaa', 'a', 2).count, 2);
});

test('scoreUnit requires every term (AND), case-insensitively', () => {
  const q = parseQuery('cookie safari');
  assert.ok(scoreUnit(q, null, prepare('The COOKIE expires early on Safari')) > 0);
  assert.equal(scoreUnit(q, null, prepare('The cookie expires early on Firefox')), 0);
  assert.equal(scoreUnit(q, null, null), 0);
});

test('scoreUnit ranks a title hit and the whole phrase above scattered words', () => {
  const q = parseQuery('login test');
  const titled = scoreUnit(q, prepare('Fix the flaky login test'), prepare('Retry it.'));
  const phrase = scoreUnit(q, null, prepare('The login test is flaky.'));
  const scattered = scoreUnit(q, null, prepare('Our test of the login page.'));
  assert.ok(titled > phrase, `${titled} > ${phrase}`);
  assert.ok(phrase > scattered, `${phrase} > ${scattered}`);
});

test('scoreUnit prefers whole words and short focused text', () => {
  const q = parseQuery('log');
  assert.ok(scoreUnit(q, null, prepare('rotate the log daily')) > scoreUnit(q, null, prepare('fix the login daily')));
  const short = scoreUnit(q, null, prepare('log rotation is weekly'));
  const long = scoreUnit(q, null, prepare(`log rotation is weekly. ${'filler words '.repeat(3000)}`));
  assert.ok(short > long);
});

test('scoreUnit still ranks text without spaces (Chinese) by frequency', () => {
  const q = parseQuery('登录');
  const once = scoreUnit(q, null, prepare('修复登录测试'));
  const twice = scoreUnit(q, null, prepare('登录失败，登录测试不稳定'));
  assert.ok(once > 0);
  assert.ok(twice > once);
});

test('makeSnippet centres on the densest match and marks every needle', () => {
  const body = `${'Unrelated setup text. '.repeat(20)}The cookie expires early on Safari, so the login test flakes. ${'More text. '.repeat(20)}`;
  const q = parseQuery('cookie safari');
  const snip = makeSnippet(prepare(body), needlesOf(q), { radius: 40, max: 200 });
  assert.ok(snip.text.startsWith('… '));
  assert.ok(snip.text.endsWith(' …'));
  assert.deepEqual(marked(snip).map((s) => s.toLowerCase()), ['cookie', 'safari']);
});

test('makeSnippet strips markdown noise but keeps marks aligned', () => {
  const md = '## 2026-10-06 — Auth\n\n- The **cookie** expires `early`\n> on Safari';
  const snip = makeSnippet(prepare(md), ['cookie', 'safari'], { radius: 200 });
  assert.equal(snip.text, '2026-10-06 — Auth The cookie expires early on Safari');
  assert.deepEqual(marked(snip), ['cookie', 'Safari']);
});

test('makeSnippet without a match is the opening of the text', () => {
  const snip = leadSnippet('First line.\nSecond line.', 200);
  assert.equal(snip.text, 'First line. Second line.');
  assert.deepEqual(snip.marks, []);
  assert.deepEqual(makeSnippet(prepare(''), ['x']), { text: '', marks: [] });
});

test('makeSnippet caps its length', () => {
  const snip = makeSnippet(prepare('word '.repeat(500)), [], { max: 50 });
  assert.ok(snip.text.length <= 50 + 2);
});

test('mergeMarks and findMarks merge overlaps and sort', () => {
  assert.deepEqual(mergeMarks([[5, 8], [0, 2], [1, 3], [8, 9]]), [[0, 3], [5, 9]]);
  assert.deepEqual(findMarks('the login log', ['log', 'login']), [[4, 9], [10, 13]]);
});

test('parseQuery cuts an oversized input before doing any work on it', () => {
  const q = parseQuery(`${'word '.repeat(2_000_000)}`);
  assert.ok(q.raw.length <= 200);
});
