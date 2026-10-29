'use strict';
/**
 * Devices, Task 6: what a remote agent's terminal is made of. remoteTerminal
 * writes launch.sh (owner-only: it carries the agent's env) and tmux.conf into
 * the hive, and returns an ssh spawn. pty.ts starts that spawn although the
 * folder exists only on the device.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { DeviceLink, remoteTerminal } = loadTs('src/main/devices.ts');
const dc = loadTs('src/main/deviceCommands.ts');
const { PtyManager } = loadTs('src/main/pty.ts');

test('remoteTerminal writes launch.sh and tmux.conf, and returns the ssh spawn', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-remote-spawn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hive = path.join(dir, 'hive');
  const link = new DeviceLink({ id: 'my-lap', host: '100.65.189.1', user: 'royal' }, {
    hiveRoot: hive, hookSock: path.join(hive, 'hooks.sock'), sftpPort: 1, telemetryPort: null,
    sshBin: '/usr/bin/ssh', runDir: dir
  });
  const spawn = remoteTerminal(link, hive, {
    ptyId: 'pty-a1', agentId: 'a1', cwd: '/home/royal/Pro/x',
    env: { AGENT_ID: 'a1', MD_BROKER_TOKEN: 'tok' }, args: ['--model', 'm'], cols: 120, rows: 40
  });
  assert.deepEqual(spawn, {
    id: 'pty-a1', cwd: '/home/royal/Pro/x', command: '/usr/bin/ssh', cols: 120, rows: 40, remote: true,
    args: dc.terminalArgs(path.join(dir, 'md-my-lap.ctl'), 'royal@100.65.189.1', hive, 'a1', '/home/royal/Pro/x')
  });
  const launch = dc.launchPath(hive, 'a1');
  assert.ok(fs.readFileSync(launch, 'utf8').endsWith("exec 'claude' '--model' 'm'\n"));
  assert.equal(fs.statSync(launch).mode & 0o077, 0, 'launch.sh carries tokens: owner-only');
  assert.equal(fs.readFileSync(dc.tmuxConfPath(hive), 'utf8'), dc.TMUX_CONF);

  // A respawn over a launch.sh left world-readable must tighten it again.
  fs.chmodSync(launch, 0o644);
  remoteTerminal(link, hive, { ptyId: 'pty-a1', agentId: 'a1', cwd: '/x', env: { MD_BROKER_TOKEN: 'tok2' }, args: [] });
  assert.equal(fs.statSync(launch).mode & 0o077, 0, 'an existing launch.sh is re-tightened');
});

test('a symlink planted at launch.sh is replaced, never followed', (t) => {
  // An agent can write in its own hive folder, and the app is unsandboxed:
  // writing through a planted link would overwrite (and chmod) its target.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-remote-spawn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hive = path.join(dir, 'hive');
  const outside = path.join(dir, 'outside.txt');
  fs.writeFileSync(outside, 'keep me\n', { mode: 0o644 });
  const before = fs.readFileSync(outside);
  const launch = dc.launchPath(hive, 'a1');
  fs.mkdirSync(path.dirname(launch), { recursive: true });
  fs.symlinkSync(outside, launch);
  const link = new DeviceLink({ id: 'my-lap', host: '100.65.189.1', user: 'royal' }, {
    hiveRoot: hive, hookSock: path.join(hive, 'hooks.sock'), sftpPort: 1, telemetryPort: null,
    sshBin: '/usr/bin/ssh', runDir: dir
  });
  remoteTerminal(link, hive, { ptyId: 'pty-a1', agentId: 'a1', cwd: '/x', env: { MD_BROKER_TOKEN: 'tok' }, args: [] });
  assert.ok(fs.readFileSync(outside).equals(before), 'the link target is byte-for-byte unchanged');
  assert.equal(fs.statSync(outside).mode & 0o777, 0o644, 'and not chmodded');
  const st = fs.lstatSync(launch);
  assert.ok(st.isFile() && !st.isSymbolicLink(), 'launch.sh is now a regular file');
  assert.equal(st.mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(launch)), ['launch.sh'], 'no temp file left behind');
});

test('a symlink planted at tmux.conf is replaced, never followed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-remote-spawn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hive = path.join(dir, 'hive');
  const outside = path.join(dir, 'outside.conf');
  fs.writeFileSync(outside, 'keep me\n', { mode: 0o600 });
  const before = fs.readFileSync(outside);
  const conf = dc.tmuxConfPath(hive);
  fs.mkdirSync(path.dirname(conf), { recursive: true });
  fs.symlinkSync(outside, conf);
  const link = new DeviceLink({ id: 'my-lap', host: '100.65.189.1', user: 'royal' }, {
    hiveRoot: hive, hookSock: path.join(hive, 'hooks.sock'), sftpPort: 1, telemetryPort: null,
    sshBin: '/usr/bin/ssh', runDir: dir
  });
  remoteTerminal(link, hive, { ptyId: 'pty-a1', agentId: 'a1', cwd: '/x', env: {}, args: [] });
  assert.ok(fs.readFileSync(outside).equals(before), 'the link target is byte-for-byte unchanged');
  assert.equal(fs.statSync(outside).mode & 0o777, 0o600, 'and not chmodded');
  const st = fs.lstatSync(conf);
  assert.ok(st.isFile() && !st.isSymbolicLink(), 'tmux.conf is now a regular file');
  assert.equal(fs.readFileSync(conf, 'utf8'), dc.TMUX_CONF);
});

test('a symlink planted at a parent folder is refused, and nothing is written outside the hive', (t) => {
  // An agent can swap its own hive folder (agents/<id>) for a link; rename
  // would then land launch.sh wherever the link points.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-remote-spawn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hive = path.join(dir, 'hive');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(hive, 'agents'), { recursive: true });
  fs.symlinkSync(outside, path.join(hive, 'agents', 'a1'));
  const link = new DeviceLink({ id: 'my-lap', host: '100.65.189.1', user: 'royal' }, {
    hiveRoot: hive, hookSock: path.join(hive, 'hooks.sock'), sftpPort: 1, telemetryPort: null,
    sshBin: '/usr/bin/ssh', runDir: dir
  });
  assert.throws(
    () => remoteTerminal(link, hive, { ptyId: 'pty-a1', agentId: 'a1', cwd: '/x', env: { MD_BROKER_TOKEN: 'tok' }, args: [] }),
    /outside the hive/
  );
  assert.deepEqual(fs.readdirSync(outside), [], 'no launch.sh (or temp file) outside the hive');

  // Same for the shared devices/ folder.
  const outside2 = path.join(dir, 'outside2');
  fs.mkdirSync(outside2);
  fs.rmSync(path.join(hive, 'agents', 'a1'));
  fs.symlinkSync(outside2, path.join(hive, 'devices'));
  assert.throws(
    () => remoteTerminal(link, hive, { ptyId: 'pty-a1', agentId: 'a1', cwd: '/x', env: {}, args: [] }),
    /outside the hive/
  );
  assert.deepEqual(fs.readdirSync(outside2), [], 'no tmux.conf outside the hive');
});

test('a remote terminal starts although its folder exists only on the device', async () => {
  const pm = new PtyManager();
  const exited = new Promise((resolve) => pm.setExitHandler((_id, code) => resolve(code)));
  assert.deepEqual(
    pm.spawn({ id: 't1', cwd: '/only/on/the/device', command: 'sh', args: ['-c', 'exit 0'], remote: true }),
    { ok: true }
  );
  assert.equal(await exited, 0);
  assert.deepEqual(
    pm.spawn({ id: 't2', cwd: '/only/on/the/device', command: 'sh', args: ['-c', 'exit 0'] }),
    { ok: false, error: 'cwd does not exist: /only/on/the/device' },
    'a local agent keeps the folder check'
  );
});
