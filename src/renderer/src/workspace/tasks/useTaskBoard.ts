/**
 * Everything the Tasks screen reads, in one hook: the ledger (through the
 * Workspace's single shared poller, useHiveTasks), normalized into board
 * cards; main's record of when each card last changed; and the names behind
 * the agent ids the ledger stores.
 *
 * The ledger is polled every five seconds by useHiveTasks. Main's activity
 * record is asked for whenever that snapshot changes — so a card an agent just
 * moved is timestamped by the same read that shows it moving — and once a
 * minute besides. Ages ("stale · 6h") are computed here against a clock that
 * ticks every 30 seconds, so they advance without anyone touching the ledger.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { useHiveTasks } from '../useHiveTasks';
import { normalizeLedger, type ActivityMap, type WsTask } from '@shared/workspace/tasks';
import { useTaskMoves } from './movesStore';

const ACTIVITY_FALLBACK_MS = 60_000;
const CLOCK_MS = 30_000;

export interface AgentOption {
  id: string;
  name: string;
  isGod: boolean;
  /** On the floor right now (vs a name remembered from an earlier session). */
  live: boolean;
}

export interface TaskBoardData {
  /** False until the ledger's first read lands. */
  loaded: boolean;
  tasks: WsTask[];
  activity: ActivityMap;
  /** Main could not give an activity record (no hive, or the IPC failed). The
   *  board still works; only stale chips and done-hiding fall back to the
   *  cards' own stamps. */
  activityError: string | null;
  /** True once main has said which ledger is open (moves are keyed by it). */
  ledgerBound: boolean;
  folderKey: string;
  now: number;
  nameOf: (agentId: string) => string | undefined;
  /** Who a card can be given to: the floor's agents, then any other owner the
   *  ledger mentions. */
  owners: AgentOption[];
  godName: string | undefined;
  /** Re-read activity now (after a write of our own). */
  refreshActivity: () => void;
}

export function useTaskBoard(): TaskBoardData {
  const { tasks: raw, loaded } = useHiveTasks();
  const tasks = useMemo(() => normalizeLedger(raw), [raw]);

  const agents = useStore((s) => s.agents);
  const restorable = useStore((s) => s.restorableAgents);
  const archived = useStore((s) => s.archivedAgents);

  const [activity, setActivity] = useState<ActivityMap>({});
  const [activityError, setActivityError] = useState<string | null>(null);
  const [folderKey, setFolderKey] = useState('TSK');
  const [ledgerBound, setLedgerBound] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Keep the latest normalized ledger reachable from the async reply, so the
  // reconcile that follows a reply uses the cards that reply describes.
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const inFlight = useRef(false);
  const again = useRef(false);

  const refreshActivity = useCallback(() => {
    if (inFlight.current) { again.current = true; return; }
    inFlight.current = true;
    const api = window.cth?.features?.tasks;
    void (async () => {
      try {
        if (!api) throw new Error('unavailable');
        const reply = await api.activity();
        if (reply.ok) {
          setActivity(reply.activity);
          setFolderKey(reply.folderKey);
          setActivityError(reply.warning ?? null);
          useTaskMoves.getState().bindLedger(reply.ledgerId);
          setLedgerBound(true);
        } else {
          setActivityError(reply.error);
        }
      } catch (e) {
        setActivityError(e instanceof Error ? e.message : 'unavailable');
      } finally {
        // After binding (so it is the right ledger's moves), and only against
        // a ledger that has actually been read: an empty pre-load snapshot
        // would look like "every card is gone" and discard the staged moves.
        if (loadedRef.current) reconcileWithLedger(tasksRef.current);
        inFlight.current = false;
        setNow(Date.now());
        if (again.current) { again.current = false; refreshActivity(); }
      }
    })();
  }, []);

  // Each new ledger snapshot (useHiveTasks keeps identity when nothing changed).
  useEffect(() => { refreshActivity(); }, [raw, loaded, refreshActivity]);

  useEffect(() => {
    const a = setInterval(refreshActivity, ACTIVITY_FALLBACK_MS);
    const c = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => { clearInterval(a); clearInterval(c); };
  }, [refreshActivity]);

  const nameOf = useCallback((id: string): string | undefined =>
    agents.find((a) => a.id === id)?.name
      ?? restorable.find((a) => a.id === id)?.name
      ?? archived.find((a) => a.id === id)?.name,
  [agents, restorable, archived]);

  const owners = useMemo<AgentOption[]>(() => {
    const out: AgentOption[] = [];
    const seen = new Set<string>();
    for (const a of agents) {
      if (a.isAssistant || seen.has(a.id)) continue;
      seen.add(a.id);
      out.push({ id: a.id, name: a.name, isGod: !!a.isGod, live: true });
    }
    // The orchestrator first, then the floor by name.
    out.sort((x, y) => (x.isGod === y.isGod ? x.name.localeCompare(y.name) : x.isGod ? -1 : 1));
    const extra: AgentOption[] = [];
    for (const t of tasks) {
      if (!t.assignee || seen.has(t.assignee)) continue;
      seen.add(t.assignee);
      extra.push({ id: t.assignee, name: nameOf(t.assignee) ?? t.assignee, isGod: false, live: false });
    }
    extra.sort((x, y) => x.name.localeCompare(y.name));
    return [...out, ...extra];
  }, [agents, tasks, nameOf]);

  const godName = agents.find((a) => a.isGod)?.name;

  return { loaded, tasks, activity, activityError, ledgerBound, folderKey, now, nameOf, owners, godName, refreshActivity };
}

/** Align the open ledger's staged and sent moves with these cards. */
export function reconcileWithLedger(tasks: readonly WsTask[]): void {
  useTaskMoves.getState().reconcile(
    tasks.map((t) => ({ id: t.id, title: t.title, column: t.column, assignee: t.assignee })),
    Date.now()
  );
}

/** First day of the week for the "This week" filter, from the system's
 *  calendar conventions (0 = Sunday … 6 = Saturday); Monday when unknown.
 *  This reads the locale for CALENDAR rules only — the UI language is still
 *  the one picked in Settings. */
export function localWeekStart(): number {
  try {
    type WeekInfo = { firstDay?: number };
    const loc = new Intl.Locale(navigator.language) as Intl.Locale & { weekInfo?: WeekInfo; getWeekInfo?: () => WeekInfo };
    const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
    if (info && typeof info.firstDay === 'number' && info.firstDay >= 1 && info.firstDay <= 7) return info.firstDay % 7;
  } catch { /* older runtime */ }
  return 1;
}
