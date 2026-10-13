'use strict';

/**
 * Parsing `mempalace search` output (src/shared/workspace/memoryPalace.ts).
 * The fixtures reproduce the CLI's print statements (mempalace 3.x
 * searcher/cli_search.py) line for line, including both Match: generations.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { parsePalaceOutput, parseMatchLine } = loadTs('src/shared/workspace/memoryPalace.ts');

const RULE = `  ${'-'.repeat(56)}`;
const BAR = '='.repeat(60);

function hit(i, wing, room, source, match, text) {
  return [
    `  [${i}] ${wing} / ${room}`,
    `      Source: ${source}`,
    `      Match:  ${match}`,
    '',
    ...text.split('\n').map((l) => `      ${l}`),
    '',
    RULE
  ].join('\n');
}

const VECTOR = [
  '',
  BAR,
  '  Results for: "safari cookie"',
  BAR,
  '',
  hit(1, 'dwight-1', 'auth', 'memory.md', 'cosine_sim=0.612  bm25=3.1', '## 2026-10-06 — Auth\nThe cookie expires early on Safari.\n  - indented bullet'),
  hit(2, 'jim_1', 'general', 'memory.md', 'cosine_sim=0.401  bm25=0.0', 'Login retries hide the flake (bmt-12).'),
  ''
].join('\n');

test('parses ranked hits with wing, room, source, scores and dedented text', () => {
  const p = parsePalaceOutput(VECTOR);
  assert.equal(p.noResults, false);
  assert.equal(p.unparsed, false);
  assert.equal(p.hits.length, 2);
  const [a, b] = p.hits;
  assert.deepEqual(
    { rank: a.rank, wing: a.wing, room: a.room, source: a.source, similarity: a.similarity, bm25: a.bm25 },
    { rank: 1, wing: 'dwight-1', room: 'auth', source: 'memory.md', similarity: 0.612, bm25: 3.1 }
  );
  assert.equal(a.text, '## 2026-10-06 — Auth\nThe cookie expires early on Safari.\n  - indented bullet');
  assert.equal(b.wing, 'jim_1');
  assert.equal(b.text, 'Login retries hide the flake (bmt-12).');
});

test('a body line of dashes inside the text does not end the hit', () => {
  const out = [BAR, '  Results for: "x"', BAR, '', hit(1, 'w', 'r', 's.md', '0.5', `before\n${'-'.repeat(30)}\nafter`)].join('\n');
  const p = parsePalaceOutput(out);
  assert.equal(p.hits.length, 1);
  assert.match(p.hits[0].text, /before\n-{30}\nafter/);
});

test('the BM25-only fallback carries its notice', () => {
  const out = [
    '',
    '  NOTICE: vector search disabled — HNSW index has diverged from SQLite.',
    '          Showing BM25-only results. Run `mempalace repair` to restore vector search.',
    '',
    BAR,
    '  Results for: "cookie"',
    BAR,
    '',
    hit(1, 'dwight-1', 'auth', 'memory.md', 'bm25=2.5  (vector disabled)', 'cookie text')
  ].join('\n');
  const p = parsePalaceOutput(out);
  assert.match(p.notice, /^vector search disabled .*`mempalace repair`/);
  assert.equal(p.hits[0].bm25, 2.5);
  assert.equal(p.hits[0].similarity, undefined);
});

test('"No results found" is an empty answer, not an unknown format', () => {
  const p = parsePalaceOutput(`\n${BAR}\n  Results for: "zzz"\n${BAR}\n\n  No results found for: "zzz"\n`);
  assert.deepEqual([p.hits.length, p.noResults, p.unparsed], [0, true, false]);
  const p2 = parsePalaceOutput('\n  No results found for: "zzz"\n');
  assert.deepEqual([p2.hits.length, p2.noResults, p2.unparsed], [0, true, false]);
});

test('output in a format we do not know is flagged, empty output is not', () => {
  assert.equal(parsePalaceOutput('{"results": []}').unparsed, true);
  assert.equal(parsePalaceOutput('').unparsed, false);
  assert.equal(parsePalaceOutput(undefined).hits.length, 0);
});

test('parseMatchLine reads every generation of the Match: line', () => {
  assert.deepEqual(parseMatchLine('cosine_sim=0.523  bm25=1.2'), { similarity: 0.523, bm25: 1.2 });
  assert.deepEqual(parseMatchLine('l2_sim=-0.1  bm25=0'), { similarity: -0.1, bm25: 0 });
  assert.deepEqual(parseMatchLine('0.523'), { similarity: 0.523 });
  assert.deepEqual(parseMatchLine('bm25=4.2  (vector disabled)'), { similarity: undefined, bm25: 4.2 });
  assert.deepEqual(parseMatchLine('n/a'), {});
});

test('Windows line endings parse the same', () => {
  const p = parsePalaceOutput(VECTOR.replace(/\n/g, '\r\n'));
  assert.equal(p.hits.length, 2);
  assert.equal(p.hits[1].text, 'Login retries hide the flake (bmt-12).');
});
