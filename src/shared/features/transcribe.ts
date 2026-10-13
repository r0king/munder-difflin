/**
 * Transcription contract (owned by the `transcribe` unit; the shape is fixed
 * here so `stapler` and `dictate` can build against it in parallel).
 *
 * Engines:
 *   'local'       — the bundled Whisper model (default).
 *   'local-large' — the optional larger Whisper download.
 *   'apple'       — Apple's on-device recogniser (macOS 26+ only).
 *   'groq'        — Groq Whisper, only when the user added their own key.
 *
 * A recording is a SESSION: the renderer (audio/capture.ts) opens it in main
 * (`beginSession`), streams 16 kHz mono Int16 PCM per track (`appendPcm`), and
 * `finalizeSession` closes the WAV files under
 * `<userData>/features/transcribe/sessions/<id>/{mic,system}.wav`. Audio is
 * deleted 24 h after it is transcribed (7 days if it never is).
 *
 * Pure module: no Electron, no Node — the renderer, preload and main all import it.
 */
export type TranscribeEngine = 'local' | 'local-large' | 'apple' | 'groq';
export const TRANSCRIBE_ENGINES: readonly TranscribeEngine[] = ['local', 'local-large', 'apple', 'groq'];

/** The two local Whisper models: the bundled default and the larger download. */
export type LocalModelId = 'base' | 'large';

/** A capture track: the microphone ('you') or system audio ('them'). */
export type TranscribeTrack = 'mic' | 'system';

/** What a capture is for. Picks the mic's processing (see capture.ts). */
export type CapturePurpose = 'message' | 'meeting' | 'dictation';

/** Every track is written at this rate, mono, 16-bit — what Whisper wants. */
export const PCM_SAMPLE_RATE = 16_000;

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
  /** The engine that actually ran (a preferred engine that was unavailable
   *  falls back to 'local'). */
  engine: TranscribeEngine;
  error?: string;
  /** Length of the audio that was transcribed. */
  durationMs?: number;
  /** Something the user may want to know although it worked (e.g. Groq failed
   *  and the local model was used instead). */
  warning?: string;
}

export interface TranscribeOptions {
  language?: string;
  /** Extra biasing text (names, jargon), placed before the vocabulary. */
  prompt?: string;
  /** Override the engine chosen in settings for this one call. */
  engine?: TranscribeEngine;
  /** Apply the vocabulary (prompt + casing pass). Default true. */
  vocabulary?: boolean;
}

/** The result every stub and every early failure returns. */
export function failedTranscription(error: string, engine: TranscribeEngine = 'local'): TranscribeResult {
  return { ok: false, text: '', segments: [], engine, error };
}

// ─── Sessions ───────────────────────────────────────────────────────────────

export interface BeginSessionRequest {
  sessionId: string;
  mic: boolean;
  system: boolean;
  purpose?: CapturePurpose;
}

export interface BeginSessionResult {
  ok: boolean;
  error?: string;
  /** Main armed its display-media handler for this window, so a
   *  getDisplayMedia() call now returns system audio (Windows; macOS 13+). */
  loopback: boolean;
}

export interface FinalizeResult {
  ok: boolean;
  sessionId: string;
  /** Absolute path of the microphone WAV, when one was written. */
  micWav?: string;
  /** Absolute path of the system-audio WAV, when one was written. */
  systemWav?: string;
  durationMs: number;
  error?: string;
}

export interface TranscribeSessionOptions {
  /** Both tracks, labelled You / Them, interleaved by time. Without it the
   *  mic track is transcribed (or the system track when there is no mic). */
  meeting?: boolean;
  engine?: TranscribeEngine;
}

/** Session ids name a directory on disk, so they are strictly shaped: no dots,
 *  no separators, nothing a path could be built from. (Same shape the stapler
 *  checks; `newSessionId` makes one.) */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

/** A fresh, sortable session id (time prefix + 48 random bits). */
export function newSessionId(now: number = Date.now()): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${now.toString(36)}-${rand}`;
}

// ─── Settings ───────────────────────────────────────────────────────────────

export interface TranscribeSettings {
  /** The engine to use when it is available. */
  engine: TranscribeEngine;
  /** The user's own words, added to the built-in vocabulary. */
  customVocabulary: string[];
  /** Microphone deviceId; '' = the system default. */
  micDeviceId: string;
  /** System-audio input deviceId; '' = automatic (loopback on Windows/macOS,
   *  a "Monitor of …" source on Linux). */
  systemDeviceId: string;
}

export const DEFAULT_TRANSCRIBE_SETTINGS: TranscribeSettings = {
  engine: 'local',
  customVocabulary: [],
  micDeviceId: '',
  systemDeviceId: ''
};

export const MAX_CUSTOM_WORDS = 200;
export const MAX_CUSTOM_WORD_LENGTH = 48;
const MAX_DEVICE_ID_LENGTH = 512;

/** Keep only well-formed fields of a settings patch from the renderer. */
export function sanitizeSettingsPatch(raw: unknown): Partial<TranscribeSettings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const p = raw as Record<string, unknown>;
  const out: Partial<TranscribeSettings> = {};
  if (typeof p.engine === 'string' && (TRANSCRIBE_ENGINES as readonly string[]).includes(p.engine)) {
    out.engine = p.engine as TranscribeEngine;
  }
  if (Array.isArray(p.customVocabulary)) {
    const seen = new Set<string>();
    const words: string[] = [];
    for (const w of p.customVocabulary) {
      if (typeof w !== 'string') continue;
      // One entry is one term: collapse inner whitespace, drop control chars.
      const clean = w.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
      if (!clean || clean.length > MAX_CUSTOM_WORD_LENGTH) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      words.push(clean);
      if (words.length >= MAX_CUSTOM_WORDS) break;
    }
    out.customVocabulary = words;
  }
  for (const k of ['micDeviceId', 'systemDeviceId'] as const) {
    const v = p[k];
    if (typeof v === 'string' && v.length <= MAX_DEVICE_ID_LENGTH) out[k] = v;
  }
  return out;
}

/** Settings read from disk, with every field checked (a hand-edited file must
 *  not crash main or reach the renderer malformed). */
export function normalizeSettings(raw: unknown): TranscribeSettings {
  return { ...DEFAULT_TRANSCRIBE_SETTINGS, ...sanitizeSettingsPatch(raw) };
}

// ─── Status ─────────────────────────────────────────────────────────────────

/** Why an engine cannot run right now (rendered by TranscribeSettings). */
export type EngineUnavailableReason =
  | 'model-missing'      // local-large: not downloaded yet
  | 'downloading'        // a model download is in flight
  | 'no-groq-key'        // groq: no key in Settings → Voice
  | 'macos-only'         // apple: not a Mac
  | 'needs-macos-26'     // apple: an older macOS
  | 'no-native-helper';  // apple: macOS 26, but this build ships no Speech helper

export interface EngineInfo {
  id: TranscribeEngine;
  available: boolean;
  reason?: EngineUnavailableReason;
}

export type ModelState = 'bundled' | 'cached' | 'missing' | 'downloading' | 'error';

export interface ModelInfo {
  id: LocalModelId;
  /** Hugging Face repo id, e.g. onnx-community/whisper-base.en. */
  repo: string;
  /** Total download size of the files we need. */
  sizeBytes: number;
  state: ModelState;
  error?: string;
}

export interface DownloadProgress {
  model: LocalModelId;
  loadedBytes: number;
  totalBytes: number;
  /** 0..100 */
  pct: number;
}

/** How this platform gets the other side of a call ("Them"). */
export type SystemAudioMode = 'loopback' | 'monitor' | 'device';

export interface TranscribeStatus {
  /** The engine chosen in settings. */
  engine: TranscribeEngine;
  /** What a transcription started now would actually use. */
  effectiveEngine: TranscribeEngine;
  /** The effective engine can run without a download first. */
  modelReady: boolean;
  engines: EngineInfo[];
  models: ModelInfo[];
  downloading?: DownloadProgress;
  /** A Groq key is saved (the key itself never leaves main). */
  groqKey: boolean;
  /** A transcription is running. */
  busy: boolean;
  platform: string;
  systemAudio: SystemAudioMode;
  /** How many built-in vocabulary terms ship with the app. */
  builtinVocabularyCount: number;
  /** macOS only: Screen & System Audio Recording permission, which system
   *  audio capture needs. */
  screenAccess?: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';
}

// ─── Channels ───────────────────────────────────────────────────────────────

/** `feat:transcribe:<action>` — invoke unless marked otherwise. */
export const TRANSCRIBE_CH = {
  begin: 'feat:transcribe:begin',
  /** renderer → main, `send` (fire-and-forget): one PCM chunk. */
  append: 'feat:transcribe:append',
  finalize: 'feat:transcribe:finalize',
  cancel: 'feat:transcribe:cancel',
  transcribeSession: 'feat:transcribe:transcribeSession',
  getSettings: 'feat:transcribe:getSettings',
  setSettings: 'feat:transcribe:setSettings',
  getStatus: 'feat:transcribe:getStatus',
  /** main → every window: TranscribeStatus. */
  status: 'feat:transcribe:status',
  downloadModel: 'feat:transcribe:downloadModel',
  cancelDownload: 'feat:transcribe:cancelDownload',
  removeModel: 'feat:transcribe:removeModel',
  getVocabulary: 'feat:transcribe:getVocabulary'
} as const;
