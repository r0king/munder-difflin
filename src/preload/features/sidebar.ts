/**
 * `window.cth.features.sidebar` — owned by the `wsSidebar` unit. The Workspace sidebar.
 *
 * Add members here and nowhere else; the object is spread into the bridge as
 * is, so its type IS the renderer's type. Invoke channels are
 * `feat:sidebar:<action>`; a listener helper returns its unsubscribe function, e.g.
 *
 *   onThing: (cb: (x: Thing) => void): (() => void) => {
 *     const listener = (_e: IpcRendererEvent, x: Thing) => cb(x);
 *     ipcRenderer.on('feat:sidebar:thing', listener);
 *     return () => ipcRenderer.removeListener('feat:sidebar:thing', listener);
 *   }
 */
export const sidebarApi = {};
