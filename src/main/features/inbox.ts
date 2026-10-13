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
 * readdirs plus whatever arrived since the last one (./inbox/scan.ts).
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
import { join } from 'node:path';
import { redactSecrets } from '../hive';
import {
  BASELINE_MARK,
  selectForWire,
  type ReadMarks
} from '../../shared/workspace/inboxMessages';
import { MailboxScanner } from './inbox/scan';
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
/** Most entries one markRead call may carry. */
const MAX_MARK_ENTRIES = 500;
/** Hives whose read marks are remembered (one entry per hive folder). */
const MAX_HIVES = 24;

// ─── Mailbox scan ───────────────────────────────────────────────────────────

const scanner = new MailboxScanner({ redact: redactSecrets });

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
        const all = await scanner.scan(root);
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
    scanner.reset();
  }
};
