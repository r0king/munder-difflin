'use strict';
/**
 * Devices, Task 4: DeviceLink against a fake ssh (test/fake-ssh.cjs). States,
 * backoff, one master per device, a stale ControlPath, a busy device-side port,
 * a non-empty hive folder, and exec output fenced against login-shell noise.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { fakeDevice, waitForState } = require('./fake-ssh.cjs');

const { DeviceLink, DeviceRegistry, checkDevice } = loadTs('src/main/devices.ts');
const DEV = { id: 'my-lap', host: '100.65.189.1' };
const isMaster = (argv) => argv.includes('-M');

test('connects: one master with the forwards, the hive mounted, then online', async (t) => {
  const f = fakeDevice(t);
  const link = new DeviceLink(DEV, f.env);
  t.after(() => link.stop());
  const states = [];
  link.on('state', (s) => states.push(s.state));
  const online = new Promise((r) => link.once('online', r));
  link.start();
  await online;
  assert.equal(link.state, 'online');
  assert.deepEqual(states.slice(0, 2), ['connecting', 'online']);
  const masters = f.calls().filter(isMaster);
  assert.equal(masters.length, 1);
  assert.ok(masters[0].includes('127.0.0.1:47990:127.0.0.1:40001'));
  assert.ok(fs.existsSync(path.join(f.hive, '.fake-mounted')), 'the hive was mounted');
  assert.ok(fs.existsSync(path.join(f.home, '.cache', 'munder-difflin', 'cth-hook.cjs')), 'the shim was copied to the device disk');
});

test('start() twice and sync() twice still run one master per device', async (t) => {
  const f = fakeDevice(t);
  const reg = new DeviceRegistry(() => f.env);
  t.after(() => reg.stopAll());
  reg.sync([DEV]);
  reg.sync([{ ...DEV }]);
  const link = reg.get('my-lap');
  link.start();
  await waitForState(link, 'online');
  assert.equal(f.calls().filter(isMaster).length, 1);
});

test('a stale ControlPath from a crash is cleared before the master starts', async (t) => {
  const f = fakeDevice(t);
  const link = new DeviceLink(DEV, f.env);
  t.after(() => link.stop());
  fs.writeFileSync(link.ctl(), 'left behind by a crashed app');
  link.start();
  await waitForState(link, 'online');
  const calls = f.calls();
  const exitAt = calls.findIndex((a) => a.includes('-O') && a.includes('exit'));
  const masterAt = calls.findIndex(isMaster);
  assert.ok(exitAt >= 0 && exitAt < masterAt, 'old master asked to exit, then the path removed, then -M');
});

test('a device-side port in use: offline with a message naming the port', async (t) => {
  const attempts = [];
  const f = fakeDevice(t, { mode: 'portbusy', backoff: (n) => { attempts.push(n); return 60_000; } });
  const link = new DeviceLink(DEV, f.env);
  t.after(() => link.stop());
  link.start();
  const s = await waitForState(link, 'offline');
  assert.match(s.error, /^Port 47991 is already in use on my-lap\. .*portBase/);
  assert.deepEqual(attempts, [0], 'it still retries, on the backoff, with the reason showing');
});

test("exec returns only the command's output and exit code; offline exec fails at once", async (t) => {
  const f = fakeDevice(t);
  const link = new DeviceLink(DEV, f.env);
  link.start();
  await waitForState(link, 'online');
  const r = await link.exec('echo hi; exit 3');
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
  assert.equal(r.stdout, 'hi\n', 'no motd, no logout banner');
  link.stop();
  const t0 = Date.now();
  const off = await link.exec('true');
  assert.deepEqual([off.ok, off.code, off.error], [false, -1, 'my-lap is offline']);
  assert.ok(Date.now() - t0 < 50);
});

test('a dead master: offline, then a reconnect on the backoff', async (t) => {
  const attempts = [];
  const f = fakeDevice(t, { backoff: (n) => { attempts.push(n); return 20; } });
  const link = new DeviceLink(DEV, f.env);
  t.after(() => link.stop());
  link.start();
  await waitForState(link, 'online');
  const pid = Number(fs.readFileSync(link.ctl(), 'utf8'));
  const offline = waitForState(link, 'offline');
  process.kill(pid, 'SIGTERM');
  await offline;
  await waitForState(link, 'online');
  assert.deepEqual(attempts, [0]);
  assert.equal(f.calls().filter(isMaster).length, 2);
});

test('no sftp-server here: offline with the reason, and no ssh at all', async (t) => {
  const f = fakeDevice(t);
  const link = new DeviceLink(DEV, { ...f.env, sftpPort: null, sftpError: 'No sftp-server on this laptop (looked in …).' });
  t.after(() => link.stop());
  link.start();
  const s = await waitForState(link, 'offline');
  assert.match(s.error, /^No sftp-server on this laptop/);
  assert.equal(f.calls().length, 0);
});

test('a non-empty hive folder on the device is refused with the fix', async (t) => {
  const f = fakeDevice(t, { backoff: () => 60_000 });
  fs.mkdirSync(f.hive, { recursive: true });
  fs.writeFileSync(path.join(f.hive, 'stray-mail.json'), '{}');
  const link = new DeviceLink(DEV, f.env);
  t.after(() => link.stop());
  link.start();
  const s = await waitForState(link, 'offline');
  assert.match(s.error, /not empty/);
  assert.ok(s.error.includes(`mv ${f.hive} ${f.hive}.local`));
});

test('a hand-edited host that ssh would read as an option never reaches ssh', async (t) => {
  // readConfig() hands devices over unvalidated; sync() must clean them itself.
  const f = fakeDevice(t);
  const marker = path.join(f.dir, 'pwned');
  const bad = { id: 'evil', host: `-oProxyCommand=touch ${marker}` };
  const reg = new DeviceRegistry(() => f.env);
  t.after(() => reg.stopAll());
  reg.sync([bad, { id: 'evil2', host: 'ok-host', user: '-oProxyCommand=x' }]);
  assert.equal(reg.get('evil'), undefined);
  assert.deepEqual(reg.all().map((l) => [l.id, l.device.user]), [['evil2', undefined]], 'a bad user is dropped, the device kept');
  reg.stopAll();
  // A link built directly (not through sync) refuses too, without spawning.
  const link = new DeviceLink(bad, f.env);
  t.after(() => link.stop());
  link.start();
  const s = await waitForState(link, 'offline');
  assert.match(s.error, /not a valid host/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(f.calls().filter((a) => a.some((x) => x.includes('ProxyCommand'))).length, 0);
  assert.ok(!fs.existsSync(marker));
});

for (const [mode, re] of [['hostkey-new', /ssh royal@100\.65\.189\.1/], ['hostkey-changed', /ssh-keygen -R 100\.65\.189\.1/]]) {
  test(`${mode}: offline with the fix, no retry loop, and a Check tries again`, async (t) => {
    const attempts = [];
    const f = fakeDevice(t, { mode, backoff: (n) => { attempts.push(n); return 20; } });
    const link = new DeviceLink({ ...DEV, user: 'royal' }, f.env);
    t.after(() => link.stop());
    link.start();
    const s = await waitForState(link, 'offline');
    assert.match(s.error, re);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(attempts, [], 'it will not fix itself: no backoff retries');
    assert.equal(f.calls().filter(isMaster).length, 1);

    const [login] = await checkDevice(link, f.hive, []);
    assert.deepEqual([login.id, login.ok], ['login', false]);
    assert.match(login.fix, re, 'the Check says the same');
    assert.equal(f.calls().filter(isMaster).length, 2, 'a manual Check tries once more');

    // Key accepted in a terminal: the next Check connects.
    f.env.sshEnv.FAKE_SSH_MODE = '';
    const items = await checkDevice(link, f.hive, []);
    assert.equal(link.state, 'online');
    assert.deepEqual(items[0], { id: 'login', ok: true });
  });
}
