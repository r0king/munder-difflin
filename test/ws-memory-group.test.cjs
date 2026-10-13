'use strict';

/**
 * Answers in three shapes — tickets, the agents who worked on them, their
 * notes (src/shared/workspace/memoryGroup.ts).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { groupAnswer } = loadTs('src/shared/workspace/memoryGroup.ts');

const people = [
  { id: 'god', name: 'Michael', isGod: true },
  { id: 'dwight-1', name: 'Dwight', role: 'owns the auth tests' },
  { id: 'jim-1', name: 'Jim' },
  { id: 'pam-1', name: 'Pam' }
];
const snip = (text) => ({ text, marks: [] });
const note = (key, score, extra = {}) => ({
  kind: 'note', key, source: 'memory', title: key, score, snippet: snip(key), ticketRefs: [],
  ref: { kind: 'memory', agentId: extra.authorId ?? 'jim-1', section: 1 }, ...extra
});
const ticket = (id, score, agentIds = [], extra = {}) => ({ kind: 'ticket', id, title: `T ${id}`, agentIds, score, ...extra });
const ledger = new Map([
  ['bmt-12', { id: 'bmt-12', title: 'Fix the flaky login test', status: 'doing', agentIds: ['dwight-1'] }],
  ['bmt-13', { id: 'bmt-13', title: 'Ship SSO', status: 'todo', agentIds: [] }]
]);

test('a matching note pulls in the ticket it names, and its author onto that ticket', () => {
  const a = groupAnswer({
    tickets: [],
    notes: [note('cookie', 8, { authorId: 'god', ticketRefs: ['bmt-12'] })],
    agents: [],
    ledger,
    people
  });
  assert.equal(a.tickets.length, 1);
  const t = a.tickets[0];
  assert.equal(t.id, 'bmt-12');
  assert.equal(t.mentioned, true);
  assert.equal(t.title, 'Fix the flaky login test');
  assert.deepEqual(t.agentIds, ['dwight-1', 'god']);
  assert.equal(t.score, 4, 'a mentioned ticket ranks at half the note that names it');
});

test('a direct ticket hit stays direct and gains note authors', () => {
  const a = groupAnswer({
    tickets: [ticket('bmt-12', 10, ['dwight-1'])],
    notes: [note('n1', 3, { authorId: 'jim-1', ticketRefs: ['bmt-12'] })],
    agents: [],
    ledger,
    people
  });
  assert.equal(a.tickets[0].mentioned, false);
  assert.equal(a.tickets[0].score, 10);
  assert.deepEqual(a.tickets[0].agentIds, ['dwight-1', 'jim-1']);
});

test('agents are the union of direct matches, ticket people and note authors', () => {
  const a = groupAnswer({
    tickets: [ticket('bmt-12', 10, ['dwight-1'])],
    notes: [note('n1', 5, { authorId: 'jim-1' }), note('n2', 4, { authorId: 'jim-1' })],
    agents: [{ kind: 'agent', id: 'pam-1', score: 2 }],
    ledger,
    people
  });
  const byId = Object.fromEntries(a.agents.map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(byId).sort(), ['dwight-1', 'jim-1', 'pam-1']);
  assert.deepEqual([byId['dwight-1'].tickets, byId['dwight-1'].notes, byId['dwight-1'].direct], [1, 0, false]);
  assert.deepEqual([byId['jim-1'].tickets, byId['jim-1'].notes], [0, 2]);
  assert.equal(byId['pam-1'].direct, true);
  // jim: 3 + 2.4/2 = 4.2 ; dwight: 6 ; pam: 2
  assert.deepEqual(a.agents.map((x) => x.id), ['dwight-1', 'jim-1', 'pam-1']);
  assert.equal(byId['jim-1'].score, 4.2);
});

test('unknown ids (a wing with no agent, a free-text assignee) are left out', () => {
  const a = groupAnswer({
    tickets: [ticket('bmt-13', 3, ['stranger'])],
    notes: [note('n1', 2, { authorId: 'ghost' })],
    agents: [{ kind: 'agent', id: 'nobody', score: 9 }],
    ledger,
    people
  });
  assert.deepEqual(a.agents, []);
  assert.deepEqual(a.tickets[0].agentIds, []);
  assert.deepEqual(a.people, []);
});

test('notes rank by score, then newest first', () => {
  const a = groupAnswer({
    tickets: [],
    notes: [
      note('old', 5, { at: '2026-01-01' }),
      note('new', 5, { at: '2026-10-01' }),
      note('best', 9)
    ],
    agents: [],
    ledger,
    people
  });
  assert.deepEqual(a.notes.map((n) => n.key), ['best', 'new', 'old']);
});

test('caps apply per shape, totals count everything, people label what is shown', () => {
  const notes = Array.from({ length: 10 }, (_, i) => note(`n${i}`, 10 - i, { authorId: i % 2 ? 'jim-1' : 'pam-1' }));
  const a = groupAnswer({ tickets: [], notes, agents: [], ledger, people, caps: { notes: 3, agents: 1 } });
  assert.equal(a.notes.length, 3);
  assert.equal(a.totals.notes, 10);
  assert.equal(a.agents.length, 1);
  assert.equal(a.totals.agents, 2);
  assert.deepEqual(a.people.map((p) => p.id).sort(), ['jim-1', 'pam-1']);
});

test('an empty input is an empty answer', () => {
  const a = groupAnswer({ tickets: [], notes: [], agents: [], ledger: new Map(), people: [] });
  assert.deepEqual(a, { tickets: [], agents: [], notes: [], people: [], totals: { tickets: 0, agents: 0, notes: 0 } });
});
