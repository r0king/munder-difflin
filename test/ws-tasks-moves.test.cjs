'use strict';

// Workspace Tasks — staged moves. The human's drags are STAGED, folded one per
// card, kept aligned with the live ledger, and sent as ONE message to the
// orchestrator, who applies them.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const mv = loadTs('src/shared/workspace/tasksMoves.ts');

const stage = (state, over) => mv.movesReducer(state, {
  type: 'stage', taskId: 'bmt-12', title: 'Fix the flaky login test',
  fromColumn: 'doing', fromOwner: 'dwight', now: 1000, ...over
});

test('staging a move records ledger origin and target', () => {
  const s = stage([], { toColumn: 'done' });
  assert.deepEqual(s, [{
    taskId: 'bmt-12', title: 'Fix the flaky login test', fromColumn: 'doing', toColumn: 'done',
    fromOwner: 'dwight', toOwner: 'dwight', stagedAt: 1000
  }]);
});

test('moving the same card again folds into one entry', () => {
  let s = stage([], { toColumn: 'blocked' });
  s = stage(s, { toColumn: 'done', now: 2000 });
  assert.equal(s.length, 1);
  assert.equal(s[0].fromColumn, 'doing');
  assert.equal(s[0].toColumn, 'done');
  assert.equal(s[0].stagedAt, 1000, 'keeps its place in the queue');
  // An owner change keeps the staged column, and vice versa.
  s = stage(s, { toOwner: 'jim' });
  assert.equal(s[0].toColumn, 'done');
  assert.equal(s[0].toOwner, 'jim');
  s = stage(s, { toColumn: 'blocked' });
  assert.equal(s[0].toOwner, 'jim');
});

test('moving a card back to where it really is removes the entry', () => {
  let s = stage([], { toColumn: 'done' });
  s = stage(s, { toColumn: 'doing' });
  assert.deepEqual(s, []);
  // ...unless the owner change still stands.
  s = stage([], { toColumn: 'done', toOwner: 'jim' });
  s = stage(s, { toColumn: 'doing' });
  assert.equal(s.length, 1);
  assert.equal(s[0].toOwner, 'jim');
  // Unassigning is a real change (null), distinct from "keep".
  s = stage([], { toOwner: null });
  assert.equal(s[0].toOwner, null);
});

test('undo and clear', () => {
  let s = stage([], { toColumn: 'done' });
  s = stage(s, { taskId: 'bmt-18', title: 'Dark mode', fromColumn: 'todo', fromOwner: null, toColumn: 'doing' });
  assert.deepEqual(mv.movesReducer(s, { type: 'undo', taskId: 'bmt-12' }).map((m) => m.taskId), ['bmt-18']);
  assert.deepEqual(mv.movesReducer(s, { type: 'clear' }), []);
});

test('reconcile drops vanished and already-applied moves and refreshes origins', () => {
  let s = stage([], { toColumn: 'done' });
  s = stage(s, { taskId: 'gone', title: 'Gone', fromColumn: 'todo', fromOwner: null, toColumn: 'doing' });
  s = stage(s, { taskId: 'applied', title: 'Applied', fromColumn: 'todo', fromOwner: null, toColumn: 'doing' });
  const ledger = [
    { id: 'bmt-12', title: 'Fix the flaky login test (renamed)', column: 'blocked', assignee: 'dwight' },
    { id: 'applied', title: 'Applied', column: 'doing' }
  ];
  const r = mv.reconcileMoves(s, ledger);
  assert.equal(r.length, 1);
  assert.equal(r[0].taskId, 'bmt-12');
  assert.equal(r[0].fromColumn, 'blocked', 'origin follows the agent who moved it meanwhile');
  assert.equal(r[0].title, 'Fix the flaky login test (renamed)');
  // Nothing to change → the same array instance (lets the store skip a write).
  assert.equal(mv.reconcileMoves(r, ledger), r);
});

test('sent moves stay until the ledger acts on them, or they expire', () => {
  const s = stage([], { toColumn: 'done' });
  const sent = mv.markSent([], s, 5000);
  const waiting = [{ id: 'bmt-12', title: 't', column: 'doing', assignee: 'dwight' }];
  assert.equal(mv.reconcileSent(sent, waiting, 6000), sent);
  assert.deepEqual(mv.reconcileSent(sent, [{ id: 'bmt-12', title: 't', column: 'done', assignee: 'dwight' }], 6000), []);
  assert.deepEqual(mv.reconcileSent(sent, [], 6000), []);
  assert.deepEqual(mv.reconcileSent(sent, waiting, 5000 + mv.SENT_MOVE_TTL_MS), []);
  // Re-sending a card replaces its older sent entry.
  const again = mv.markSent(sent, [{ ...s[0], toColumn: 'blocked' }], 7000);
  assert.equal(again.length, 1);
  assert.equal(again[0].toColumn, 'blocked');
});

test('the Send message names each move with ids, titles and ledger values', () => {
  const moves = [
    { taskId: 'bmt-12', title: 'Fix the flaky login test', fromColumn: 'doing', toColumn: 'done', fromOwner: 'dwight', toOwner: 'dwight', stagedAt: 1 },
    { taskId: 'bmt-18', title: 'Add dark mode\nto settings', fromColumn: 'todo', toColumn: 'doing', fromOwner: null, toOwner: 'dwight', stagedAt: 2 },
    { taskId: 'bmt-17', title: 'Swap the logo', fromColumn: 'blocked', toColumn: 'blocked', fromOwner: 'angela', toOwner: 'jim', stagedAt: 3 }
  ];
  const names = { dwight: 'Dwight', angela: 'Angela', jim: 'Jim' };
  const text = mv.buildMoveMessage(moves, (id) => names[id]);
  const lines = text.split('\n');
  assert.match(lines[0], /3 changes/);
  assert.match(lines[0], /not edited tasks\.json/);
  assert.ok(lines.includes('1. bmt-12 "Fix the flaky login test": Doing → Done (status "doing" → "done")'));
  assert.ok(lines.includes('2. bmt-18 "Add dark mode to settings": To do → Doing (status "todo" → "doing"); owner unassigned → Dwight (assignee "dwight")'));
  assert.ok(lines.includes('3. bmt-17 "Swap the logo": owner Angela (assignee "angela") → Jim (assignee "jim"); stays in Blocked'));
  assert.match(mv.buildMoveMessage(moves.slice(0, 1)), /one change/);
  // Unknown names fall back to the raw id.
  assert.match(mv.buildMoveMessage([moves[2]]), /owner assignee "angela" → assignee "jim"/);
});

test('the New task note tells the orchestrator what was added and to whom', () => {
  const text = mv.buildNewTaskMessage(
    { id: 'bmt-19', title: 'Answer the support inbox', description: 'Reply to the three oldest tickets.', assignee: 'pam' },
    (id) => (id === 'pam' ? 'Pam' : undefined)
  );
  assert.match(text, /^New task from the human, added to tasks\.json from the Tasks screen: bmt-19 "Answer the support inbox" \(status "todo", owner Pam \(assignee "pam"\)\)\./);
  assert.match(text, /Description:\nReply to the three oldest tickets\./);
  assert.match(text, /Please dispatch it to Pam and keep/);
  const bare = mv.buildNewTaskMessage({ id: 'MUN-1', title: 'Something' });
  assert.match(bare, /unassigned\)\./);
  assert.match(bare, /Please pick an owner/);
  assert.doesNotMatch(bare, /Description/);
});
