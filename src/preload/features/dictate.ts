/**
 * `window.cth.features.dictate` — owned by the `dictate` unit. Dictate into any
 * app: the shortcut, the hidden recorder window, and typing the words where
 * the cursor is.
 *
 * Three audiences share this one object (the preload is the same in every
 * window); main checks the sender of every host/insert message, so a window
 * calling a member meant for another is ignored, not obeyed:
 *   - everyone: toggle / cancel / getState / onState / settings / status;
 *   - the hidden recorder window (stapler.html#dictate): `host.*`;
 *   - app windows (useDictationInsert): `onInsert` + `insertReady` / `insertResult`.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  DictateConfig,
  DictateHostCommand,
  DictateHostEvent,
  DictateInsertReply,
  DictateInsertRequest,
  DictatePlatformStatus,
  DictateSetResult,
  DictateState
} from '../../shared/features/dictate';

export const dictateApi = {
  /** Start a dictation, or stop the running one and type it (what the
   *  shortcut and the Stapler's ring do). Resolves with the new state. */
  toggle: (): Promise<DictateState> => ipcRenderer.invoke('feat:dictate:toggle'),
  /** Abandon the running dictation; nothing is typed. */
  cancel: (): Promise<DictateState> => ipcRenderer.invoke('feat:dictate:cancel'),
  getState: (): Promise<DictateState> => ipcRenderer.invoke('feat:dictate:getState'),
  /** Every state change, in every window. Returns the unsubscribe function. */
  onState: (cb: (state: DictateState) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, state: DictateState) => cb(state);
    ipcRenderer.on('feat:dictate:state', listener);
    return () => ipcRenderer.removeListener('feat:dictate:state', listener);
  },
  /** Microphone level 0..1 while recording, ~10 times a second. Sent to the
   *  Stapler's windows only (the puck animates with it). */
  onLevel: (cb: (level: number) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, level: number) => cb(level);
    ipcRenderer.on('feat:dictate:level', listener);
    return () => ipcRenderer.removeListener('feat:dictate:level', listener);
  },
  getSettings: (): Promise<DictateConfig> => ipcRenderer.invoke('feat:dictate:getSettings'),
  /** Validate + persist + apply (re-registers the shortcut). An invalid field
   *  comes back as `{ ok: false, field, error }` and nothing is saved. */
  setSettings: (patch: Partial<DictateConfig>): Promise<DictateSetResult> =>
    ipcRenderer.invoke('feat:dictate:setSettings', patch),
  /** Permissions, display server and helper tools on this machine. */
  getStatus: (): Promise<DictatePlatformStatus> => ipcRenderer.invoke('feat:dictate:getStatus'),
  /** Ask the OS for a permission (macOS prompts, then opens the right pane of
   *  System Settings; elsewhere opens the closest settings page there is). */
  requestPermission: (which: 'accessibility' | 'microphone' | 'automation'): Promise<DictatePlatformStatus> =>
    ipcRenderer.invoke('feat:dictate:requestPermission', which),
  /** Copy the last dictation to the clipboard again. */
  copyLast: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('feat:dictate:copyLast'),

  // ─── App windows: insertion at the caret (workspace … useDictationInsert) ──
  /** Say this window can insert at its caret (true on mount, false on unmount). */
  insertReady: (ready: boolean): void => ipcRenderer.send('feat:dictate:insertReady', ready === true),
  onInsert: (cb: (req: DictateInsertRequest) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, req: DictateInsertRequest) => cb(req);
    ipcRenderer.on('feat:dictate:insert', listener);
    return () => ipcRenderer.removeListener('feat:dictate:insert', listener);
  },
  insertResult: (reply: DictateInsertReply): void => ipcRenderer.send('feat:dictate:insertResult', reply),

  // ─── The hidden recorder window (stapler.html#dictate) ─────────────────────
  host: {
    /** Subscribed and listening: main sends any command it was holding. */
    ready: (): Promise<void> => ipcRenderer.invoke('feat:dictate:host:ready'),
    onCommand: (cb: (cmd: DictateHostCommand) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, cmd: DictateHostCommand) => cb(cmd);
      ipcRenderer.on('feat:dictate:host:command', listener);
      return () => ipcRenderer.removeListener('feat:dictate:host:command', listener);
    },
    event: (evt: DictateHostEvent): void => ipcRenderer.send('feat:dictate:host:event', evt)
  }
};
