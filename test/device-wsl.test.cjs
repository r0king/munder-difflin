'use strict';
/**
 * Devices phase 2, item 6: a Windows machine runs as a Linux device inside
 * WSL2. Check spots WSL and adds its items: systemd and /dev/fuse are
 * checked; two Windows-side settings are printed as reminders.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { fakeDevice, waitForState } = require('./fake-ssh.cjs');

const dc = loadTs('src/main/deviceCommands.ts');
const { DeviceLink, checkDevice } = loadTs('src/main/devices.ts');

const WSL_VERSION = 'Linux version 5.15.153.1-microsoft-standard-WSL2 (root@x) (gcc) #1 SMP\n';

test('systemd: only systemd=true under [boot] counts', () => {
  assert.equal(dc.wslSystemdOn('[boot]\nsystemd=true\n'), true);
  assert.equal(dc.wslSystemdOn('[boot]\n  systemd = TRUE  # on\n'), true);
  assert.equal(dc.wslSystemdOn('[network]\nsystemd=true\n'), false, 'wrong section');
  assert.equal(dc.wslSystemdOn('[boot]\n# systemd=true\n'), false, 'commented out');
  assert.equal(dc.wslSystemdOn('[boot]\nsystemd=true\nsystemd=false\n'), false, 'the last one wins');
  assert.equal(dc.wslSystemdOn(''), false);
});

test('the probe: WSL from /proc/version, then wsl.conf, then /dev/fuse', () => {
  assert.deepEqual(dc.parseWslProbe(`${WSL_VERSION}__MD_WSL__\n[boot]\nsystemd=true\n__MD_WSL__\nfuse\n`),
    { wsl: true, systemd: true, fuse: true });
  assert.deepEqual(dc.parseWslProbe(`${WSL_VERSION}__MD_WSL__\n__MD_WSL__\n`), { wsl: true, systemd: false, fuse: false });
  assert.equal(dc.parseWslProbe('Linux version 6.9.7-arch1-1\n__MD_WSL__\n__MD_WSL__\n').wsl, false);
  assert.equal(dc.parseWslProbe('').wsl, false, 'no answer is not WSL');
});

test('WSL items: two checks with fixes, two reminders that never fail', () => {
  const items = dc.wslCheckItems({ wsl: true, systemd: false, fuse: true });
  assert.deepEqual(items.map((i) => [i.id, i.ok, !!i.reminder]),
    [['wslSystemd', false, false], ['wslFuse', true, false], ['wslIdle', true, true], ['wslSleep', true, true]]);
  assert.match(items[0].fix, /systemd=true/);
  assert.match(items[2].fix, /vmIdleTimeout=-1/);
  assert.ok(items[3].fix.length > 0);
  assert.deepEqual(dc.wslCheckItems({ wsl: false, systemd: false, fuse: false }), []);
});

test('Check on a plain Linux device adds no WSL items', async (t) => {
  const f = fakeDevice(t);
  const link = new DeviceLink({ id: 'my-lap', host: '100.65.189.1' }, f.env);
  t.after(() => link.stop());
  link.start();
  await waitForState(link, 'online');
  const ids = (await checkDevice(link, f.hive, [])).map((i) => i.id);
  assert.ok(!ids.some((id) => id.startsWith('wsl')), ids.join(','));
});
