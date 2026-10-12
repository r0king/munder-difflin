/**
 * Transcription — main-process side (owned by the `transcribe` unit).
 *
 * Local Whisper (bundled model + the optional larger download), Apple's
 * on-device recogniser on macOS 26, and Groq with the user's own key; the
 * vocabulary (built-in technical names + the user's words); and the You/Them
 * meeting merge.
 *
 * The two exported functions are the contract `stapler` and `dictate` call
 * directly (same process, no IPC). FOUNDATION STUB: both resolve to
 * `{ ok: false, error: 'not implemented' }` so callers can be built and
 * exercised against the failure path today.
 *
 * Reuse: src/main/freeflow.ts already has `transcribeWithGroq` (the Groq HTTP
 * call + key handling for the composer mic); the Groq key is `groqApiKey` in
 * config.
 *
 * Channels: feat:transcribe:<action>.
 */
import { failedTranscription, type TranscribeOptions, type TranscribeResult } from '../../shared/features/transcribe';
import type { FeatureModule } from './types';

/** Transcribe one WAV file (absolute path). */
export async function transcribeFile(wavPath: string, opts?: TranscribeOptions): Promise<TranscribeResult> {
  void wavPath; void opts;
  return failedTranscription('not implemented');
}

/**
 * Transcribe a meeting: the microphone track as 'you', the system-audio track
 * as 'them', segments interleaved by start time. Either track may be absent.
 */
export async function transcribeMeeting(micWav?: string, systemWav?: string): Promise<TranscribeResult> {
  void micWav; void systemWav;
  return failedTranscription('not implemented');
}

export const transcribeFeature: FeatureModule = {
  name: 'transcribe',
  register(ctx) {
    void ctx;
    // TODO(transcribe): register feat:transcribe:* handlers (engine status,
    // model download, vocabulary) here.
  }
};
