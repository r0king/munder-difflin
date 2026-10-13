/**
 * The routing log — who sent what to whom, and when — read from the hive's
 * event log (`<hive>/log.jsonl`).
 *
 * The router (HiveManager.routeMessage in src/main/hive.ts) appends one line per
 * routed message, plus a line for every way a message can fail to arrive:
 *
 *   { kind: 'message', from, to, act, subject, id, delivered: string[] }
 *   { kind: 'terminal-handoff', from, to, act, subject, id, delivered: boolean }
 *   { kind: 'archived-recipient', from, to, id, act }
 *   { kind: 'drop', reason, from, to?, id? }
 *
 * Every other kind on that log (spawn, drain, session, hooks, …) is lifecycle,
 * not routing, and is skipped here. Parsing is defensive: the log is
 * append-only and hand-editable, so a torn or foreign line is dropped, never
 * thrown on.
 *
 * Import-free on purpose so node:test loads it through test/load-ts.cjs.
 */

export type RoutingKind = 'message' | 'handoff' | 'archived' | 'drop';

export const ROUTING_KINDS: readonly RoutingKind[] = ['message', 'handoff', 'archived', 'drop'];

export interface RoutingEntry {
  /** Stable React key: kind + message id + timestamp. */
  key: string;
  ts: number;
  kind: RoutingKind;
  /** The hive message id, when the line carries one. */
  id: string | null;
  from: string;
  /** As addressed: an agent id, 'god', 'human' or 'broadcast'. */
  to: string;
  act: string | null;
  subject: string;
  /** Agent ids that actually took delivery. Empty for a drop, and for a
   *  message nobody could receive. */
  delivered: string[];
  /** Why a drop happened ('hop-cap', 'no-inbox', 'malformed-json'). */
  reason: string | null;
}

/** Senders that are the app itself rather than an agent or the human. Mirrors
 *  the `from` values the main process passes to hive.send(). */
export const SYSTEM_ROUTING_SENDERS: ReadonlySet<string> = new Set([
  'system', 'heartbeat', 'breaker', 'scheduler', 'ephemeral-worker', 'harness', 'slack', 'webhook', 'closing-time', 'trigger'
]);

/** Longest subject kept per entry. Subjects are one-liners by protocol; a
 *  runaway one must not bloat the IPC payload. */
export const MAX_ROUTING_SUBJECT = 400;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Parse one log line into a routing entry, or null for non-routing / bad lines. */
export function parseRoutingLine(line: string): RoutingEntry | null {
  if (!line || line[0] !== '{') return null;
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const ts = typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : 0;
  if (ts <= 0) return null;

  let kind: RoutingKind;
  switch (r.kind) {
    case 'message': kind = 'message'; break;
    case 'terminal-handoff': kind = 'handoff'; break;
    case 'archived-recipient': kind = 'archived'; break;
    case 'drop': kind = 'drop'; break;
    default: return null;
  }

  const from = str(r.from);
  if (!from) return null;
  const to = str(r.to);
  const id = str(r.id) || null;

  let delivered: string[] = [];
  if (kind === 'message' && Array.isArray(r.delivered)) {
    delivered = r.delivered.filter((d): d is string => typeof d === 'string' && d.length > 0);
  } else if (kind === 'handoff' && r.delivered === true && to) {
    delivered = [to];
  } else if (kind === 'archived' && to) {
    // Filed in the archived agent's inbox (it is only READ if the agent returns).
    delivered = [to];
  }

  let subject = str(r.subject);
  if (subject.length > MAX_ROUTING_SUBJECT) subject = `${subject.slice(0, MAX_ROUTING_SUBJECT - 1)}…`;

  return {
    key: `${kind}:${id ?? '-'}:${ts}:${from}>${to}`,
    ts,
    kind,
    id,
    from,
    to,
    act: str(r.act) || null,
    subject,
    delivered,
    reason: kind === 'drop' ? (str(r.reason) || null) : null
  };
}

/**
 * Parse a chunk of the log, oldest first. `skipFirstLine` drops the first line
 * when the chunk was cut from the middle of the file (it is almost certainly a
 * partial line). Keeps at most `limit` entries — the NEWEST ones.
 */
export function parseRoutingLog(text: string, opts: { skipFirstLine?: boolean; limit?: number } = {}): RoutingEntry[] {
  const lines = text.split('\n');
  if (opts.skipFirstLine) lines.shift();
  const out: RoutingEntry[] = [];
  for (const line of lines) {
    const e = parseRoutingLine(line.trim());
    if (e) out.push(e);
  }
  const limit = opts.limit ?? Infinity;
  return out.length > limit ? out.slice(out.length - limit) : out;
}

/** Resolve the router's aliases ('god', 'human') to the orchestrator's id, the
 *  way routeMessage does, so "messages involving Michael" catches both. */
export function resolveRoutingId(id: string, godId: string | null | undefined): string {
  if (godId && (id === 'god' || id === 'human')) return godId;
  return id;
}

/** True when `agentId` sent, was addressed by, or received the entry. A
 *  broadcast involves everyone it reached (its `delivered` list). The
 *  pseudo-id 'human' matches what the human sent; 'system' matches every
 *  app-originated message. */
export function routingInvolves(e: RoutingEntry, agentId: string, godId?: string | null): boolean {
  if (agentId === 'human') return e.from === 'human';
  if (agentId === 'system') return SYSTEM_ROUTING_SENDERS.has(e.from);
  if (e.from === agentId) return true;
  if (e.to === agentId || resolveRoutingId(e.to, godId) === agentId) return true;
  return e.delivered.includes(agentId);
}

export interface RoutingFilter {
  /** Only entries involving this participant (agent id, 'human' or 'system'). */
  agentId?: string | null;
  /** Case-insensitive text match over subject, act, ids and display names. */
  query?: string;
  /** Only these kinds; empty / omitted = all. */
  kinds?: readonly RoutingKind[];
  godId?: string | null;
  /** id → display name, so a search for "Dwight" finds `agent-3`. */
  names?: Readonly<Record<string, string>>;
}

/** Apply a filter. Order is preserved. */
export function filterRouting(entries: readonly RoutingEntry[], f: RoutingFilter): RoutingEntry[] {
  const q = (f.query ?? '').trim().toLowerCase();
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];
  const kinds = f.kinds && f.kinds.length ? new Set(f.kinds) : null;
  const names = f.names ?? {};
  const label = (id: string): string => names[resolveRoutingId(id, f.godId)] ?? names[id] ?? '';
  return entries.filter((e) => {
    if (kinds && !kinds.has(e.kind)) return false;
    if (f.agentId && !routingInvolves(e, f.agentId, f.godId)) return false;
    if (!terms.length) return true;
    const hay = [
      e.subject, e.act ?? '', e.from, e.to, e.reason ?? '', e.id ?? '',
      label(e.from), label(e.to), ...e.delivered, ...e.delivered.map(label)
    ].join(' \u0000 ').toLowerCase();
    // Every term must appear somewhere — "dwight login" narrows, not widens.
    return terms.every((t) => hay.includes(t));
  });
}

/** Everyone who appears in the log, most active first — the agent filter's
 *  options. Aliases resolve to the orchestrator; system senders fold into one
 *  'system' entry; 'broadcast' is an address, not a participant. */
export function routingParticipants(entries: readonly RoutingEntry[], godId?: string | null): string[] {
  const counts = new Map<string, number>();
  const bump = (id: string): void => {
    if (!id || id === 'broadcast') return;
    const k = id === 'human' ? 'human' : SYSTEM_ROUTING_SENDERS.has(id) ? 'system' : resolveRoutingId(id, godId);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  for (const e of entries) {
    bump(e.from);
    if (e.to !== 'human') bump(e.to);
    for (const d of e.delivered) if (d !== e.to) bump(d);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
}

/** Group key for a day header in the list (local calendar day). */
export function routingDayKey(ts: number): string {
  const d = new Date(ts);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${d.getFullYear()}-${m < 10 ? '0' : ''}${m}-${day < 10 ? '0' : ''}${day}`;
}
