'use strict';
/**
 * Devices, Task 2: the strings that cross ssh, tmux and launch.sh. Each test
 * runs the built command through a real shell, with fake binaries that record
 * their argv and env, because a quoting bug only shows up when a shell parses
 * the result. Nothing here touches the network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const dc = loadTs('src/main/deviceCommands.ts');
const { projectKey } = loadTs('src/main/transcript.ts');

// A fake binary: appends {argv, env} as one JSON line to $DUMP.
const DUMP = "require('fs').appendFileSync(process.env.DUMP, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + '\\n');\n";

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-devcmd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const dump = path.join(dir, 'dump.jsonl');
  const env = { HOME: dir, PATH: `${bin}:${process.env.PATH}`, DUMP: dump };
  const fake = (name, body = DUMP) =>
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${body}`, { mode: 0o755 });
  const calls = () => (fs.existsSync(dump)
    ? fs.readFileSync(dump, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []);
  const sh = (cmd) => spawnSync('sh', ['-c', cmd], { env, encoding: 'utf8' });
  return { dir, env, fake, calls, sh };
}

// The one string sshd hands the user's login shell. `-l` is dropped here: these
// tests are about quoting, not about what /etc/profile does on this machine.
const remoteOf = (args) => args[args.length - 1].replace(/^bash -lc /, 'bash -c ');

const NASTY = "line one\nit's \"quoted\" $HOME `whoami` $(echo no) \\back\\slash\ttab ünïcødé ✓ 中文 'end'";

test('a multi-line prompt and its env reach claude unchanged through ssh, tmux and launch.sh', (t) => {
  const s = sandbox(t);
  s.fake('tmux');
  s.fake('claude');
  const hive = path.join(s.dir, "hive with 'quote' and space");
  const cwd = path.join(s.dir, 'repo $x');
  const agentId = 'dev.1:x';
  fs.mkdirSync(path.join(hive, 'agents', agentId), { recursive: true });
  fs.mkdirSync(cwd);
  fs.writeFileSync(dc.launchPath(hive, agentId), dc.launchScript({
    cwd,
    command: 'claude',
    env: { AGENT_ID: agentId, NASTY, 'NOT-A-NAME': 'dropped' },
    args: ['--append-system-prompt', NASTY, '--model', 'claude-fable-5']
  }));

  const args = dc.terminalArgs('/run/user/1000/md-my-lap.ctl', 'royal@100.65.189.1', hive, agentId, cwd);
  assert.deepEqual(args.slice(0, 5), ['-tt', '-S', '/run/user/1000/md-my-lap.ctl', 'royal@100.65.189.1', '--']);

  // sshd → login shell → tmux
  let r = s.sh(remoteOf(args));
  assert.equal(r.status, 0, r.stderr);
  const tmux = s.calls()[0].argv;
  assert.deepEqual(tmux.slice(0, 10), ['-L', 'md', '-f', dc.tmuxConfPath(hive), 'new-session', '-A', '-s', 'md-dev-1-x', '-c', cwd]);
  assert.equal(tmux.length, 11);

  // tmux runs its shell-command through `sh -c` → launch.sh → claude
  r = s.sh(tmux[10]);
  assert.equal(r.status, 0, r.stderr);
  const claude = s.calls()[1];
  assert.deepEqual(claude.argv, ['--append-system-prompt', NASTY, '--model', 'claude-fable-5']);
  assert.equal(claude.env.NASTY, NASTY);
  assert.equal(claude.env.AGENT_ID, agentId);
  assert.equal(claude.env.COLORTERM, 'truecolor');
  assert.equal('NOT-A-NAME' in claude.env, false);
});

test('launch.sh pre-accepts the folder trust on the device, and leaves a corrupt ~/.claude.json alone', (t) => {
  const s = sandbox(t);
  s.fake('claude');
  const cwd = path.join(s.dir, 'repo');
  fs.mkdirSync(cwd);
  const script = path.join(s.dir, 'launch.sh');
  fs.writeFileSync(script, dc.launchScript({ cwd, env: {}, command: 'claude', args: [] }));

  assert.equal(s.sh(`bash ${dc.shq(script)}`).status, 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(s.dir, '.claude.json'), 'utf8'));
  assert.equal(cfg.projects[cwd].hasTrustDialogAccepted, true);
  const settings = JSON.parse(fs.readFileSync(path.join(s.dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.skipDangerousModePermissionPrompt, true);

  fs.writeFileSync(path.join(s.dir, '.claude.json'), '{ not json');
  assert.equal(s.sh(`bash ${dc.shq(script)}`).status, 0, 'claude still starts');
  assert.equal(fs.readFileSync(path.join(s.dir, '.claude.json'), 'utf8'), '{ not json');
});

test('tmux session names never carry "." or ":", and kills match the exact name', () => {
  assert.equal(dc.sessionName('worker-req.1:2'), 'md-worker-req-1-2');
  assert.equal(dc.killSessionCommand('md-jim'), "tmux -L md kill-session -t '=md-jim'");
  assert.equal(dc.hasSessionCommand('md-jim'), "tmux -L md has-session -t '=md-jim'");
});

test('login-shell noise around a fenced command is dropped and its exit code kept', (t) => {
  const s = sandbox(t);
  const args = dc.execArgs('/c.ctl', 'royal@h', 'printf "a\\nb"; exit 7');
  assert.deepEqual(args.slice(0, 6), ['-S', '/c.ctl', '-o', 'BatchMode=yes', 'royal@h', '--']);
  const r = s.sh(`echo 'Welcome to my-lap'; ${remoteOf(args)}; echo 'bye from .bash_logout'`);
  assert.deepEqual(dc.parseFenced(r.stdout), { out: 'a\nb', code: 7 });
  assert.deepEqual(dc.parseFenced(s.sh(remoteOf(dc.execArgs('/c', 'u@h', 'true'))).stdout), { out: '', code: 0 });
  assert.equal(dc.parseFenced('Welcome to my-lap\n'), null, 'no fence = the command never ran');
});

// "Is it mounted" comes from the mount table, never from a stat: a live sshfs
// mount answers EIO to a stat while the link is cut, and reconnects by itself.
function mounts(s, ...paths) {
  const f = path.join(s.dir, 'mounts');
  fs.writeFileSync(f, paths.map((p) => `127.0.0.1:${p} ${p} fuse.sshfs rw,nosuid,nodev 0 0\n`).join(''));
  return f;
}

test('the hive mounts only on an empty folder; a non-empty one is refused, not hidden', (t) => {
  const s = sandbox(t);
  s.fake('sshfs');
  s.fake('fusermount3');
  s.fake('fusermount');
  const hive = path.join(s.dir, 'home', 'hive');
  const table = mounts(s, '/elsewhere'); // not listed: mount, with no unmount

  let r = s.sh(dc.mountCommand(hive, 47990, table));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.calls().map((c) => c.argv), [['-o', 'directport=47990,reconnect,ServerAliveInterval=15,dir_cache=no,entry_timeout=0,attr_timeout=0,negative_timeout=0', `127.0.0.1:${hive}`, hive]]);

  fs.writeFileSync(path.join(hive, 'stray-mail.json'), '{}');
  r = s.sh(dc.mountCommand(hive, 47990, table));
  assert.equal(r.status, 3);
  assert.ok(r.stdout.includes(dc.NOT_EMPTY));
  assert.equal(s.calls().length, 1, 'sshfs must not mount over a non-empty folder');

  // Listed and readable: a live mount (maybe just reconnected) is left alone.
  mounts(s, '/elsewhere', hive);
  assert.equal(s.sh(dc.mountCommand(hive, 47990, table)).status, 0);
  assert.equal(s.calls().length, 1, 'a live mount is left alone: no unmount, no sshfs');
});

test('a port held by a process connected to itself is freed; nothing else is touched', async (t) => {
  const stderr = 'Warning: remote port forwarding failed for listen port 47990\nWarning: remote port forwarding failed for listen port 47992\n';
  assert.deepEqual(dc.busyForwardPorts(stderr), [47990, 47992]);
  const s = sandbox(t);
  const stuck = require('node:child_process').spawn('sleep', ['60']); // stands in for the stuck sshfs
  t.after(() => stuck.kill());
  // ss lists the stuck process only for a socket whose two ends are both :47990.
  s.fake('ss', `if (process.argv.join(' ').includes('sport = :47990 and dport = :47990'))
  console.log('ESTAB 0 0 127.0.0.1:47990 127.0.0.1:47990 users:(("sshfs",pid=${stuck.pid},fd=3))');\n`);
  let r = s.sh(dc.freeBusyPortsCommand([47991], false));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'nothing self-connected on 47991: nothing killed');
  assert.equal(stuck.exitCode ?? stuck.signalCode, null);
  r = s.sh(dc.freeBusyPortsCommand([47990, 47991], false));
  assert.equal(r.stdout.trim(), 'freed', r.stderr);
  const died = await Promise.race([new Promise((res) => stuck.once('exit', () => res(true))), new Promise((res) => setTimeout(res, 2000, false))]);
  assert.equal(died && stuck.signalCode, 'SIGKILL', 'the self-connected process is gone');
});

test('a root-owned listener left by a dead session restarts tailscaled, detached; otherwise nothing', (t) => {
  const run = (ssLines, { mayRestart = true, sudoExit = 0 } = {}) => {
    const s = sandbox(t);
    s.fake('ss', `if (process.argv.includes('-Htlnp')) console.log(${JSON.stringify(ssLines)});\n`);
    s.fake('sudo', `${DUMP}process.exit(process.argv.includes('-l') ? ${sudoExit} : 0);\n`);
    s.fake('setsid');
    const r = s.sh(dc.freeBusyPortsCommand([47990, 47991], mayRestart));
    return { r, calls: s.calls() };
  };
  const stale = 'LISTEN 0 4096 127.0.0.1:47990 0.0.0.0:*';
  let { r, calls } = run(stale);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'restarting');
  const setsid = calls.find((c) => c.argv[0] === '-f');
  assert.deepEqual(setsid.argv.slice(0, 3), ['-f', 'sh', '-c']);
  assert.match(setsid.argv[3], /sudo -n systemctl restart tailscaled/);
  assert.deepEqual(calls.find((c) => c.argv[0] === '-n').argv, ['-n', '-l', '/usr/bin/systemctl', 'restart', 'tailscaled']);

  ({ r, calls } = run(stale, { mayRestart: false }));
  assert.deepEqual([r.status, r.stdout, calls.length], [0, '', 0], 'not allowed to restart: nothing runs');
  ({ r, calls } = run(stale, { sudoExit: 1 }));
  assert.deepEqual([r.status, r.stdout, calls.some((c) => c.argv[0] === '-f')], [0, '', false], 'no sudo rule: no restart');
  ({ r, calls } = run('LISTEN 0 4096 127.0.0.1:47990 0.0.0.0:* users:(("sshd",pid=1,fd=9))'));
  assert.deepEqual([r.status, r.stdout, calls.length], [0, '', 0], 'a listener with users: is ours: left alone');
});

test('a dead sshfs mount is lazily unmounted, then mounted again', (t) => {
  const s = sandbox(t);
  const hive = path.join(s.dir, 'home', 'hive');
  const unmounted = path.join(s.dir, 'unmounted');
  const table = mounts(s, hive); // listed, but ls fails: sshfs is dead
  s.fake('sshfs');
  // mkdir fails the way it does on a dead mount until something unmounts it.
  s.fake('mkdir', `const fs = require('fs');
if (!fs.existsSync(${JSON.stringify(unmounted)})) { process.stderr.write('mkdir: Transport endpoint is not connected\\n'); process.exit(1); }
fs.mkdirSync(process.argv[3], { recursive: true });\n`);
  // fusermount3 missing its setuid bit fails; the fusermount fallback works.
  s.fake('fusermount3', DUMP + 'process.exit(1);\n');
  s.fake('fusermount', `${DUMP}require('fs').writeFileSync(${JSON.stringify(unmounted)}, '');\n`);
  const r = s.sh(dc.mountCommand(hive, 47990, table));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.calls().map((c) => c.argv), [
    ['-uz', hive],
    ['-uz', hive],
    ['-o', 'directport=47990,reconnect,ServerAliveInterval=15,dir_cache=no,entry_timeout=0,attr_timeout=0,negative_timeout=0', `127.0.0.1:${hive}`, hive]
  ]);

  // Still unable to create the folder: exit 2, with the fix in the message.
  fs.rmSync(unmounted);
  fs.rmSync(hive, { recursive: true }); // dead again: ls fails
  s.fake('fusermount', 'process.exit(1);\n');
  const r2 = s.sh(dc.mountCommand(hive, 47990, table));
  assert.equal(r2.status, 2);
  assert.ok(r2.stderr.includes(`fusermount3 -uz '${hive}'`), r2.stderr);
});

test('the master carries the three forwards, and drops telemetry when it is off', () => {
  const d = { id: 'my-lap', host: '100.65.189.1' };
  assert.deepEqual(
    dc.masterArgs(d, '/run/user/1000/md-my-lap.ctl', 'royal', { sftp: 40001, hookSock: '/h/hive/hooks.sock', telemetry: 40002 }),
    [
      '-M', '-S', '/run/user/1000/md-my-lap.ctl', '-N',
      '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=8',
      '-R', '127.0.0.1:47990:127.0.0.1:40001',
      '-R', '127.0.0.1:47991:/h/hive/hooks.sock',
      '-R', '127.0.0.1:47992:127.0.0.1:40002',
      '--', 'royal@100.65.189.1'
    ]
  );
  const off = dc.masterArgs({ ...d, user: 'me', portBase: 50000 }, '/c', 'royal', { sftp: 1, hookSock: '/s', telemetry: null });
  assert.equal(off.filter((a) => a === '-R').length, 2);
  assert.ok(off.includes('127.0.0.1:50001:/s'));
  assert.equal(off[off.length - 1], 'me@100.65.189.1');
});

test('a remote agent reaches hooks and telemetry over the forwarded ports', () => {
  const env = dc.remoteAgentEnv({
    AGENT_ID: 'a', HIVE_SOCK: '/h/hooks.sock',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:43210', HIVE_NODE: '/h/bin/hive-node'
  }, 47990, 10);
  assert.deepEqual(env, {
    AGENT_ID: 'a', HIVE_HOOK_PORT: '47991', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:47992',
    HIVE_NODE: 'node', HIVE_OFFLINE_PAUSE_MIN: '10'
  });
  assert.equal('OTEL_EXPORTER_OTLP_ENDPOINT' in dc.remoteAgentEnv({}, 47990, 0), false, 'telemetry off stays off');
});

test('tmux ls parsing and the reconcile plan', () => {
  const sessions = dc.parseTmuxLs('md-jim\nmd-dev-1\n\nroyal-own\nmd-gone\n');
  assert.deepEqual(sessions, ['md-jim', 'md-dev-1', 'md-gone']);
  assert.deepEqual(dc.planReconcile(sessions, ['jim', 'dev.1']), { keep: ['md-jim', 'md-dev-1'], kill: ['md-gone'] });
});

test('backoff is 2s, 5s, 15s, 30s, then every 60s; a busy port names itself', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map(dc.backoffDelay), [2000, 5000, 15000, 30000, 60000, 60000, 60000]);
  assert.match(
    dc.masterExitReason('Warning: x\nError: remote port forwarding failed for listen port 47991\n', 'my-lap', 'ignored'),
    /^Port 47991 on my-lap is still held by a dropped connection\. .*sudo systemctl restart tailscaled/
  );
  assert.equal(dc.masterExitReason('ssh: connect to host h port 22: No route to host\n', 'my-lap'), 'my-lap: ssh: connect to host h port 22: No route to host');
  assert.equal(dc.masterExitReason('', 'my-lap', 'the link ended it'), 'the link ended it');
});

test('a host key ssh does not trust yet, or one that changed, says what to do', () => {
  const unknown = 'No ED25519 host key is known for 100.65.189.1 and you have requested strict checking.\nHost key verification failed.\n';
  const why = dc.masterExitReason(unknown, 'my-lap', undefined, 'royal@100.65.189.1');
  assert.ok(why.includes('ssh royal@100.65.189.1'), why);
  assert.match(why, /fingerprint/);
  assert.match(why, /yes/);
  assert.equal(dc.hostKeyFailed(unknown), true);
  assert.ok(dc.masterExitReason('Host key verification failed.\n', 'my-lap', undefined, 'royal@h').includes('ssh royal@h'));

  const changed = '@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@\nHost key verification failed.\n';
  const why2 = dc.masterExitReason(changed, 'my-lap', undefined, 'royal@100.65.189.1');
  assert.match(why2, /changed/);
  assert.match(why2, /reinstalled or replaced/);
  assert.ok(why2.includes("ssh-keygen -R 100.65.189.1"), why2);
  assert.ok(!/answer yes/.test(why2), 'a changed key is never just accepted');
  assert.equal(dc.hostKeyFailed(changed), true);
  assert.equal(dc.hostKeyFailed('ssh: connect to host h port 22: No route to host'), false);
});

test('git runs in the right folder whatever its name', (t) => {
  const s = sandbox(t);
  s.fake('git');
  assert.equal(s.sh(dc.gitCommand("/p/it's here", ['worktree', 'add', '/w t', '-b', 'agent/x', 'main'])).status, 0);
  assert.deepEqual(s.calls()[0].argv, ['-C', "/p/it's here", 'worktree', 'add', '/w t', '-b', 'agent/x', 'main']);
});

test('a session resumes only if its transcript is on the device', (t) => {
  const s = sandbox(t);
  const cwd = '/home/royal/Pro/Zensible/repo.x';
  assert.notEqual(s.sh(dc.transcriptExistsCommand(cwd, 'sid-1')).status, 0);
  const dir = path.join(s.dir, '.claude', 'projects', projectKey(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sid-1.jsonl'), '{}\n');
  assert.equal(s.sh(dc.transcriptExistsCommand(cwd, 'sid-1')).status, 0);
});

test('the paused flag is taken exactly once', (t) => {
  const s = sandbox(t);
  const dir = path.join(s.dir, '.cache', 'munder-difflin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'md-a.1.paused'), '1');
  assert.equal(s.sh(dc.takePausedCommand('a.1')).stdout, 'paused\n');
  assert.equal(fs.existsSync(path.join(dir, 'md-a.1.paused')), false);
  assert.equal(s.sh(dc.takePausedCommand('a.1')).stdout, '');
});

test('the setup check lists every item, and one folder line per agent folder', () => {
  const items = dc.checkCommands('/h/hive', ["/repo/it's"]);
  assert.deepEqual(items.map((i) => i.item), ['login', 'claude', 'node', 'tmux', 'sshfs', 'mount', 'folder']);
  const folder = items[items.length - 1];
  assert.equal(folder.path, "/repo/it's");
  assert.equal(folder.cmd, `test -d ${dc.shq("/repo/it's")}`);
  assert.ok(items.every((i) => i.fix.length > 0));
});

test('ssh argv guards: options end before the target, and no host or user can pass as an option', () => {
  assert.deepEqual(dc.controlArgs('/c', 'u@h', 'check'), ['-S', '/c', '-O', 'check', '--', 'u@h']);
  // A leading '-' would be read by ssh as an option (`-oProxyCommand=…` runs a command here).
  assert.throws(() => dc.sshTarget({ id: 'd', host: '-oX' }, 'royal'), /not a valid host/);
  assert.throws(() => dc.sshTarget({ id: 'd', host: 'h', user: '-oX' }, 'royal'), /not a valid user/);
  assert.throws(() => dc.sshTarget({ id: 'd', host: 'h' }, '-oX'), /not a valid user/);
  assert.equal(dc.sshTarget({ id: 'd', host: 'h' }, 'royal'), 'royal@h');
});

test("claude in ~/.local/bin is found: every device command and launch.sh put it on PATH", () => {
  // Claude's installer puts claude in ~/.local/bin, and a login shell may leave
  // that out (Arch's default profile does; found on my-lap, 2026-10-29).
  const args = dc.execArgs('/c', 'u@h', 'command -v claude');
  assert.match(args[args.length - 1], /^bash -lc 'export PATH="\$HOME\/\.local\/bin:\$PATH"; /);
  const script = dc.launchScript({ cwd: '/r', env: { A: '1' }, command: 'claude', args: [] }).split('\n');
  const pathLine = script.indexOf('export PATH="$HOME/.local/bin:$PATH";');
  assert.ok(pathLine > 0, 'launch.sh sets PATH');
  assert.ok(pathLine < script.findIndex((l) => l.startsWith('exec ')), 'before it execs claude');
});
