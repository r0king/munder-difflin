'use strict';

/**
 * The context block "send the results to an agent" delivers, and the small
 * display helpers (src/shared/workspace/memoryContext.ts, memoryFormat.ts).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { buildContextBlock, oneLine, CONTEXT_PROMPT_MAX } = loadTs('src/shared/workspace/memoryContext.ts');
const { parseNoteDate, dayLabel, isoDay, snippetRuns } = loadTs('src/shared/workspace/memoryFormat.ts');
const { MAX_DELIVER_TEXT } = loadTs('src/shared/features/deliver.ts');

const items = [
  { kind: 'note', title: 'The cookie expires early on Safari', author: 'Dwight', date: '2026-10-06', source: 'memory',
    path: '/Users/me/My Hive/hive/agents/dwight-1/memory.md', excerpt: 'Safari drops it after 5 min.\nPin the expiry.' },
  { kind: 'ticket', id: 'bmt-12', title: 'Fix the flaky login test', status: 'doing', people: ['Dwight', 'Michael'] },
  { kind: 'agent', id: 'dwight-1', name: 'Dwight', role: 'owns the auth tests', tickets: 1, notes: 1 }
];

test('the prompt comes first, then the results grouped tickets → agents → notes', () => {
  const text = buildContextBlock({ prompt: 'Fix the login test for good.', query: 'safari cookie', items });
  assert.equal(text, [
    'Fix the login test for good.',
    '',
    '---',
    'Context from the floor\'s memory for "safari cookie":',
    '',
    'Tickets',
    '- bmt-12 — Fix the flaky login test [doing] · worked on by Dwight, Michael',
    '',
    'Agents',
    '- Dwight (id: dwight-1) — owns the auth tests · 1 ticket, 1 note in these results',
    '',
    'Notes',
    '- The cookie expires early on Safari — Dwight, 2026-10-06 (memory)',
    '  file: /Users/me/My Hive/hive/agents/dwight-1/memory.md',
    '  > Safari drops it after 5 min.',
    '  > Pin the expiry.',
    '',
    'Read the files listed for the full notes. Tickets are in the hive task ledger (tasks.json) under their ids.'
  ].join('\n'));
});

test('no prompt sends the block alone; no items sends the prompt alone', () => {
  const block = buildContextBlock({ prompt: '  ', items: [items[1]] });
  assert.ok(block.startsWith("Context from the floor's memory:\n\nTickets\n- bmt-12"));
  assert.equal(buildContextBlock({ prompt: 'just this', items: [] }), 'just this');
});

test("the user's own note reads as from the user, with its source", () => {
  const text = buildContextBlock({ prompt: '', items: [{ kind: 'note', title: 'Release checklist', source: 'notes', excerpt: '' }] });
  assert.match(text, /- Release checklist — the user \(note\)$/m);
});

test('excerpts are capped and the block stops at its budget, counting what it left out', () => {
  const long = { kind: 'note', title: 'Long', source: 'memory', excerpt: 'word '.repeat(1000) };
  const one = buildContextBlock({ prompt: '', items: [long], excerptChars: 100 });
  const quoted = one.split('\n').filter((l) => l.startsWith('  > '));
  assert.ok(quoted.join('').length < 140, 'excerpt capped');
  const many = Array.from({ length: 40 }, (_, i) => ({ ...long, title: `Note ${i}` }));
  const text = buildContextBlock({ prompt: 'p', items: many, maxChars: 2000, excerptChars: 200 });
  const kept = (text.match(/^- Note \d+/gm) || []).length;
  assert.ok(kept > 0 && kept < 40);
  assert.match(text, new RegExp(`\\(${40 - kept} more selected results left out to keep this short\\.\\)`));
});

test('the prompt is capped and the whole text never exceeds a delivery', () => {
  const text = buildContextBlock({ prompt: 'x'.repeat(CONTEXT_PROMPT_MAX + 50), items: [items[1]] });
  assert.ok(text.startsWith('x'.repeat(CONTEXT_PROMPT_MAX) + '\n\n---'));
  assert.ok(text.length <= MAX_DELIVER_TEXT);
});

test('oneLine collapses whitespace and cuts at a word', () => {
  assert.equal(oneLine(' a \n b ', 10), 'a b');
  assert.equal(oneLine('alpha beta gamma delta', 12), 'alpha beta…');
});

test('parseNoteDate reads a dated heading as a LOCAL day', () => {
  const d = parseNoteDate('2026-10-06');
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2026, 9, 6, 0]);
  assert.equal(parseNoteDate('2026-10-06T14:30').getHours(), 14);
  assert.equal(parseNoteDate('nope'), null);
  assert.equal(parseNoteDate(undefined), null);
  assert.equal(isoDay(new Date(2026, 0, 5)), '2026-01-05');
});

test('dayLabel: today, yesterday, a weekday this week, a date beyond', () => {
  const now = new Date(2026, 9, 12, 9, 0); // Monday 12 Oct 2026
  assert.deepEqual(dayLabel(new Date(2026, 9, 12, 1), now, 'en'), { kind: 'today' });
  assert.deepEqual(dayLabel(new Date(2026, 9, 11, 23), now, 'en'), { kind: 'yesterday' });
  assert.deepEqual(dayLabel(new Date(2026, 9, 6), now, 'en'), { kind: 'weekday', text: 'Tuesday' });
  assert.deepEqual(dayLabel(new Date(2026, 8, 1), now, 'en'), { kind: 'date', text: 'Sep 1' });
  assert.equal(dayLabel(new Date(2025, 8, 1), now, 'en').text, 'Sep 1, 2025');
  assert.equal(dayLabel(new Date(2026, 9, 20), now, 'en').kind, 'date', 'the future is a date');
  assert.equal(dayLabel(new Date(2026, 9, 6), now, 'not-a-locale!!').kind, 'weekday');
});

test('snippetRuns splits text into plain and marked runs', () => {
  assert.deepEqual(snippetRuns('the login test', [[4, 9]]), [
    { text: 'the ', mark: false }, { text: 'login', mark: true }, { text: ' test', mark: false }
  ]);
  assert.deepEqual(snippetRuns('abc', [[0, 99]]), [{ text: 'abc', mark: true }]);
  assert.deepEqual(snippetRuns('abc', []), [{ text: 'abc', mark: false }]);
});

test('toContextItems turns ticked results into items with display names and local dates', () => {
  const { toContextItems } = loadTs('src/shared/workspace/memoryContext.ts');
  const names = {
    name: (id) => ({ 'dwight-1': 'Dwight', god: 'Michael' }[id] ?? id),
    role: (id) => (id === 'dwight-1' ? 'owns the auth tests' : undefined)
  };
  const out = toContextItems([
    { kind: 'ticket', id: 'bmt-12', title: 'Fix it', status: 'doing', agentIds: ['dwight-1', 'god'], score: 1, mentioned: false,
      snippet: { text: '… Safari only …', marks: [] } },
    { kind: 'agent', id: 'dwight-1', direct: true, tickets: 1, notes: 2, score: 1 },
    { kind: 'note', key: 'k', source: 'palace', title: 'Cookies', authorId: 'dwight-1', at: '2026-10-06', score: 1,
      ref: { kind: 'palace', wing: 'dwight_1', room: 'auth', source: 'memory.md' }, ticketRefs: [],
      snippet: { text: 'short', marks: [] }, text: 'the whole drawer' },
    { kind: 'note', key: 'd', source: 'knowledge', title: 'Spec', score: 1, ref: { kind: 'knowledge', docId: 'd' }, ticketRefs: [],
      snippet: { text: 'doc text', marks: [] } }
  ], names);
  assert.deepEqual(out[0], { kind: 'ticket', id: 'bmt-12', title: 'Fix it', status: 'doing', people: ['Dwight', 'Michael'], excerpt: '… Safari only …' });
  assert.deepEqual(out[1], { kind: 'agent', id: 'dwight-1', name: 'Dwight', role: 'owns the auth tests', tickets: 1, notes: 2 });
  assert.deepEqual(out[2], { kind: 'note', title: 'Cookies', source: 'palace', excerpt: 'the whole drawer', author: 'Dwight', date: '2026-10-06' });
  const text = buildContextBlock({ prompt: '', items: [out[3]] });
  assert.match(text, /^- Spec \(document\)$/m, 'a document has no author line');
});
