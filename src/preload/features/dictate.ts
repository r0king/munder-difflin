/**
 * `window.cth.features.dictate` — owned by the `dictate` unit. Dictate into any app: shortcut state, permissions, injection.
 *
 * Add members here and nowhere else; the object is spread into the bridge as
 * is, so its type IS the renderer's type. Invoke channels are
 * `feat:dictate:<action>`; a listener helper returns its unsubscribe function, e.g.
 *
 *   onThing: (cb: (x: Thing) => void): (() => void) => {
 *     const listener = (_e: IpcRendererEvent, x: Thing) => cb(x);
 *     ipcRenderer.on('feat:dictate:thing', listener);
 *     return () => ipcRenderer.removeListener('feat:dictate:thing', listener);
 *   }
 */
export const dictateApi = {};
