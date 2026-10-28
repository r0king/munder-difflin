import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── On-demand compaction: HIVE_ROOT/compact-requests/<id>.json ─────────────
// Slash commands act only on your own session, so god could never /compact an
// agent (or itself — it is never idle while it is the one typing). A request
// file `{ "agent": "<id>", "keep": "<optional /compact focus text>" }` asks the
// harness to do it. Polled on the spawn-requests tick, no fs.watch.
//
// Delivery REUSES the standup's path: main asks the renderer to queue the
// provider's compact command for that one agent, and the queue drain types it
// only at an idle prompt, never mid-tool-call. A busy agent therefore just keeps
// the request pending; it is re-asked every tick (the renderer dedupes a queued
// /compact and latches a delivered one). Success is the agent's own PostCompact
// hook, so `.done` means it really compacted, not merely that we typed it.

/** How long a request may wait for the agent to go idle and compact. */
export const COMPACT_REQUEST_TIMEOUT_MS = 60 * 60_000;
/** A file still unparseable after this long is failed rather than retried
 *  (it may simply be mid-write on the first look). */
const PARSE_GRACE_MS = 10_000;

export interface CompactRequestDeps {
  /** Registry entry, or undefined for an unknown agent. */
  agent(id: string): { archived?: boolean } | undefined;
  /** Does the agent have a live PTY? */
  live(id: string): boolean;
  /** Ask the renderer to queue the compact command for this agent when idle. */
  queue(id: string, keep: string): void;
  /** Live agents and their context fill, for the optional auto threshold. */
  liveAgents?(): string[];
  ctxPct?(id: string): number | null;
  now?(): number;
}

/** Optional auto-compact: request a compaction for any live agent at or above
 *  `pct` of its window, at most once per `everyMs` per agent. */
export interface AutoCompactRule { pct: number; everyMs: number }

export class CompactRequests {
  /** file name → when this process first saw it (the timeout and PostCompact clock). */
  private pending = new Map<string, number>();
  private compactedAt = new Map<string, number>();
  private autoAt = new Map<string, number>();

  constructor(
    private readonly dir: () => string | null,
    private readonly deps: CompactRequestDeps,
    private readonly timeoutMs = COMPACT_REQUEST_TIMEOUT_MS
  ) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /** Feed from the hook stream: this agent just finished a compaction. */
  noteCompacted(agentId: string): void { this.compactedAt.set(agentId, this.now()); }

  tick(auto?: AutoCompactRule | null): void {
    const dir = this.dir();
    if (!dir) return;
    if (auto) this.autoRequest(dir, auto);
    if (!existsSync(dir)) return;
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return; }
    for (const f of files) this.process(dir, f);
  }

  private process(dir: string, f: string): void {
    const now = this.now();
    const since = this.pending.get(f) ?? now;
    this.pending.set(f, since);
    let req: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      req = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      if (now - since < PARSE_GRACE_MS) return;
      this.finish(dir, f, {}, 'unparseable request');
      return;
    }
    const agent = typeof req.agent === 'string' ? req.agent.trim() : '';
    // Typed into a live prompt: control characters (a newline would submit early,
    // an ESC could drive the TUI) collapse to spaces.
    const keep = typeof req.keep === 'string'
      ? req.keep.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000) : '';
    const a = agent ? this.deps.agent(agent) : undefined;
    if (!a) return this.finish(dir, f, req, `unknown agent "${agent}"`);
    if (a.archived) return this.finish(dir, f, req, `agent "${agent}" is archived`);
    if (!this.deps.live(agent)) return this.finish(dir, f, req, `agent "${agent}" has no live session`);
    if ((this.compactedAt.get(agent) ?? -Infinity) >= since) return this.finish(dir, f, req, null);
    if (now - since > this.timeoutMs) {
      return this.finish(dir, f, req, `timeout: not compacted within ${Math.round(this.timeoutMs / 60_000)} min `
        + '(agent stayed busy, its CLI has no compact command, or there was nothing to compact)');
    }
    this.deps.queue(agent, keep);
  }

  /** Move to .done/ (reason null) or .failed/ with the reason written into the JSON. */
  private finish(dir: string, f: string, req: Record<string, unknown>, reason: string | null): void {
    this.pending.delete(f);
    const sub = join(dir, reason ? '.failed' : '.done');
    try {
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, f), JSON.stringify({ ...req, ...(reason ? { reason } : {}), at: new Date(this.now()).toISOString() }, null, 2));
    } catch (e) { console.error('[compact] archive failed:', e); }
    try { unlinkSync(join(dir, f)); } catch { /* already gone */ }
  }

  private autoRequest(dir: string, auto: AutoCompactRule): void {
    const now = this.now();
    for (const id of this.deps.liveAgents?.() ?? []) {
      const pct = this.deps.ctxPct?.(id);
      if (pct == null || pct < auto.pct) continue;
      if (now - (this.autoAt.get(id) ?? -Infinity) < auto.everyMs) continue;
      this.autoAt.set(id, now);
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `auto-${id}-${now}.json`), JSON.stringify({ agent: id, auto: true, ctxPct: pct }));
      } catch (e) { console.error('[compact] auto request failed:', e); }
    }
  }
}
