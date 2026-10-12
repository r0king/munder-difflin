/**
 * Transcription contract (owned by the `transcribe` unit; the shape is fixed
 * here so `stapler` and `dictate` can build against it in parallel).
 *
 * Engines:
 *   'local'       — the bundled Whisper model (default).
 *   'local-large' — the optional larger Whisper download.
 *   'apple'       — Apple's on-device recogniser (macOS 26+ only).
 *   'groq'        — Groq Whisper, only when the user added their own key.
 */
export type TranscribeEngine = 'local' | 'local-large' | 'apple' | 'groq';

export interface TranscriptSegment {
  /** Meetings only: the microphone is 'you', system audio is 'them'. */
  speaker?: 'you' | 'them';
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscribeResult {
  ok: boolean;
  text: string;
  segments: TranscriptSegment[];
  engine: TranscribeEngine;
  error?: string;
}

export interface TranscribeOptions {
  language?: string;
  /** Biasing prompt (vocabulary: names, jargon). */
  prompt?: string;
}

/** The result every stub and every early failure returns. */
export function failedTranscription(error: string, engine: TranscribeEngine = 'local'): TranscribeResult {
  return { ok: false, text: '', segments: [], engine, error };
}
