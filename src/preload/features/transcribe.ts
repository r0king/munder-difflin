/**
 * `window.cth.features.transcribe` — owned by the `transcribe` unit.
 * Recording sessions (PCM in, WAV on disk), transcription, engines, model
 * downloads and the vocabulary. Contract types: src/shared/features/transcribe.ts.
 *
 * Normal callers use src/renderer/src/stapler/audio/capture.ts (startCapture),
 * which drives beginSession / appendPcm / finalizeSession / cancelSession; then
 * `transcribeSession(sessionId, { meeting })`.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  TRANSCRIBE_CH,
  type BeginSessionRequest,
  type BeginSessionResult,
  type FinalizeResult,
  type LocalModelId,
  type TranscribeResult,
  type TranscribeSessionOptions,
  type TranscribeSettings,
  type TranscribeStatus,
  type TranscribeTrack
} from '../../shared/features/transcribe';

export const transcribeApi = {
  /** Open a recording session. Call BEFORE getUserMedia: main's mic gate only
   *  opens while a session is live. */
  beginSession: (req: BeginSessionRequest): Promise<BeginSessionResult> =>
    ipcRenderer.invoke(TRANSCRIBE_CH.begin, req),
  /** Append 16 kHz mono Int16 PCM to a track. Fire-and-forget; ordered. */
  appendPcm: (sessionId: string, track: TranscribeTrack, chunk: Int16Array | ArrayBuffer): void => {
    // Ship exactly the chunk's bytes, never the whole backing buffer of a view.
    const bytes = chunk instanceof ArrayBuffer
      ? new Uint8Array(chunk)
      : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    ipcRenderer.send(TRANSCRIBE_CH.append, sessionId, track, bytes);
  },
  /** Close the WAV files; resolves with their paths and the duration. */
  finalizeSession: (sessionId: string): Promise<FinalizeResult> =>
    ipcRenderer.invoke(TRANSCRIBE_CH.finalize, sessionId),
  /** Close and delete everything recorded in the session. */
  cancelSession: (sessionId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(TRANSCRIBE_CH.cancel, sessionId),
  /** Transcribe a finalized session; `meeting` labels You / Them. */
  transcribeSession: (sessionId: string, opts?: TranscribeSessionOptions): Promise<TranscribeResult> =>
    ipcRenderer.invoke(TRANSCRIBE_CH.transcribeSession, sessionId, opts ?? {}),

  getSettings: (): Promise<TranscribeSettings> => ipcRenderer.invoke(TRANSCRIBE_CH.getSettings),
  setSettings: (patch: Partial<TranscribeSettings>): Promise<TranscribeSettings> =>
    ipcRenderer.invoke(TRANSCRIBE_CH.setSettings, patch),
  getStatus: (): Promise<TranscribeStatus> => ipcRenderer.invoke(TRANSCRIBE_CH.getStatus),
  /** Engine / model / download changes, in every window. */
  onStatus: (cb: (status: TranscribeStatus) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, status: TranscribeStatus) => cb(status);
    ipcRenderer.on(TRANSCRIBE_CH.status, listener);
    return () => ipcRenderer.removeListener(TRANSCRIBE_CH.status, listener);
  },
  /** Start downloading a local model; progress arrives through onStatus. */
  downloadModel: (which: LocalModelId): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(TRANSCRIBE_CH.downloadModel, which),
  cancelDownload: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(TRANSCRIBE_CH.cancelDownload),
  /** Delete the downloaded larger model (the bundled one cannot be removed). */
  removeModel: (which: LocalModelId): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(TRANSCRIBE_CH.removeModel, which),
  /** The built-in vocabulary (read-only list shown beside the user's words). */
  getVocabulary: (): Promise<{ builtin: string[] }> => ipcRenderer.invoke(TRANSCRIBE_CH.getVocabulary)
};
