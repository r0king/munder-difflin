'use strict';
/**
 * Devices, Task 1: the device list in config.json and an agent's `device` in
 * the hive registry. A device's host and user end up in ssh's argv, so a
 * malformed entry must be dropped on write, never reach a spawn.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// config.ts reads Electron's app.getPath(); hive.ts imports Notification.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-devices-config-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: {
    app: { getPath: () => userData },
    Notification: class { show() {} static isSupported() { return false; } }
  }
};
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const { writeConfig, readConfig } = loadTs('src/main/config.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { normalizeDeviceId, isValidDeviceId, LOCAL_DEVICE } = loadTs('src/shared/devices.ts');

writeConfig({});
readConfig();

test('devices survive a config round trip; malformed entries are dropped', () => {
  writeConfig({
    devices: [
      { id: 'my-lap', host: '100.65.189.1', user: 'royal' },
      { id: 'my-lap', host: '100.1.1.1' },                        // duplicate id
      { id: 'local', host: 'h' },                                  // reserved for this laptop
      { id: 'evil', host: '-oProxyCommand=touch /tmp/pwned' },     // would be read as an ssh option
      { id: 'a.b', host: 'h' },                                    // '.' breaks tmux names
      { id: 'big', host: 'h', portBase: 70000, user: '-x' }        // bad port and user dropped, device kept
    ],
    deviceOfflinePauseMin: 0
  });
  const c = readConfig();
  assert.deepEqual(c.devices, [
    { id: 'my-lap', host: '100.65.189.1', user: 'royal' },
    { id: 'big', host: 'h' }
  ]);
  assert.equal(c.deviceOfflinePauseMin, 0, '0 means never pause and must survive');

  writeConfig({ deviceOfflinePauseMin: -3 });
  assert.equal(readConfig().deviceOfflinePauseMin, undefined);
});

test('"" and "local" both mean this laptop', () => {
  assert.equal(normalizeDeviceId(''), undefined);
  assert.equal(normalizeDeviceId('local'), undefined);
  assert.equal(normalizeDeviceId(undefined), undefined);
  assert.equal(normalizeDeviceId(' my-lap '), 'my-lap');
  // fleet.json writes this, so a registry entry with device '' reads 'local', never "".
  assert.equal(normalizeDeviceId('') ?? LOCAL_DEVICE, 'local');
  assert.equal(isValidDeviceId('my-lap', ['other']), true);
  assert.equal(isValidDeviceId('my-lap', ['my-lap']), false);
});

test("the registry keeps an agent's device across a respawn that does not name it", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-devices-reg-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  // The folder exists on the device, not here: the registry must not call it invalid.
  const remoteCwd = '/only/on/the/device/repo';

  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: remoteCwd, device: 'my-lap' });
  let a = hive.registry().agents.a1;
  assert.equal(a.device, 'my-lap');
  assert.equal(a.cwdValid, true);

  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: remoteCwd });
  assert.equal(hive.registry().agents.a1.device, 'my-lap', 'a restart that does not say where keeps it there');
  assert.equal(hive.registry().agents.a1.cwdValid, true, 'and its device folder is still not judged on this laptop');

  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home, device: undefined });
  a = hive.registry().agents.a1;
  assert.equal(a.device, undefined, 'an explicit move home clears it');
});
