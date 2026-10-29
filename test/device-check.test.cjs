'use strict';
/**
 * Devices, Task 9: Settings → Devices → Check runs each setup item over the
 * link and gives a fix command for each failure (fake ssh: test/fake-ssh.cjs).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { fakeDevice, waitForState } = require('./fake-ssh.cjs');

const { DeviceLink, checkDevice } = loadTs('src/main/devices.ts');
const DEV = { id: 'my-lap', host: '100.65.189.1' };

test('Check: every item over the link, with a fix for each failure', async (t) => {
  const f = fakeDevice(t);
  f.tool('claude', 'exit 0');
  f.tool('tmux', 'exit 0');
  fs.mkdirSync(path.join(f.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.claude', '.credentials.json'), '{}');
  const link = new DeviceLink(DEV, f.env);
  t.after(() => link.stop());
  link.start();
  await waitForState(link, 'online');

  const items = await checkDevice(link, f.hive, [f.dir, '/no/such/folder']);
  assert.deepEqual(items.map((i) => [i.id, i.ok]), [
    ['login', true], ['claude', true], ['node', true], ['tmux', true], ['sshfs', true],
    ['mount', true], ['folder', true], ['folder', false]
  ]);
  assert.equal(items[0].fix, undefined, 'a pass carries no fix');
  assert.equal(items[7].path, '/no/such/folder');
  assert.match(items[7].fix, /^mkdir -p '\/no\/such\/folder'/);
});

test('Check while offline: one failed login line with the reason', async () => {
  const items = await checkDevice(undefined, '/h', ['/x']);
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].id, items[0].ok], ['login', false]);
  assert.ok(items[0].fix.length > 0);
});
