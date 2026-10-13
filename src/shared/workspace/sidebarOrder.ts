/**
 * Ordering for the Workspace sidebar's agent list — the manual order behind
 * "Keep my agent order", and the automatic order used when that is off.
 *
 * Two lists are kept per hive, both plain arrays of ids:
 *   - project keys (sidebarProjects.ts `ProjectIdentity.key`), and
 *   - agent ids, ONE flat list across every project. An agent's position
 *     inside its group is its position in that list; drags never cross groups
 *     (a group comes from the agent's folder, so a cross-group drop would snap
 *     straight back), which is what lets one flat list serve every group.
 *
 * A saved list is a PREFERENCE, never the roster: agents come and go (closed,
 * restored, hired by the orchestrator), so every read reconciles the saved list
 * with who is actually present, and every write keeps the slots of agents that
 * are absent right now so a restored agent comes back where you put it.
 *
 * Pure and import-free so node:test can load it.
 */

/** Upper bound on a persisted list: present ids always survive, absent ones
 *  are dropped oldest-slot-last once the list would exceed this. */
export const MAX_SAVED_ORDER = 400;

/**
 * The present ids in saved order, then the ones the saved list has never seen
 * in their natural order. Absent saved ids are skipped; duplicates collapse.
 */
export function reconcileOrder(saved: readonly string[] | null | undefined, present: readonly string[]): string[] {
  const presentSet = new Set(present);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of saved ?? []) {
    if (typeof id !== 'string' || seen.has(id) || !presentSet.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const id of present) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Move `id` so it lands at `toIndex` of the result. Out-of-range clamps; an
 *  unknown id returns the list unchanged (a copy). */
export function moveItem(list: readonly string[], id: string, toIndex: number): string[] {
  const from = list.indexOf(id);
  if (from < 0) return [...list];
  const rest = list.filter((x) => x !== id);
  const at = Math.max(0, Math.min(rest.length, Math.round(toIndex)));
  rest.splice(at, 0, id);
  return rest;
}

/** Move `id` one step earlier (-1) or later (+1) within `list`. */
export function nudgeItem(list: readonly string[], id: string, delta: -1 | 1): string[] {
  const from = list.indexOf(id);
  if (from < 0) return [...list];
  return moveItem(list, id, from + delta);
}

/**
 * Place `id` immediately before or after `targetId` — what a drop on a row
 * means. Dropping on yourself is a no-op.
 */
export function placeRelative(
  list: readonly string[],
  id: string,
  targetId: string,
  where: 'before' | 'after'
): string[] {
  if (id === targetId || !list.includes(id) || !list.includes(targetId)) return [...list];
  const rest = list.filter((x) => x !== id);
  const t = rest.indexOf(targetId);
  rest.splice(where === 'before' ? t : t + 1, 0, id);
  return rest;
}

/**
 * Re-sequence ONE group's members inside the flat list: the slots those
 * members occupy keep their positions, and are refilled in `groupOrder`. Every
 * other id (other groups, absent agents) stays exactly where it was.
 */
export function applyGroupOrder(flat: readonly string[], groupOrder: readonly string[]): string[] {
  const members = new Set(groupOrder);
  const queue = groupOrder.filter((id) => flat.includes(id));
  const out = flat.map((id) => (members.has(id) ? queue.shift() ?? id : id));
  // Members the flat list did not know yet go to the end, in group order.
  for (const id of groupOrder) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * What to persist after the user reordered: `view` is the full present order
 * they now see. Slots held by present ids are refilled in view order; slots of
 * absent ids are kept, so an agent closed today and restored tomorrow keeps its
 * place. New ids go to the end. Bounded by MAX_SAVED_ORDER.
 */
export function mergeSavedOrder(saved: readonly string[] | null | undefined, view: readonly string[]): string[] {
  const unique = [...new Set(view)];
  const viewSet = new Set(unique);
  // Each present slot takes the next id in view order, so every view id is
  // placed exactly once; whatever is left over had no slot yet.
  const queue = [...unique];
  const out: string[] = [];
  const seenSaved = new Set<string>();
  for (const id of saved ?? []) {
    if (typeof id !== 'string' || seenSaved.has(id)) continue;
    seenSaved.add(id);
    if (viewSet.has(id)) {
      const next = queue.shift();
      if (next !== undefined) out.push(next);
    } else {
      out.push(id);
    }
  }
  out.push(...queue);
  if (out.length <= MAX_SAVED_ORDER) return out;
  // Over the cap: shed absent ids from the end first.
  const trimmed = [...out];
  for (let i = trimmed.length - 1; i >= 0 && trimmed.length > MAX_SAVED_ORDER; i--) {
    if (!viewSet.has(trimmed[i])) trimmed.splice(i, 1);
  }
  return trimmed.slice(0, Math.max(MAX_SAVED_ORDER, view.length));
}

/** Longest id a saved list may hold. Project keys are folder paths
 *  (`path:/…`), so this is sized for a deep path, not for an agent id. */
export const MAX_SAVED_ID = 4096;

/** Validate an untrusted persisted value as an id list. */
export function isIdList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= MAX_SAVED_ORDER * 2
    && value.every((v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_SAVED_ID);
}

// ─── Automatic order ────────────────────────────────────────────────────────

/** The statuses the automatic order distinguishes (the Workspace's WsAgentStatus). */
export type OrderStatus =
  | 'working' | 'thinking' | 'needs-you' | 'waiting' | 'compacting' | 'looping' | 'idle' | 'offline';

/**
 * Urgency rank, lowest first. Needs-you leads (and a breaker stop is a kind of
 * needs-you: nothing moves until a human looks), then everything mid-turn,
 * then agents parked on someone else, then idle, then dead terminals.
 */
export function statusRank(status: OrderStatus, askedYou = false): number {
  if (status === 'needs-you' || askedYou) return 0;
  switch (status) {
    case 'looping': return 1;
    case 'working':
    case 'thinking':
    case 'compacting': return 2;
    case 'waiting': return 3;
    case 'idle': return 4;
    default: return 5;
  }
}

export interface RankState {
  rank: number;
  /** When this agent first reported something OTHER than `rank` (ms), while
   *  the demotion is being held. Absent when stable. */
  pendingSince?: number;
  pendingRank?: number;
}

/**
 * Hysteresis for the automatic order, so rows do not hop on every tool call.
 *
 * An agent between two tool calls flickers working → idle → working within a
 * second; re-sorting on each flicker makes the list unreadable and a click can
 * land on the wrong row. So a DEMOTION (to a less urgent rank) only takes
 * effect once it has held for `holdMs`; a PROMOTION (more urgent — a question,
 * a breaker stop, work starting) applies at once, because that is exactly the
 * change the order exists to surface.
 *
 * Returns the next state map; ids absent from `current` are dropped.
 */
export function settleRanks(
  prev: Readonly<Record<string, RankState>>,
  current: Readonly<Record<string, number>>,
  now: number,
  holdMs: number
): Record<string, RankState> {
  const next: Record<string, RankState> = {};
  for (const [id, rank] of Object.entries(current)) {
    const p = prev[id];
    if (!p || rank <= p.rank) {
      next[id] = { rank };
      continue;
    }
    // Demotion: start (or continue) the hold.
    const since = p.pendingRank === undefined ? now : (p.pendingSince ?? now);
    if (now - since >= holdMs) next[id] = { rank };
    else next[id] = { rank: p.rank, pendingSince: since, pendingRank: rank };
  }
  return next;
}

/** The earliest time a held demotion in `state` will apply, or null. */
export function nextSettleAt(state: Readonly<Record<string, RankState>>, holdMs: number): number | null {
  let at: number | null = null;
  for (const s of Object.values(state)) {
    if (s.pendingSince === undefined) continue;
    const t = s.pendingSince + holdMs;
    if (at === null || t < at) at = t;
  }
  return at;
}

/**
 * Stable automatic order: by rank, ties keep their natural (roster) order.
 * `natural` is the roster order; `rankOf` gives each id's settled rank.
 */
export function autoOrder(natural: readonly string[], rankOf: (id: string) => number): string[] {
  return natural
    .map((id, i) => ({ id, i, r: rankOf(id) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.id);
}

/**
 * Order project groups automatically: by their most urgent member, ties by
 * name (locale-aware, case-insensitive) so a calm floor reads alphabetically
 * and does not reshuffle when nothing urgent changed.
 */
export function autoGroupOrder<G extends { key: string; name: string }>(
  groups: readonly G[],
  bestRankOf: (group: G) => number
): G[] {
  return [...groups].sort((a, b) =>
    bestRankOf(a) - bestRankOf(b)
    || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    || a.key.localeCompare(b.key)
  );
}
