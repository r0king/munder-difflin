/**
 * Inbox — main-process side (owned by the `wsInbox` unit).
 *
 * The Inbox reads three things. Two already have IPC and are read through it
 * from the renderer: the task ledger (Ask me — `hive:tasks`, answered with
 * `hive:patchTask` + `hive:send`, the Classic ASK ME path) and the trigger
 * history (Outside — `triggerHistory:list` / `triggerHistory:decide`). The
 * third is the floor's mail, and the existing reads do not fit it:
 * `hive:inbox` is one agent's UNDRAINED inbox, unredacted, and `hive:messages`
 * (the voice layer's) stops at 40. "Everyone" is every routed message, so this
 * module reads the mailboxes itself:
 *
 *   feat:inbox:messages    every agent's inbox/, inbox/.done and outbox/.sent,
 *                          merged once per message, newest first, REDACTED.
 *   feat:inbox:readMarks   this hive's read watermarks (unread state).
 *   feat:inbox:markRead    move watermarks forward; pushed to every app window
 *                          on feat:inbox:readMarksChanged.
 *
 * WHY A CACHE. A hive's inbox/.done grows by every message ever handled, and
 * this is read every few seconds while the Inbox (or its bell) is on screen.
 * A message file never changes once written — the router writes it atomically
 * and draining it is a rename into .done under the same name — so a file is
 * parsed once and remembered by owner + name; a scan is then a handful of
 * readdirs plus whatever arrived since the last one.
 *
 * SECURITY. Paths come only from config.harnessHome and the directory listing
 * itself: agent directories and message files are taken from readdir with
 * their types (symlinks are skipped, so a link planted in a mailbox cannot
 * point the reader elsewhere), a file over MAX_FILE_BYTES is skipped unread,
 * and every subject and body goes through hive.ts `redactSecrets` before it
 * crosses IPC — the same stripping the voice read-layer applies. Renderer
 * input is limited to a number and short validated keys.
 */
import { ipcMain } from 'electron';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { redactSecrets } from '../hive';
import {
  BASELINE_MARK,
  MAX_BODY,
  mergeMailboxes,
  normalizeHiveMessage,
  selectForWire,
  type InboxMessage,
  type ReadMarks
} from '../../shared/workspace/inboxMessages';
import { applyReadMark, sanitizeReadMarks } from '../../shared/workspace/inboxSection';
import {
  INBOX_CHANNELS,
  type InboxMessagesReply,
  type MarkReadReply,
  type ReadMarkEntry,
  type ReadMarksReply
} from '../../shared/workspace/inboxChannels';
import type { FeatureContext, FeatureModule } from './types';

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 5000;
/** Human↔agent mail always sent on top of the floor-wide window. */
const HUMAN_LIMIT = 2000;
/** A message file larger than this is not a message; it is skipped unread. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Parallel file reads during a scan. */
const READ_CONCURRENCY = 16;
/** Most entries one markRead call may carry. */
const MAX_MARK_ENTRIES = 500;
/** Hives whose read marks are remembered (one entry per hive folder). */
const MAX_HIVES = 24;

// ─── Mailbox scan ───────────────────────────────────────────────────────────

/** Where a file was found. Inbox and inbox/.done share a key, because draining
 *  a message is a rename between them under the same name. */
type Slot = 'in' | 'sent';

interface Cached {
  msg: InboxMessage | null;
  slot: Slot;
}

let cacheRoot: string | null = null;
const cache = new Map<string, Cached>();
let scanning: Promise<InboxMessage[]> | null = null;

async function listDir(dir: string, want: 'file' | 'dir'): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => (want === 'dir' ? e.isDirectory() : e.isFile()) && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

const isMessageFile = (name: string): boolean =>
  name.endsWith('.json') && !name.startsWith('.') && !name.startsWith('bad-');

/** Parse one message file; null for anything that is not a usable message. */
async function readMessage(path: string, owner: string, slot: Slot, name: string): Promise<InboxMessage | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    const msg = normalizeHiveMessage(raw, {
      // A raw outbox/.sent copy may carry no id (the router minted one on the
      // routed copy); the file name keeps it unique and stable.
      id: `sent-${owner}-${name.slice(0, -'.json'.length)}`,
      createdAt: info.mtime.toISOString(),
      // Redact the WHOLE body first, then clip — clipping first could cut a
      // secret in half and leave the half the pattern no longer matches.
      maxBody: Number.POSITIVE_INFINITY
    });
    if (!msg) return null;
    // The router treats the owning directory as the sender of anything in an
    // outbox (hive.ts routeOnce), whatever the file says. Mirror that.
    if (slot === 'sent') msg.from = owner;
    msg.subject = redactSecrets(msg.subject);
    const body = redactSecrets(msg.body);
    if (body.length > MAX_BODY) {
      msg.body = body.slice(0, MAX_BODY);
      msg.clipped = true;
    } else {
      msg.body = body;
    }
    return msg;
  } catch {
    return null; // unreadable or malformed — the router quarantines those itself
  }
}

/** Run `jobs` with at most `n` in flight. */
async function pool(jobs: Array<() => Promise<void>>, n: number): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await job();
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
}

/** Every message on the floor, newest first, each once. */
async function scanAll(hiveRoot: string): Promise<InboxMessage[]> {
  if (cacheRoot !== hiveRoot) {
    cache.clear();
    cacheRoot = hiveRoot;
  }
  const agentsDir = join(hiveRoot, 'agents');
  const owners = await listDir(agentsDir, 'dir');
  const seen = new Set<string>();
  const jobs: Array<() => Promise<void>> = [];

  const folders = (owner: string): Array<{ dir: string; slot: Slot }> => {
    const base = join(agentsDir, owner);
    return [
      { dir: join(base, 'inbox'), slot: 'in' },
      { dir: join(base, 'inbox', '.done'), slot: 'in' },
      { dir: join(base, 'outbox', '.sent'), slot: 'sent' }
    ];
  };

  await Promise.all(owners.map(async (owner) => {
    for (const { dir, slot } of folders(owner)) {
      for (const name of await listDir(dir, 'file')) {
        if (!isMessageFile(name)) continue;
        const key = `${owner}\u0000${slot}\u0000${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (cache.has(key)) continue;
        const path = join(dir, name);
        jobs.push(async () => {
          cache.set(key, { msg: await readMessage(path, owner, slot, name), slot });
        });
      }
    }
  }));
  await pool(jobs, READ_CONCURRENCY);

  // Forget files that are gone (a cleared mailbox, a deleted agent).
  for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);

  const delivered: InboxMessage[] = [];
  const sent: InboxMessage[] = [];
  for (const { msg, slot } of cache.values()) {
    if (!msg) continue;
    (slot === 'in' ? delivered : sent).push(msg);
  }
  return mergeMailboxes(delivered, sent);
}

/** One scan at a time; callers that arrive mid-scan share its result. */
function scan(hiveRoot: string): Promise<InboxMessage[]> {
  if (!scanning) {
    scanning = scanAll(hiveRoot).finally(() => { scanning = null; });
  }
  return scanning;
}

function hiveRootOf(ctx: FeatureContext): string | null {
  const home = ctx.harnessHome();
  return home ? join(home, 'hive') : null;
}

function clampLimit(opts: unknown): number {
  const raw = opts && typeof opts === 'object' ? (opts as { limit?: unknown }).limit : undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.round(raw)));
}

// ─── Read marks ─────────────────────────────────────────────────────────────

interface InboxSettings {
  /** Read watermarks per hive folder. */
  marks: Record<string, ReadMarks>;
}

const SETTINGS_DEFAULTS: InboxSettings = { marks: {} };

function readAllMarks(ctx: FeatureContext): Record<string, ReadMarks> {
  const s = ctx.readFeatureSettings<InboxSettings>('inbox', SETTINGS_DEFAULTS);
  const all = s.marks && typeof s.marks === 'object' && !Array.isArray(s.marks) ? s.marks : {};
  return all;
}

function writeMarks(ctx: FeatureContext, hiveRoot: string, marks: ReadMarks): void {
  const all = { ...readAllMarks(ctx), [hiveRoot]: marks };
  // Keep the most recently touched hives; a long-gone test folder should not
  // ride along in the settings file forever. Insertion order is touch order
  // because the touched hive is re-inserted last.
  const { [hiveRoot]: mine, ...rest } = all;
  const keep = Object.keys(rest).slice(-(MAX_HIVES - 1));
  const next: Record<string, ReadMarks> = {};
  for (const k of keep) next[k] = rest[k];
  next[hiveRoot] = mine;
  ctx.writeFeatureSettings<InboxSettings>('inbox', SETTINGS_DEFAULTS, { marks: next });
}

/** This hive's marks; the first call ever stamps the baseline (see
 *  BASELINE_MARK — history before the Inbox existed is not "new"). */
function marksFor(ctx: FeatureContext, hiveRoot: string): ReadMarks {
  const marks = sanitizeReadMarks(readAllMarks(ctx)[hiveRoot]);
  if (!marks[BASELINE_MARK]) {
    marks[BASELINE_MARK] = new Date().toISOString();
    try { writeMarks(ctx, hiveRoot, marks); } catch (e) { console.warn('[inbox] could not save read marks:', e); }
  }
  return marks;
}

// ─── Module ─────────────────────────────────────────────────────────────────

export const inboxFeature: FeatureModule = {
  name: 'inbox',
  register(ctx) {
    ipcMain.handle(INBOX_CHANNELS.messages, async (_evt, opts: unknown): Promise<InboxMessagesReply> => {
      const root = hiveRootOf(ctx);
      if (!root) return { hive: false, hiveId: null, messages: [], total: 0, truncated: false };
      try {
        const all = await scan(root);
        const limit = clampLimit(opts);
        const messages = selectForWire(all, limit, HUMAN_LIMIT);
        return { hive: true, hiveId: root, messages, total: all.length, truncated: all.length > messages.length };
      } catch (e) {
        console.error('[inbox] reading the mailboxes failed:', e);
        return { hive: true, hiveId: root, messages: [], total: 0, truncated: false, error: 'read-failed' };
      }
    });

    ipcMain.handle(INBOX_CHANNELS.readMarks, (): ReadMarksReply => {
      const root = hiveRootOf(ctx);
      if (!root) return { hiveId: null, marks: {} };
      try { return { hiveId: root, marks: marksFor(ctx, root) }; } catch { return { hiveId: root, marks: {} }; }
    });

    ipcMain.handle(INBOX_CHANNELS.markRead, (_evt, entries: unknown): MarkReadReply => {
      const root = hiveRootOf(ctx);
      if (!root) return { ok: false, hiveId: null, marks: {}, error: 'no hive' };
      const list = Array.isArray(entries) ? entries.slice(0, MAX_MARK_ENTRIES) : [entries];
      try {
        const now = new Date().toISOString();
        let marks = marksFor(ctx, root);
        let changed = false;
        for (const e of list) {
          if (!e || typeof e !== 'object') continue;
          const { key, at } = e as Partial<ReadMarkEntry>;
          const next = applyReadMark(marks, key, at, now);
          if (next) { marks = next; changed = true; }
        }
        if (changed) {
          writeMarks(ctx, root, marks);
          const push: ReadMarksReply = { hiveId: root, marks };
          ctx.broadcast(INBOX_CHANNELS.readMarksChanged, push);
        }
        return { ok: true, hiveId: root, marks };
      } catch (e) {
        console.error('[inbox] saving read marks failed:', e);
        return { ok: false, hiveId: root, marks: {}, error: 'write-failed' };
      }
    });
  },
  dispose() {
    cache.clear();
    cacheRoot = null;
  }
};
