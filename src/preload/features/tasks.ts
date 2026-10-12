/**
 * `window.cth.features.tasks` — owned by the `wsTasks` unit. The Tasks board.
 *
 * Add members here and nowhere else; the object is spread into the bridge as
 * is, so its type IS the renderer's type. Invoke channels are
 * `feat:tasks:<action>`; a listener helper returns its unsubscribe function, e.g.
 *
 *   onThing: (cb: (x: Thing) => void): (() => void) => {
 *     const listener = (_e: IpcRendererEvent, x: Thing) => cb(x);
 *     ipcRenderer.on('feat:tasks:thing', listener);
 *     return () => ipcRenderer.removeListener('feat:tasks:thing', listener);
 *   }
 */
export const tasksApi = {};
