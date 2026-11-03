'use strict';
/**
 * Devices phase 2, item 8: the FloorSource the control page serves. Agent
 * status, open questions and mail come from the same state the floor
 * renders; answering a question writes the same task file the floor's Ask
 * Me does, and sends the same mail.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};
const { FloorActivity, createFloorSource, PAGE_MAIL_SUBJECT } = loadTs('src/main/remoteFloorSource.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { answerHumanQA, findRawTask } = loadTs('src/shared/workspace/inboxAsk.ts');

const NOW = new Date('2026-10-29T12:00:00.000Z');

function deps(over = {}) {
  const calls = [];
  const d = {
    registry: () => ({ godId: 'god', agents: {
      god: { name: 'Michael', isGod: true },
      pam: { name: 'Pam', role: 'worker', device: 'my-lap' },
      jim: { name: 'Jim' },
      old: { name: 'Old', archived: true }
    } }),
    tasks: () => ({ tasks: [{ id: 't1', title: 'Ship it', humanQA: [
      { q: 'Done one?', a: 'yes' }, { q: 'Which branch?', askedAt: '2026-10-29T10:00:00Z' }, { q: 'Skip?', dismissedAt: 'x' }
    ] }] }),
    patchTask: () => true,
    send: (msg, from) => { calls.push(['send', msg, from]); },
    messages: () => [
      { id: 'm1', from: 'human', to: 'pam', subject: 's', body: 'b', created_at: '2026-10-29T09:00:00Z' },
      { id: 'm1', from: 'human', to: 'pam', subject: 's', body: 'b', created_at: '2026-10-29T09:00:00Z' },
      { id: 'm2', from: 'pam', to: 'god', subject: 's', body: 'b', created_at: '2026-10-29T11:00:00Z' },
      { id: 'm3', from: 'pam', to: 'jim', subject: 's', body: 'b', created_at: '2026-10-29T11:30:00Z' }
    ],
    isGod: (id) => id === 'god',
    activity: (id) => (id === 'jim' ? 'needs-you' : 'working'),
    paused: () => false,
    deliveryPaused: (id) => id === 'pam',
    contextPct: () => 42,
    costToday: () => 1.25,
    devices: () => [{ id: 'my-lap', state: 'online' }],
    halt: (id) => calls.push(['halt', id]),
    restart: async (id) => { calls.push(['restart', id]); return { ok: true }; },
    setAutoDelivery: (id, p) => calls.push(['auto', id, p]),
    messageSent: () => calls.push(['counted']),
    now: () => NOW,
    ...over
  };
  return { d, calls };
}

test('state: live agents with status, device, context, cost and delivery', async () => {
  const { d } = deps();
  const s = await createFloorSource(d).state();
  assert.deepEqual(s.agents.map((a) => [a.id, a.status, a.device]), [['god', 'working', 'local'], ['pam', 'working', 'my-lap'], ['jim', 'needs-you', 'local']]);
  const pam = s.agents[1];
  assert.deepEqual([pam.role, pam.contextPct, pam.costTodayUsd, pam.deliveryPaused, pam.remoteControlUrl], ['worker', 42, 1.25, true, null]);
  assert.equal(s.agents[0].role, 'orchestrator');
  assert.deepEqual(s.devices, [{ id: 'my-lap', name: 'my-lap', state: 'online' }]);
});

test('status: paused beats a dropped device, which beats activity', async () => {
  const { d } = deps({ devices: () => [{ id: 'my-lap', state: 'offline' }], paused: (id) => id === 'god' });
  const s = await createFloorSource(d).state();
  assert.deepEqual(s.agents.map((a) => a.status), ['paused', 'offline', 'needs-you']);
});

test('questions: only open humanQA entries, with their index', async () => {
  const { d } = deps();
  assert.deepEqual((await createFloorSource(d).state()).questions,
    [{ taskId: 't1', taskTitle: 'Ship it', qIndex: 1, q: 'Which branch?', askedAt: '2026-10-29T10:00:00Z' }]);
});

test('mail: to or from the human or god, once each, newest first', async () => {
  const { d } = deps();
  assert.deepEqual((await createFloorSource(d).state()).mail.map((m) => m.id), ['m2', 'm1']);
});

function realHive(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-floor-src-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  hive.writeTasks([{ id: 't1', title: 'Ship it', status: 'blocked', humanQA: [{ q: 'Which branch?', askedAt: 'x', extra: 'kept' }] }]);
  return { hive, file: path.join(home, 'hive', 'tasks.json') };
}

test('answering from the page writes the same task file as the floor, and mails god', async (t) => {
  const page = realHive(t);
  const floor = realHive(t);
  const { d, calls } = deps({ tasks: () => page.hive.tasks(), patchTask: (id, p) => page.hive.patchTask(id, p) });
  assert.deepEqual(await createFloorSource(d).answerQuestion('t1', 0, '  main  '), { ok: true });
  // The floor's Ask Me path (workspace/inbox/actions.ts), on an identical hive.
  const raw = findRawTask(floor.hive.tasks(), 't1');
  floor.hive.patchTask('t1', { humanQA: answerHumanQA(raw.humanQA, 'Which branch?', 'main', NOW.toISOString()) });
  assert.equal(fs.readFileSync(page.file, 'utf8'), fs.readFileSync(floor.file, 'utf8'));
  const [, mail, from] = calls.find((c) => c[0] === 'send');
  assert.equal(from, 'human');
  assert.equal(mail.to, 'god');
  assert.match(mail.subject, /HUMAN ANSWER on task "Ship it"/);
});

test('a question no longer open is refused, and nothing is written', async (t) => {
  const page = realHive(t);
  const { d, calls } = deps({ tasks: () => page.hive.tasks(), patchTask: (id, p) => page.hive.patchTask(id, p) });
  const src = createFloorSource(d);
  await src.answerQuestion('t1', 0, 'main');
  assert.equal((await src.answerQuestion('t1', 0, 'again')).ok, false);
  assert.equal((await src.answerQuestion('t1', 5, 'x')).ok, false);
  assert.equal(calls.filter((c) => c[0] === 'send').length, 1);
});

test('actions route to the floor handlers and fire a change', async () => {
  const { d, calls } = deps();
  const src = createFloorSource(d);
  let changes = 0;
  src.onChange(() => { changes++; });
  assert.deepEqual(await src.sendMail('pam', ' hi '), { ok: true });
  assert.deepEqual(await src.stopAgent('pam'), { ok: true });
  assert.deepEqual(await src.restartAgent('pam'), { ok: true });
  assert.deepEqual(await src.setAutoDelivery('pam', true), { ok: true });
  assert.deepEqual(calls, [
    ['send', { to: 'pam', act: 'inform', subject: PAGE_MAIL_SUBJECT, body: 'hi' }, 'human'], ['counted'],
    ['halt', 'pam'], ['restart', 'pam'], ['auto', 'pam', true]
  ]);
  assert.equal(changes, 4);
  assert.equal((await src.stopAgent('old')).ok, false, 'archived');
  assert.equal((await src.sendMail('nobody', 'x')).ok, false);
  assert.equal((await src.sendMail('pam', '   ')).ok, false);
});

test('activity: a permission prompt is needs-you until the next turn event', () => {
  const a = new FloorActivity();
  assert.equal(a.get('pam'), 'idle');
  a.note('pam', 'PreToolUse', undefined);
  assert.equal(a.get('pam'), 'working');
  a.note('pam', 'Notification', 'Claude needs your permission to use Bash');
  assert.equal(a.get('pam'), 'needs-you');
  a.note('pam', 'PostToolUse', undefined);
  assert.equal(a.get('pam'), 'working');
  a.note('pam', 'Stop', undefined);
  assert.equal(a.get('pam'), 'idle');
});
