'use strict';
/**
 * Devices, Task 8: the lifecycle decisions that must never go wrong. A
 * terminal that dies with the link is a detach, not an agent that ended. After
 * a crash, or a quit while a device was offline, the next connect keeps the
 * sessions the restore flow brings back and kills the rest.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const dc = loadTs('src/main/deviceCommands.ts');

test('only a definite "no such session" on an online device ends the agent', () => {
  assert.equal(dc.isDetach('online', 1), false, 'has-session said no: the agent ended');
  assert.equal(dc.isDetach('online', 0), true, 'still running there: a detach');
  assert.equal(dc.isDetach('online', -1), true, 'the check itself failed: never archive on a guess');
  assert.equal(dc.isDetach('offline', -1), true, 'link down: a detach');
  assert.equal(dc.isDetach('connecting', 1), true);
});

test('a device offline at quit: the next connect keeps what the restore flow brings back and kills the rest', () => {
  const roster = {
    agents: [{ id: 'jim', device: 'my-lap', cwd: '/r/jim' }, { id: 'pam', cwd: '/r/pam' }],
    restorable: [{ id: 'dev.1', device: 'my-lap', cwd: '/r/dev' }, { id: 'kev', device: 'other-lap' }, null, 'junk']
  };
  const keep = dc.rosterAgentsOn(roster, 'my-lap');
  assert.deepEqual(keep, [{ id: 'jim', cwd: '/r/jim' }, { id: 'dev.1', cwd: '/r/dev' }]);
  const plan = dc.planReconcile(dc.parseTmuxLs('md-jim\nmd-dev-1\nmd-stopped-before-quit\n'), keep.map((a) => a.id));
  assert.deepEqual(plan, { keep: ['md-jim', 'md-dev-1'], kill: ['md-stopped-before-quit'] });
  assert.deepEqual(dc.rosterAgentsOn(null, 'my-lap'), []);
});

test("a device agent's worktree is removed on the device, never with local git", () => {
  // Paths are the same on every machine, so the same path on this laptop can be
  // a different, real worktree; a forced local remove there would destroy it.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
  const start = src.indexOf('function teardownPty(');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  const remoteBranch = body.slice(body.indexOf('if (remote) {\n      if (worker)'), body.indexOf('} else if (worker) {'));
  assert.ok(remoteBranch.length > 0, 'teardownPty has a device branch for the worktree');
  assert.match(remoteBranch, /removeWorktree\(origCwd, wtPath, remoteLink\)/);
  assert.doesNotMatch(remoteBranch, /removeWorktree\(origCwd, wtPath\)/);
  assert.doesNotMatch(remoteBranch, /finalizeWorkerWorktree/);
});

test('a refused launch.sh write is a failed spawn, not an exception', () => {
  // remoteTerminal throws when launch.sh's folder resolves outside the hive;
  // the spawn IPC must get { ok:false, error } back instead of a throw.
  const fs = require('node:fs');
  const path = require('node:path');
  // Raw source: index.ts has '/*' inside strings, which a comment-stripping
  // regex would read as a comment and eat real code with it.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const call = src.indexOf('remoteSpawn = remoteTerminal(');
  assert.ok(call > 0, 'spawnAgentCore calls remoteTerminal');
  const before = src.slice(Math.max(0, call - 200), call);
  assert.match(before, /try \{\s*$/);
  assert.match(src.slice(call, call + 800), /catch \(e\) \{[\s\S]*?res = \{ ok: false, error: refused \}/);
});
