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
import { AUTO_DEVICE, DEFAULT_PORT_BASE, isValidDeviceHost, isValidDeviceUser, LOCAL_DEVICE, normalizeDeviceId, type DeviceCheckItem, type DeviceConfig, type DeviceState } from '../shared/devices';
import { projectKey } from './transcript';
import { installInfoForProvider, type AgentProvider } from '../shared/agentProvider';
import { posix } from 'node:path';

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

/** After a device agent's terminal died: was it only a detach (the agent
 *  still runs in its tmux session), or did the agent itself end? Only a
 *  definite "no such session" (has-session exit 1 on an online device)
 *  counts as ended. A dead link or a failed check must never archive a live
 *  agent. */
export function isDetach(state: DeviceState, hasSessionCode: number): boolean {
  return !(state === 'online' && hasSessionCode === 1);
}

/** The roster's agents on a device, on the floor or waiting in the restore
 *  list, for reconcile and Check. The roster's agent shape is the renderer's
 *  (roster.ts keeps it opaque), so it is read defensively. */
export function rosterAgentsOn(
  roster: { agents?: unknown[]; restorable?: unknown[] } | null,
  deviceId: string
): Array<{ id: string; cwd?: string; provider?: string; command?: string }> {
  const out: Array<{ id: string; cwd?: string; provider?: string; command?: string }> = [];
  for (const a of [...(roster?.agents ?? []), ...(roster?.restorable ?? [])]) {
    if (!a || typeof a !== 'object') continue;
    const { id, cwd, device, lastDevice, provider, command } = a as Record<string, unknown>;
    // An Auto agent lives where it last ran: reconcile must keep its session,
    // and Check must cover its folder there.
    const on = device === AUTO_DEVICE ? lastDevice : device;
    if (typeof id !== 'string' || on !== deviceId) continue;
    // Check also needs each agent's engine (devices phase 2, item 5).
    out.push({
      id,
      ...(typeof cwd === 'string' ? { cwd } : {}),
      ...(typeof provider === 'string' ? { provider } : {}),
      ...(typeof command === 'string' ? { command } : {})
    });
  }
  return out;
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
 *  quietly. fusermount3 is fuse3's name, fusermount fuse2's.
 *
 *  No caching: sshfs keeps directory listings and attributes for 20 s by
 *  default, so an agent woken for new mail could list its inbox and not see
 *  the file yet, and a launch.sh rewritten at another length within 20 s
 *  could be read at its stale size (a truncated or padded script). */
export function mountCommand(hiveRoot: string, base: number): string {
  const h = shq(hiveRoot);
  const hint = shq(`Cannot create ${hiveRoot} on the device. If it is a dead mount, run there: fusermount3 -uz ${h} (or fusermount -uz); otherwise check the permissions of its parent folder.`);
  return `mountpoint -q ${h} || { fusermount3 -uz ${h} 2>/dev/null || fusermount -uz ${h} 2>/dev/null; mkdir -p ${h} || { printf '%s\\n' ${hint} >&2; exit 2; }; [ -z "$(ls -A ${h})" ] || { echo ${NOT_EMPTY}; exit 3; }; sshfs -o directport=${base},reconnect,ServerAliveInterval=15,dir_cache=no,entry_timeout=0,attr_timeout=0,negative_timeout=0 127.0.0.1:${h} ${h}; }`;
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

// ─── god's spawn requests ────────────────────────────────────────────────────

/** A spawn request's `device`. Absent, '' or 'local' = this laptop. An
 *  unknown, offline or still-connecting device fails the request, with a
 *  reason god can read in `.failed/`. */
export function validateSpawnDevice(device: unknown, states: Record<string, DeviceState>): { device?: string; error?: string } {
  if (device !== undefined && typeof device !== 'string') return { error: '"device" must be a device id' };
  const id = normalizeDeviceId(device);
  if (!id) return {};
  // Placed when the worker starts (index.ts placeAuto).
  if (id === AUTO_DEVICE) return { device: AUTO_DEVICE };
  if (!Object.hasOwn(states, id)) return { error: `unknown device "${id}"` };
  if (states[id] !== 'online') return { error: `device "${id}" is ${states[id]}` };
  return { device: id };
}

// ─── Moving an agent: its conversation file (devices phase 2, item 1) ────────

/** readTranscriptCommand's exit code when the file is not there. */
export const TRANSCRIPT_MISSING = 3;

function projectDirSh(cwd: string): string {
  return `"$HOME"/.claude/projects/${shq(projectKey(cwd))}`;
}

/** Print a session's transcript, or exit TRANSCRIPT_MISSING. */
export function readTranscriptCommand(cwd: string, sessionId: string): string {
  const f = `${projectDirSh(cwd)}/${shq(`${sessionId}.jsonl`)}`;
  return `[ -f ${f} ] || exit ${TRANSCRIPT_MISSING}; cat ${f}`;
}

/** Write stdin as a session's transcript. It goes through a temp file, so a
 *  link cut mid-copy never leaves half a conversation where `--resume`
 *  would find it. */
export function writeTranscriptCommand(cwd: string, sessionId: string): string {
  const d = projectDirSh(cwd);
  const part = `${d}/${shq(`.${sessionId}.jsonl.part`)}`;
  return `mkdir -p ${d} && cat > ${part} && mv -f ${part} ${d}/${shq(`${sessionId}.jsonl`)}`;
}

// ─── Automatic placement (devices phase 2, item 2) ───────────────────────────

/** One device's load, as the spec states it. */
export const LOAD_COMMAND = 'cat /proc/loadavg; nproc; grep MemAvailable /proc/meminfo';

/** One candidate machine. `id` is a device id, or 'local' for this laptop. */
export interface LoadSample {
  id: string;
  load1: number;
  cores: number;
  /** Bytes. */
  memAvailable: number;
}

export function parseLoad(id: string, out: string): LoadSample | null {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const load1 = parseFloat((lines[0] ?? '').split(/\s+/)[0]);
  const cores = parseInt(lines[1] ?? '', 10);
  const kb = /^MemAvailable:\s+(\d+)\s*kB/.exec(lines[2] ?? '');
  if (!Number.isFinite(load1) || !(cores > 0) || !kb) return null;
  return { id, load1, cores, memAvailable: Number(kb[1]) * 1024 };
}

/** Candidates under 1.5 load per core qualify; the one with the most free
 *  memory wins; if none qualifies, the most free memory overall. Ties go to
 *  this laptop, so an agent never crosses the network for nothing. */
export function pickDevice(samples: LoadSample[]): string {
  const calm = samples.filter((x) => x.load1 / x.cores < 1.5);
  const pool = calm.length ? calm : samples;
  let best: LoadSample | undefined;
  for (const x of pool) {
    if (!best || x.memAvailable > best.memAvailable || (x.memAvailable === best.memAvailable && x.id === LOCAL_DEVICE)) best = x;
  }
  return best?.id ?? LOCAL_DEVICE;
}

// ─── The base folder (devices phase 2, item 3) ───────────────────────────────
// The hive's own files hold absolute paths (PROTOCOL.md, fleet.json, task
// cards, mail), so the device must have the same paths. A symlink there makes
// them exist with no translation anywhere.

/** The parent of the hive home: `/home/royal/Pro/Zensible` for a hive at
 *  `/home/royal/Pro/Zensible/<home>/hive`. */
export function baseFolder(hiveRoot: string): string {
  return posix.dirname(posix.dirname(hiveRoot));
}

export const BASE_OK = 'MD_BASE_OK';

/** Prints BASE_OK when the base folder exists (symlinks followed); else
 *  `home:<device $HOME>` when the same layout exists under the device
 *  user's home; else `missing`. */
export function basePathCommand(base: string, localHome: string): string {
  const rest = base === localHome ? '' : base.startsWith(`${localHome}/`) ? base.slice(localHome.length + 1) : null;
  const same = rest === null ? '' : `elif [ -d "$HOME"/${shq(rest)} ]; then printf 'home:%s\\n' "$HOME"; `;
  return `if [ -d ${shq(base)} ]; then echo ${BASE_OK}; ${same}else echo missing; fi`;
}

/** The command that makes the base folder exist on the device, or null when
 *  it already does. `<their folder>` is left for the person to fill in: only
 *  they know where the repos live on that machine. */
export function basePathFix(base: string, localHome: string, probeOut: string): string | null {
  if (probeOut.includes(BASE_OK)) return null;
  const home = /^home:(.+)$/m.exec(probeOut);
  if (home) return `sudo ln -s ${shq(home[1].trim())} ${shq(localHome)}`;
  return `sudo mkdir -p ${shq(posix.dirname(base))} && sudo ln -s <their folder> ${shq(base)}`;
}

// ─── Windows through WSL2 (devices phase 2, item 6) ──────────────────────────

const WSL_SEP = '__MD_WSL__';

/** /proc/version, /etc/wsl.conf and /dev/fuse, in one round trip. */
export const WSL_PROBE = `cat /proc/version 2>/dev/null; echo ${WSL_SEP}; cat /etc/wsl.conf 2>/dev/null; echo ${WSL_SEP}; [ -e /dev/fuse ] && echo fuse`;

/** Is `systemd=true` set under `[boot]`? The last setting wins. */
export function wslSystemdOn(conf: string): boolean {
  let section = '';
  let on = false;
  for (const raw of conf.split('\n')) {
    const line = raw.replace(/[#;].*$/, '').trim();
    const head = /^\[(.+)\]$/.exec(line);
    if (head) { section = head[1].trim().toLowerCase(); continue; }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (section === 'boot' && kv && kv[1].trim().toLowerCase() === 'systemd') on = kv[2].trim().toLowerCase() === 'true';
  }
  return on;
}

export function parseWslProbe(out: string): { wsl: boolean; systemd: boolean; fuse: boolean } {
  const [version = '', conf = '', fuse = ''] = out.split(`${WSL_SEP}\n`);
  return { wsl: /microsoft/i.test(version), systemd: wslSystemdOn(conf), fuse: fuse.trim() === 'fuse' };
}

/** Check's WSL items; none on a plain Linux device. systemd keeps tailscaled
 *  and our tmux running; /dev/fuse is what the hive mount needs. The two
 *  Windows-side settings cannot be seen from inside WSL, so they are
 *  reminders. */
export function wslCheckItems(p: { wsl: boolean; systemd: boolean; fuse: boolean }): DeviceCheckItem[] {
  if (!p.wsl) return [];
  return [
    p.systemd
      ? { id: 'wslSystemd', ok: true }
      : { id: 'wslSystemd', ok: false, fix: 'sudoedit /etc/wsl.conf   # under [boot] set systemd=true; then, in Windows: wsl --shutdown' },
    p.fuse
      ? { id: 'wslFuse', ok: true }
      : { id: 'wslFuse', ok: false, fix: 'sudo apt install fuse3   # then, in Windows: wsl --shutdown' },
    { id: 'wslIdle', ok: true, reminder: true, fix: 'In Windows, %UserProfile%\\.wslconfig: [wsl2] vmIdleTimeout=-1, then wsl --shutdown' },
    { id: 'wslSleep', ok: true, reminder: true, fix: 'In Windows, an admin terminal: powercfg /change standby-timeout-ac 0 and powercfg /change hibernate-timeout-ac 0' }
  ];
}

// ─── Other engines on a device (devices phase 2, item 5) ─────────────────────

/** Is an engine's CLI on the device's login PATH, and how to install it. */
export function engineCheck(provider: AgentProvider, bin: string): { cmd: string; fix: string } {
  const info = installInfoForProvider(provider, 'linux');
  return {
    cmd: `command -v ${shq(bin)} >/dev/null`,
    fix: info.nativeCommand ?? info.command ?? `install ${bin} on the device, on its login PATH`
  };
}

/** The device's $HOME and the login shell's node: hook commands bake in both
 *  as absolute paths, because engines run hooks with a stripped PATH. */
export const REMOTE_ENV_PROBE = `printf 'home=%s\\nnode=%s\\n' "$HOME" "$(command -v node)"`;

export function parseRemoteEnv(out: string): { home: string; node: string } | null {
  const home = /^home=(.*)$/m.exec(out)?.[1].trim() ?? '';
  const node = /^node=(.*)$/m.exec(out)?.[1].trim() ?? '';
  return home.startsWith('/') && node.startsWith('/') ? { home, node } : null;
}

/** Write stdin to a file under the device's home, making its folders. */
export function writeHomeFileCommand(rel: string): string {
  return `f="$HOME"/${shq(rel)}; mkdir -p "$(dirname "$f")" && cat > "$f"`;
}

// The same rule installAgyHooks follows on this laptop: an unparseable or
// non-object file becomes {}, every other key is kept, only `key` is set.
const MERGE_JS = [
  "const fs=require('fs'),p=require('path');",
  "const f=p.join(require('os').homedir(),process.argv[1]),k=process.argv[2];let v='';",
  "process.stdin.setEncoding('utf8').on('data',d=>{v+=d}).on('end',()=>{",
  "let o={};try{o=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){}",
  'if(!o||typeof o!=="object"||Array.isArray(o))o={};',
  'o[k]=JSON.parse(v);fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(o,null,2))})'
].join('');

/** Set one key of a JSON file under the device's home to the JSON on stdin. */
export function mergeHomeJsonCommand(rel: string, key: string): string {
  return `node -e ${shq(MERGE_JS)} ${shq(rel)} ${shq(key)}`;
}

// ─── Proxy-tier engines on a device (devices phase 2, item 5) ────────────────

/** The first proxy slot: base = SFTP, +1 hooks, +2 telemetry, then proxies. */
export const PROXY_SLOT_FIRST = 3;

/** Add or cancel one remote forward on the running master. A new master
 *  starts with only its three, so the link re-adds these on every connect. */
export function forwardArgs(ctl: string, target: string, op: 'forward' | 'cancel', devicePort: number, localPort: number): string[] {
  return ['-S', ctl, '-O', op, '-R', `127.0.0.1:${devicePort}:127.0.0.1:${localPort}`, '--', target];
}
