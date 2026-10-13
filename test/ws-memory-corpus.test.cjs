'use strict';

/**
 * Turning the floor's files into searchable units, and the graph edges between
 * them (src/shared/workspace/memoryCorpus.ts).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  splitSections, headingDate, sectionTitle, plainInline, collectTopics, ticketUnits, stableTaskId,
  findTicketRefs, resolveAgent, wingKey
} = loadTs('src/shared/workspace/memoryCorpus.ts');

const SEEDED = '# Memory — Jim (jim-1)\n\n_Append durable facts, decisions, and context below._\n';

test('a freshly seeded memory.md has no notes', () => {
  assert.deepEqual(splitSections(SEEDED), []);
});

test('memory sections split at ## and keep a stable index', () => {
  const md = `${SEEDED}\n## 2026-10-06 — Auth\nCookie expires early.\n\n## Deploys\n- use blue/green\n`;
  const s = splitSections(md);
  assert.deepEqual(s.map((x) => [x.index, x.heading, x.level, x.body]), [
    [1, '2026-10-06 — Auth', 2, 'Cookie expires early.'],
    [2, 'Deploys', 2, '- use blue/green']
  ]);
});

test('text before the first heading is the preamble section', () => {
  const s = splitSections('Loose fact one.\n\n## Later\nmore');
  assert.equal(s[0].index, 0);
  assert.equal(s[0].heading, '');
  assert.equal(s[0].body, 'Loose fact one.');
});

test('headings inside fenced code are text, not structure', () => {
  const md = '## Real\n```md\n## not a heading\n```\nafter';
  const s = splitSections(md);
  assert.equal(s.length, 1);
  assert.match(s[0].body, /## not a heading/);
});

test('a heading-only section is still a note (its heading says something)', () => {
  const s = splitSections('## Decided to use Postgres\n\n## Next\nbody');
  assert.deepEqual(s.map((x) => x.heading), ['Decided to use Postgres', 'Next']);
});

test('headingDate reads real calendar dates only', () => {
  assert.equal(headingDate('2026-10-06 — Auth'), '2026-10-06');
  assert.equal(headingDate('Deploy 2026-10-06 14:30'), '2026-10-06T14:30');
  assert.equal(headingDate('2026-02-31 bogus'), undefined);
  assert.equal(headingDate('2026-13-01'), undefined);
  assert.equal(headingDate('No date here'), undefined);
});

test('sectionTitle drops the date and markup, falls back to the first line', () => {
  assert.equal(sectionTitle({ heading: '2026-10-06 — **Auth** tests', body: '' }), 'Auth tests');
  assert.equal(sectionTitle({ heading: '', body: '\n- The cookie expires early\nmore' }), 'The cookie expires early');
  assert.equal(sectionTitle({ heading: 'x'.repeat(300), body: '' }, 20).length, 20);
  assert.equal(plainInline('See [the doc](https://x.y) and `code`'), 'See the doc and code');
});

test('collectTopics counts headings and bold terms once, skipping generic ones', () => {
  const topics = new Set();
  collectTopics('## 2026-10-06 — Login tests\n**Safari cookies** and **notes**\n## Status\n```\n## fenced\n```', topics);
  collectTopics('## Login Tests\n**safari cookies**', topics);
  assert.deepEqual([...topics].sort(), ['login tests', 'safari cookies']);
});

test('ticketUnits reads every card, searchable text from an allowlist only', () => {
  const units = ticketUnits({
    tasks: [
      {
        id: 'bmt-12', title: 'Fix the flaky login test', status: 'doing', assignee: 'dwight-1',
        description: 'Retries hide it.', result: 'Pinned the cookie.', createdAt: '2026-10-01T10:00:00Z',
        updatedAt: '2026-10-06T10:00:00Z', humanQA: [{ q: 'Which browser?', a: 'Safari' }],
        webhook: { tokenHash: 'deadbeef' }, slack: { channel: 'C1', thread_ts: '1.2' }
      },
      'garbage',
      { title: 'No id card', createdAt: '2026-10-02' }
    ]
  });
  assert.equal(units.length, 2);
  const [a, b] = units;
  assert.equal(a.id, 'bmt-12');
  assert.equal(a.status, 'doing');
  assert.deepEqual(a.people, ['dwight-1']);
  assert.equal(a.at, '2026-10-06T10:00:00Z');
  assert.match(a.body, /Retries hide it\./);
  assert.match(a.body, /Pinned the cookie\./);
  assert.match(a.body, /Which browser\?/);
  assert.match(a.body, /Safari/);
  assert.doesNotMatch(a.body, /deadbeef/);
  assert.doesNotMatch(a.body, /thread_ts|C1/);
  // A card without an id gets the board's own fallback id, so it opens the same card.
  assert.equal(b.id, stableTaskId('No id card|2026-10-02|2'));
  assert.match(b.id, /^t-[0-9a-z]+$/);
});

test('ticketUnits tolerates a missing or malformed ledger', () => {
  assert.deepEqual(ticketUnits(null), []);
  assert.deepEqual(ticketUnits({ tasks: 'nope' }), []);
  assert.deepEqual(ticketUnits({}), []);
});

test('findTicketRefs matches whole ids only, case-insensitively', () => {
  const ids = ['bmt-120', 'bmt-12', 'ab', 't-x1'];
  assert.deepEqual(findTicketRefs('Fixed BMT-12 today; see t-x1.', ids), ['bmt-12', 't-x1']);
  assert.deepEqual(findTicketRefs('bmt-120 only', ids), ['bmt-120']);
  assert.deepEqual(findTicketRefs('bmt-12a is not it, nor xbmt-12', ids), []);
  assert.deepEqual(findTicketRefs('ab ab ab', ids), [], 'two-character ids are ignored');
  assert.deepEqual(findTicketRefs('', ids), []);
});

test('resolveAgent maps an id, a name or a wing back to an agent', () => {
  const people = [{ id: 'dwight-1', name: 'Dwight' }, { id: 'god', name: 'Michael', isGod: true }];
  assert.equal(resolveAgent('dwight-1', people), 'dwight-1');
  assert.equal(resolveAgent('michael', people), 'god');
  assert.equal(resolveAgent('@Dwight', people), 'dwight-1');
  assert.equal(resolveAgent('dwight_1', people), 'dwight-1');
  assert.equal(resolveAgent('human', people), undefined);
  assert.equal(resolveAgent('  ', people), undefined);
  assert.equal(wingKey('Dwight-1 '), 'dwight_1');
});
