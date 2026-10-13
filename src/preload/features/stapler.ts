/**
 * `window.cth.features.stapler` — owned by the `stapler` unit.
 *
 * getState / setEnabled / onState are the contract the titlebar toggle and the
 * Workspace sidebar build against; keep their shapes. The rest serves three
 * audiences that share this one preload (main checks the sender where it
 * matters, so a window calling a member meant for another is refused):
 *   - every window: state, settings, the meetings library;
 *   - the puck (stapler.html#puck): its window, the tray, recording, sending;
 *   - the screenshot overlay (stapler.html#overlay): overlayInit/Commit/Cancel.
 * Channels are `feat:stapler:<action>`; see src/main/features/stapler.ts.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  MeetingFinishRequest,
  MeetingPatch,
  MeetingRecord,
  MeetingSummary,
  MeetingTranscribingRequest,
  OverlayInit,
  PuckBoot,
  Region,
  ScreenshotStart,
  StaplerCommand,
  StaplerDraft,
  StaplerEnv,
  StaplerLayout,
  StaplerMode,
  StaplerPanel,
  StaplerResult,
  StaplerSendRequest,
  StaplerState,
  StaplerTarget
} from '../../shared/features/stapler';

const ch = (action: string): string => `feat:stapler:${action}`;
const invoke = <T>(action: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(ch(action), ...args);

function listen<T>(action: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(ch(action), listener);
  return () => ipcRenderer.removeListener(ch(action), listener);
}

export const staplerApi = {
  getState: (): Promise<StaplerState> => invoke('getState'),
  /** Show or hide the puck. Resolves with the state main settled on, which is
   *  what a toggle should render (it may refuse: no display, or a recording
   *  is running and must be stopped first). */
  setEnabled: (on: boolean): Promise<StaplerState> => invoke('setEnabled', on),
  /** Every state change, in every window. Returns the unsubscribe function. */
  onState: (cb: (state: StaplerState) => void): (() => void) => listen('state', cb),

  // ─── Settings ──────────────────────────────────────────────────────────────
  /** "Make invisible" (persisted). */
  setInvisible: (on: boolean): Promise<StaplerState> => invoke('setInvisible', on),
  /** Put the puck in the middle of its screen. */
  resetPosition: (): Promise<StaplerState> => invoke('resetPosition'),
  /** Try registering the meeting shortcut again. */
  retryShortcut: (): Promise<StaplerState> => invoke('retryShortcut'),
  getEnv: (): Promise<StaplerEnv> => invoke('getEnv'),
  /** macOS: open System Settings at Screen Recording. */
  openScreenSettings: (): Promise<{ ok: boolean }> => invoke('openScreenSettings'),
  /** From an app window: show the puck (turning it on) at a panel. */
  openPanel: (panel: StaplerPanel): Promise<StaplerResult> => invoke('openPanel', panel),
  getTarget: (): Promise<StaplerTarget> => invoke('getTarget'),
  /** The To menu's pick (remembered). Resolves with what main kept. */
  setTarget: (target: StaplerTarget): Promise<StaplerTarget> => invoke('setTarget', target),

  // ─── The puck window ───────────────────────────────────────────────────────
  /** Call after subscribing onCommand/onDraft. */
  puckReady: (): Promise<PuckBoot> => invoke('puckReady'),
  setMode: (mode: StaplerMode, panel?: StaplerPanel): Promise<StaplerLayout> => invoke('setMode', mode, panel),
  /** Hover tracking for click-through transparent areas. Fire-and-forget. */
  setIgnoreMouse: (ignore: boolean): void => { void ipcRenderer.invoke(ch('setIgnoreMouse'), ignore); },
  dragStart: (): Promise<boolean> => invoke('dragStart'),
  dragEnd: (): Promise<StaplerLayout | null> => invoke('dragEnd'),
  /** Say what is recording BEFORE opening the mic (content protection and
   *  the permission gate follow it); null when it stops. */
  setRecording: (kind: 'message' | 'meeting' | null): Promise<StaplerState> => invoke('setRecording', kind),
  onCommand: (cb: (cmd: StaplerCommand) => void): (() => void) => listen('command', cb),

  // ─── Screenshot ────────────────────────────────────────────────────────────
  screenshot: (): Promise<ScreenshotStart> => invoke('screenshot'),
  overlayInit: (): Promise<OverlayInit> => invoke('overlayInit'),
  overlayCommit: (region: Region): Promise<StaplerResult> => invoke('overlayCommit', region),
  overlayCancel: (): Promise<StaplerResult> => invoke('overlayCancel'),

  // ─── The tray and sending ──────────────────────────────────────────────────
  getDraft: (): Promise<StaplerDraft> => invoke('getDraft'),
  onDraft: (cb: (draft: StaplerDraft) => void): (() => void) => listen('draft', cb),
  removeAttachment: (id: string): Promise<StaplerDraft> => invoke('removeAttachment', id),
  clearDraft: (): Promise<StaplerDraft> => invoke('clearDraft'),
  /** Main's own file/folder picker. */
  pickFiles: (what: 'files' | 'folders'): Promise<{ draft: StaplerDraft; rejected: number; cancelled?: boolean }> =>
    invoke('pickFiles', what),
  /** Paths of files dropped on the panel (from window.cth.pathForFile). */
  addPaths: (paths: string[]): Promise<{ draft: StaplerDraft; rejected: number }> => invoke('addPaths', paths),
  /** Send the note and everything in the tray. */
  send: (req: StaplerSendRequest): Promise<StaplerResult> => invoke('send', req),

  // ─── Meetings ──────────────────────────────────────────────────────────────
  meetingStart: (): Promise<{ ok: boolean; id?: string; startedAt?: string; error?: string }> => invoke('meetingStart'),
  meetingAbort: (id: string): Promise<StaplerResult> => invoke('meetingAbort', id),
  meetingTranscribing: (id: string, req: MeetingTranscribingRequest): Promise<StaplerResult> =>
    invoke('meetingTranscribing', id, req),
  meetingFinish: (id: string, req: MeetingFinishRequest): Promise<StaplerResult & { meeting?: MeetingSummary }> =>
    invoke('meetingFinish', id, req),
  meetingList: (query?: string): Promise<MeetingSummary[]> => invoke('meetingList', query ?? ''),
  meetingGet: (id: string): Promise<MeetingRecord | null> => invoke('meetingGet', id),
  meetingUpdate: (id: string, patch: MeetingPatch): Promise<MeetingRecord | null> => invoke('meetingUpdate', id, patch),
  meetingDelete: (id: string): Promise<StaplerResult> => invoke('meetingDelete', id),
  meetingSend: (id: string, target: StaplerTarget): Promise<StaplerResult> => invoke('meetingSend', id, target),
  /** Open the meeting's folder in the file manager. */
  meetingReveal: (id: string): Promise<StaplerResult> => invoke('meetingReveal', id),
  /** The meeting the puck asked the library to open, once. */
  takeMeetingFocus: (): Promise<string | null> => invoke('takeMeetingFocus'),
  /** From the puck: show the library in the main window (at a meeting). */
  openMeetingInApp: (id?: string): Promise<StaplerResult> => invoke('openMeetingInApp', id),
  /** The library changed on disk. */
  onMeetings: (cb: () => void): (() => void) => listen('meetings', () => cb()),
  /** The puck asked to open this meeting (app windows). */
  onFocusMeeting: (cb: (id: string) => void): (() => void) => listen('focusMeeting', cb)
};
