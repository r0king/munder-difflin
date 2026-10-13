'use strict';

// Workspace Tasks screen — the pure model over hive/tasks.json: column
// mapping, normalization, staleness, done-leaves-the-board, the local
// day/week/month filters, ordering, and new-task ids.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const m = loadTs('src/shared/workspace/tasks.ts');

const HOUR = 3600_000;
const DAY = 24 * HOUR;

test('ledger statuses map onto the four columns, synonyms included', () => {
  assert.equal(m.columnForStatus('todo'), 'todo');
  assert.equal(m.columnForStatus('doing'), 'doing');
  assert.equal(m.columnForStatus('blocked'), 'blocked');
  assert.equal(m.columnForStatus('done'), 'done');
  assert.equal(m.columnForStatus('In Progress'), 'doing');
  assert.equal(m.columnForStatus('in_review'), 'doing');
  assert.equal(m.columnForStatus('WIP'), 'doing');
  assert.equal(m.columnForStatus('on-hold'), 'blocked');
  assert.equal(m.columnForStatus('waiting'), 'blocked');
  assert.equal(m.columnForStatus('Completed'), 'done');
  assert.equal(m.columnForStatus('cancelled'), 'done');
  assert.equal(m.columnForStatus('backlog'), 'todo');
  // Unknown and missing fall back to To do, as the Classic kanban does.
  assert.equal(m.columnForStatus('mystery'), 'todo');
  assert.equal(m.columnForStatus(undefined), 'todo');
  assert.equal(m.columnForStatus(42), 'todo');
});

test('normalizeLedger tolerates a hand-written file and keeps every card', () => {
  const raw = {
    tasks: [
      { id: 'bmt-12', title: 'Fix the flaky login test', status: 'in_progress', assignee: 'dwight', priority: 4, createdAt: '2026-10-01T10:00:00Z' },
      { title: 'No id here', status: 'todo', createdAt: '2026-10-02T10:00:00Z' },
      { id: 'bmt-17', title: 'Swap the logo', status: 'blocked', humanQA: [{ q: 'Old?', a: 'yes' }, { q: 'Which logo?', askedAt: '2026-10-03T09:00:00Z' }] },
      null,
      'garbage',
      { id: 'bmt-12', title: 'Duplicate id', status: 'done', priority: 'high' }
    ]
  };
  const tasks = m.normalizeLedger(raw);
  assert.equal(tasks.length, 4);
  assert.equal(tasks[0].column, 'doing');
  assert.equal(tasks[0].rawStatus, 'in_progress');
  assert.equal(tasks[0].priority, 4);
  // A card without an id gets the Classic kanban's stable synthetic id.
  assert.match(tasks[1].id, /^t-[0-9a-z]+$/);
  assert.equal(tasks[1].id, m.normalizeLedger(raw)[1].id, 'stable across polls');
  assert.equal(tasks[1].id, m.stableTaskId('No id here|2026-10-02T10:00:00Z|1'));
  assert.deepEqual(tasks[2].openAsk, { q: 'Which logo?', askedAt: '2026-10-03T09:00:00Z' });
  assert.equal(m.asksYou(tasks[2]), true);
  // Duplicate ids keep the ledger id but get a unique React key.
  assert.equal(tasks[3].id, 'bmt-12');
  assert.notEqual(tasks[3].key, tasks[0].key);
  assert.equal(tasks[3].priority, 3, 'non-numeric priority → default');
  assert.deepEqual(m.normalizeLedger(null), []);
  assert.deepEqual(m.normalizeLedger({ tasks: 'nope' }), []);
});

test('asks you means blocked with an open, undismissed question', () => {
  const [open, answered, dismissed, doing] = m.normalizeLedger([
    { id: 'a', status: 'blocked', humanQA: [{ q: 'x?' }] },
    { id: 'b', status: 'blocked', humanQA: [{ q: 'x?', a: 'y' }] },
    { id: 'c', status: 'blocked', humanQA: [{ q: 'x?', dismissedAt: '2026-10-01T00:00:00Z' }] },
    { id: 'd', status: 'doing', humanQA: [{ q: 'x?' }] }
  ]);
  assert.equal(m.asksYou(open), true);
  assert.equal(m.asksYou(answered), false);
  assert.equal(m.asksYou(dismissed), false);
  assert.equal(m.asksYou(doing), false, 'same predicate as the ASK ME board');
});

test('a Doing card with no change for the threshold is stale; unknown is never stale', () => {
  const now = Date.parse('2026-10-12T18:00:00Z');
  const [doing, todo] = m.normalizeLedger([
    { id: 'a', status: 'doing' },
    { id: 'b', status: 'todo' }
  ]);
  assert.equal(m.staleForMs(doing, { changedAt: now - 6 * HOUR, statusSince: now - 6 * HOUR }, now), 6 * HOUR);
  assert.equal(m.staleForMs(doing, { changedAt: now - 1 * HOUR, statusSince: now - 6 * HOUR }, now), null);
  assert.equal(m.staleForMs(doing, undefined, now), null, 'no evidence → not stale');
  assert.equal(m.staleForMs(todo, { changedAt: now - 9 * DAY, statusSince: 0 }, now), null, 'only Doing goes stale');
  // An explicit updatedAt on the card counts as a change.
  const [stamped] = m.normalizeLedger([{ id: 'c', status: 'doing', updatedAt: new Date(now - 30 * 60_000).toISOString() }]);
  assert.equal(m.staleForMs(stamped, { changedAt: now - 9 * HOUR, statusSince: 0 }, now), null);
});

test('done cards leave the Board a day after they got there', () => {
  const now = Date.parse('2026-10-12T18:00:00Z');
  const [done, doing] = m.normalizeLedger([{ id: 'a', status: 'done' }, { id: 'b', status: 'doing' }]);
  assert.equal(m.leftTheBoard(done, { changedAt: now, statusSince: now - 25 * HOUR }, now), true);
  assert.equal(m.leftTheBoard(done, { changedAt: now, statusSince: now - 2 * HOUR }, now), false);
  assert.equal(m.leftTheBoard(done, undefined, now), false, 'unknown done-time stays on the board');
  assert.equal(m.leftTheBoard(doing, { changedAt: 0, statusSince: 0 }, now), false);
});

test('ageParts reads minutes, then hours, then days', () => {
  assert.deepEqual(m.ageParts(0), { n: 1, unit: 'm' });
  assert.deepEqual(m.ageParts(45 * 60_000), { n: 45, unit: 'm' });
  assert.deepEqual(m.ageParts(6 * HOUR + 59 * 60_000), { n: 6, unit: 'h' });
  assert.deepEqual(m.ageParts(47 * HOUR), { n: 47, unit: 'h' });
  assert.deepEqual(m.ageParts(3 * DAY), { n: 3, unit: 'd' });
});

test('range starts are local midnight, local week start and the 1st of the month', () => {
  // Wednesday 14 October 2026, 15:30 local time.
  const now = new Date(2026, 9, 14, 15, 30).getTime();
  assert.equal(m.rangeStartMs('all', now), null);
  assert.equal(m.rangeStartMs('today', now), new Date(2026, 9, 14).getTime());
  assert.equal(m.rangeStartMs('month', now), new Date(2026, 9, 1).getTime());
  assert.equal(m.rangeStartMs('week', now, 1), new Date(2026, 9, 12).getTime(), 'Monday start');
  assert.equal(m.rangeStartMs('week', now, 0), new Date(2026, 9, 11).getTime(), 'Sunday start');
  // On the week's first day, the week starts that very midnight.
  const monday = new Date(2026, 9, 12, 0, 5).getTime();
  assert.equal(m.rangeStartMs('week', monday, 1), new Date(2026, 9, 12).getTime());
  // Across a month boundary.
  const thu = new Date(2026, 9, 1, 9).getTime();
  assert.equal(m.rangeStartMs('week', thu, 1), new Date(2026, 8, 28).getTime());
});

test('filters: range keeps touched cards, but never hides one that needs you', () => {
  const now = new Date(2026, 9, 14, 15, 30).getTime();
  const tasks = m.normalizeLedger([
    { id: 'new', title: 'Made today', status: 'todo', createdAt: new Date(2026, 9, 14, 9).toISOString() },
    { id: 'old', title: 'Made last month', status: 'todo', createdAt: new Date(2026, 8, 2).toISOString() },
    { id: 'ask', title: 'Old ask', status: 'blocked', createdAt: new Date(2026, 8, 2).toISOString(), humanQA: [{ q: '?' }] },
    { id: 'stale', title: 'Old doing', status: 'doing', createdAt: new Date(2026, 8, 2).toISOString() },
    { id: 'mine', title: 'Owned', status: 'todo', assignee: 'jim', createdAt: new Date(2026, 9, 13).toISOString() }
  ]);
  const activity = { stale: { changedAt: new Date(2026, 8, 3).getTime(), statusSince: 0 } };
  const ids = (filter) => m.filterTasks(tasks, filter, { now, activity, nameOf: (id) => (id === 'jim' ? 'Jim Halpert' : undefined) }).map((t) => t.id);
  assert.deepEqual(ids({ range: 'today', assignee: 'all', query: '' }), ['new', 'ask', 'stale']);
  assert.deepEqual(ids({ range: 'week', assignee: 'all', query: '' }), ['new', 'ask', 'stale', 'mine']);
  assert.deepEqual(ids({ range: 'all', assignee: 'all', query: '' }), ['new', 'old', 'ask', 'stale', 'mine']);
  assert.deepEqual(ids({ range: 'all', assignee: 'jim', query: '' }), ['mine']);
  assert.deepEqual(ids({ range: 'all', assignee: 'unassigned', query: '' }), ['new', 'old', 'ask', 'stale']);
  // Search: every word, case-insensitive, over id/title/owner name.
  assert.deepEqual(ids({ range: 'all', assignee: 'all', query: 'HALPERT' }), ['mine']);
  assert.deepEqual(ids({ range: 'all', assignee: 'all', query: 'old doing' }), ['stale']);
  assert.deepEqual(ids({ range: 'all', assignee: 'all', query: 'ask' }), ['ask']);
});

test('summary counts the whole floor', () => {
  const tasks = m.normalizeLedger([
    { id: 'a', status: 'doing' }, { id: 'b', status: 'in progress' }, { id: 'c', status: 'doing' },
    { id: 'd', status: 'blocked', humanQA: [{ q: '?' }] }, { id: 'e', status: 'done' }
  ]);
  assert.deepEqual(m.summarizeTasks(tasks), { doing: 3, asksYou: 1, total: 5 });
});

test('in-column order: needs-you first, then priority, then most recent', () => {
  const now = Date.parse('2026-10-12T18:00:00Z');
  const tasks = m.normalizeLedger([
    { id: 'low', status: 'doing', priority: 1, createdAt: '2026-10-12T17:00:00Z' },
    { id: 'high-old', status: 'doing', priority: 5, createdAt: '2026-10-12T10:00:00Z' },
    { id: 'high-new', status: 'doing', priority: 5, createdAt: '2026-10-12T16:00:00Z' },
    { id: 'stale', status: 'doing', priority: 1, createdAt: '2026-10-01T10:00:00Z' }
  ]);
  const activity = {
    'high-old': { changedAt: now - HOUR, statusSince: 0 },
    'high-new': { changedAt: now - 2 * HOUR, statusSince: 0 },
    low: { changedAt: now - HOUR, statusSince: 0 },
    stale: { changedAt: now - 10 * HOUR, statusSince: 0 }
  };
  const order = [...tasks].sort((a, b) => m.compareInColumn(a, b, activity, now)).map((t) => t.id);
  assert.deepEqual(order, ['stale', 'high-old', 'high-new', 'low']);
});

test('new ids follow the ledger key, else the folder key', () => {
  assert.equal(m.nextTaskId(['bmt-12', 'bmt-9', 'bmt-17', 'webhook-abc', 't-xyz'], 'MUN'), 'bmt-18');
  assert.equal(m.nextTaskId(['V53-299', 'V53-12', 'bmt-4'], 'MUN'), 'V53-300', 'most common prefix wins');
  assert.equal(m.nextTaskId([], 'MUN'), 'MUN-1');
  assert.equal(m.nextTaskId(['fix-login-a1b2', 'MUN-1'], 'MUN'), 'MUN-2');
  assert.equal(m.nextTaskId([], ''), 'TSK-1');
  // Never collides, even with odd spellings in the file.
  assert.equal(m.nextTaskId(['abc-1', 'ABC-2', 'abc-3'], 'X'), 'abc-4');
});

test('deriveTaskKey makes a short ASCII key from a folder name', () => {
  assert.equal(m.deriveTaskKey('munder-difflin'), 'MUN');
  assert.equal(m.deriveTaskKey('v53 site'), 'V53');
  assert.equal(m.deriveTaskKey('2026-site'), 'SIT');
  assert.equal(m.deriveTaskKey('我的项目'), 'TSK');
  assert.equal(m.deriveTaskKey('x'), 'TSK');
  assert.equal(m.deriveTaskKey('ab'), 'AB');
});

test('a first-look bound counts for staleness but not for the date filters', () => {
  const now = new Date(2026, 9, 14, 15, 30).getTime();
  const [old] = m.normalizeLedger([{ id: 'old', status: 'doing', createdAt: new Date(2026, 8, 2).toISOString() }]);
  const bound = { old: { changedAt: now - 5 * HOUR, statusSince: 0, observed: false } };
  // Not touched today as far as anyone knows...
  assert.equal(m.lastActivityMs(old, bound.old), new Date(2026, 8, 2).getTime());
  // ...but the bound still drives the stale chip, conservatively.
  assert.equal(m.staleForMs(old, bound.old, now), 5 * HOUR);
  const todo = m.normalizeLedger([{ id: 't', status: 'todo', createdAt: new Date(2026, 8, 2).toISOString() }]);
  const ids = m.filterTasks(todo, { range: 'today', assignee: 'all', query: '' }, {
    now, activity: { t: { changedAt: now - HOUR, statusSince: 0, observed: false } }
  }).map((t) => t.id);
  assert.deepEqual(ids, []);
});
