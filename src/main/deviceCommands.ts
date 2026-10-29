/**
 * Devices: every command and argv the device link sends, and the parsers for
 * what comes back (spec: docs/superpowers/specs/2026-10-29-devices-design.md).
 *
 * Pure: no I/O, no Electron. test/device-commands.test.cjs runs each string
 * through a real shell with fake binaries, because a quoting bug only shows
 * when a shell parses the result.
 *
 * The quoting rule: every value is POSIX-single-quoted once, at the layer that
 * parses it. A command that crosses ssh travels as ONE string (sshd joins its
 * argv with spaces and hands the result to the user's login shell), so it is
 * always `bash -lc '<cmd>'`: a known shell, with the device's login PATH,
 * where `~/.local/bin/claude` lives.
 */
import { DEFAULT_PORT_BASE, isValidDeviceHost, isValidDeviceUser, type DeviceCheckItem, type DeviceConfig } from '../shared/devices';
import { projectKey } from './transcript';

/** POSIX single quotes: safe for any string, newlines and unicode included. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ─── ssh ─────────────────────────────────────────────────────────────────────

export function portBase(d: DeviceConfig): number {
  return d.portBase ?? DEFAULT_PORT_BASE;
}

/** `user@host`, for every ssh argv. config.json can be edited by hand and
 *  a host or user starting with '-' would be read by ssh as an option
 *  (`-oProxyCommand=…` runs a command here), so this refuses anything
 *  normalizeDevices would have dropped, whoever built the DeviceConfig. */
export function sshTarget(d: DeviceConfig, localUser: string): string {
  if (!isValidDeviceHost(d.host)) throw new Error(`${JSON.stringify(d.host)} is not a valid host for device ${d.id}.`);
  const user = d.user ?? localUser;
  if ((d.user !== undefined && !isValidDeviceUser(d.user)) || user.startsWith('-')) {
    throw new Error(`${JSON.stringify(user)} is not a valid user for device ${d.id}.`);
  }
  return `${user}@${d.host}`;
}

/** A Unix socket path must stay under 108 bytes, hence /run/user/<uid>. */
export function controlPath(deviceId: string, runDir: string): string {
  return `${runDir}/md-${deviceId}.ctl`;
}

/** The ControlMaster. No command (-N), never prompts (BatchMode), and exits
 *  rather than run without a forward (ExitOnForwardFailure). A dead link is
 *  noticed in about 45 s (ServerAlive 15 × 3). Remote Unix-socket forwards
 *  are broken under Tailscale SSH, so every forward listens on a device-side
 *  loopback TCP port; the hook one lands on hooks.sock here. */
export function masterArgs(
  d: DeviceConfig,
  ctl: string,
  localUser: string,
  ports: { sftp: number; hookSock: string; telemetry: number | null }
): string[] {
  const base = portBase(d);
  return [
    '-M', '-S', ctl, '-N',
    '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-R', `127.0.0.1:${base}:127.0.0.1:${ports.sftp}`,
    '-R', `127.0.0.1:${base + 1}:${ports.hookSock}`,
    ...(ports.telemetry ? ['-R', `127.0.0.1:${base + 2}:127.0.0.1:${ports.telemetry}`] : []),
    // '--' ends ssh's options before the destination. Only where no command
    // follows: after '--' ssh no longer strips a second '--' before the
    // command, so exec and terminal argv rely on sshTarget's check alone.
    '--', sshTarget(d, localUser)
  ];
}

export function controlArgs(ctl: string, target: string, op: 'check' | 'exit'): string[] {
  return ['-S', ctl, '-O', op, '--', target];
}

/** Why the master exited, in words a person can act on. `fallback` is the
 *  link's own reason when it ended the master itself. A busy port still wins,
 *  because that is the thing that needs fixing. */
export function masterExitReason(stderr: string, deviceId: string, fallback?: string): string {
  const port = /remote port forwarding failed for listen port (\d+)/.exec(stderr);
  if (port) {
    return `Port ${port[1]} is already in use on ${deviceId}. Free it there, or give ${deviceId} another portBase in config.json.`;
  }
  if (fallback) return fallback;
  const last = stderr.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  return last ? `${deviceId}: ${last}` : `Lost the connection to ${deviceId}.`;
}

const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/** Reconnect delay after the `attempt`-th failure in a row (0-based). */
export function backoffDelay(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
}

// ─── One-shot commands (`exec`) ──────────────────────────────────────────────

const BEGIN = '__MD_BEGIN__';
const END = '__MD_END__';

/** Fence a command's output so whatever the login shell's rc files print
 *  around it (motd, nvm banners, an `echo` in .bashrc, .bash_logout) is cut
 *  away. The subshell keeps an `exit` in `cmd` from skipping the end mark. */
export function fence(cmd: string): string {
  return `printf '%s\\n' ${BEGIN}; (\n${cmd}\n); printf '\\n%s %d\\n' ${END} $?`;
}

/** The fenced output and exit code, or null when the fence never printed
 *  (ssh failed before the command ran). */
export function parseFenced(stdout: string): { out: string; code: number } | null {
  const b = stdout.indexOf(`${BEGIN}\n`);
  if (b < 0) return null;
  const from = b + BEGIN.length + 1;
  const e = stdout.lastIndexOf(`\n${END} `);
  if (e < from) return null;
  const code = parseInt(stdout.slice(e + END.length + 2), 10);
  return Number.isFinite(code) ? { out: stdout.slice(from, e), code } : null;
}

export function execArgs(ctl: string, target: string, cmd: string): string[] {
  return ['-S', ctl, '-o', 'BatchMode=yes', target, '--', `bash -lc ${shq(fence(cmd))}`];
}

// ─── tmux ────────────────────────────────────────────────────────────────────

/** Our own tmux server, apart from the user's own. */
export const TMUX = 'tmux -L md';
export const TMUX_CONF = 'set -g status off\nset -sg escape-time 0\nset -g history-limit 50000\n';
/** No server yet is not an error: it just means no sessions. */
export const TMUX_LS = `${TMUX} ls -F '#{session_name}' 2>/dev/null || true`;
export const TMUX_KILL_SERVER = `${TMUX} kill-server 2>/dev/null || true`;

/** tmux reads '.' and ':' in a target as window and pane separators. */
export function sessionName(agentId: string): string {
  return `md-${agentId.replace(/[.:]/g, '-')}`;
}

/** '=' makes tmux match the exact name; a plain `-t md-jim` also hits `md-jimmy`. */
export function killSessionCommand(name: string): string {
  return `${TMUX} kill-session -t ${shq(`=${name}`)}`;
}

export function hasSessionCommand(name: string): string {
  return `${TMUX} has-session -t ${shq(`=${name}`)}`;
}

export function parseTmuxLs(out: string): string[] {
  return out.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('md-'));
}

/** Which `md-*` sessions to keep (their agent is on this floor or coming back
 *  with the restore flow) and which are left over from a crash or a quit
 *  while the device was offline. */
export function planReconcile(sessions: string[], keepAgentIds: string[]): { keep: string[]; kill: string[] } {
  const want = new Set(keepAgentIds.map(sessionName));
  return { keep: sessions.filter((s) => want.has(s)), kill: sessions.filter((s) => !want.has(s)) };
}

export function tmuxConfPath(hiveRoot: string): string {
  return `${hiveRoot}/devices/tmux.conf`;
}

export function launchPath(hiveRoot: string, agentId: string): string {
  return `${hiveRoot}/agents/${agentId}/launch.sh`;
}

/** An agent's terminal: attach to its session, or start one running its
 *  launch.sh. `new-session -A` attaching to an existing session is also how
 *  a reattach after a link drop works. */
export function terminalArgs(ctl: string, target: string, hiveRoot: string, agentId: string, cwd: string): string[] {
  const tmux = `${TMUX} -f ${shq(tmuxConfPath(hiveRoot))} new-session -A -s ${shq(sessionName(agentId))} -c ${shq(cwd)} ${shq(`bash ${shq(launchPath(hiveRoot, agentId))}`)}`;
  return ['-tt', '-S', ctl, target, '--', `bash -lc ${shq(tmux)}`];
}

// ─── The hive mount ──────────────────────────────────────────────────────────

export const NOT_EMPTY = 'MD_HIVE_NOT_EMPTY';

/** Mount this laptop's hive at the same path on the device, through the
 *  forwarded SFTP port. sshfs reconnects by itself, so this only acts when
 *  `mountpoint` says the mount is gone. A non-empty folder there is refused:
 *  the mount would hide it, and whatever an agent wrote into it while
 *  unmounted would silently disappear from view.
 *
 *  A dead mount (sshfs killed: every stat fails with "Transport endpoint is
 *  not connected") also reads as "not mounted", and `mkdir -p` fails on it
 *  for good. So a lazy unmount runs first; on a plain folder it just fails,
 *  quietly. fusermount3 is fuse3's name, fusermount fuse2's. */
export function mountCommand(hiveRoot: string, base: number): string {
  const h = shq(hiveRoot);
  const hint = shq(`Cannot create ${hiveRoot} on the device. If it is a dead mount, run there: fusermount3 -uz ${h} (or fusermount -uz); otherwise check the permissions of its parent folder.`);
  return `mountpoint -q ${h} || { fusermount3 -uz ${h} 2>/dev/null || fusermount -uz ${h} 2>/dev/null; mkdir -p ${h} || { printf '%s\\n' ${hint} >&2; exit 2; }; [ -z "$(ls -A ${h})" ] || { echo ${NOT_EMPTY}; exit 3; }; sshfs -o directport=${base},reconnect,ServerAliveInterval=15 127.0.0.1:${h} ${h}; }`;
}

// ─── Hooks on the device ─────────────────────────────────────────────────────

const REMOTE_CACHE = '"$HOME"/.cache/munder-difflin';

/** The hook (and status-line) command for a device agent. It runs the
 *  device's OWN copy of the shim, not the hive's: the hive there is an sshfs
 *  mount that fails with EIO while the link is down, which is exactly when
 *  the shim must still run to pause the agent. */
export const REMOTE_HOOK_COMMAND = 'node "$HOME/.cache/munder-difflin/cth-hook.cjs"';

/** Refresh the device's shim copy from the mounted hive (run on every connect). */
export function installShimCommand(hiveRoot: string): string {
  return `mkdir -p ${REMOTE_CACHE} && cp ${shq(`${hiveRoot}/bin/cth-hook.cjs`)} ${REMOTE_CACHE}/cth-hook.cjs`;
}

/** Print `paused` and clear the flag if the agent paused while cut off. The
 *  file name rule matches HOOK_SHIM's (hive.ts). */
export function takePausedCommand(agentId: string): string {
  const f = `${REMOTE_CACHE}/${shq(`md-${agentId.replace(/[^A-Za-z0-9._-]/g, '-')}.paused`)}`;
  return `if [ -e ${f} ]; then rm -f ${f}; echo paused; fi`;
}

// ─── Spawn-time checks, git ──────────────────────────────────────────────────

export function dirExistsCommand(path: string): string {
  return `test -d ${shq(path)}`;
}

/** Claude keeps a session under ~/.claude/projects/<projectKey(cwd)>/ on the
 *  machine that ran it, so `--resume` is only offered when it is there. */
export function transcriptExistsCommand(cwd: string, sessionId: string): string {
  return `test -f "$HOME"/.claude/projects/${shq(projectKey(cwd))}/${shq(`${sessionId}.jsonl`)}`;
}

export function gitCommand(cwd: string, args: string[]): string {
  return ['git', '-C', cwd, ...args].map(shq).join(' ');
}

/** linkWorktreeDeps on a device: link the base checkout's node_modules into a
 *  new worktree, once. Prints `linked` when it made the link. */
export function linkDepsCommand(baseDir: string, worktreeDir: string): string {
  const b = shq(`${baseDir}/node_modules`);
  const w = shq(`${worktreeDir}/node_modules`);
  return `if [ -d ${b} ] && [ ! -e ${w} ] && [ ! -L ${w} ]; then ln -s ${b} ${w} && echo linked; fi`;
}

// ─── launch.sh ───────────────────────────────────────────────────────────────

/** A device agent's env: what differs from a local agent's. */
export function remoteAgentEnv(env: Record<string, string>, base: number, pauseMin: number): Record<string, string> {
  const out = { ...env };
  // Hooks reach the floor over the forwarded TCP port, not hooks.sock.
  delete out.HIVE_SOCK;
  out.HIVE_HOOK_PORT = String(base + 1);
  if (out.OTEL_EXPORTER_OTLP_ENDPOINT) out.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${base + 2}`;
  out.HIVE_OFFLINE_PAUSE_MIN = String(pauseMin);
  // hive-node wraps THIS laptop's Electron binary, which the device does not have.
  if (out.HIVE_NODE) out.HIVE_NODE = 'node';
  return out;
}

// The same first-run answers ensureClaudePermissionsAccepted (config.ts) writes
// on this laptop: skip the bypass-mode warning, and trust the agent's folder.
// On a device they belong in the DEVICE's ~/.claude, so node writes them there
// just before claude starts. An unparseable file is left alone, as on the laptop.
const TRUST_JS = [
  "const fs=require('fs'),p=require('path'),h=require('os').homedir(),cwd=process.argv[1];",
  'function patch(f,fn){let o={};if(fs.existsSync(f)){try{o=JSON.parse(fs.readFileSync(f,"utf8"))}catch(e){return}}',
  'if(!o||typeof o!=="object"||Array.isArray(o))return;if(fn(o)===false)return;',
  'fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(o,null,2))}',
  "patch(p.join(h,'.claude','settings.json'),o=>{if(o.skipDangerousModePermissionPrompt===true&&o.skipAutoPermissionPrompt===true)return false;o.skipDangerousModePermissionPrompt=true;o.skipAutoPermissionPrompt=true});",
  "patch(p.join(h,'.claude.json'),o=>{o.projects=o.projects||{};const e=o.projects[cwd]||{};if(e.hasTrustDialogAccepted===true)return false;o.projects[cwd]=Object.assign({},e,{hasTrustDialogAccepted:true})});"
].join('');

export function claudeTrustCommand(cwd: string): string {
  return `node -e ${shq(TRUST_JS)} ${shq(cwd)} || true`;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The script an agent's tmux session runs. Every value is quoted once,
 *  here, so the long multi-line hive prompt never has to survive ssh, a login
 *  shell and tmux as an argument. Env names a shell cannot export are dropped. */
export function launchScript(o: { cwd: string; env: Record<string, string>; command: string; args: string[] }): string {
  const exports = Object.entries({ COLORTERM: 'truecolor', FORCE_COLOR: '1', ...o.env })
    .filter(([k]) => ENV_NAME.test(k))
    .map(([k, v]) => `export ${k}=${shq(v)}`);
  return [
    '#!/usr/bin/env bash',
    '# Written by Munder Difflin on every start of this agent. Do not edit.',
    `cd ${shq(o.cwd)} || exit 1`,
    ...exports,
    claudeTrustCommand(o.cwd),
    `exec ${[o.command, ...o.args].map(shq).join(' ')}`,
    ''
  ].join('\n');
}

// ─── Settings → Devices → Check ──────────────────────────────────────────────

/** The setup checks, in display order, each with the command that fixes it. */
export function checkCommands(
  hiveRoot: string,
  folders: string[]
): Array<{ item: DeviceCheckItem['id']; path?: string; cmd: string; fix: string }> {
  return [
    { item: 'login', cmd: 'true', fix: 'sudo tailscale up --ssh   # on the device; and give it "action": "accept" in the Tailscale SSH policy' },
    { item: 'claude', cmd: 'command -v claude >/dev/null && test -s "$HOME/.claude/.credentials.json"', fix: 'curl -fsSL https://claude.ai/install.sh | bash && claude   # then /login, on the device' },
    { item: 'node', cmd: 'command -v node >/dev/null', fix: 'sudo pacman -S --needed nodejs   # Debian/Ubuntu: sudo apt install nodejs' },
    { item: 'tmux', cmd: 'command -v tmux >/dev/null', fix: 'sudo pacman -S --needed tmux   # Debian/Ubuntu: sudo apt install tmux' },
    { item: 'sshfs', cmd: 'command -v sshfs >/dev/null', fix: 'sudo pacman -S --needed sshfs   # Debian/Ubuntu: sudo apt install sshfs' },
    { item: 'mount', cmd: `mountpoint -q ${shq(hiveRoot)}`, fix: `mv ${shq(hiveRoot)} ${shq(`${hiveRoot}.local`)}   # on the device, only if that folder is not empty; the link then mounts it` },
    ...folders.map((f) => ({ item: 'folder' as const, path: f, cmd: dirExistsCommand(f), fix: `mkdir -p ${shq(f)}   # or clone the repo there, on the device` }))
  ];
}
