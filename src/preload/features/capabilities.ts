/**
 * `window.cth.features.capabilities` — owned by the `wsCapabilities` unit. Capabilities, Temps and role bundles.
 *
 * Add members here and nowhere else; the object is spread into the bridge as
 * is, so its type IS the renderer's type. Invoke channels are
 * `feat:capabilities:<action>`; a listener helper returns its unsubscribe function, e.g.
 *
 *   onThing: (cb: (x: Thing) => void): (() => void) => {
 *     const listener = (_e: IpcRendererEvent, x: Thing) => cb(x);
 *     ipcRenderer.on('feat:capabilities:thing', listener);
 *     return () => ipcRenderer.removeListener('feat:capabilities:thing', listener);
 *   }
 */
export const capabilitiesApi = {};
