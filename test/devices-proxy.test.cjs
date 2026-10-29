'use strict';
/**
 * Devices phase 2, item 5, proxy tier: qwen and crush talk to a sidecar on
 * THIS laptop, whose port is forwarded to the device's loopback at base+3,
 * base+4, … A reconnect re-adds the forwards. Engines whose usage comes from
 * files on this laptop say so instead of showing a wrong zero.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { fakeDevice, waitForState } = require('./fake-ssh.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};
const dc = loadTs('src/main/deviceCommands.ts');
const { DeviceLink } = loadTs('src/main/devices.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { usageUnavailableOnDevice } = loadTs('src/shared/devices.ts');

const forwards = (f) => f.calls().filter((a) => a.includes('-O') && a[a.indexOf('-O') + 1] === 'forward').map((a) => a[a.indexOf('-R') + 1]);

async function online(t, f) {
  const link = new DeviceLink({ id: 'my-lap', host: '100.65.189.1' }, f.env);
  t.after(() => link.stop());
  link.start();
  await waitForState(link, 'online');
  return link;
}

test('forward argv: one -R on the device loopback, through the master', () => {
  assert.deepEqual(dc.forwardArgs('/c', 'u@h', 'forward', 47993, 5555),
    ['-S', '/c', '-O', 'forward', '-R', '127.0.0.1:47993:127.0.0.1:5555', '--', 'u@h']);
});

test('slots: base+3, base+4, and a freed slot is reused', async (t) => {
  const f = fakeDevice(t);
  const link = await online(t, f);
  assert.equal(await link.addForward('proxy:a', 5555), 47993);
  assert.equal(await link.addForward('proxy:b', 6666), 47994);
  await link.removeForward('proxy:a');
  assert.equal(await link.addForward('proxy:c', 7777), 47993);
  assert.deepEqual(forwards(f), ['127.0.0.1:47993:127.0.0.1:5555', '127.0.0.1:47994:127.0.0.1:6666', '127.0.0.1:47993:127.0.0.1:7777']);
});

test('forwards come back after a reconnect', { timeout: 20_000 }, async (t) => {
  const f = fakeDevice(t);
  const link = await online(t, f);
  await link.addForward('proxy:a', 5555);
  // Kill the master as a dropped link would: the fake master's pid is in the ControlPath.
  process.kill(Number(fs.readFileSync(link.ctl(), 'utf8')), 'SIGTERM');
  await waitForState(link, 'offline');
  await waitForState(link, 'online');
  assert.deepEqual(forwards(f), ['127.0.0.1:47993:127.0.0.1:5555', '127.0.0.1:47993:127.0.0.1:5555']);
});

function hiveWith(t, forward) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-proxy-dev-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.startProxyBridge = async () => 43210; // the sidecar on this laptop
  const calls = [];
  const remote = { home: '/home/alice', node: '/usr/bin/node', write: async () => {}, forward: async (p) => { calls.push(p); return forward; } };
  return { home, hive, remote, calls };
}

test("qwen on a device: its base URL is the forwarded port on the device's loopback", async (t) => {
  const { home, hive, remote, calls } = hiveWith(t, 47993);
  const inj = await hive.ensureAgent({ id: 'qw-1', name: 'Qwen', provider: 'qwen', cwd: home }, { remote });
  assert.deepEqual(calls, [43210]);
  assert.equal(inj.env.OPENAI_BASE_URL, 'http://127.0.0.1:47993');
  assert.equal(inj.degraded, undefined);
});

test('crush on a device: its config points at the forwarded port', async (t) => {
  const { home, hive, remote } = hiveWith(t, 47994);
  await hive.ensureAgent({ id: 'cr-1', name: 'Crush', provider: 'crush', cwd: home }, { remote });
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'agents', 'cr-1', 'crush.json'), 'utf8'));
  assert.equal(cfg.providers.openai.base_url, 'http://127.0.0.1:47994');
});

test('a forward that fails degrades the agent out loud', async (t) => {
  const { home, hive, remote } = hiveWith(t, null);
  const inj = await hive.ensureAgent({ id: 'qw-2', name: 'Qwen', provider: 'qwen', cwd: home }, { remote });
  assert.ok(inj.degraded);
  assert.equal(inj.env.OPENAI_BASE_URL, undefined);
});

test('usage: only engines that count from files on this laptop lose it on a device', () => {
  assert.equal(usageUnavailableOnDevice('claude'), false, 'OTLP is forwarded');
  assert.equal(usageUnavailableOnDevice('qwen'), false, 'its sidecar is here');
  assert.equal(usageUnavailableOnDevice('crush'), false);
  assert.equal(usageUnavailableOnDevice('codex'), true);
  assert.equal(usageUnavailableOnDevice('grok'), true);
  assert.equal(usageUnavailableOnDevice('antigravity'), true);
  assert.equal(usageUnavailableOnDevice('custom'), true);
});
