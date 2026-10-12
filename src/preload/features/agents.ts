/**
 * `window.cth.features.agents` — owned by the `wsAgents` unit. Agent cards and agent rooms.
 *
 * Add members here and nowhere else; the object is spread into the bridge as
 * is, so its type IS the renderer's type. Invoke channels are
 * `feat:agents:<action>`; a listener helper returns its unsubscribe function, e.g.
 *
 *   onThing: (cb: (x: Thing) => void): (() => void) => {
 *     const listener = (_e: IpcRendererEvent, x: Thing) => cb(x);
 *     ipcRenderer.on('feat:agents:thing', listener);
 *     return () => ipcRenderer.removeListener('feat:agents:thing', listener);
 *   }
 */
export const agentsApi = {};
