/**
 * The renderer end of the feature bridge. Mounted ONCE, in App, in both
 * interfaces — a Stapler send must reach the agent whichever one is showing.
 *
 *   feat:deliver   main → here → deliverToAgent (the composer's queue).
 *   feat:navigate  main → here → the Workspace route. In Classic the route is
 *                  remembered for the next switch and, for an agent route,
 *                  that agent is selected — nothing switches modes on its own.
 *   feat:roster    here → main, debounced: the minimal roster main serves to
 *                  feature windows (which have no store of their own).
 *
 * After subscribing it calls `bridgeReady()`, which marks this window live in
 * main and hands back whatever main queued while no renderer was listening
 * (boot, a reload, the hive picker). Drained items are processed even if this
 * effect has since been torn down (StrictMode's double mount): main has
 * already let go of them, so dropping them here would lose them.
 */
import { useEffect } from 'react';
import { useStore, type Agent } from '@/store/store';
import { isWorkspaceRoute, type WorkspaceRoute } from '@shared/features/route';
import type { DeliverRequest } from '@shared/features/deliver';
import type { RosterEntry } from '@shared/features/roster';
import { deriveAgentStatus } from '@shared/workspace/agentStatus';
import { deliverToAgent } from './deliver';
import { navigateWorkspace } from './store';

/** How long roster changes settle before one push. The store changes on every
 *  burst of terminal output (status/action), so this is the throttle. */
const ROSTER_DEBOUNCE_MS = 400;

/** Last path segment of a cwd, the way the classic floor labels a room. */
function projectOf(a: Agent): string | undefined {
  const raw = (a.project || a.cwd || '').split(/[\\/]/).filter(Boolean).pop();
  return raw || undefined;
}

/** The PII-free roster main may cache: no cwd, no notes, no prompts. */
export function buildRoster(agents: readonly Agent[]): RosterEntry[] {
  return agents
    .filter((a) => !a.isAssistant)
    .map((a) => {
      const entry: RosterEntry = {
        id: a.id,
        name: a.name,
        isGod: !!a.isGod,
        status: deriveAgentStatus(a)
      };
      if (a.model) entry.model = a.model;
      if (a.provider) entry.provider = a.provider;
      const project = projectOf(a);
      if (project) entry.project = project;
      return entry;
    });
}

function handleDelivery(req: DeliverRequest): void {
  void deliverToAgent(req).then((res) => {
    if (!res.ok) console.warn(`[features] delivery from ${req.source ?? 'a feature'} failed: ${res.error ?? 'unknown error'}`);
  });
}

function handleNavigate(route: WorkspaceRoute): void {
  if (!isWorkspaceRoute(route)) return;
  // navigateWorkspace also SELECTS an agent route's agent in the hive store,
  // which is the whole of the Classic-mode behaviour.
  navigateWorkspace(route);
}

export function useFeatureBridge(): void {
  // Deliveries and navigation.
  useEffect(() => {
    const features = window.cth?.features;
    if (!features) return;
    const offDeliver = features.onDeliver(handleDelivery);
    const offNavigate = features.onNavigate(handleNavigate);
    void features.bridgeReady().then(
      (backlog) => {
        for (const req of backlog?.deliveries ?? []) handleDelivery(req);
        if (backlog?.navigate) handleNavigate(backlog.navigate);
      },
      () => { /* main without the bridge (should not happen) — nothing queued */ }
    );
    return () => { offDeliver(); offNavigate(); };
  }, []);

  // Roster snapshot → main.
  useEffect(() => {
    const features = window.cth?.features;
    if (!features) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = '';
    const push = (): void => {
      timer = null;
      const list = buildRoster(useStore.getState().agents);
      const key = JSON.stringify(list);
      if (key === last) return;
      last = key;
      try { features.pushRoster(list); } catch { /* window tearing down */ }
    };
    const schedule = (): void => {
      if (!timer) timer = setTimeout(push, ROSTER_DEBOUNCE_MS);
    };
    push();
    const unsub = useStore.subscribe(schedule);
    return () => { unsub(); if (timer) clearTimeout(timer); };
  }, []);
}
