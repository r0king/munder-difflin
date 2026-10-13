/**
 * One poll of the task ledger (hive/tasks.json) for the whole Workspace.
 *
 * The sidebar ("Asked you"), the agent cards (the ticket an agent is on), the
 * inbox (Ask me), the tasks board and the orchestrator's board all need the
 * same file. Each polling it on its own timer would read a ledger that is
 * routinely hundreds of KB several times every few seconds. So there is one
 * poller, started by the first subscriber and stopped by the last, and every
 * hook reads its snapshot.
 *
 * After a write (hivePatchTask, hiveAddTask, …) call `refreshHiveTasks()` so
 * every screen sees the change now rather than at the next tick.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { openQuestion, waitsOnHuman, type HiveTask } from '@/components/TasksKanban';

export type { HiveTask, HumanQA } from '@/components/TasksKanban';
export { openQuestion, waitsOnHuman } from '@/components/TasksKanban';

const POLL_MS = 5000;

export interface HiveTasksSnapshot {
  tasks: HiveTask[];
  /** False until the first read lands (render a quiet loading state, not
   *  "no tasks"). */
  loaded: boolean;
}

let snapshot: HiveTasksSnapshot = { tasks: [], loaded: false };
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function parse(raw: unknown): HiveTask[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)
    ? (raw as { tasks: unknown[] }).tasks
    : [];
  return list.filter((t): t is HiveTask =>
    !!t && typeof t === 'object' && typeof (t as HiveTask).id === 'string');
}

/** Re-read the ledger now. Concurrent calls share one read. */
export function refreshHiveTasks(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const tasks = parse(await window.cth.hiveTasks());
      // Keep identity when nothing changed, so subscribers do not re-render
      // every five seconds for a ledger nobody touched.
      if (!snapshot.loaded || JSON.stringify(tasks) !== JSON.stringify(snapshot.tasks)) {
        snapshot = { tasks, loaded: true };
        for (const l of [...listeners]) l();
      }
    } catch { /* keep the last good snapshot */ }
    finally { inFlight = null; }
  })();
  return inFlight;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    void refreshHiveTasks();
    timer = setInterval(() => { void refreshHiveTasks(); }, POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) { clearInterval(timer); timer = null; }
  };
}

const getSnapshot = (): HiveTasksSnapshot => snapshot;

/** The whole ledger, polled while anything is subscribed. */
export function useHiveTasks(): HiveTasksSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Ids of agents that own a card waiting on the human (an open ASK ME
 *  question) — the input for `deriveAgentStatus({ hasOpenQuestion })`. */
export function useAskedYou(): ReadonlySet<string> {
  const { tasks } = useHiveTasks();
  return useMemo(() => {
    const ids = new Set<string>();
    for (const t of tasks) if (t.assignee && waitsOnHuman(t)) ids.add(t.assignee);
    return ids;
  }, [tasks]);
}

/** The cards waiting on the human, newest question first is the caller's
 *  choice (see components/askMeOrder.ts) — this is the unsorted set. */
export function useOpenQuestions(): HiveTask[] {
  const { tasks } = useHiveTasks();
  return useMemo(() => tasks.filter((t) => !!openQuestion(t) && waitsOnHuman(t)), [tasks]);
}
