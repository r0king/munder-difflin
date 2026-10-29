/**
 * Devices: one SSH link per configured device (spec: "Device link").
 *
 * A link owns one ControlMaster `ssh` that carries three reverse forwards
 * (hive SFTP, hooks, telemetry). It mounts this laptop's hive on the device
 * through the first, and runs every other remote command as a short-lived
 * client of that master (`exec`). When the master exits, the device goes
 * offline and the link reconnects on a backoff of 2 s, 5 s, 15 s, 30 s, then
 * every 60 s; after a refused host key it waits for a Check instead. Agents'
 * terminals are `ssh -tt` clients of the same master (remoteTerminal below), so a dead link ends them too; index.ts reattaches
 * them when the link emits `online` again.
 *
 * Events: 'state' (DeviceStatus) on every change; 'online' once the hive is
 * mounted, which is the moment a device can take agents.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, freemem, homedir, loadavg, tmpdir, userInfo } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { LOCAL_DEVICE, normalizeDevices, type ConversationStayed, type DeviceCheckItem, type DeviceConfig, type DeviceState, type DeviceStatus } from '../shared/devices';
import {
  backoffDelay, baseFolder, basePathCommand, basePathFix, checkCommands, LOAD_COMMAND, parseLoad, type LoadSample, controlArgs, controlPath, execArgs, hostKeyFailed, installShimCommand, launchPath, launchScript,
  masterArgs, masterExitReason, mountCommand, NOT_EMPTY, parseFenced, portBase, readTranscriptCommand, sshTarget,
  terminalArgs, TMUX_CONF, tmuxConfPath, TRANSCRIPT_MISSING, writeTranscriptCommand
} from './deviceCommands';
import { projectKey } from './transcript';
import type { SpawnOptions } from './pty';

export interface ExecResult {
  /** The command ran on the device and exited 0. */
  ok: boolean;
  /** Its exit code, or -1 when it never ran (offline, timeout, ssh failed). */
  code: number;
  stdout: string;
  stderr: string;
  error?: string;
}

/** What a link needs from the app around it. The last four are test seams. */
export interface LinkEnv {
  hiveRoot: string;
  hookSock: string;
  /** The shared SFTP server's port, or null when it could not start. */
  sftpPort: number | null;
  sftpError?: string;
  /** The OTLP collector's port, or null when telemetry is off. */
  telemetryPort: number | null;
  sshBin?: string;
  sshEnv?: NodeJS.ProcessEnv;
  runDir?: string;
  backoff?: (attempt: number) => number;
  /** This laptop's home folder, for the base-path fix (a test seam). */
  localHome?: string;
  /** The device's mount table (a test seam; default /proc/self/mounts). */
  mountsFile?: string;
}

/** /run/user/<uid> keeps the ControlPath short; a Unix socket path must be under 108 bytes. */
function defaultRunDir(): string {
  const d = `/run/user/${userInfo().uid}`;
  return existsSync(d) ? d : tmpdir();
}

export class DeviceLink extends EventEmitter {
  state: DeviceState = 'offline';
  error: string | undefined;
  private master: ChildProcess | null = null;
  private running = false;
  private attempt = 0;
  private retry: NodeJS.Timeout | null = null;
  /** Set when the link ends the master itself, so the exit says why. */
  private killReason: string | undefined;

  constructor(readonly device: DeviceConfig, private readonly env: LinkEnv) {
    super();
  }

  get id(): string { return this.device.id; }
  get portBase(): number { return portBase(this.device); }
  get sshBin(): string { return this.env.sshBin ?? 'ssh'; }
  get mountsFile(): string | undefined { return this.env.mountsFile; }
  ctl(): string { return controlPath(this.id, this.env.runDir ?? defaultRunDir()); }
  target(): string { return sshTarget(this.device, userInfo().username); }
  status(): DeviceStatus {
    return this.error ? { id: this.id, state: this.state, error: this.error } : { id: this.id, state: this.state };
  }

  /** Idempotent: a link never runs two masters. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const m = this.master;
    this.master = null;
    if (m) { try { m.kill(); } catch { /* already gone */ } }
    rmSync(this.ctl(), { force: true });
    this.setState('offline', undefined);
  }

  /** Try once now, for a link that stopped retrying (a refused host key, a
   *  bad host). No-op while connected, connecting or waiting on the backoff. */
  async reconnect(): Promise<void> {
    if (!this.running || this.master || this.retry) return;
    await this.connect();
  }

  /** Run one command on the device over the master, under `bash -lc` so it
   *  sees the login PATH. Fails at once while the device is not online. */
  exec(cmd: string, timeoutMs = 15_000, input?: string): Promise<ExecResult> {
    if (this.state !== 'online') {
      return Promise.resolve({ ok: false, code: -1, stdout: '', stderr: '', error: `${this.id} is offline` });
    }
    return this.run(cmd, timeoutMs, input);
  }

  private setState(state: DeviceState, error: string | undefined): void {
    this.state = state;
    this.error = error;
    this.emit('state', this.status());
  }

  private async connect(): Promise<void> {
    if (!this.running || this.master) return;
    if (this.env.sftpPort === null) {
      // Nothing to retry: the SFTP server is this laptop's, and it did not start.
      this.setState('offline', this.env.sftpError ?? 'No SFTP server on this laptop.');
      return;
    }
    try {
      this.target();
    } catch (e) {
      // A host or user ssh would read as an option. Nothing to retry, and
      // no ssh is ever spawned for it (sshTarget is in every argv).
      this.setState('offline', (e as Error).message);
      return;
    }
    // Keep the last error showing while we try again.
    this.setState('connecting', this.error);
    await this.clearStaleControlPath();
    if (!this.running) return;
    mkdirSync(dirname(this.ctl()), { recursive: true });
    let stderr = '';
    const m = spawn(this.sshBin, masterArgs(this.device, this.ctl(), userInfo().username, {
      sftp: this.env.sftpPort,
      hookSock: this.env.hookSock,
      telemetry: this.env.telemetryPort
    }), { stdio: ['ignore', 'ignore', 'pipe'], env: this.env.sshEnv });
    this.master = m;
    const gone = (): void => {
      if (this.master !== m) return; // stop(), or already handled
      this.master = null;
      const why = masterExitReason(stderr, this.id, this.killReason, this.target());
      this.killReason = undefined;
      this.setState('offline', why);
      // A refused host key never fixes itself: wait for a Check (reconnect).
      if (!hostKeyFailed(stderr)) this.scheduleReconnect();
    };
    m.stderr?.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
    m.on('error', (e) => { stderr += `\n${e.message}`; gone(); });
    m.on('close', gone);

    if (!(await this.waitForMaster(m))) return;
    const mount = await this.run(`${mountCommand(this.env.hiveRoot, this.portBase, this.env.mountsFile)} && ${installShimCommand(this.env.hiveRoot)}`, 30_000);
    if (this.master !== m) return;
    if (!mount.ok) {
      // mkdir failed (exit 2): usually this laptop's base folder does not
      // exist there (another user, another layout). Say how to make it exist.
      const fix = mount.code === 2 ? await this.baseFix() : null;
      if (this.master !== m) return;
      this.killReason = mount.stdout.includes(NOT_EMPTY)
        ? `The hive folder on ${this.id} is not empty, so it was not mounted. Move it aside on ${this.id}: mv ${this.env.hiveRoot} ${this.env.hiveRoot}.local`
        : fix
          ? `${baseFolder(this.env.hiveRoot)} does not exist on ${this.id}, so the hive cannot be mounted at the same path. On ${this.id}, run: ${fix}`
          : `Could not mount the hive on ${this.id}: ${mount.error ?? (mount.stderr.trim() || `exit ${mount.code}`)}`;
      m.kill();
      return;
    }
    this.attempt = 0;
    this.setState('online', undefined);
    this.emit('online');
  }

  /** The command that makes this laptop's base folder exist on the device,
   *  or null when it exists or the probe got no answer. */
  private async baseFix(): Promise<string | null> {
    const base = baseFolder(this.env.hiveRoot);
    const home = this.env.localHome ?? homedir();
    const r = await this.run(basePathCommand(base, home), 10_000);
    return r.ok ? basePathFix(base, home, r.stdout) : null;
  }

  /** The master gives no "ready" signal, so ask it (`-O check`) until it answers. */
  private async waitForMaster(m: ChildProcess, timeoutMs = 20_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (this.master === m && Date.now() < until) {
      const r = await this.spawnSsh(controlArgs(this.ctl(), this.target(), 'check'), 5_000);
      if (r.code === 0) return this.master === m;
      await new Promise((res) => setTimeout(res, 300));
    }
    if (this.master === m) {
      this.killReason = `${this.id} did not answer within ${timeoutMs / 1000} s.`;
      m.kill();
    }
    return false;
  }

  /** A ControlPath left by a crashed app makes a new `ssh -M` quietly run as
   *  a plain client ("ControlSocket … already exists, disabling
   *  multiplexing") that never answers `-O check`. Ask any old master to exit
   *  (its forwards point at ports of an app that is gone), then remove it. */
  private async clearStaleControlPath(): Promise<void> {
    if (!existsSync(this.ctl())) return;
    await this.spawnSsh(controlArgs(this.ctl(), this.target(), 'exit'), 3_000);
    rmSync(this.ctl(), { force: true });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = (this.env.backoff ?? backoffDelay)(this.attempt++);
    this.retry = setTimeout(() => { this.retry = null; void this.connect(); }, delay);
  }

  private async run(cmd: string, timeoutMs: number, input?: string): Promise<ExecResult> {
    const r = await this.spawnSsh(execArgs(this.ctl(), this.target(), cmd), timeoutMs, input);
    const fenced = parseFenced(r.stdout);
    if (!fenced) {
      return { ok: false, code: -1, stdout: '', stderr: r.stderr, error: r.stderr.trim().split('\n').pop() || `No answer from ${this.id}.` };
    }
    return { ok: fenced.code === 0, code: fenced.code, stdout: fenced.out, stderr: r.stderr };
  }

  private spawnSsh(args: string[], timeoutMs: number, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const p = spawn(this.sshBin, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], env: this.env.sshEnv });
      if (input !== undefined) {
        // ssh may die before reading it all; its exit reports that, not this.
        p.stdin?.on('error', () => { /* reported by close */ });
        p.stdin?.end(input);
      }
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
      // One decoder for the whole stream: a multi-byte character split
      // across two reads would become two U+FFFD with a per-chunk toString().
      p.stdout?.setEncoding('utf8');
      p.stdout?.on('data', (d: string) => { stdout += d; });
      p.stderr?.on('data', (d) => { stderr += d.toString(); });
      p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: `${stderr}${e.message}` }); });
      p.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    });
  }
}

/** The running links, one per configured device. */
export class DeviceRegistry extends EventEmitter {
  private links = new Map<string, DeviceLink>();

  constructor(private readonly env: () => LinkEnv) {
    super();
  }

  /** Match the running links to the configured devices: start new ones, stop
   *  removed ones, and restart one whose host, user or ports changed. */
  sync(raw: DeviceConfig[]): void {
    // readConfig() does not validate devices, and config.json can be edited
    // by hand: drop anything that is not a well-formed device here.
    const devices = normalizeDevices(raw);
    const want = new Map(devices.map((d) => [d.id, d]));
    for (const [id, link] of this.links) {
      const d = want.get(id);
      if (d && JSON.stringify(d) === JSON.stringify(link.device)) continue;
      link.stop();
      link.removeAllListeners();
      this.links.delete(id);
    }
    for (const d of devices) {
      if (this.links.has(d.id)) continue;
      const link = new DeviceLink(d, this.env());
      link.on('state', (s: DeviceStatus) => this.emit('state', s));
      link.on('online', () => this.emit('online', link));
      this.links.set(d.id, link);
      link.start();
    }
  }

  get(id: string): DeviceLink | undefined { return this.links.get(id); }
  all(): DeviceLink[] { return [...this.links.values()]; }
  statuses(): DeviceStatus[] { return this.all().map((l) => l.status()); }
  stopAll(): void { for (const l of this.links.values()) l.stop(); }
}

/** Write `file` as a new file and rename it into place. Agents can write in
 *  the hive, and the app is unsandboxed: writeFileSync/chmodSync on a path an
 *  agent swapped for a symlink would overwrite and chmod the link's target.
 *  The temp file is created exclusively ('wx', so never through a planted
 *  link), and rename replaces a link at `file` itself, never what it points to.
 *  A link at a parent folder (agents/<id>, devices) would carry both outside
 *  the hive, so the real parent must sit inside the real hive root. */
function replaceFile(hiveRoot: string, file: string, data: string, mode: number): void {
  const root = realpathSync(hiveRoot);
  const parent = realpathSync(dirname(file));
  if (parent !== root && !parent.startsWith(root + sep)) {
    throw new Error(`refusing to write ${file}: its folder resolves to ${parent}, outside the hive`);
  }
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, data, { flag: 'wx', mode });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Write what a device agent's terminal runs (its launch.sh, and the shared
 *  tmux.conf, both in the hive, which the device sees through the mount) and
 *  return the pty spawn: `ssh -tt … tmux new-session -A …`. pty.ts stays the
 *  one place a terminal starts. */
export function remoteTerminal(
  link: DeviceLink,
  hiveRoot: string,
  o: { ptyId: string; agentId: string; cwd: string; env: Record<string, string>; args: string[]; cols?: number; rows?: number }
): SpawnOptions {
  const launch = launchPath(hiveRoot, o.agentId);
  mkdirSync(dirname(launch), { recursive: true });
  // Owner-only: it carries the agent's env, capability tokens included. A
  // fresh file each time, so a launch.sh left wider (a copied or restored
  // hive) never keeps its old mode.
  replaceFile(hiveRoot, launch, launchScript({ cwd: o.cwd, env: o.env, command: 'claude', args: o.args }), 0o600);
  mkdirSync(dirname(tmuxConfPath(hiveRoot)), { recursive: true });
  replaceFile(hiveRoot, tmuxConfPath(hiveRoot), TMUX_CONF, 0o644);
  return {
    id: o.ptyId,
    cwd: o.cwd,
    command: link.sshBin,
    args: terminalArgs(link.ctl(), link.target(), hiveRoot, o.agentId, o.cwd),
    cols: o.cols,
    rows: o.rows,
    remote: true
  };
}

/** Settings → Devices → Check: each setup item over the link, pass or fail,
 *  with the command that fixes a failure. The in-app twin of
 *  scripts/devices-smoke.sh. Offline, it first tries once to connect (a link
 *  stopped by a refused host key waits for this); still offline, the only
 *  answer is the login line, carrying the link's own reason. Fix texts stay English (built in main,
 *  like masterExitReason): they are shell commands and tool output. */
export async function checkDevice(
  link: DeviceLink | undefined,
  hiveRoot: string,
  folders: string[],
  localHome: string = homedir()
): Promise<DeviceCheckItem[]> {
  if (link?.state === 'offline') await link.reconnect();
  if (!link || link.state !== 'online') {
    return [{ id: 'login', ok: false, fix: link?.error ?? 'Not connected yet. Check the host, and that Tailscale SSH is on for this device.' }];
  }
  const out: DeviceCheckItem[] = [];
  for (const c of checkCommands(hiveRoot, folders, link.mountsFile)) {
    const r = await link.exec(c.cmd, 20_000);
    out.push({ id: c.item, ...(c.path ? { path: c.path } : {}), ok: r.ok, ...(r.ok ? {} : { fix: c.fix }) });
    // Right after login: the base folder, which every path the hive holds needs.
    if (c.item === 'login') out.push(await checkBase(link, hiveRoot, localHome));
  }
  return out;
}

// ─── Moving an agent: its conversation file (devices phase 2, item 1) ────────

export type TranscriptCopyResult = { ok: true } | { ok: false; reason: ConversationStayed['reason'] };

/** Claude's session ids are UUIDs. Anything else never becomes a path. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A transcript is a few MB; over Tailscale that takes seconds. */
const COPY_TIMEOUT_MS = 120_000;

function localTranscript(home: string, cwd: string, sessionId: string): string {
  return join(home, '.claude', 'projects', projectKey(cwd), `${sessionId}.jsonl`);
}

/** Copy `~/.claude/projects/<projectKey(cwd)>/<sid>.jsonl` from where the
 *  agent ran to where it is about to run: this laptop (`undefined`) or a
 *  device, at the same path. Device to device passes through this laptop.
 *  `home` is this laptop's home folder (a test seam). */
export async function copyTranscript(
  from: DeviceLink | undefined,
  to: DeviceLink | undefined,
  cwd: string,
  sessionId: string,
  home: string = homedir()
): Promise<TranscriptCopyResult> {
  if (!SESSION_ID.test(sessionId)) return { ok: false, reason: 'missing' };
  let body: string;
  if (from) {
    if (from.state !== 'online') return { ok: false, reason: 'offline' };
    const r = await from.exec(readTranscriptCommand(cwd, sessionId), COPY_TIMEOUT_MS);
    if (r.code === TRANSCRIPT_MISSING) return { ok: false, reason: 'missing' };
    // -1: the command never ran or never finished, i.e. the link went down.
    if (!r.ok) return { ok: false, reason: r.code === -1 ? 'offline' : 'failed' };
    body = r.stdout;
  } else {
    try { body = readFileSync(localTranscript(home, cwd, sessionId), 'utf8'); }
    catch { return { ok: false, reason: 'missing' }; }
  }
  if (to) {
    const w = await to.exec(writeTranscriptCommand(cwd, sessionId), COPY_TIMEOUT_MS, body);
    return w.ok ? { ok: true } : { ok: false, reason: 'failed' };
  }
  try {
    const dest = localTranscript(home, cwd, sessionId);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(`${dest}.part`, body);
    renameSync(`${dest}.part`, dest);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

// ─── Automatic placement (devices phase 2, item 2) ───────────────────────────

/** A device's load, or null when it did not answer (it is then no candidate). */
export async function readLoad(link: DeviceLink): Promise<LoadSample | null> {
  const r = await link.exec(LOAD_COMMAND, 10_000);
  return r.ok ? parseLoad(link.id, r.stdout) : null;
}

/** This laptop's load, the same three numbers. */
export function localLoad(): LoadSample {
  return { id: LOCAL_DEVICE, load1: loadavg()[0], cores: cpus().length || 1, memAvailable: freemem() };
}

/** Check's base-folder item (devices phase 2, item 3). */
async function checkBase(link: DeviceLink, hiveRoot: string, localHome: string): Promise<DeviceCheckItem> {
  const base = baseFolder(hiveRoot);
  const r = await link.exec(basePathCommand(base, localHome), 20_000);
  const fix = basePathFix(base, localHome, r.ok ? r.stdout : '');
  return fix ? { id: 'base', path: base, ok: false, fix } : { id: 'base', path: base, ok: true };
}
