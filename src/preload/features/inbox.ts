/**
 * `window.cth.features.inbox` — owned by the `wsInbox` unit. The Inbox.
 *
 * Add members here and nowhere else; the object is spread into the bridge as
 * is, so its type IS the renderer's type. Invoke channels are
 * `feat:inbox:<action>`; a listener helper returns its unsubscribe function, e.g.
 *
 *   onThing: (cb: (x: Thing) => void): (() => void) => {
 *     const listener = (_e: IpcRendererEvent, x: Thing) => cb(x);
 *     ipcRenderer.on('feat:inbox:thing', listener);
 *     return () => ipcRenderer.removeListener('feat:inbox:thing', listener);
 *   }
 */
export const inboxApi = {};
