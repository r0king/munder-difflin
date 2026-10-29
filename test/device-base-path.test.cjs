'use strict';
/**
 * Devices phase 2, item 3: this laptop's base folder (the parent of the hive
 * home) must exist on the device, following symlinks. Check says so, and
 * so does a failed mount, each with the fix the spec gives.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { fakeDevice, waitForState } = require('./fake-ssh.cjs');

const dc = loadTs('src/main/deviceCommands.ts');
const { DeviceLink, checkDevice } = loadTs('src/main/devices.ts');

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-base-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const probe = (cmd, home) => spawnSync('bash', ['-c', cmd], { env: { ...process.env, HOME: home }, encoding: 'utf8' }).stdout;

test('the base folder is the parent of the hive home', () => {
  assert.equal(dc.baseFolder('/home/royal/Pro/Zensible/HarnessAgents/hive'), '/home/royal/Pro/Zensible');
});

test('present (a symlink counts): no fix', (t) => {
  const dir = sandbox(t);
  fs.mkdirSync(path.join(dir, 'real'), { recursive: true });
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'Zensible'));
  const base = path.join(dir, 'Zensible');
  const out = probe(dc.basePathCommand(base, '/home/royal'), dir);
  assert.equal(dc.basePathFix(base, '/home/royal', out), null);
});

test('same layout, another user: link their home to this one', (t) => {
  const dir = sandbox(t);
  const alice = path.join(dir, 'alice');
  fs.mkdirSync(path.join(alice, 'Pro', 'Zensible'), { recursive: true });
  const localHome = path.join(dir, 'royal');
  const base = path.join(localHome, 'Pro', 'Zensible');
  const out = probe(dc.basePathCommand(base, localHome), alice);
  assert.equal(dc.basePathFix(base, localHome, out), `sudo ln -s ${dc.shq(alice)} ${dc.shq(localHome)}`);
});

test('another layout: make the parent and link their folder', (t) => {
  const dir = sandbox(t);
  // A path under the sandbox, not the literal /home/royal/Pro/Zensible, which
  // exists on the machine that runs these tests.
  const localHome = path.join(dir, 'royal');
  const base = path.join(localHome, 'Pro', 'Zensible');
  const out = probe(dc.basePathCommand(base, localHome), dir);
  assert.equal(dc.basePathFix(base, localHome, out),
    `sudo mkdir -p ${dc.shq(path.join(localHome, 'Pro'))} && sudo ln -s <their folder> ${dc.shq(base)}`);
});

test('Check lists the base folder right after login', async (t) => {
  const f = fakeDevice(t);
  const link = new DeviceLink({ id: 'my-lap', host: '100.65.189.1' }, f.env);
  t.after(() => link.stop());
  link.start();
  await waitForState(link, 'online');
  const items = await checkDevice(link, f.hive, []);
  assert.deepEqual(items.slice(0, 2).map((i) => [i.id, i.ok]), [['login', true], ['base', true]]);
  assert.equal(items[1].path, path.dirname(path.dirname(f.hive)));
});

test('a mount that fails for a missing base folder says how to fix it', { skip: process.getuid?.() === 0, timeout: 20_000 }, async (t) => {
  const f = fakeDevice(t);
  // Not creatable by a normal user, so the mount's mkdir fails (exit 2).
  const root = `/md-nobase-${process.pid}`;
  const localHome = `${root}/royal`;
  const hiveRoot = `${localHome}/Pro/Zensible/HarnessAgents/hive`;
  fs.mkdirSync(path.join(f.home, 'Pro', 'Zensible'), { recursive: true }); // the device user's own layout matches
  const link = new DeviceLink({ id: 'my-lap', host: '100.65.189.1' }, { ...f.env, hiveRoot, localHome });
  t.after(() => link.stop());
  const why = new Promise((resolve) => link.on('state', (s) => { if (s.error?.includes('sudo ln -s')) resolve(s.error); }));
  link.start();
  const error = await why;
  assert.match(error, new RegExp(`${root}/royal/Pro/Zensible does not exist on my-lap`));
  assert.ok(error.includes(`sudo ln -s ${dc.shq(f.home)} ${dc.shq(localHome)}`));
});
