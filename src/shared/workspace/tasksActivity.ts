/**
 * When did each card last change? — the observation rules behind "stale · 6h"
 * and "done cards leave the board on their own".
 *
 * The ledger does not carry that answer. Cards have a `createdAt`, sometimes an
 * ask/answer trail, and rarely an `updatedAt`; the orchestrator rewrites the
 * file by hand, so there is no per-card history either. The main process
 * therefore WATCHES the ledger (src/main/features/tasks.ts reads it on a timer
 * and on every Tasks-screen poll) and records, per card, a fingerprint of its
 * content plus the time a change to it was first seen. This module is the pure
 * fold that does that; main only adds the file I/O.
 *
 * Every rule below leans the same way. A "stale" chip is a claim that nothing
 * has happened, so when the tracker does not KNOW when a change happened it
 * credits it to the latest moment it could have happened — a card is never
 * called stale on a guess. The one place that leans early is a Done card's
 * done-time, where being early only moves a finished card off the Board and
 * into the List.
 */
import { columnForStatus, evidenceStamp, explicitUpdateStamp, ledgerCards, rawTaskId, type ActivityMap, type TaskColumn } from './tasks';

export interface TrackedCard {
  /** Content fingerprint (see fingerprintCard). */
  fp: string;
  column: TaskColumn;
  changedAt: number;
  statusSince: number;
  /** See CardActivity.observed: false while changedAt is a first-look bound. */
  observed: boolean;
}

export interface ActivityState {
  v: 1;
  /** The last time the ledger was observed. */
  seenAt: number;
  cards: Record<string, TrackedCard>;
}

/** JSON with object keys sorted, so key order in the file is not a "change". */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** A short, deterministic fingerprint of a raw card's whole content. */
export function fingerprintCard(raw: unknown): string {
  const s = stableJson(raw);
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = ((h1 << 5) + h1) ^ c;
    h2 = ((h2 << 5) + h2) ^ c;
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}:${s.length}`;
}

const clampToNow = (ms: number | null, now: number): number | null =>
  ms === null ? null : Math.min(ms, now);

/**
 * Fold one observation of the ledger into the tracker state.
 *
 * @param prev       The persisted state, or null on the very first look at this
 *                   hive (a fresh install, or a hive never opened before).
 * @param rawLedger  The ledger as read from disk (`{ tasks: [...] }` or the array).
 * @param now        Observation time, epoch ms.
 * @param fileMtimeMs The ledger file's mtime. On a first look it is the best
 *                   bound we have: no card changed after the file did.
 *
 * Rules, per card:
 *   - first look at this hive: changed at its own explicit update stamp if it
 *     has one, else at the file's mtime (the latest it can have changed —
 *     marked `observed: false`, so the date filters ignore the bound);
 *     in its column since its explicit stamp, else its latest known event
 *     (creation, an ask, an answer), else the mtime.
 *   - a card new since the last look, or one whose content changed: changed
 *     NOW — unless the card carries an explicit update stamp newer than what we
 *     had, which is then believed. A column change restarts `statusSince` the
 *     same way. A NEW card's `statusSince` may use its own events when they all
 *     happened after our last look (it was created, and so entered its column,
 *     while we were not watching).
 *   - an unchanged card keeps its record; a card gone from the ledger is dropped.
 */
export function observeLedger(
  prev: ActivityState | null,
  rawLedger: unknown,
  now: number,
  fileMtimeMs: number | null
): { state: ActivityState; changed: boolean } {
  const cards: Record<string, TrackedCard> = {};
  let changed = prev === null;
  const floor = clampToNow(fileMtimeMs, now) ?? now;

  ledgerCards(rawLedger).forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const raw = entry as Record<string, unknown>;
    const id = rawTaskId(raw, index);
    if (cards[id]) return; // a repeated id keeps its first card's record
    const fp = fingerprintCard(raw);
    const column = columnForStatus(raw.status);
    const explicit = clampToNow(explicitUpdateStamp(raw), now);
    const evidence = clampToNow(evidenceStamp(raw), now);
    const before = prev?.cards[id];

    if (!prev) {
      cards[id] = {
        fp,
        column,
        changedAt: explicit ?? floor,
        statusSince: explicit ?? evidence ?? floor,
        observed: explicit !== null
      };
      return;
    }
    if (!before) {
      changed = true;
      const createdUnseen = evidence !== null && evidence > prev.seenAt;
      cards[id] = {
        fp,
        column,
        changedAt: explicit ?? now,
        statusSince: explicit ?? (createdUnseen ? evidence! : now),
        observed: true
      };
      return;
    }
    if (before.fp === fp && before.column === column) {
      cards[id] = before;
      return;
    }
    changed = true;
    const believed = explicit !== null && explicit > before.changedAt ? explicit : now;
    cards[id] = {
      fp,
      column,
      changedAt: believed,
      statusSince: column === before.column
        ? before.statusSince
        : (explicit !== null && explicit > before.statusSince ? explicit : now),
      observed: true
    };
  });

  if (prev && !changed) {
    for (const id of Object.keys(prev.cards)) {
      if (!cards[id]) { changed = true; break; }
    }
  }
  return { state: { v: 1, seenAt: now, cards }, changed };
}

/** The renderer's view of the state: no fingerprints, no columns. */
export function activityMap(state: ActivityState | null): ActivityMap {
  const out: ActivityMap = {};
  if (!state) return out;
  for (const [id, c] of Object.entries(state.cards)) {
    out[id] = c.observed
      ? { changedAt: c.changedAt, statusSince: c.statusSince }
      : { changedAt: c.changedAt, statusSince: c.statusSince, observed: false };
  }
  return out;
}

/** Validate a persisted state read back from disk. Anything malformed is
 *  treated as "never looked" rather than half-trusted. */
export function parseActivityState(value: unknown): ActivityState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 || typeof v.seenAt !== 'number' || !Number.isFinite(v.seenAt)) return null;
  if (!v.cards || typeof v.cards !== 'object' || Array.isArray(v.cards)) return null;
  const cards: Record<string, TrackedCard> = {};
  for (const [id, raw] of Object.entries(v.cards as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.fp !== 'string' || typeof c.changedAt !== 'number' || typeof c.statusSince !== 'number') continue;
    if (!Number.isFinite(c.changedAt) || !Number.isFinite(c.statusSince)) continue;
    cards[id] = {
      fp: c.fp,
      column: columnForStatus(c.column),
      changedAt: c.changedAt,
      statusSince: c.statusSince,
      observed: c.observed === true
    };
  }
  return { v: 1, seenAt: v.seenAt, cards };
}
