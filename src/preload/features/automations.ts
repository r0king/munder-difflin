/**
 * `window.cth.features.automations` — owned by the `wsAutomations` unit. Automations: schedules, context rules, webhooks.
 *
 * Add members here and nowhere else; the object is spread into the bridge as
 * is, so its type IS the renderer's type. Invoke channels are
 * `feat:automations:<action>`; a listener helper returns its unsubscribe function, e.g.
 *
 *   onThing: (cb: (x: Thing) => void): (() => void) => {
 *     const listener = (_e: IpcRendererEvent, x: Thing) => cb(x);
 *     ipcRenderer.on('feat:automations:thing', listener);
 *     return () => ipcRenderer.removeListener('feat:automations:thing', listener);
 *   }
 */
export const automationsApi = {};
