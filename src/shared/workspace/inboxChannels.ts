/**
 * IPC channels and wire shapes of the Inbox (`feat:inbox:*`), shared by
 * src/main/features/inbox.ts and src/preload/features/inbox.ts so the two
 * cannot drift. Owned by the `wsInbox` unit.
 */
import type { InboxMessage, ReadMarks } from './inboxMessages';

export const INBOX_CHANNELS = {
  /** invoke(opts?: InboxMessagesRequest) → InboxMessagesReply */
  messages: 'feat:inbox:messages',
  /** invoke() → { marks } — this hive's read watermarks (sets the baseline on first call). */
  readMarks: 'feat:inbox:readMarks',
  /** invoke(entries: ReadMarkEntry[]) → { ok, marks } — move watermarks forward. */
  markRead: 'feat:inbox:markRead',
  /** main → app windows: { marks } after any window marked something read. */
  readMarksChanged: 'feat:inbox:readMarksChanged'
} as const;

export interface InboxMessagesRequest {
  /** Newest floor-wide messages to return (1..5000, default 2000). Mail between
   *  the human and an agent is always included on top of this, so a quiet
   *  request from last month never falls out of its agent's row. */
  limit?: number;
}

export interface InboxMessagesReply {
  /** False before onboarding (no hive folder yet) — the screen says so. */
  hive: boolean;
  /** Which hive was read (its folder), so a renderer notices a switch and
   *  drops what it held for the previous one. Null without a hive. */
  hiveId: string | null;
  /** Newest first, redacted. */
  messages: InboxMessage[];
  /** Messages on disk in all (before the limit). */
  total: number;
  /** `total` exceeded what was sent. */
  truncated: boolean;
  error?: string;
}

export interface ReadMarkEntry {
  key: string;
  /** ISO time everything in `key` up to which is now read. */
  at: string;
}

export interface ReadMarksReply {
  /** The hive these marks belong to (see InboxMessagesReply.hiveId). */
  hiveId: string | null;
  marks: ReadMarks;
}

export interface MarkReadReply extends ReadMarksReply {
  ok: boolean;
  error?: string;
}
