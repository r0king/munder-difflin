'use strict';

// Workspace Tasks — the main-process activity tracker's fold. It decides when
// a card "last changed" (stale chips) and when it entered its column (done
// cards leaving the Board). Every rule leans toward NOT calling a card stale.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const a = loadTs('src/shared/workspace/tasksActivity.ts');

const HOUR = 3600_000;
const T0 = Date.parse('2026-10-12T08:00:00Z');

test('fingerprints ignore key order and see every field', () => {
  assert.equal(a.fingerprintCard({ id: 'x', status: 'doing' }), a.fingerprintCard({ status: 'doing', id: 'x' }));
  assert.notEqual(a.fingerprintCard({ id: 'x', status: 'doing' }), a.fingerprintCard({ id: 'x', status: 'done' }));
  assert.notEqual(
    a.fingerprintCard({ id: 'x', humanQA: [{ q: '?' }] }),
    a.fingerprintCard({ id: 'x', humanQA: [{ q: '?', a: 'yes' }] })
  );
});

test('first look: changed at the explicit stamp, else the file mtime', () => {
  const mtime = T0 - 2 * HOUR;
  const ledger = {
    tasks: [
      { id: 'plain', status: 'doing', createdAt: '2026-10-01T00:00:00Z' },
      { id: 'stamped', status: 'doing', updatedAt: new Date(T0 - 5 * HOUR).toISOString() },
      { id: 'done', status: 'done', createdAt: '2026-10-01T00:00:00Z' }
    ]
  };
  const { state, changed } = a.observeLedger(null, ledger, T0, mtime);
  assert.equal(changed, true);
  assert.equal(state.seenAt, T0);
  // No stamp: the latest it could have changed is when the file did.
  assert.equal(state.cards.plain.changedAt, mtime);
  assert.equal(state.cards.stamped.changedAt, T0 - 5 * HOUR);
  // Its column-entry time leans early (only used to move done cards off the Board).
  assert.equal(state.cards.done.statusSince, Date.parse('2026-10-01T00:00:00Z'));
  assert.equal(state.cards.plain.observed, false, 'a bound, not a sighting');
  assert.equal(state.cards.stamped.observed, true);
  // A future mtime (clock skew) never yields a future change.
  const skew = a.observeLedger(null, ledger, T0, T0 + HOUR).state;
  assert.equal(skew.cards.plain.changedAt, T0);
});

test('an unchanged card keeps its record; a changed one is credited to now', () => {
  const first = a.observeLedger(null, { tasks: [{ id: 'x', status: 'todo' }, { id: 'y', status: 'doing' }] }, T0, T0 - HOUR).state;
  const later = T0 + 3 * HOUR;
  const { state, changed } = a.observeLedger(first, { tasks: [{ id: 'x', status: 'todo' }, { id: 'y', status: 'done' }] }, later, later);
  assert.equal(changed, true);
  assert.deepEqual(state.cards.x, first.cards.x, 'untouched card is byte-identical');
  assert.equal(state.cards.y.changedAt, later);
  assert.equal(state.cards.y.statusSince, later, 'column change restarts statusSince');
  assert.equal(state.cards.y.column, 'done');
  assert.equal(state.cards.y.observed, true);
});

test('a content edit without a column change keeps statusSince', () => {
  const first = a.observeLedger(null, [{ id: 'x', status: 'doing', description: 'a' }], T0, T0).state;
  const later = T0 + HOUR;
  const next = a.observeLedger(first, [{ id: 'x', status: 'doing', description: 'b' }], later, later).state;
  assert.equal(next.cards.x.changedAt, later);
  assert.equal(next.cards.x.statusSince, first.cards.x.statusSince);
});

test('an explicit stamp newer than what we had is believed over "now"', () => {
  const first = a.observeLedger(null, [{ id: 'x', status: 'doing' }], T0, T0).state;
  const later = T0 + 5 * HOUR;
  const stamp = T0 + 2 * HOUR;
  const next = a.observeLedger(first, [{ id: 'x', status: 'blocked', updatedAt: new Date(stamp).toISOString() }], later, later).state;
  assert.equal(next.cards.x.changedAt, stamp);
  assert.equal(next.cards.x.statusSince, stamp);
});

test('a card new since the last look is fresh now, not stale on a guess', () => {
  const first = a.observeLedger(null, [{ id: 'x', status: 'todo' }], T0, T0).state;
  const later = T0 + 48 * HOUR;
  const created = new Date(T0 + 30 * HOUR).toISOString();
  const next = a.observeLedger(first, [{ id: 'x', status: 'todo' }, { id: 'n', status: 'done', createdAt: created }], later, later).state;
  assert.equal(next.cards.n.changedAt, later);
  // ...but it was created after our last look, so its column-entry is at least that.
  assert.equal(next.cards.n.statusSince, Date.parse(created));
});

test('a card gone from the ledger is dropped, and that counts as a change', () => {
  const first = a.observeLedger(null, [{ id: 'x' }, { id: 'y' }], T0, T0).state;
  const { state, changed } = a.observeLedger(first, [{ id: 'x' }], T0 + 1, T0 + 1);
  assert.equal(changed, true);
  assert.deepEqual(Object.keys(state.cards), ['x']);
  const same = a.observeLedger(state, [{ id: 'x' }], T0 + 2, T0 + 2);
  assert.equal(same.changed, false, 'nothing to persist when nothing moved');
});

test('the renderer map and the on-disk round trip', () => {
  const { state } = a.observeLedger(null, [{ id: 'x', status: 'doing' }], T0, T0);
  // A first-look bound is flagged, so the date filters do not read it as a change.
  assert.deepEqual(a.activityMap(state), { x: { changedAt: T0, statusSince: T0, observed: false } });
  const seen = a.observeLedger(state, [{ id: 'x', status: 'done' }], T0 + 5, T0 + 5).state;
  assert.deepEqual(a.activityMap(seen), { x: { changedAt: T0 + 5, statusSince: T0 + 5 } });
  assert.deepEqual(a.parseActivityState(JSON.parse(JSON.stringify(state))), state);
  assert.equal(a.parseActivityState({ v: 2, seenAt: 1, cards: {} }), null);
  assert.equal(a.parseActivityState('nope'), null);
  const partial = a.parseActivityState({ v: 1, seenAt: 5, cards: { ok: { fp: 'f', column: 'done', changedAt: 1, statusSince: 1 }, bad: { fp: 3 } } });
  assert.deepEqual(Object.keys(partial.cards), ['ok']);
});
