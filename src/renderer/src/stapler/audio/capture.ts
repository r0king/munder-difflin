/**
 * Audio capture contract — owned by the `transcribe` unit, used by `stapler`
 * (record message, record meeting) and `dictate`.
 *
 * Runs in a renderer (the puck window). Captures the microphone ('you') and/or
 * system audio ('them'), reports live levels for the meter, and writes each
 * track to a WAV file whose absolute path main can transcribe
 * (transcribeFile / transcribeMeeting in src/main/features/transcribe.ts).
 *
 * The mic permission gate in main only opens while a feature module's
 * `micLive()` answers true — capture must be started through the unit's own
 * IPC so main knows it is live BEFORE getUserMedia is called.
 *
 * FOUNDATION STUB — typed, and throws at run time.
 */

export interface CaptureOptions {
  /** Names the WAV files; one session = one recording. */
  sessionId: string;
  /** Capture the microphone ('you'). */
  mic: boolean;
  /** Capture system audio ('them'). */
  system: boolean;
  micDeviceId?: string;
  systemDeviceId?: string;
}

export interface CaptureLevels {
  /** 0..1 */
  mic: number;
  /** 0..1 */
  system: number;
}

export interface CaptureStopResult {
  ok: boolean;
  /** Absolute path of the microphone WAV, when captured. */
  micWav?: string;
  /** Absolute path of the system-audio WAV, when captured. */
  systemWav?: string;
  durationMs: number;
  error?: string;
}

export interface CaptureHandle {
  /** Live input levels; returns the unsubscribe function. */
  onLevel(cb: (levels: CaptureLevels) => void): () => void;
  /** Stop and write the WAV file(s). */
  stop(): Promise<CaptureStopResult>;
  /** Stop and discard everything. */
  cancel(): Promise<void>;
}

export async function startCapture(opts: CaptureOptions): Promise<CaptureHandle> {
  void opts;
  throw new Error('audio capture is not implemented yet');
}
