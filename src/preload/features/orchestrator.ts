/**
 * `window.cth.features.orchestrator` — owned by the `wsOrchestrator` unit. The orchestrator's screen.
 *
 * Add members here and nowhere else; the object is spread into the bridge as
 * is, so its type IS the renderer's type. Invoke channels are
 * `feat:orchestrator:<action>`; a listener helper returns its unsubscribe function, e.g.
 *
 *   onThing: (cb: (x: Thing) => void): (() => void) => {
 *     const listener = (_e: IpcRendererEvent, x: Thing) => cb(x);
 *     ipcRenderer.on('feat:orchestrator:thing', listener);
 *     return () => ipcRenderer.removeListener('feat:orchestrator:thing', listener);
 *   }
 */
export const orchestratorApi = {};
