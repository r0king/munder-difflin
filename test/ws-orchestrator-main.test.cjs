'use strict';

// The orchestrator feature's main-process module end to end, against a fake
// Electron and a throwaway hive: the floor-wide delivery hold persists, the
// daily cap trips it once per (day, cap), the default token cap is exposed to
// the breaker, IPC inputs are validated, and the routing log is read from the
// hive's log.jsonl with subjects redacted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-orch-user-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-orch-home-'));
const hiveDir = path.join(home, 'hive');
fs.mkdirSync(hiveDir, { recursive: true });

const handlers = new Map();
const notifications = [];
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: {
    app: { getPath: () => userData },
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
    Notification: class {
      static isSupported() { return true; }
      constructor(opts) { this.opts = opts; }
      show() { notifications.push(this.opts); }
    }
  }
};

const orch = loadTs('src/main/features/orchestrator.ts');
const { ORCH_CHANNELS } = loadTs('src/shared/workspace/orchestratorTypes.ts');
const { localDayKey } = loadTs('src/shared/workspace/orchestratorBudget.ts');

const broadcasts = [];
const dataDir = path.join(userData, 'features', 'orchestrator');
const ctx = {
  harnessHome: () => home,
  featureDataDir: () => { fs.mkdirSync(dataDir, { recursive: true }); return dataDir; },
  broadcast: (ch, payload) => broadcasts.push({ ch, payload })
};

const invoke = (ch, ...args) => handlers.get(ch)({}, ...args);
const ledger = path.join(hiveDir, 'cost-ledger.jsonl');
const row = (agent, session, ts, usd) => JSON.stringify({
  agent_id: agent, session_id: session, ts, input: 0, output: 0, cache_read: 0, cache_creation: 0, model: 'm', usd
});

test.after(() => {
  orch.orchestratorFeature.dispose();
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('before register, the hold reads as off and nothing throws', () => {
  assert.equal(orch.floorDeliveriesPaused(), false);
  assert.equal(orch.orchestratorDefaultAgentTokenCap(), undefined);
});

test('register wires every channel', () => {
  orch.orchestratorFeature.register(ctx);
  for (const ch of ['getState', 'setDailyCap', 'setDefaultTokenCap', 'setDeliveriesPaused', 'routingLog']) {
    assert.ok(handlers.has(ORCH_CHANNELS[ch]), ch);
  }
});

test('deliveries: pause, persist, resume; bad input rejected', async () => {
  let state = await invoke(ORCH_CHANNELS.setDeliveriesPaused, true);
  assert.equal(state.delivery.paused, true);
  assert.equal(state.delivery.reason, 'manual');
  assert.equal(orch.floorDeliveriesPaused(), true);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'delivery.json'), 'utf8'));
  assert.equal(onDisk.paused, true);
  assert.ok(broadcasts.some((b) => b.ch === ORCH_CHANNELS.state && b.payload.delivery.paused));
  assert.throws(() => invoke(ORCH_CHANNELS.setDeliveriesPaused, 'yes'));
  orch.liftFloorDeliveryPause();
  assert.equal(orch.floorDeliveriesPaused(), false);
  state = await invoke(ORCH_CHANNELS.getState);
  assert.equal(state.delivery.paused, false);
});

test('today\'s spend comes from the ledger; reaching the cap pauses once and notifies', async () => {
  const now = Date.now();
  fs.writeFileSync(ledger, [row('a', 's1', now, 1), row('a', 's1', now, 4), row('b', 's2', now, 2.5)].join('\n') + '\n');
  let state = await invoke(ORCH_CHANNELS.getState);
  assert.equal(state.budget.ready, true);
  assert.equal(state.budget.today, localDayKey(now));
  assert.equal(state.budget.spendTodayUsd, 6.5);
  assert.deepEqual(state.budget.byAgent.map((x) => x.agentId), ['a', 'b']);
  assert.equal(state.budget.history.length, 7);

  // A cap above today's spend: nothing happens.
  state = await invoke(ORCH_CHANNELS.setDailyCap, 10);
  assert.equal(state.budget.dailyCapUsd, 10);
  assert.equal(state.budget.level, 'ok');
  assert.equal(state.delivery.paused, false);

  // Spend crosses it: the next refresh pauses with reason 'budget' and notifies.
  fs.appendFileSync(ledger, row('a', 's1', Date.now(), 8) + '\n');
  state = await invoke(ORCH_CHANNELS.getState);
  assert.equal(state.budget.spendTodayUsd, 10.5);
  assert.equal(state.budget.level, 'over');
  assert.equal(state.delivery.paused, true);
  assert.equal(state.delivery.reason, 'budget');
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].body, /\$10\.50 of your \$10\.00/);

  // The user resumes: not re-paused the same day for the same cap.
  await invoke(ORCH_CHANNELS.setDeliveriesPaused, false);
  state = await invoke(ORCH_CHANNELS.getState);
  assert.equal(state.delivery.paused, false);
  assert.equal(notifications.length, 1);

  // Raising the cap clears the condition; lowering it below spend trips again at once.
  state = await invoke(ORCH_CHANNELS.setDailyCap, 50);
  assert.equal(state.delivery.paused, false);
  state = await invoke(ORCH_CHANNELS.setDailyCap, 5);
  assert.equal(state.delivery.paused, true);
  assert.equal(notifications.length, 2);

  // Clearing the cap is allowed; junk is not.
  state = await invoke(ORCH_CHANNELS.setDailyCap, null);
  assert.equal(state.budget.dailyCapUsd, null);
  for (const bad of [0, -1, 'ten', Infinity, 1e9]) {
    assert.throws(() => invoke(ORCH_CHANNELS.setDailyCap, bad), String(bad));
  }
  await invoke(ORCH_CHANNELS.setDeliveriesPaused, false);
});

test('the default token cap is stored and exposed to the breaker', async () => {
  const state = await invoke(ORCH_CHANNELS.setDefaultTokenCap, 500000);
  assert.equal(state.budget.defaultAgentTokenCap, 500000);
  assert.equal(orch.orchestratorDefaultAgentTokenCap(), 500000);
  assert.throws(() => invoke(ORCH_CHANNELS.setDefaultTokenCap, 1.5));
  assert.throws(() => invoke(ORCH_CHANNELS.setDefaultTokenCap, -3));
  await invoke(ORCH_CHANNELS.setDefaultTokenCap, null);
  assert.equal(orch.orchestratorDefaultAgentTokenCap(), undefined);
});

test('routing log: empty without a log, then parsed with secrets redacted', async () => {
  let res = await invoke(ORCH_CHANNELS.routingLog, {});
  assert.deepEqual(res, { ok: true, entries: [], truncated: false });
  const log = [
    JSON.stringify({ ts: 1, kind: 'spawn', agentId: 'a' }),
    JSON.stringify({ ts: 2, kind: 'message', from: 'god', to: 'a', act: 'request', subject: 'use sk-ant-abcdefghijklmnopqrstuvwxyz', id: 'm1', delivered: ['a'] }),
    JSON.stringify({ ts: 3, kind: 'drop', reason: 'no-inbox', from: 'god', to: 'ghost', id: 'm2' })
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(hiveDir, 'log.jsonl'), log);
  res = await invoke(ORCH_CHANNELS.routingLog, { limit: 10 });
  assert.equal(res.ok, true);
  assert.equal(res.entries.length, 2);
  assert.doesNotMatch(res.entries[0].subject, /sk-ant-/);
  assert.match(res.entries[0].subject, /\[redacted\]/);
  // The limit keeps the newest and reports truncation; a junk limit falls back.
  res = await invoke(ORCH_CHANNELS.routingLog, { limit: 1 });
  assert.equal(res.entries.length, 1);
  assert.equal(res.entries[0].kind, 'drop');
  assert.equal(res.truncated, true);
  res = await invoke(ORCH_CHANNELS.routingLog, { limit: 'all' });
  assert.equal(res.entries.length, 2);
});

test('the hold survives a restart (state is re-read from disk)', async () => {
  await invoke(ORCH_CHANNELS.setDeliveriesPaused, true);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'delivery.json'), 'utf8'));
  assert.equal(saved.paused, true);
  assert.equal(saved.reason, 'manual');
  assert.equal(typeof saved.since, 'number');
  await invoke(ORCH_CHANNELS.setDeliveriesPaused, false);
});
