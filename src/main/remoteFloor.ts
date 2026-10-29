/**
 * RemoteFloor — the phone-first control page (devices phase 2, item 8).
 *
 * A small Node `http` server that shows the floor on Royal's phone or my-lap
 * over Tailscale: every agent and device, god's open questions, recent mail,
 * and stop / restart / pause-delivery. Claude Code's Remote Control already
 * covers chat, prompts and terminals from the Claude app, so this page covers
 * only what that app can't show — the floor itself.
 *
 * SECURITY — the tailnet is the perimeter, and the owner is the only reader:
 *   - it binds ONLY to this machine's Tailscale IPv4 (`tailscale ip -4`),
 *     never 0.0.0.0 or the LAN; with no address it retries every 30 s,
 *   - every request's peer IP goes through `tailscale whois`, cached 60 s per
 *     IP, and is served only when that login equals the login that owns this
 *     node. A failed or missing whois is a 403, never a pass,
 *   - the Host header must name this server (its IP, or a MagicDNS name), so a
 *     DNS-rebinding page in the owner's own browser can't read the floor,
 *   - a POST also needs an Origin/Referer whose host:port equals Host,
 *   - no passwords and no tokens in URLs; JSON bodies are capped at 64 KB,
 *   - the page renders every agent-written string as text, never as HTML.
 *
 * Everything the floor knows comes from an injected {@link FloorSource}; the
 * Tailscale lookups are injected too. Runs in the Electron main process with
 * no `electron` import, so test/remote-floor.test.cjs drives it on 127.0.0.1.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { REMOTE_FLOOR_PAGE } from './remoteFloorPage';

export const DEFAULT_REMOTE_FLOOR_PORT = 47980;
const MAX_BODY_BYTES = 64 * 1024;
const WHOIS_TTL_MS = 60_000;
const BIND_RETRY_MS = 30_000;
const HEARTBEAT_MS = 25_000;
const TAILSCALE_TIMEOUT_MS = 5_000;

/** The floor's words for an agent's state, as the page shows them. */
export type FloorAgentStatus = 'working' | 'idle' | 'needs-you' | 'paused' | 'offline';

export interface FloorAgent {
  id: string;
  name: string;
  role: string;
  /** Device name the agent runs on; 'local' for this laptop. */
  device: string;
  /** 'needs-you' = waiting on a permission prompt (the page lists it under
   *  "Needs you" with its Remote Control link). */
  status: FloorAgentStatus;
  /** Context window used, 0–100, or null when unknown. */
  contextPct: number | null;
  /** Today's spend in USD, or null when unknown. */
  costTodayUsd: number | null;
  /** The agent's Remote Control session URL (https only), or null. */
  remoteControlUrl: string | null;
  /** Auto-delivery is paused for this agent (ControlRegistry). */
  deliveryPaused: boolean;
}

/** One unanswered `humanQA` entry on a task card. */
export interface FloorQuestion {
  taskId: string;
  taskTitle: string;
  /** Index of the entry in the card's `humanQA` array. */
  qIndex: number;
  q: string;
  askedAt?: string;
}

export interface FloorMail {
  id: string;
  from: string;
  to: string;
  subject: string;
  /** Already redacted (hive.voiceMessages redacts main-side). */
  body: string;
  createdAt: string;
}

export interface FloorDevice {
  id: string;
  name: string;
  state: 'online' | 'connecting' | 'offline';
}

export interface FloorState {
  agents: FloorAgent[];
  questions: FloorQuestion[];
  mail: FloorMail[];
  devices: FloorDevice[];
}

export interface FloorActionResult { ok: boolean; error?: string }

/**
 * Everything the page reads and does, injected by src/main/index.ts. Each
 * member names the existing function the wiring should call, so the page acts
 * exactly as the floor does and the hive can't tell which surface was used.
 */
export interface FloorSource {
  /**
   * The floor right now. Build from:
   *  - agents: `hive.registry().agents` (not archived) joined with the fleet
   *    snapshot fields of `writeFleetSnapshot()` (name, role, usd, onHold,
   *    lastActiveSecAgo), `hive:agentContext` for context %, the cost ledger
   *    for today's spend, `control.snapshot(id).paused` → 'paused',
   *    `controlSnapshotWithFloorHold(id).autoDeliveryPaused` → deliveryPaused,
   *    the device link state → 'offline', and the agent's Remote Control URL
   *    when the session reported one;
   *  - questions: `hive.tasks()` cards whose `humanQA` entry has a string `q`
   *    and no `a` / `dismissedAt` (TasksKanban `openQuestion()`);
   *  - mail: `hive.voiceMessages({ limit })` filtered to from/to 'human' and
   *    god (`hive.isGod`), newest first — bodies are already redacted;
   *  - devices: each DeviceLink's `offline | connecting | online` state.
   */
  state(): FloorState | Promise<FloorState>;
  /**
   * Subscribe to "the floor changed"; returns the unsubscribe. Fire it from
   * the same moments the renderer is told: the fleet snapshot timer
   * (`writeFleetSnapshot`), `hive.setRoutedObserver`, task writes, control
   * changes and device link state changes. Bursts are fine; each one sends
   * one SSE `change` event.
   */
  onChange(listener: () => void): () => void;
  /**
   * Answer god's open question, exactly as the Ask Me tab does: re-read
   * `findRawTask(hive.tasks(), taskId)`, take `humanQA[qIndex].q`, apply
   * `answerHumanQA(humanQA, q, text, nowIso)` (shared/workspace/inboxAsk.ts),
   * write it with `hive.patchTask(taskId, { humanQA })`, then
   * `hive.send(answerMail(task, q, text), 'human')`. A question that is no
   * longer open returns `{ ok: false }`.
   */
  answerQuestion(taskId: string, qIndex: number, text: string): Promise<FloorActionResult>;
  /** Mail an agent's inbox from the human: the `hive:send` handler's body —
   *  `hive.send({ to: agentId, act: 'inform', subject, body: text }, 'human')`
   *  plus `analytics.trackMessageSent('hive')`. */
  sendMail(agentId: string, text: string): Promise<FloorActionResult>;
  /** Stop cleanly at the next hook boundary: the floor's Stop button
   *  (`control:halt` → `control.halt(agentId)`). */
  stopAgent(agentId: string): Promise<FloorActionResult>;
  /** Restart in place, continuing the conversation when the engine can. The
   *  restart lives in the renderer (`restartAgentProcess(id, { resume: true,
   *  resumeOptional: true })`, workspace/agents/restartAgent.ts), so main must
   *  ask the renderer over IPC; call `control.resume(agentId)` first so a
   *  halted agent's flag doesn't stop the new process. */
  restartAgent(agentId: string): Promise<FloorActionResult>;
  /** Pause or resume auto-delivery: the `control:autoDelivery` handler's body
   *  (`control.pauseAutoDelivery`, persist `autoDeliveryPausedAgents`, and
   *  `liftFloorDeliveryPause()` on resume). */
  setAutoDelivery(agentId: string, paused: boolean): Promise<FloorActionResult>;
}

export interface RemoteFloorOptions {
  source: FloorSource;
  /** Config `remoteFloorPort`. */
  port?: number;
  whois?: (ip: string) => Promise<{ login: string } | null>;
  ownerLogin?: () => Promise<string | null>;
  bindAddress?: () => Promise<string | null>;
}

// ─── Default Tailscale lookups ───────────────────────────────────────────────

function tailscale(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('tailscale', args, { encoding: 'utf8', timeout: TAILSCALE_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

export async function tailscaleWhois(ip: string): Promise<{ login: string } | null> {
  const out = await tailscale(['whois', '--json', ip]);
  try {
    const login = out ? JSON.parse(out)?.UserProfile?.LoginName : null;
    return typeof login === 'string' && login ? { login } : null;
  } catch { return null; }
}

export async function tailscaleOwnerLogin(): Promise<string | null> {
  const out = await tailscale(['status', '--json']);
  try {
    const s = out ? JSON.parse(out) : null;
    const login = s?.User?.[String(s?.Self?.UserID)]?.LoginName;
    return typeof login === 'string' && login ? login : null;
  } catch { return null; }
}

export async function tailscaleIPv4(): Promise<string | null> {
  const out = await tailscale(['ip', '-4']);
  const ip = out?.split('\n')[0].trim();
  return ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
}

// ─── Server ──────────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(readonly status: number) { super(String(status)); }
}

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
    + "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};

export class RemoteFloor {
  private readonly source: FloorSource;
  private readonly port: number;
  private readonly whois: (ip: string) => Promise<{ login: string } | null>;
  private readonly ownerLogin: () => Promise<string | null>;
  private readonly bindAddress: () => Promise<string | null>;

  private server: Server | null = null;
  private boundIp: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private stopped = true;
  private readonly streams = new Set<ServerResponse>();
  private readonly whoisCache = new Map<string, { login: string | null; at: number }>();

  constructor(opts: RemoteFloorOptions) {
    this.source = opts.source;
    this.port = opts.port ?? DEFAULT_REMOTE_FLOOR_PORT;
    this.whois = opts.whois ?? tailscaleWhois;
    this.ownerLogin = opts.ownerLogin ?? tailscaleOwnerLogin;
    this.bindAddress = opts.bindAddress ?? tailscaleIPv4;
  }

  /** The address actually listened on, or null while waiting for Tailscale. */
  address(): { ip: string; port: number } | null {
    const a = this.server?.address();
    return a && typeof a === 'object' && this.boundIp ? { ip: this.boundIp, port: a.port } : null;
  }

  /** Start listening; resolves after the first bind attempt. With no Tailscale
   *  address (or a failed listen) it keeps retrying every 30 s until stop(). */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribe = this.source.onChange(() => { void this.broadcast(); });
    this.heartbeat = setInterval(() => {
      for (const res of this.streams) res.write(': ping\n\n');
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
    await this.tryBind();
  }

  private async tryBind(): Promise<void> {
    this.retryTimer = null;
    const ip = await this.bindAddress().catch(() => null);
    if (this.stopped) return;
    if (ip) {
      const server = createServer((req, res) => { void this.handle(req, res); });
      const ok = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false));
        server.listen(this.port, ip, () => resolve(true));
      });
      if (ok && !this.stopped) {
        this.server = server;
        this.boundIp = ip;
        return;
      }
      server.close();
      if (this.stopped) return;
    }
    this.retryTimer = setTimeout(() => { void this.tryBind(); }, BIND_RETRY_MS);
    this.retryTimer.unref();
  }

  /** Close the server and every open SSE stream; stop retrying. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.retryTimer = this.heartbeat = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const res of this.streams) res.end();
    this.streams.clear();
    const server = this.server;
    this.server = this.boundIp = null;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  }

  private async broadcast(): Promise<void> {
    if (!this.streams.size) return;
    let data: string;
    try { data = JSON.stringify(await this.source.state()); } catch { return; }
    for (const res of this.streams) res.write(`event: change\ndata: ${data}\n\n`);
  }

  // ─── Access ────────────────────────────────────────────────────────────────

  private async allowed(req: IncomingMessage): Promise<boolean> {
    const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (!ip) return false;
    let hit = this.whoisCache.get(ip);
    if (!hit || Date.now() - hit.at > WHOIS_TTL_MS) {
      const who = await this.whois(ip).catch(() => null);
      hit = { login: who?.login ?? null, at: Date.now() };
      this.whoisCache.set(ip, hit);
    }
    if (!hit.login) return false;
    const owner = await this.ownerLogin().catch(() => null);
    return !!owner && hit.login === owner;
  }

  /** Host must name this server: its bound IP, or a MagicDNS name (a short
   *  machine name or `*.ts.net`). Any other name means a DNS-rebinding page. */
  private hostOk(req: IncomingMessage): boolean {
    const host = req.headers.host;
    if (!host) return false;
    let name: string;
    try { name = new URL(`http://${host}`).hostname; } catch { return false; }
    return name === this.boundIp || name.endsWith('.ts.net') || !name.includes('.');
  }

  private static sameOrigin(req: IncomingMessage): boolean {
    const from = req.headers.origin ?? req.headers.referer;
    if (!from || !req.headers.host) return false;
    try { return new URL(from).host === req.headers.host; } catch { return false; }
  }

  // ─── Routes ────────────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.hostOk(req) || !(await this.allowed(req))) throw new HttpError(403);
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (req.method === 'GET') return await this.get(path, req, res);
      if (req.method !== 'POST') throw new HttpError(405);
      if (!RemoteFloor.sameOrigin(req)) throw new HttpError(403);
      const body = await readJson(req);
      const result = await this.post(path, body);
      send(res, result.ok ? 200 : 409, result);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error('[remoteFloor]', e);
      // A 413 arrives mid-upload: close the connection rather than drain it.
      if (status === 413) res.setHeader('connection', 'close');
      if (!res.headersSent) send(res, status, { ok: false, error: String(status) });
      else res.end();
    }
  }

  private async get(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (path === '/') {
      res.writeHead(200, PAGE_HEADERS);
      res.end(REMOTE_FLOOR_PAGE);
    } else if (path === '/api/state') {
      send(res, 200, await this.source.state());
    } else if (path === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write('retry: 5000\n\n');
      this.streams.add(res);
      req.on('close', () => this.streams.delete(res));
    } else {
      throw new HttpError(404);
    }
  }

  private async post(path: string, body: Record<string, unknown>): Promise<FloorActionResult> {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (path === '/api/answer') {
      const { taskId, qIndex } = body;
      if (typeof taskId !== 'string' || !taskId || !Number.isInteger(qIndex) || (qIndex as number) < 0 || !text) {
        throw new HttpError(400);
      }
      return this.source.answerQuestion(taskId, qIndex as number, text);
    }
    if (path === '/api/mail') {
      const { agentId } = body;
      if (typeof agentId !== 'string' || !agentId || !text) throw new HttpError(400);
      return this.source.sendMail(agentId, text);
    }
    const m = /^\/api\/agents\/([^/]+)\/(stop|restart|delivery)$/.exec(path);
    if (!m) throw new HttpError(404);
    let id: string;
    try { id = decodeURIComponent(m[1]); } catch { throw new HttpError(400); }
    if (m[2] === 'stop') return this.source.stopAgent(id);
    if (m[2] === 'restart') return this.source.restartAgent(id);
    if (typeof body.paused !== 'boolean') throw new HttpError(400);
    return this.source.setAutoDelivery(id, body.paused);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** A JSON object body, at most 64 KB (413 above, 400 when not an object). */
function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) return reject(new HttpError(413));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { req.removeAllListeners('data'); req.pause(); reject(new HttpError(413)); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (v && typeof v === 'object' && !Array.isArray(v)) resolve(v); else reject(new HttpError(400));
      } catch { reject(new HttpError(400)); }
    });
    req.on('error', () => reject(new HttpError(400)));
  });
}
