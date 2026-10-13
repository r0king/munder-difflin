'use strict';

// Workspace Tasks — what the screen draws: staged moves shown in their target
// column, done cards leaving the Board after a day, the keyboard's lifted card
// previewed where it would land.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { normalizeLedger } = loadTs('src/shared/workspace/tasks.ts');
const v = loadTs('src/shared/workspace/tasksView.ts');

const HOUR = 3600_000;
const NOW = Date.parse('2026-10-12T18:00:00Z');

const tasks = normalizeLedger([
  { id: 'bmt-18', title: 'Dark mode', status: 'todo' },
  { id: 'bmt-12', title: 'Flaky test', status: 'doing', assignee: 'dwight' },
  { id: 'bmt-17', title: 'Logo', status: 'blocked', humanQA: [{ q: 'Which?' }] },
  { id: 'bmt-9', title: 'Onboarding', status: 'done' },
  { id: 'bmt-3', title: 'Old', status: 'done' }
]);
const activity = {
  'bmt-12': { changedAt: NOW - 6 * HOUR, statusSince: NOW - 6 * HOUR },
  'bmt-9': { changedAt: NOW - 2 * HOUR, statusSince: NOW - 2 * HOUR },
  'bmt-3': { changedAt: NOW - 30 * HOUR, statusSince: NOW - 30 * HOUR }
};

test('views carry staged target, owner, stale age and the ask', () => {
  const staged = [{ taskId: 'bmt-18', title: 'Dark mode', fromColumn: 'todo', toColumn: 'doing', fromOwner: null, toOwner: 'jim', stagedAt: 1 }];
  const views = v.buildTaskViews(tasks, { activity, staged, sent: [], now: NOW });
  const by = Object.fromEntries(views.map((x) => [x.task.id, x]));
  assert.equal(by['bmt-18'].column, 'doing');
  assert.equal(by['bmt-18'].owner, 'jim');
  assert.equal(by['bmt-18'].task.column, 'todo', 'the ledger card itself is untouched');
  assert.equal(by['bmt-12'].staleMs, 6 * HOUR);
  assert.equal(by['bmt-17'].asks, true);
  assert.equal(by['bmt-12'].owner, 'dwight');
});

test('the Board groups by column and drops done cards older than a day', () => {
  const views = v.buildTaskViews(tasks, { activity, staged: [], sent: [], now: NOW });
  const cols = v.boardColumns(views, NOW);
  assert.deepEqual(cols.map((c) => c.column), ['todo', 'doing', 'blocked', 'done']);
  assert.deepEqual(cols[3].cards.map((x) => x.task.id), ['bmt-9']);
  assert.equal(cols[3].hiddenDone, 1);
});

test('a staged card is drawn in its target column and never hidden', () => {
  const staged = [{ taskId: 'bmt-3', title: 'Old', fromColumn: 'done', toColumn: 'doing', fromOwner: null, toOwner: null, stagedAt: 1 }];
  const views = v.buildTaskViews(tasks, { activity, staged, sent: [], now: NOW });
  const cols = v.boardColumns(views, NOW);
  assert.ok(cols[1].cards.some((x) => x.task.id === 'bmt-3'));
  assert.equal(cols[3].hiddenDone, 0);
});

test('a lifted card previews in the column it is over', () => {
  const views = v.buildTaskViews(tasks, { activity, staged: [], sent: [], now: NOW });
  const cols = v.boardColumns(views, NOW, { id: 'bmt-12', column: 'blocked' });
  assert.deepEqual(cols[1].cards.map((x) => x.task.id), []);
  assert.ok(cols[2].cards.some((x) => x.task.id === 'bmt-12' && x.column === 'blocked'));
});

test('sent moves show only while nothing is staged for the card', () => {
  const sent = [{ taskId: 'bmt-12', title: 'Flaky test', fromColumn: 'doing', toColumn: 'done', fromOwner: 'dwight', toOwner: 'dwight', stagedAt: 1, sentAt: 2 }];
  let views = v.buildTaskViews(tasks, { activity, staged: [], sent, now: NOW });
  assert.equal(views.find((x) => x.task.id === 'bmt-12').sent.toColumn, 'done');
  assert.equal(views.find((x) => x.task.id === 'bmt-12').column, 'doing', 'drawn where the ledger has it');
  const staged = [{ ...sent[0], toColumn: 'blocked' }];
  views = v.buildTaskViews(tasks, { activity, staged, sent, now: NOW });
  assert.equal(views.find((x) => x.task.id === 'bmt-12').sent, undefined);
});

test('the List orders by column, then needs-you and recency', () => {
  const views = v.buildTaskViews(tasks, { activity, staged: [], sent: [], now: NOW });
  assert.deepEqual(v.listOrder(views, NOW).map((x) => x.task.id), ['bmt-18', 'bmt-12', 'bmt-17', 'bmt-9', 'bmt-3']);
});
