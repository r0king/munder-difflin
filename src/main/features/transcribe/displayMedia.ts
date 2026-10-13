/**
 * System audio ("Them") through getDisplayMedia loopback, Windows and macOS 13+.
 *
 * Chromium only hands a page system audio as part of a screen share, so the
 * capture asks for `getDisplayMedia({ audio: true, video: true })` and drops
 * the video track at once. Electron sends that request here; we answer with
 * the first screen and `audio: 'loopback'` — but ONLY for a webContents that
 * is armed, i.e. that opened a recording session with system audio through
 * our own IPC and has not finalized it. Every other request is denied, which is
 * exactly what happened before this handler existed (the app had none, and
 * Electron denies getDisplayMedia without one), so no existing behaviour
 * changes. One handler per session object is installed, lazily.
 *
 * macOS needs Chromium's ScreenCaptureKit loopback switched on before the app
 * is ready (see LOOPBACK_FEATURES, applied through earlyEnableFeatures) and the
 * user's Screen & System Audio Recording permission; without either, the
 * stream arrives with no audio track and capture.ts falls back to a chosen
 * input device with an explanation.
 */
import { desktopCapturer, webContents, type Session, type WebFrameMain } from 'electron';

export const LOOPBACK_FEATURES = ['MacLoopbackAudioForScreenShare', 'MacSckSystemAudioLoopbackOverride'];

const armed = new Map<number, number>();
const installed = new WeakSet<Session>();

export function armLoopback(webContentsId: number): void {
  armed.set(webContentsId, (armed.get(webContentsId) ?? 0) + 1);
}

export function disarmLoopback(webContentsId: number): void {
  const n = (armed.get(webContentsId) ?? 0) - 1;
  if (n > 0) armed.set(webContentsId, n);
  else armed.delete(webContentsId);
}

function sameFrame(a: WebFrameMain | null | undefined, b: WebFrameMain | null | undefined): boolean {
  return !!a && !!b && a.processId === b.processId && a.routingId === b.routingId;
}

function isArmedFrame(frame: WebFrameMain | null | undefined): boolean {
  if (!frame) return false;
  for (const id of armed.keys()) {
    const wc = webContents.fromId(id);
    if (!wc || wc.isDestroyed()) {
      armed.delete(id);
      continue;
    }
    if (sameFrame(wc.mainFrame, frame) || sameFrame(wc.mainFrame, frame.top)) return true;
  }
  return false;
}

export function ensureDisplayMediaHandler(ses: Session): void {
  if (installed.has(ses)) return;
  installed.add(ses);
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (!request.audioRequested || !isArmedFrame(request.frame)) {
      callback({});
      return;
    }
    desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        if (!sources.length) callback({});
        else callback({ video: sources[0], audio: 'loopback' });
      })
      .catch((e) => {
        console.error('[transcribe] screen source lookup failed:', e);
        callback({});
      });
  });
}
