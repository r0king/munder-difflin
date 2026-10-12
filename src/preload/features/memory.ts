/**
 * `window.cth.features.memory` — owned by the `wsMemory` unit. Memory search.
 *
 * Add members here and nowhere else; the object is spread into the bridge as
 * is, so its type IS the renderer's type. Invoke channels are
 * `feat:memory:<action>`; a listener helper returns its unsubscribe function, e.g.
 *
 *   onThing: (cb: (x: Thing) => void): (() => void) => {
 *     const listener = (_e: IpcRendererEvent, x: Thing) => cb(x);
 *     ipcRenderer.on('feat:memory:thing', listener);
 *     return () => ipcRenderer.removeListener('feat:memory:thing', listener);
 *   }
 */
export const memoryApi = {};
