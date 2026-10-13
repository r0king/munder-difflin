'use strict';

// The local-day arithmetic is what this file is about, so it pins a zone with a
// DST switch. Node re-reads TZ when it is assigned, before any Date is built.
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  parseLedgerLine,
  localDayKey,
  localDayBounds,
  shiftDayKey,
  DailySpendFold,
  dailySpendFromLedger,
  evaluateCap,
  shouldTripCap,
  parseCapInput,
  parseTokenInput,
  sanitizeCap,
  MAX_DAILY_CAP_USD,
  AGENT_BREAKDOWN_DAYS
} = loadTs('src/shared/workspace/orchestratorBudget.ts');

/** Local wall-clock time in the pinned zone → epoch ms. */
const at = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

/** One ledger line in the exact shape hive.appendCostLedger writes. */
function line(agent, session, ts, usd) {
  return JSON.stringify({
    agent_id: agent, session_id: session, ts,
    input: 0, output: 0, cache_read: 0, cache_creation: 0, model: 'claude-opus-4-8', usd
  });
}

const near = (a, b) => Math.abs(a - b) < 1e-9;

test('parseLedgerLine: accepts a real row, rejects torn and foreign lines', () => {
  assert.deepEqual(parseLedgerLine(line('a', 's', 1000, 1.5)), { agentId: 'a', sessionId: 's', ts: 1000, usd: 1.5 });
  assert.equal(parseLedgerLine('{"agent_id":"a","ts":10'), null); // torn tail
  assert.equal(parseLedgerLine(''), null);
  assert.equal(parseLedgerLine('[]'), null);
  assert.equal(parseLedgerLine(JSON.stringify({ ts: 5, usd: 1 })), null); // no agent
  assert.equal(parseLedgerLine(JSON.stringify({ agent_id: 'a', usd: 1 })), null); // no ts
  // A null session id and a bad usd still parse; usd falls back to 0.
  assert.deepEqual(
    parseLedgerLine(JSON.stringify({ agent_id: 'a', session_id: null, ts: 7, usd: 'x' })),
    { agentId: 'a', sessionId: '', ts: 7, usd: 0 }
  );
});

test('localDayKey uses the local calendar day, not UTC', () => {
  // 23:30 local on 9 Mar is already 10 Mar in UTC.
  assert.equal(localDayKey(at(2026, 3, 9, 23, 30)), '2026-03-09');
  assert.equal(localDayKey(at(2026, 3, 10, 0, 0)), '2026-03-10');
});

test('localDayBounds: a spring-forward day is 23 hours, a fall-back day 25', () => {
  const spring = localDayBounds(at(2026, 3, 8, 15));
  assert.equal((spring.end - spring.start) / 3_600_000, 23);
  assert.equal(localDayKey(spring.start), '2026-03-08');
  assert.equal(localDayKey(spring.end), '2026-03-09');
  const fall = localDayBounds(at(2026, 11, 1, 9));
  assert.equal((fall.end - fall.start) / 3_600_000, 25);
  const plain = localDayBounds(at(2026, 6, 15, 9));
  assert.equal((plain.end - plain.start) / 3_600_000, 24);
});

test('shiftDayKey crosses month, year and DST boundaries', () => {
  assert.equal(shiftDayKey('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDayKey('2025-12-31', 1), '2026-01-01');
  assert.equal(shiftDayKey('2026-03-09', -1), '2026-03-08');
  assert.equal(shiftDayKey('2026-11-01', 1), '2026-11-02');
  assert.equal(shiftDayKey('not-a-day', 3), 'not-a-day');
});

test('today\'s spend is the growth of each cumulative counter, not the sum of rows', () => {
  const fold = dailySpendFromLedger([
    line('a', 's1', at(2026, 6, 15, 9), 1),
    line('a', 's1', at(2026, 6, 15, 10), 3),
    line('a', 's1', at(2026, 6, 15, 11), 3), // idle beat: no growth
    line('b', 's2', at(2026, 6, 15, 11), 0.5)
  ].join('\n'));
  assert.ok(near(fold.spendOn('2026-06-15'), 3.5));
  assert.deepEqual(fold.agentSpendOn('2026-06-15').map((r) => r.agentId), ['a', 'b']);
});

test('a session spanning midnight books each side to its own day', () => {
  const fold = dailySpendFromLedger([
    line('a', 's1', at(2026, 6, 14, 22), 2),
    line('a', 's1', at(2026, 6, 14, 23, 59), 5),
    line('a', 's1', at(2026, 6, 15, 0, 1), 6),
    line('a', 's1', at(2026, 6, 15, 8), 9)
  ].join('\n'));
  assert.ok(near(fold.spendOn('2026-06-14'), 5));
  assert.ok(near(fold.spendOn('2026-06-15'), 4));
});

test('an app restart (counter drops) counts the new climb, not a negative', () => {
  const fold = dailySpendFromLedger([
    line('a', 's1', at(2026, 6, 15, 9), 8),
    line('a', 's1', at(2026, 6, 15, 10), 0.2), // restarted at ~0, climbed to 0.2
    line('a', 's1', at(2026, 6, 15, 11), 1.2)
  ].join('\n'));
  assert.ok(near(fold.spendOn('2026-06-15'), 8 + 0.2 + 1));
});

test('DST: spend on the 23-hour and 25-hour days lands on the right day', () => {
  const fold = dailySpendFromLedger([
    line('a', 's', at(2026, 3, 7, 23, 50), 1),
    line('a', 's', at(2026, 3, 8, 1, 50), 2),   // just before the 2:00 jump
    line('a', 's', at(2026, 3, 8, 3, 10), 3),   // just after it
    line('a', 's', at(2026, 3, 8, 23, 50), 4),
    line('a', 's', at(2026, 3, 9, 0, 10), 5),
    // Fall back: 1:30 happens twice; both belong to 1 Nov.
    line('b', 't', new Date('2026-11-01T05:30:00Z').getTime(), 1), // 01:30 EDT
    line('b', 't', new Date('2026-11-01T06:30:00Z').getTime(), 2), // 01:30 EST
    line('b', 't', new Date('2026-11-02T04:30:00Z').getTime(), 3), // 23:30 EST
    line('b', 't', new Date('2026-11-02T05:30:00Z').getTime(), 4)  // 00:30 EST, 2 Nov
  ].join('\n'));
  assert.ok(near(fold.spendOn('2026-03-07'), 1));
  assert.ok(near(fold.spendOn('2026-03-08'), 3));
  assert.ok(near(fold.spendOn('2026-03-09'), 1));
  assert.ok(near(fold.spendOn('2026-11-01'), 3));
  assert.ok(near(fold.spendOn('2026-11-02'), 1));
});

test('history gives n days ending today, zero-filled, oldest first', () => {
  const fold = dailySpendFromLedger([
    line('a', 's', at(2026, 6, 13, 9), 2),
    line('a', 's', at(2026, 6, 15, 9), 5)
  ].join('\n'));
  assert.deepEqual(fold.history('2026-06-15', 4), [
    { day: '2026-06-12', usd: 0 },
    { day: '2026-06-13', usd: 2 },
    { day: '2026-06-14', usd: 0 },
    { day: '2026-06-15', usd: 3 }
  ]);
});

test('folding in chunks equals folding at once; torn and blank lines are skipped', () => {
  const rows = [];
  for (let i = 0; i < 50; i++) rows.push(line(i % 3 === 0 ? 'a' : 'b', `s${i % 2}`, at(2026, 6, 15, 1 + (i % 20)), i * 0.1));
  const whole = dailySpendFromLedger(rows.join('\n'));
  const parts = new DailySpendFold();
  parts.addText(rows.slice(0, 20).join('\n'));
  parts.addText('{"torn":');
  parts.addText('');
  parts.addText(rows.slice(20).join('\n'));
  assert.ok(near(parts.spendOn('2026-06-15'), whole.spendOn('2026-06-15')));
});

test('the per-agent split is pruned to the recent window, the floor total is kept', () => {
  const fold = new DailySpendFold();
  const days = AGENT_BREAKDOWN_DAYS + 10;
  for (let i = 0; i < days; i++) {
    fold.add({ agentId: 'a', sessionId: `s${i}`, ts: at(2026, 1, 1 + i, 9), usd: 1 });
  }
  assert.equal(fold.agentSpendOn('2026-01-01').length, 0);
  assert.ok(near(fold.spendOn('2026-01-01'), 1));
  const last = localDayKey(at(2026, 1, days, 9));
  assert.equal(fold.agentSpendOn(last).length, 1);
});

test('evaluateCap: none, ok, near, over (reaching the cap counts as over)', () => {
  assert.deepEqual(evaluateCap(5, null), { level: 'none', fraction: 0, remainingUsd: null });
  assert.equal(evaluateCap(5, 0).level, 'none');
  assert.equal(evaluateCap(5, -1).level, 'none');
  assert.equal(evaluateCap(4.2, 10).level, 'ok');
  assert.equal(evaluateCap(8, 10).level, 'near');
  assert.equal(evaluateCap(10, 10).level, 'over');
  assert.equal(evaluateCap(12.5, 10).level, 'over');
  assert.ok(near(evaluateCap(12.5, 10).fraction, 1.25));
  assert.equal(evaluateCap(12.5, 10).remainingUsd, 0);
  assert.ok(near(evaluateCap(4.2, 10).remainingUsd, 5.8));
  assert.equal(evaluateCap(NaN, 10).level, 'ok');
});

test('shouldTripCap: once per day and cap value', () => {
  const base = { dayKey: '2026-06-15', spendUsd: 11, capUsd: 10 };
  assert.equal(shouldTripCap({ ...base, lastTrip: null }), true);
  assert.equal(shouldTripCap({ ...base, lastTrip: { day: '2026-06-15', capUsd: 10 } }), false);
  // Raised the cap and crossed it again → trip again.
  assert.equal(shouldTripCap({ ...base, spendUsd: 21, capUsd: 20, lastTrip: { day: '2026-06-15', capUsd: 10 } }), true);
  // A new day → trip again.
  assert.equal(shouldTripCap({ ...base, dayKey: '2026-06-16', lastTrip: { day: '2026-06-15', capUsd: 10 } }), true);
  // Under the cap or no cap → never.
  assert.equal(shouldTripCap({ ...base, spendUsd: 9, lastTrip: null }), false);
  assert.equal(shouldTripCap({ ...base, capUsd: null, lastTrip: null }), false);
});

test('parseCapInput accepts what people type and rejects the rest', () => {
  assert.equal(parseCapInput('10'), 10);
  assert.equal(parseCapInput(' $12.5 '), 12.5);
  assert.equal(parseCapInput('1,250.00'), 1250);
  assert.equal(parseCapInput('3.456'), 3.46);
  assert.equal(parseCapInput(''), null);
  assert.equal(parseCapInput('   '), null);
  for (const bad of ['0', '-5', 'abc', '1e3', '10$', String(MAX_DAILY_CAP_USD + 1), '.5']) {
    assert.equal(parseCapInput(bad), 'invalid', bad);
  }
});

test('sanitizeCap validates what crosses IPC', () => {
  assert.equal(sanitizeCap(null), null);
  assert.equal(sanitizeCap(10.004), 10);
  assert.equal(sanitizeCap(0), undefined);
  assert.equal(sanitizeCap(-1), undefined);
  assert.equal(sanitizeCap(Infinity), undefined);
  assert.equal(sanitizeCap('10'), undefined);
  assert.equal(sanitizeCap(MAX_DAILY_CAP_USD + 1), undefined);
});

test('parseTokenInput reads plain, grouped and suffixed counts', () => {
  const max = 10_000_000_000;
  assert.equal(parseTokenInput('500000', max), 500000);
  assert.equal(parseTokenInput('1,000,000', max), 1_000_000);
  assert.equal(parseTokenInput('500k', max), 500_000);
  assert.equal(parseTokenInput(' 1.5M ', max), 1_500_000);
  assert.equal(parseTokenInput('2b', max), 2_000_000_000);
  assert.equal(parseTokenInput('', max), null);
  for (const bad of ['0', '-5', 'lots', '1.5x', '11b', '0k']) {
    assert.equal(parseTokenInput(bad, max), 'invalid', bad);
  }
});
