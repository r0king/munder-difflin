'use strict';
/**
 * Devices phase 2, item 2: "Runs on: Auto". The load parser and the pick
 * rule with fixed inputs, the reserved id, and the places where an Auto
 * agent must count as being on the device it last ran on.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { fakeDevice, waitForState } = require('./fake-ssh.cjs');

const dc = loadTs('src/main/deviceCommands.ts');
const { DeviceLink, readLoad, localLoad } = loadTs('src/main/devices.ts');
const { isValidDeviceId, normalizeDevices } = loadTs('src/shared/devices.ts');
const { effectiveDevice, deviceLabel, deviceInUse, deviceOffline } = loadTs('src/renderer/src/store/devices.ts');

const GB = 1024 ** 3;
const s = (id, load1, cores, memGb) => ({ id, load1, cores, memAvailable: memGb * GB });

test('parseLoad reads loadavg, nproc and MemAvailable', () => {
  assert.deepEqual(dc.parseLoad('my-lap', '0.52 0.61 0.70 2/345 6789\n8\nMemAvailable:    8123456 kB\n'),
    { id: 'my-lap', load1: 0.52, cores: 8, memAvailable: 8123456 * 1024 });
  assert.equal(dc.parseLoad('my-lap', 'nonsense'), null);
  assert.equal(dc.parseLoad('my-lap', '0.5 0.5 0.5 1/1 1\n0\nMemAvailable: 1 kB\n'), null, 'zero cores');
});

test('pick: the calm candidate with the most memory', () => {
  assert.equal(dc.pickDevice([s('local', 14, 8, 1.3), s('my-lap', 2, 8, 9), s('big', 30, 8, 20)]), 'my-lap');
});

test('pick: nobody calm, so the most memory overall', () => {
  assert.equal(dc.pickDevice([s('local', 14, 8, 1.3), s('my-lap', 20, 8, 9), s('big', 30, 8, 20)]), 'big');
});

test('pick: load per core exactly 1.5 does not qualify', () => {
  assert.equal(dc.pickDevice([s('local', 12, 8, 2), s('my-lap', 11.9, 8, 1)]), 'my-lap');
});

test('pick: a tie goes to this laptop, wherever it sits in the list', () => {
  assert.equal(dc.pickDevice([s('my-lap', 1, 8, 4), s('local', 1, 8, 4)]), 'local');
  assert.equal(dc.pickDevice([s('local', 1, 8, 4), s('my-lap', 1, 8, 4)]), 'local');
  assert.equal(dc.pickDevice([]), 'local');
});

test('the load command reads real numbers on a (fake) device and here', async (t) => {
  const f = fakeDevice(t);
  const link = new DeviceLink({ id: 'my-lap', host: '100.65.189.1' }, f.env);
  t.after(() => link.stop());
  link.start();
  await waitForState(link, 'online');
  const r = await readLoad(link);
  assert.equal(r.id, 'my-lap');
  assert.ok(r.cores > 0 && r.memAvailable > 0 && r.load1 >= 0);
  const l = localLoad();
  assert.equal(l.id, 'local');
  assert.ok(l.cores > 0 && l.memAvailable > 0);
});

test('"auto" can never name a device', () => {
  assert.equal(isValidDeviceId('auto'), false);
  assert.deepEqual(normalizeDevices([{ id: 'auto', host: 'h' }, { id: 'my-lap', host: 'h' }]).map((d) => d.id), ['my-lap']);
});

test('an Auto agent counts as on the device it last ran on', () => {
  const roster = { agents: [
    { id: 'a1', cwd: '/r', device: 'auto', lastDevice: 'my-lap' },
    { id: 'a2', cwd: '/r', device: 'auto' },
    { id: 'a3', cwd: '/r', device: 'my-lap' }
  ] };
  assert.deepEqual(dc.rosterAgentsOn(roster, 'my-lap').map((a) => a.id), ['a1', 'a3']);
  assert.equal(effectiveDevice('auto', 'my-lap'), 'my-lap');
  assert.equal(effectiveDevice('auto', ''), undefined);
  assert.equal(effectiveDevice('my-lap', 'other'), 'my-lap');
  assert.equal(deviceInUse([{ device: 'auto', lastDevice: 'my-lap' }], 'my-lap'), true);
  const states = { 'my-lap': { id: 'my-lap', state: 'online' } };
  assert.equal(deviceOffline(effectiveDevice('auto', 'my-lap'), states), false);
  assert.equal(deviceOffline(effectiveDevice('auto', undefined), states), false, 'Auto on this laptop is never offline');
  assert.equal(deviceOffline('auto', {}), false, "Edit's move guard lets you switch to Auto");
});

test('the card tag says where Auto put it', () => {
  assert.equal(deviceLabel('auto', 'my-lap', 'This laptop'), 'my-lap (auto)');
  assert.equal(deviceLabel('auto', '', 'This laptop'), 'This laptop (auto)');
  assert.equal(deviceLabel('my-lap', undefined, 'This laptop'), 'my-lap');
  assert.equal(deviceLabel(undefined, undefined, 'This laptop'), undefined);
});

test("god's spawn requests may say auto", () => {
  assert.deepEqual(dc.validateSpawnDevice('auto', {}), { device: 'auto' });
});
