'use strict';

// Workspace sidebar ordering: the saved "Keep my agent order" list reconciled
// with who is actually on the floor, and the automatic order (needs-you first,
// then working, then idle) with its hysteresis so rows do not hop around.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  reconcileOrder,
  moveItem,
  nudgeItem,
  placeRelative,
  applyGroupOrder,
  mergeSavedOrder,
  isIdList,
  statusRank,
  settleRanks,
  nextSettleAt,
  autoOrder,
  autoGroupOrder,
  MAX_SAVED_ORDER
} = loadTs('src/shared/workspace/sidebarOrder.ts');

test('reconcile: saved order first, newcomers after in roster order, the absent skipped', () => {
  assert.deepEqual(reconcileOrder(['c', 'gone', 'a'], ['a', 'b', 'c', 'd']), ['c', 'a', 'b', 'd']);
  assert.deepEqual(reconcileOrder(null, ['a', 'b']), ['a', 'b']);
  assert.deepEqual(reconcileOrder(['a', 'a', 'b'], ['b', 'a']), ['a', 'b']);
});

test('moveItem / nudgeItem clamp at the ends', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 'a', 2), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 'c', -5), ['c', 'a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 'zzz', 0), ['a', 'b']);
  assert.deepEqual(nudgeItem(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(nudgeItem(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(nudgeItem(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c']);
});

test('placeRelative drops before or after the target row', () => {
  assert.deepEqual(placeRelative(['a', 'b', 'c', 'd'], 'a', 'c', 'after'), ['b', 'c', 'a', 'd']);
  assert.deepEqual(placeRelative(['a', 'b', 'c', 'd'], 'd', 'b', 'before'), ['a', 'd', 'b', 'c']);
  assert.deepEqual(placeRelative(['a', 'b'], 'a', 'a', 'after'), ['a', 'b']);
});

test('applyGroupOrder re-sequences one group inside the flat list and leaves the rest', () => {
  // Group {b, d} reordered to [d, b]; a, c and the absent x keep their slots.
  assert.deepEqual(applyGroupOrder(['a', 'b', 'x', 'c', 'd'], ['d', 'b']), ['a', 'd', 'x', 'c', 'b']);
  // A member the flat list never saw is appended.
  assert.deepEqual(applyGroupOrder(['a', 'b'], ['b', 'n']), ['a', 'b', 'n']);
});

test('mergeSavedOrder keeps an absent agent\'s slot for when it comes back', () => {
  const saved = ['a', 'pam', 'b', 'c'];
  // pam is closed today; the user swaps b and c.
  const next = mergeSavedOrder(saved, ['a', 'c', 'b']);
  assert.deepEqual(next, ['a', 'pam', 'c', 'b']);
  // pam is restored tomorrow and lands where she was.
  assert.deepEqual(reconcileOrder(next, ['a', 'b', 'c', 'pam']), ['a', 'pam', 'c', 'b']);
});

test('mergeSavedOrder appends ids the saved list never had and never duplicates', () => {
  assert.deepEqual(mergeSavedOrder(['a', 'b'], ['b', 'a', 'new']), ['b', 'a', 'new']);
  assert.deepEqual(mergeSavedOrder([], ['x', 'y']), ['x', 'y']);
  const out = mergeSavedOrder(['a', 'b', 'c'], ['c', 'a', 'b']);
  assert.deepEqual(out, ['c', 'a', 'b']);
  assert.equal(new Set(out).size, out.length);
});

test('mergeSavedOrder is bounded: absent ids are shed, present ones never', () => {
  const absent = Array.from({ length: MAX_SAVED_ORDER + 50 }, (_, i) => `gone-${i}`);
  const out = mergeSavedOrder(['a', ...absent, 'b'], ['b', 'a']);
  assert.ok(out.length <= MAX_SAVED_ORDER);
  assert.ok(out.includes('a') && out.includes('b'));
  assert.ok(out.indexOf('b') < out.indexOf('a'));
});

test('isIdList rejects anything that is not a list of short strings', () => {
  assert.equal(isIdList(['a', 'b']), true);
  assert.equal(isIdList('a'), false);
  assert.equal(isIdList([1]), false);
  assert.equal(isIdList(['']), false);
  assert.equal(isIdList(['x'.repeat(600)]), false);
});

test('statusRank: needs-you (or an open question) leads, offline trails', () => {
  assert.equal(statusRank('needs-you'), 0);
  assert.equal(statusRank('idle', true), 0);
  assert.ok(statusRank('looping') < statusRank('working'));
  assert.equal(statusRank('working'), statusRank('thinking'));
  assert.ok(statusRank('working') < statusRank('waiting'));
  assert.ok(statusRank('waiting') < statusRank('idle'));
  assert.ok(statusRank('idle') < statusRank('offline'));
});

test('autoOrder is stable: equal ranks keep roster order', () => {
  const rank = { a: 4, b: 2, c: 4, d: 0, e: 2 };
  assert.deepEqual(autoOrder(['a', 'b', 'c', 'd', 'e'], (id) => rank[id]), ['d', 'b', 'e', 'a', 'c']);
});

test('settleRanks: promotions apply at once, demotions only after the hold', () => {
  const HOLD = 8000;
  let s = settleRanks({}, { a: 2 }, 0, HOLD);
  assert.equal(s.a.rank, 2);
  // a goes idle between tool calls: held at working.
  s = settleRanks(s, { a: 4 }, 1000, HOLD);
  assert.equal(s.a.rank, 2);
  assert.equal(nextSettleAt(s, HOLD), 9000);
  // ...and starts working again before the hold ends: never moved.
  s = settleRanks(s, { a: 2 }, 3000, HOLD);
  assert.deepEqual(s.a, { rank: 2 });
  // Truly idle now: the demotion applies once it has held.
  s = settleRanks(s, { a: 4 }, 4000, HOLD);
  s = settleRanks(s, { a: 4 }, 11_000, HOLD);
  assert.equal(s.a.rank, 2);
  s = settleRanks(s, { a: 4 }, 12_000, HOLD);
  assert.deepEqual(s.a, { rank: 4 });
  // A question jumps straight to the top.
  s = settleRanks(s, { a: 0 }, 12_001, HOLD);
  assert.deepEqual(s.a, { rank: 0 });
  // Agents that left are dropped.
  assert.deepEqual(Object.keys(settleRanks(s, {}, 12_002, HOLD)), []);
});

test('autoGroupOrder: the group with the most urgent member first, calm groups alphabetical', () => {
  const groups = [
    { key: 'path:/r/web', name: 'web', best: 4 },
    { key: 'path:/r/api', name: 'api', best: 4 },
    { key: 'path:/r/app', name: 'App', best: 0 }
  ];
  assert.deepEqual(autoGroupOrder(groups, (g) => g.best).map((g) => g.name), ['App', 'api', 'web']);
});
