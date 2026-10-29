'use strict';
/**
 * Devices, Task 11: god. A spawn request may name a device. An unknown or
 * offline one fails into .failed with a reason god can read. god's prompt
 * names the devices and says heavy work belongs there.
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
const { HiveManager } = loadTs('src/main/hive.ts');
const { validateSpawnDevice } = loadTs('src/main/deviceCommands.ts');

test('spawn-request device: default this laptop; unknown or offline fails with the reason', () => {
  const states = { 'my-lap': 'online', 'big-box': 'offline', mid: 'connecting' };
  assert.deepEqual(validateSpawnDevice(undefined, states), {});
  assert.deepEqual(validateSpawnDevice('', states), {});
  assert.deepEqual(validateSpawnDevice('local', states), {});
  assert.deepEqual(validateSpawnDevice('my-lap', states), { device: 'my-lap' });
  assert.deepEqual(validateSpawnDevice('nope', states), { error: 'unknown device "nope"' });
  // Object.prototype keys are not devices.
  assert.deepEqual(validateSpawnDevice('constructor', states), { error: 'unknown device "constructor"' });
  assert.deepEqual(validateSpawnDevice('big-box', states), { error: 'device "big-box" is offline' });
  assert.deepEqual(validateSpawnDevice('mid', states), { error: 'device "mid" is connecting' });
  assert.deepEqual(validateSpawnDevice(7, states), { error: '"device" must be a device id' });
});

async function godPrompt(t, deviceIds) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-god-devices-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.setOrchestratorMaySpawn(true);
  hive.setDeviceIds(deviceIds);
  const inj = await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  return inj.args[inj.args.indexOf('--append-system-prompt') + 1];
}

test("god's prompt names the devices and says heavy work belongs there", async (t) => {
  const p = await godPrompt(t, ['my-lap']);
  assert.ok(p.includes('heavy work (type-checks, suites, builds) is best placed on a device'));
  assert.ok(p.includes('`device` (my-lap)'));
  // teardownPty keeps a device worker's worktree, so god must know to clean it up.
  assert.ok(p.includes("a device worker's worktree is kept"));
});

test('no devices, no device line', async (t) => {
  assert.ok(!(await godPrompt(t, [])).includes('best placed on a device'));
});

test('teardownAndQuit runs once: its first statement is the quitting guard', () => {
  // It awaits each device's remote kill-server (up to 3 s), and closing the last
  // window or a closing-time conclusion can re-enter it during that wait.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
  assert.match(src, /^let quitting = false;$/m);
  const start = src.indexOf('async function teardownAndQuit(): Promise<void> {');
  assert.ok(start >= 0, 'teardownAndQuit exists');
  const body = src.slice(src.indexOf('{', start) + 1).trimStart();
  assert.ok(body.startsWith('if (quitting) return;\n  quitting = true;'), `first statement is the guard, got: ${body.slice(0, 80)}`);
});
