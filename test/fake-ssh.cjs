'use strict';
/**
 * A fake `ssh` for the device tests: no network, ever. The "device" is this
 * machine. A remote command runs through `sh -c` (as sshd hands it to the
 * login shell), with a fake bin dir first on PATH.
 *
 *   -M …           a ControlMaster: writes its pid to the ControlPath and
 *                  waits for SIGTERM. FAKE_SSH_MODE=portbusy fails the way
 *                  ExitOnForwardFailure does. A ControlPath that already
 *                  exists makes it run as a plain client, as real ssh does.
 *   -O check|exit  answers for the pid in the ControlPath.
 *   … -- <cmd>     prints login-shell noise around running <cmd>.
 *
 * Every call is logged to FAKE_SSH_LOG as one JSON argv line.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAKE_SSH = `#!${process.execPath}
const fs = require('fs');
const { spawnSync } = require('child_process');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(a) + '\\n');
const ctl = a[a.indexOf('-S') + 1];
const masterPid = () => {
  try { const p = Number(fs.readFileSync(ctl, 'utf8')); process.kill(p, 0); return p; } catch (_) { return 0; }
};
if (a.includes('-M')) {
  if (process.env.FAKE_SSH_MODE === 'portbusy') {
    process.stderr.write('Error: remote port forwarding failed for listen port 47991\\n');
    process.exit(255);
  }
  if (fs.existsSync(ctl)) {
    process.stderr.write('ControlSocket ' + ctl + ' already exists, disabling multiplexing\\n');
  } else {
    fs.writeFileSync(ctl, String(process.pid));
    process.on('SIGTERM', () => { try { fs.rmSync(ctl); } catch (_) {} process.exit(0); });
  }
  setInterval(() => {}, 1000);
} else if (a.includes('-O')) {
  const pid = masterPid();
  if (a[a.indexOf('-O') + 1] === 'exit' && pid) process.kill(pid, 'SIGTERM');
  process.exit(pid ? 0 : 255);
} else {
  process.stdout.write('Welcome to my-lap! (login-shell noise)\\n');
  const r = spawnSync('sh', ['-c', a[a.indexOf('--') + 1]], { stdio: ['ignore', 'pipe', 'inherit'] });
  process.stdout.write(r.stdout);
  process.stdout.write('bye from .bash_logout\\n');
  process.exit(r.status === null ? 255 : r.status);
}
`;

function fakeDevice(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fakessh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  const hive = path.join(dir, 'hive');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  const log = path.join(dir, 'ssh.jsonl');
  const ssh = path.join(bin, 'ssh');
  fs.writeFileSync(ssh, FAKE_SSH, { mode: 0o755 });
  const tool = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // The fake mount: sshfs marks the folder and puts the hive's shim in it (as
  // the real mount would show it); mountpoint reads the mark.
  tool('mountpoint', '[ -e "$2/.fake-mounted" ]');
  tool('sshfs', 'touch "$4/.fake-mounted" && mkdir -p "$4/bin" && echo "// shim" > "$4/bin/cth-hook.cjs"');
  const env = {
    hiveRoot: hive,
    hookSock: path.join(dir, 'hooks.sock'),
    sftpPort: 40001,
    telemetryPort: 40002,
    sshBin: ssh,
    runDir: dir,
    sshEnv: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, FAKE_SSH_LOG: log, FAKE_SSH_MODE: opts.mode ?? '' },
    backoff: opts.backoff ?? (() => 20)
  };
  const calls = () => (fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []);
  return { dir, bin, home, hive, env, calls, tool };
}

function waitForState(link, state, ms = 10_000) {
  if (link.state === state) return Promise.resolve(link.status());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      link.off('state', on);
      reject(new Error(`timed out waiting for ${state}; last: ${JSON.stringify(link.status())}`));
    }, ms);
    function on(s) {
      if (s.state !== state) return;
      clearTimeout(timer);
      link.off('state', on);
      resolve(s);
    }
    link.on('state', on);
  });
}

module.exports = { fakeDevice, waitForState };
