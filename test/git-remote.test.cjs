'use strict';
/**
 * Devices, Task 7: git and worktrees for an agent on a device run there,
 * through the link's exec. Here the "device" runs the same fenced bash this
 * machine would receive over ssh, so paths with spaces and quotes cross the
 * same quoting as on a real link.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { isRepo, getBranch, addWorktree, removeWorktree } = loadTs('src/main/git.ts');
const { linkWorktreeDeps } = loadTs('src/main/worktreeDeps.ts');
const { fence, parseFenced } = loadTs('src/main/deviceCommands.ts');

// Every command the "device" ran: the device here is this machine, so the
// only proof git went through the link is that the link saw it.
const seen = [];
const device = {
  exec: (cmd) => new Promise((resolve) => {
    seen.push(cmd);
    execFile('bash', ['-c', fence(cmd)], (_err, stdout, stderr) => {
      const f = parseFenced(stdout);
      resolve(f
        ? { ok: f.code === 0, code: f.code, stdout: f.out, stderr }
        : { ok: false, code: -1, stdout: '', stderr, error: 'no answer' });
    });
  })
};

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-git-remote-it's "));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = path.join(dir, 'repo one');
  fs.mkdirSync(r);
  const git = (...a) => execFileSync('git', ['-C', r, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(r, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return { dir, r };
}

test('isRepo and getBranch run on the device', async (t) => {
  const { dir, r } = repo(t);
  seen.length = 0;
  assert.equal(await isRepo(r, device), true);
  assert.equal(await isRepo(dir, device), false);
  assert.deepEqual(await getBranch(r, device), { current: 'main', detached: false });
  assert.equal(seen.length, 3, 'all three ran through the device');
  assert.ok(seen.every((c) => c.startsWith("'git' '-C' ")));
});

test('a worktree is added and removed on the device', async (t) => {
  const { dir, r } = repo(t);
  const wt = path.join(dir, 'worktrees', 'dev 1');
  assert.deepEqual(await addWorktree(r, wt, 'main', device), { ok: true });
  assert.ok(fs.existsSync(path.join(wt, 'a.txt')));
  assert.deepEqual(await getBranch(wt, device), { current: 'agent/dev-1', detached: false });
  assert.deepEqual(await removeWorktree(r, wt, device), { ok: true });
  assert.equal(fs.existsSync(wt), false);
  assert.ok(seen.some((c) => c.includes("'worktree' 'remove'")));
});

test('a git error on the device comes back as an error', async (t) => {
  const { r } = repo(t);
  const res = await addWorktree(r, path.join(r, 'x'), 'no-such-branch', device);
  assert.equal(res.ok, false);
  assert.match(res.error, /no-such-branch|invalid reference/);
});

test('node_modules is linked into a device worktree once', async (t) => {
  const { dir, r } = repo(t);
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(wt);
  assert.deepEqual(await linkWorktreeDeps(r, wt, device), { ok: true, skipped: true }, 'no node_modules in the base: nothing to link');
  fs.mkdirSync(path.join(r, 'node_modules'));
  assert.deepEqual(await linkWorktreeDeps(r, wt, device), { ok: true, skipped: false });
  assert.equal(fs.readlinkSync(path.join(wt, 'node_modules')), path.join(r, 'node_modules'));
  assert.deepEqual(await linkWorktreeDeps(r, wt, device), { ok: true, skipped: true });
  assert.ok(seen.some((c) => c.includes('ln -s')), 'linked through the device');
});

test('a failed exec on the device comes back as that error', async () => {
  // git's own failure (stderr), and a link that never answered (error).
  const fatal = { exec: async () => ({ ok: false, code: 128, stdout: '', stderr: 'fatal: x\n' }) };
  const silent = { exec: async () => ({ ok: false, code: -1, stdout: '', stderr: '', error: 'no answer' }) };
  for (const [dev, error] of [[fatal, 'fatal: x'], [silent, 'no answer']]) {
    assert.deepEqual(await addWorktree('/r', '/r/wt', 'main', dev), { ok: false, error });
    assert.deepEqual(await getBranch('/r', dev), { error });
    assert.deepEqual(await linkWorktreeDeps('/r', '/r/wt', dev), { ok: false, error });
  }
});
