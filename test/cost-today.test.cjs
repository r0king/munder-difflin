'use strict';
/**
 * Devices phase 2, item 8: the control page shows each agent's spend today.
 * Ledger rows are cumulative per (agent, session) and reset when the app
 * restarts, so "today" is the session's climb since its last row before
 * local midnight, summed over sessions, counting each reset segment.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { CostLedgerTotals } = loadTs('src/main/costLifetime.ts');

const at = (d, h) => new Date(2026, 9, d, h).getTime(); // local time, October 2026
const NOW = at(29, 18);
const row = (agent, session, usd, ts) => JSON.stringify({
  agent_id: agent, session_id: session, ts, input: 0, output: 0, cache_read: 0, cache_creation: 0, model: '', usd
});

async function today(t, lines, agent = 'a') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cost-today-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'cost-ledger.jsonl');
  fs.writeFileSync(p, lines.length ? `${lines.join('\n')}\n` : '');
  const c = new CostLedgerTotals();
  await c.refreshFully(p);
  return c.usdTodayFor(agent, NOW);
}

test('yesterday\'s spend is not today\'s', async (t) => {
  assert.equal(await today(t, [row('a', 's1', 1.0, at(28, 20)), row('a', 's1', 1.5, at(29, 9)), row('a', 's1', 2.0, at(29, 10))]), 1.0);
});

test('a session that started today counts in full', async (t) => {
  assert.equal(await today(t, [row('a', 's1', 0.3, at(29, 9)), row('a', 's1', 0.7, at(29, 11))]), 0.7);
});

test('a counter reset today still counts both halves', async (t) => {
  // 1.0 by last night; +0.5 this morning; app restart (counter back to 0); +0.5 more.
  const v = await today(t, [
    row('a', 's1', 1.0, at(28, 20)), row('a', 's1', 1.5, at(29, 9)),
    row('a', 's1', 0.2, at(29, 12)), row('a', 's1', 0.5, at(29, 13))
  ]);
  assert.ok(Math.abs(v - 1.0) < 1e-9, String(v));
});

test('several sessions add up; other agents and idle sessions do not', async (t) => {
  assert.equal(await today(t, [
    row('a', 's1', 0.4, at(29, 9)), row('a', 's2', 0.6, at(29, 10)),
    row('b', 's3', 9.0, at(29, 10)), row('a', 's0', 5.0, at(27, 10))
  ]), 1.0);
});

test('null until the ledger has been read', () => {
  assert.equal(new CostLedgerTotals().usdTodayFor('a', NOW), null);
});
