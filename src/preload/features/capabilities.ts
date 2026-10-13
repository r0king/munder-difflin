/**
 * `window.cth.features.capabilities` — owned by the `wsCapabilities` unit.
 * Per-agent grants, role bundles, MCP keys and Temps
 * (main: src/main/features/capabilities.ts; shapes: shared/workspace/capabilitiesIpc.ts).
 *
 * Keys go one way: `setMcpKey` takes a key and answers ok/error; nothing here
 * ever returns one — `state().mcpKeys` is a presence boolean per server.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  CAPABILITIES_CHANNELS as CH,
  type BundleResult,
  type CapabilitiesChanged,
  type CapabilitiesState,
  type GrantResult,
  type HireTempResult,
  type SetGrantRequest,
  type TempsState
} from '../../shared/workspace/capabilitiesIpc';

export const capabilitiesApi = {
  /** Grants, skill folders and key presence for the given agents. */
  state: (agentIds: string[]): Promise<CapabilitiesState> => ipcRenderer.invoke(CH.state, agentIds),
  /** Turn one skill / MCP server / connection on or off for one agent (one write). */
  setGrant: (req: SetGrantRequest): Promise<GrantResult> => ipcRenderer.invoke(CH.setGrant, req),
  /** Remove everything granted to one agent. */
  clearGrants: (agentId: string): Promise<GrantResult> => ipcRenderer.invoke(CH.clearGrants, { agentId }),
  /** What granting a role bundle to this agent would change. */
  previewBundle: (agentId: string, bundleId: string): Promise<BundleResult> =>
    ipcRenderer.invoke(CH.previewBundle, { agentId, bundleId }),
  /** Grant a role bundle: one atomic write of the agent's record. */
  applyBundle: (agentId: string, bundleId: string): Promise<BundleResult> =>
    ipcRenderer.invoke(CH.applyBundle, { agentId, bundleId }),
  /** Save (or replace) a secret-tier MCP server's key. Write-only. */
  setMcpKey: (id: string, key: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(CH.setMcpKey, { id, key }),
  clearMcpKey: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(CH.clearMcpKey, { id }),

  /** Temps: the queue, who is running, and the history rows. */
  temps: (): Promise<TempsState> => ipcRenderer.invoke(CH.temps),
  hireTemp: (req: { job: string; provider: string; model?: string; cwd: string; isolate: boolean }): Promise<HireTempResult> =>
    ipcRenderer.invoke(CH.hireTemp, req),
  /** Cancel a queued temp, or mark a running one stopping. A `workerId` in the
   *  answer means: now call `window.cth.stopWorker(workerId)`. */
  stopTemp: (id: string): Promise<{ ok: boolean; workerId?: string; error?: string }> => ipcRenderer.invoke(CH.stopTemp, { id }),
  setMaxTemps: (n: number): Promise<{ ok: boolean; maxConcurrent: number }> => ipcRenderer.invoke(CH.setMaxTemps, { n }),
  clearTempHistory: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(CH.clearTempHistory),

  /** Something changed in main (a grant, a key, a temp); re-read that slice. */
  onChanged: (cb: (c: CapabilitiesChanged) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, c: CapabilitiesChanged) => cb(c);
    ipcRenderer.on(CH.changed, listener);
    return () => ipcRenderer.removeListener(CH.changed, listener);
  }
};
