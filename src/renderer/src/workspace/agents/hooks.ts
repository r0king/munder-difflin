/**
 * Live data hooks for the agent cards and rooms (wsAgents unit).
 *
 *   useAgentActivity  one poll of `feat:agents:activity` for every card on
 *                     screen (last reply, last message, tool call + result)
 *   useExitedPtys     which terminals' processes have died (crash strip)
 *   useLastExit       the hive's record of an agent's last abnormal exit
 *   useControlSnapshot  pause / halt / pending-steer state for one agent
 *
 * Polls stop when nothing is subscribed and skip a tick while the window is
 * hidden, so a minimised app reads nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { terminalAutomationBlockFor } from '@/components/terminalPool';
import type { AgentActivity } from '@shared/workspace/agentsSummary';
import type { AgentExitInfo } from '@shared/workspace/agentsIpc';

const ACTIVITY_POLL_MS = 4000;

function hidden(): boolean {
  try { return document.visibilityState === 'hidden'; } catch { return false; }
}

// ─── Activity (shared poller) ───────────────────────────────────────────────

let activity: Record<string, AgentActivity> = {};
const wanted = new Map<symbol, string[]>();
const activityListeners = new Set<() => void>();
let activityTimer: ReturnType<typeof setInterval> | null = null;
let activityInFlight = false;

function wantedIds(): string[] {
  const all = new Set<string>();
  for (const ids of wanted.values()) for (const id of ids) all.add(id);
  return [...all];
}

async function pollActivity(force = false): Promise<void> {
  if (activityInFlight || (!force && hidden())) return;
  const ids = wantedIds();
  if (!ids.length) return;
  activityInFlight = true;
  try {
    const list = await window.cth.features.agents.activity(ids);
    const next: Record<string, AgentActivity> = { ...activity };
    for (const a of list) next[a.agentId] = a;
    if (JSON.stringify(next) !== JSON.stringify(activity)) {
      activity = next;
      for (const l of [...activityListeners]) l();
    }
  } catch { /* keep the last good read */ }
  finally { activityInFlight = false; }
}

/** What each listed agent last said and did, read off disk. */
export function useAgentActivity(agentIds: readonly string[]): Record<string, AgentActivity> {
  const key = agentIds.join('\n');
  const token = useRef(Symbol('activity')).current;
  useEffect(() => {
    wanted.set(token, key ? key.split('\n') : []);
    void pollActivity(true);
    if (!activityTimer) activityTimer = setInterval(() => { void pollActivity(); }, ACTIVITY_POLL_MS);
    return () => {
      wanted.delete(token);
      if (wanted.size === 0 && activityTimer) { clearInterval(activityTimer); activityTimer = null; }
    };
  }, [key, token]);
  const subscribe = useCallback((l: () => void) => {
    activityListeners.add(l);
    return () => { activityListeners.delete(l); };
  }, []);
  return useSyncExternalStore(subscribe, () => activity, () => activity);
}

/** Ask for a fresh read now (after a send, a ticket, a restart). */
export function refreshAgentActivity(): void {
  void pollActivity(true);
}

// ─── Dead terminals ─────────────────────────────────────────────────────────

/**
 * The pty ids (of those given) whose process has exited. The terminal pool
 * latches `exited` when main reports the PTY's exit and clears it on a
 * relaunch; App acquires every agent's terminal at boot, so the latch exists
 * whether or not the terminal is on screen. A plain map read, polled.
 */
export function useExitedPtys(ptyIds: readonly (string | undefined)[]): ReadonlySet<string> {
  const key = ptyIds.filter(Boolean).join('\n');
  const [exited, setExited] = useState<string>('');
  useEffect(() => {
    const ids = key ? key.split('\n') : [];
    const read = (): void => {
      const dead = ids.filter((id) => terminalAutomationBlockFor(id) === 'exited').join('\n');
      setExited((prev) => (prev === dead ? prev : dead));
    };
    read();
    const iv = setInterval(read, 1500);
    return () => clearInterval(iv);
  }, [key]);
  return useMemo(() => new Set(exited ? exited.split('\n') : []), [exited]);
}

/** The hive's record of this agent's last abnormal exit, read when its
 *  process is found dead (and again if it dies again). */
export function useLastExit(agentId: string, dead: boolean): AgentExitInfo | null {
  const [info, setInfo] = useState<AgentExitInfo | null>(null);
  useEffect(() => {
    if (!dead) { setInfo(null); return; }
    let alive = true;
    // main records the exit just before tearing the PTY down; give it a beat.
    const t = setTimeout(() => {
      window.cth.features.agents.lastExit(agentId)
        .then((r) => { if (alive) setInfo(r); })
        .catch(() => { /* no record — the strip says the plain thing */ });
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [agentId, dead]);
  return info;
}

// ─── Operator control ───────────────────────────────────────────────────────

export interface ControlSnapshot {
  paused: boolean;
  halted: boolean;
  autoDeliveryPaused: boolean;
  gatedTools: string[];
  pendingSteers: number;
}

/** Pause/halt/steer state for one agent, polled (main owns it and the hook
 *  server clears `halted` and drains steers on its own schedule). */
export function useControlSnapshot(agentId: string): [ControlSnapshot | null, (s: ControlSnapshot | null) => void] {
  const [snap, setSnap] = useState<ControlSnapshot | null>(null);
  useEffect(() => {
    let alive = true;
    const read = (): void => {
      if (hidden()) return;
      window.cth.controlSnapshot(agentId)
        .then((s) => { if (alive) setSnap(s); })
        .catch(() => { /* main not ready */ });
    };
    read();
    const iv = setInterval(read, 2500);
    return () => { alive = false; clearInterval(iv); };
  }, [agentId]);
  return [snap, setSnap];
}
