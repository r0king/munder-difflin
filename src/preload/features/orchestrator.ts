/**
 * `window.cth.features.orchestrator` — owned by the `wsOrchestrator` unit. The
 * orchestrator's screen: the floor-wide delivery hold, the daily dollar cap,
 * the default per-agent token cap and the routing log. Channels and payload
 * types are in src/shared/workspace/orchestratorTypes.ts.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  ORCH_CHANNELS,
  type OrchestratorState,
  type RoutingLogResult
} from '../../shared/workspace/orchestratorTypes';

export const orchestratorApi = {
  /** Budget + delivery state. Re-folds the cost ledger first, so the figures
   *  are as fresh as the ledger on disk. */
  getState: (): Promise<OrchestratorState> => ipcRenderer.invoke(ORCH_CHANNELS.getState),
  /** Set (dollars, cents precision) or clear (null) the daily spend cap. A cap
   *  already below today's spend pauses deliveries at once. */
  setDailyCap: (capUsd: number | null): Promise<OrchestratorState> =>
    ipcRenderer.invoke(ORCH_CHANNELS.setDailyCap, capUsd),
  /** Set or clear the token cap the breaker applies to any agent without one. */
  setDefaultTokenCap: (tokens: number | null): Promise<OrchestratorState> =>
    ipcRenderer.invoke(ORCH_CHANNELS.setDefaultTokenCap, tokens),
  /** Hold (true) or release (false) every agent's queue. */
  setDeliveriesPaused: (paused: boolean): Promise<OrchestratorState> =>
    ipcRenderer.invoke(ORCH_CHANNELS.setDeliveriesPaused, paused),
  /** The newest routed messages from the hive log, oldest first. */
  routingLog: (opts?: { limit?: number }): Promise<RoutingLogResult> =>
    ipcRenderer.invoke(ORCH_CHANNELS.routingLog, opts ?? {}),
  /** State pushes (cap reached, pause toggled, spend moved). */
  onState: (cb: (state: OrchestratorState) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, state: OrchestratorState) => cb(state);
    ipcRenderer.on(ORCH_CHANNELS.state, listener);
    return () => ipcRenderer.removeListener(ORCH_CHANNELS.state, listener);
  }
};
