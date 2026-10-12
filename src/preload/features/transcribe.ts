/**
 * `window.cth.features.transcribe` — owned by the `transcribe` unit. Transcription engines, model download, vocabulary.
 *
 * Add members here and nowhere else; the object is spread into the bridge as
 * is, so its type IS the renderer's type. Invoke channels are
 * `feat:transcribe:<action>`; a listener helper returns its unsubscribe function, e.g.
 *
 *   onThing: (cb: (x: Thing) => void): (() => void) => {
 *     const listener = (_e: IpcRendererEvent, x: Thing) => cb(x);
 *     ipcRenderer.on('feat:transcribe:thing', listener);
 *     return () => ipcRenderer.removeListener('feat:transcribe:thing', listener);
 *   }
 */
export const transcribeApi = {};
