/**
 * `window.cth.features` — the feature layer's half of the preload bridge.
 *
 * One object per unit (each unit fills in ONLY its own file in this folder),
 * plus the foundation-owned bridge calls that connect every unit to the app:
 *
 *   onDeliver / onNavigate / pushRoster / bridgeReady
 *       App window only — consumed by workspace/useFeatureBridge.ts, mounted
 *       once in App.tsx. No unit calls these.
 *   deliver / navigate / getRoster / onRoster
 *       For FEATURE windows (the Stapler's puck), which have no renderer store:
 *       deliver text to an agent, open a Workspace route in the main window,
 *       and read the roster main caches. An app-window feature calls
 *       workspace/deliver.ts `deliverToAgent` directly instead.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron';
import { FEAT_BRIDGE } from '../../shared/features/channels';
import type { DeliverRequest, DeliverResult } from '../../shared/features/deliver';
import type { RosterEntry } from '../../shared/features/roster';
import type { WorkspaceRoute } from '../../shared/features/route';
import { staplerApi } from './stapler';
import { transcribeApi } from './transcribe';
import { dictateApi } from './dictate';
import { sidebarApi } from './sidebar';
import { agentsApi } from './agents';
import { orchestratorApi } from './orchestrator';
import { tasksApi } from './tasks';
import { inboxApi } from './inbox';
import { automationsApi } from './automations';
import { memoryApi } from './memory';
import { capabilitiesApi } from './capabilities';

/** What main held for this window while no bridge was listening. */
export interface BridgeBacklog {
  deliveries: DeliverRequest[];
  navigate: WorkspaceRoute | null;
}

export const featuresApi = {
  stapler: staplerApi,
  transcribe: transcribeApi,
  dictate: dictateApi,
  sidebar: sidebarApi,
  agents: agentsApi,
  orchestrator: orchestratorApi,
  tasks: tasksApi,
  inbox: inboxApi,
  automations: automationsApi,
  memory: memoryApi,
  capabilities: capabilitiesApi,

  // ─── Bridge (app window) ───────────────────────────────────────────────────
  /** main asks this window to deliver text to an agent (`feat:deliver`). */
  onDeliver: (cb: (req: DeliverRequest) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, req: DeliverRequest) => cb(req);
    ipcRenderer.on(FEAT_BRIDGE.deliver, listener);
    return () => ipcRenderer.removeListener(FEAT_BRIDGE.deliver, listener);
  },
  /** main asks this window to open a Workspace route (`feat:navigate`). */
  onNavigate: (cb: (route: WorkspaceRoute) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, route: WorkspaceRoute) => cb(route);
    ipcRenderer.on(FEAT_BRIDGE.navigate, listener);
    return () => ipcRenderer.removeListener(FEAT_BRIDGE.navigate, listener);
  },
  /** Push the roster snapshot main serves to feature windows. */
  pushRoster: (list: RosterEntry[]): void => {
    ipcRenderer.send(FEAT_BRIDGE.roster, list);
  },
  /** Call AFTER subscribing onDeliver/onNavigate: marks this window's bridge
   *  live and returns whatever main queued while it was not. */
  bridgeReady: (): Promise<BridgeBacklog> => ipcRenderer.invoke(FEAT_BRIDGE.ready),

  // ─── Bridge (feature windows) ──────────────────────────────────────────────
  /** Deliver via the main window. `ok` means main accepted it (the target
   *  exists as far as main can tell); queue-level failures are logged there. */
  deliver: (req: DeliverRequest): Promise<DeliverResult> => ipcRenderer.invoke(FEAT_BRIDGE.deliverRequest, req),
  /** Show the main window on a Workspace route. */
  navigate: (route: WorkspaceRoute): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(FEAT_BRIDGE.navigateRequest, route),
  /** The roster main last received from the main window. */
  getRoster: (): Promise<RosterEntry[]> => ipcRenderer.invoke(FEAT_BRIDGE.rosterGet),
  /** Roster changes, pushed to feature windows. */
  onRoster: (cb: (list: RosterEntry[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, list: RosterEntry[]) => cb(list);
    ipcRenderer.on(FEAT_BRIDGE.rosterChanged, listener);
    return () => ipcRenderer.removeListener(FEAT_BRIDGE.rosterChanged, listener);
  }
};

export type FeaturesApi = typeof featuresApi;
