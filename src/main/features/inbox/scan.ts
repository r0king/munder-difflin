/**
 * The Inbox's mailbox reader (owned by the `wsInbox` unit): every agent's
 * inbox/, inbox/.done and outbox/.sent under `<hive>/agents`, each message
 * once, newest first, redacted. See src/main/features/inbox.ts for why it is
 * cached and how it is exposed; kept free of Electron so node:test can drive
 * it against a temporary hive.
 *
 * Only node:fs reads. Agent directories and message files come from readdir
 * WITH their types — a symlink is neither a directory nor a file there, so a
 * link planted in a mailbox is never followed — and a file over
 * `maxFileBytes` is skipped unread.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAX_BODY,
  mergeMailboxes,
  normalizeHiveMessage,
  type InboxMessage
} from '../../../shared/workspace/inboxMessages';

/** Where a file was found. Inbox and inbox/.done share a slot, because
 *  draining a message is a rename between them under the same name. */
type Slot = 'in' | 'sent';

interface Cached {
  msg: InboxMessage | null;
  slot: Slot;
}

export interface MailboxScannerOptions {
  /** Strips secrets from a subject or body (hive.ts `redactSecrets`). */
  redact: (text: string) => string;
  /** Default 2 MiB. */
  maxFileBytes?: number;
  /** Parallel file reads; default 16. */
  concurrency?: number;
  /** Body cap after redaction; default MAX_BODY. */
  maxBody?: number;
}

const isMessageFile = (name: string): boolean =>
  name.endsWith('.json') && !name.startsWith('.') && !name.startsWith('bad-');

async function listDir(dir: string, want: 'file' | 'dir'): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => (want === 'dir' ? e.isDirectory() : e.isFile()) && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return []; // a missing folder is an empty one
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
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, jobs.length)) }, worker));
}

export class MailboxScanner {
  private readonly redact: (text: string) => string;
  private readonly maxFileBytes: number;
  private readonly concurrency: number;
  private readonly maxBody: number;
  private cacheRoot: string | null = null;
  private readonly cache = new Map<string, Cached>();
  private inFlight: { root: string; promise: Promise<InboxMessage[]> } | null = null;
  /** Files parsed since construction — lets a test prove the cache works. */
  parsed = 0;

  constructor(opts: MailboxScannerOptions) {
    this.redact = opts.redact;
    this.maxFileBytes = opts.maxFileBytes ?? 2 * 1024 * 1024;
    this.concurrency = opts.concurrency ?? 16;
    this.maxBody = opts.maxBody ?? MAX_BODY;
  }

  /** Forget everything (a hive switch does this on its own). */
  reset(): void {
    this.cache.clear();
    this.cacheRoot = null;
  }

  /** Every message under `hiveRoot`, newest first, each once. Calls that
   *  arrive while a scan of the same hive is running share it. */
  scan(hiveRoot: string): Promise<InboxMessage[]> {
    if (this.inFlight && this.inFlight.root === hiveRoot) return this.inFlight.promise;
    const promise = this.scanAll(hiveRoot).finally(() => {
      if (this.inFlight?.promise === promise) this.inFlight = null;
    });
    this.inFlight = { root: hiveRoot, promise };
    return promise;
  }

  private async readMessage(path: string, owner: string, slot: Slot, name: string): Promise<InboxMessage | null> {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > this.maxFileBytes) return null;
      this.parsed += 1;
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
      const msg = normalizeHiveMessage(raw, {
        // A raw outbox/.sent copy may carry no id (the router minted one on
        // the routed copy); the file name keeps it unique and stable.
        id: `sent-${owner}-${name.slice(0, -'.json'.length)}`,
        createdAt: info.mtime.toISOString(),
        // Redact the WHOLE body, then clip — clipping first could cut a
        // secret in half and leave a half the patterns no longer match.
        maxBody: Number.POSITIVE_INFINITY
      });
      if (!msg) return null;
      // The router treats the owning directory as the sender of anything in
      // an outbox (hive.ts routeOnce), whatever the file says. Mirror that.
      if (slot === 'sent') msg.from = owner;
      msg.subject = this.redact(msg.subject);
      const body = this.redact(msg.body);
      if (body.length > this.maxBody) {
        msg.body = body.slice(0, this.maxBody);
        msg.clipped = true;
      } else {
        msg.body = body;
      }
      return msg;
    } catch {
      return null; // unreadable or malformed — the router quarantines those itself
    }
  }

  private async scanAll(hiveRoot: string): Promise<InboxMessage[]> {
    if (this.cacheRoot !== hiveRoot) {
      this.cache.clear();
      this.cacheRoot = hiveRoot;
    }
    const agentsDir = join(hiveRoot, 'agents');
    const owners = await listDir(agentsDir, 'dir');
    const seen = new Set<string>();
    const jobs: Array<() => Promise<void>> = [];

    await Promise.all(owners.map(async (owner) => {
      const base = join(agentsDir, owner);
      const folders: Array<{ dir: string; slot: Slot }> = [
        { dir: join(base, 'inbox'), slot: 'in' },
        { dir: join(base, 'inbox', '.done'), slot: 'in' },
        { dir: join(base, 'outbox', '.sent'), slot: 'sent' }
      ];
      for (const { dir, slot } of folders) {
        for (const name of await listDir(dir, 'file')) {
          if (!isMessageFile(name)) continue;
          const key = `${owner}\u0000${slot}\u0000${name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (this.cache.has(key)) continue;
          const path = join(dir, name);
          jobs.push(async () => {
            this.cache.set(key, { msg: await this.readMessage(path, owner, slot, name), slot });
          });
        }
      }
    }));
    await pool(jobs, this.concurrency);

    // A hive switch mid-scan: this result belongs to a hive nobody shows now.
    if (this.cacheRoot !== hiveRoot) return [];

    // Forget files that are gone (a cleared mailbox, a deleted agent).
    for (const key of [...this.cache.keys()]) if (!seen.has(key)) this.cache.delete(key);

    const delivered: InboxMessage[] = [];
    const sent: InboxMessage[] = [];
    for (const { msg, slot } of this.cache.values()) {
      if (!msg) continue;
      (slot === 'in' ? delivered : sent).push(msg);
    }
    return mergeMailboxes(delivered, sent);
  }
}
