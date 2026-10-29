'use strict';
/**
 * Devices, Task 5: the hook shim on a device. It reaches the floor over a
 * forwarded TCP port (HIVE_HOOK_PORT). When the floor is unreachable it keeps
 * quiet, then stops the turn after HIVE_OFFLINE_PAUSE_MIN minutes and marks
 * the agent paused. Run with node against dead and live ports.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};
const { HiveManager, HOOK_SHIM } = loadTs('src/main/hive.ts');
const { REMOTE_HOOK_COMMAND } = loadTs('src/main/deviceCommands.ts');

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-shim-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const shim = path.join(home, 'cth-hook.cjs');
  fs.writeFileSync(shim, HOOK_SHIM);
  const cache = path.join(home, '.cache', 'munder-difflin');
  return { home, shim, unreachable: path.join(cache, 'md-a1.unreachable'), paused: path.join(cache, 'md-a1.paused'), cache };
}

function runShim(s, env, args = []) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [s.shim, ...args], {
      env: { PATH: process.env.PATH, HOME: s.home, AGENT_ID: 'a1', ...env }
    });
    let stdout = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.on('close', (code) => resolve({ code, stdout }));
    p.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' }));
  });
}

async function deadPort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

function backdate(s, minutes) {
  fs.mkdirSync(s.cache, { recursive: true });
  fs.writeFileSync(s.unreachable, String(Date.now() - minutes * 60_000));
}

test('cut off: the first failure is recorded and the turn goes on', async (t) => {
  const s = setup(t);
  const r = await runShim(s, { HIVE_HOOK_PORT: String(await deadPort()), HIVE_OFFLINE_PAUSE_MIN: '10' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  const since = Number(fs.readFileSync(s.unreachable, 'utf8'));
  assert.ok(Math.abs(Date.now() - since) < 10_000);
  assert.equal(fs.existsSync(s.paused), false);
});

test('cut off past the limit: the turn stops and the agent is marked paused', async (t) => {
  const s = setup(t);
  backdate(s, 11);
  const r = await runShim(s, { HIVE_HOOK_PORT: String(await deadPort()), HIVE_OFFLINE_PAUSE_MIN: '10' });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), {
    continue: false,
    stopReason: 'Munder Difflin floor unreachable for 11 min; paused until the link is back.'
  });
  assert.ok(fs.existsSync(s.paused));
});

test('HIVE_OFFLINE_PAUSE_MIN=0 never pauses', async (t) => {
  const s = setup(t);
  backdate(s, 600);
  const r = await runShim(s, { HIVE_HOOK_PORT: String(await deadPort()), HIVE_OFFLINE_PAUSE_MIN: '0' });
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(s.paused), false);
});

test('a reachable floor clears the record and relays its reply', async (t) => {
  const s = setup(t);
  backdate(s, 3);
  const srv = net.createServer((c) => c.once('data', () => c.end('{"decision":"approve"}')));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const r = await runShim(s, { HIVE_HOOK_PORT: String(srv.address().port), HIVE_OFFLINE_PAUSE_MIN: '10' });
  assert.equal(r.stdout, '{"decision":"approve"}');
  assert.equal(fs.existsSync(s.unreachable), false);
});

test('socket mode (an agent on this laptop) never writes the pause files', async (t) => {
  const s = setup(t);
  const r = await runShim(s, { HIVE_SOCK: path.join(s.home, 'no-such.sock'), HIVE_OFFLINE_PAUSE_MIN: '10' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(s.cache), false);
});

test('the status line in port mode never pauses', async (t) => {
  const s = setup(t);
  backdate(s, 30);
  const r = await runShim(s, { HIVE_HOOK_PORT: String(await deadPort()), HIVE_OFFLINE_PAUSE_MIN: '10' }, ['--status']);
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes('continue'));
  assert.equal(fs.existsSync(s.paused), false);
});

test("a device agent's hooks and status line run the device's own copy of the shim", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-shim-settings-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent(
    { id: 'a1', name: 'A', provider: 'claude', cwd: home, device: 'my-lap' },
    { hookCommand: REMOTE_HOOK_COMMAND }
  );
  const settings = JSON.parse(fs.readFileSync(inj.args[inj.args.indexOf('--settings') + 1], 'utf8'));
  const commands = Object.values(settings.hooks).flatMap((ms) => ms.flatMap((m) => m.hooks.map((h) => h.command)));
  assert.ok(commands.length > 0);
  assert.ok(commands.every((c) => c === REMOTE_HOOK_COMMAND));
  assert.equal(settings.statusLine.command, `${REMOTE_HOOK_COMMAND} --status`);
});
