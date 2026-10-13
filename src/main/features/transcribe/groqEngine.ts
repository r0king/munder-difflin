/**
 * Groq Whisper for transcription with timestamps.
 *
 * Reuses the app's Groq integration for everything that is not this call: the
 * key is the user's `groqApiKey` from main's config (Settings → Voice), passed
 * in by the caller, used only in the Authorization header and never logged
 * or returned; the model is freeflow.ts's DEFAULT_GROQ_MODEL. What freeflow's
 * `transcribeWithGroq` cannot do is return segments or take a prompt, so this
 * asks for `verbose_json` with segment timestamps and Whisper's `prompt`.
 *
 * One request per prepared piece (≤ 10 min, see groqPlan.ts); a 429 or 5xx is
 * retried twice, honouring Retry-After up to 20 s.
 */
import { readFile } from 'node:fs/promises';
import { DEFAULT_GROQ_MODEL } from '../../freeflow';
import type { TranscriptSegment } from '../../../shared/features/transcribe';

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const RETRIES = 2;

interface VerboseSegment {
  start?: unknown;
  end?: unknown;
  text?: unknown;
  no_speech_prob?: unknown;
  avg_logprob?: unknown;
}

export interface GroqPieceResult {
  ok: boolean;
  segments: TranscriptSegment[];
  error?: string;
  /** Worth falling back to the local engine (network, rate limit, server). */
  transient?: boolean;
}

/** Whisper's own "this was not speech" rule (openai-whisper's defaults). */
function isNoSpeech(s: VerboseSegment): boolean {
  const p = typeof s.no_speech_prob === 'number' ? s.no_speech_prob : 0;
  const lp = typeof s.avg_logprob === 'number' ? s.avg_logprob : 0;
  return p > 0.6 && lp < -1;
}

export function parseVerboseJson(raw: string): TranscriptSegment[] {
  const j = JSON.parse(raw) as { text?: unknown; segments?: unknown; duration?: unknown };
  if (Array.isArray(j.segments)) {
    const out: TranscriptSegment[] = [];
    for (const s of j.segments as VerboseSegment[]) {
      if (!s || typeof s.text !== 'string' || isNoSpeech(s)) continue;
      const text = s.text.trim();
      if (!text) continue;
      const start = typeof s.start === 'number' && Number.isFinite(s.start) ? s.start : 0;
      const end = typeof s.end === 'number' && Number.isFinite(s.end) ? Math.max(s.end, start) : start;
      out.push({ startMs: Math.round(start * 1000), endMs: Math.round(end * 1000), text });
    }
    return out;
  }
  const text = typeof j.text === 'string' ? j.text.trim() : '';
  const duration = typeof j.duration === 'number' ? j.duration : 0;
  return text ? [{ startMs: 0, endMs: Math.round(duration * 1000), text }] : [];
}

function extractError(raw: string): string {
  try {
    const j = JSON.parse(raw) as { error?: { message?: string } | string };
    if (typeof j.error === 'string') return j.error;
    if (j.error && typeof j.error.message === 'string') return j.error.message;
  } catch { /* not json */ }
  return '';
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function groqTranscribePiece(opts: {
  apiKey: string;
  wavPath: string;
  prompt: string;
  language?: string;
}): Promise<GroqPieceResult> {
  if (!opts.apiKey) return { ok: false, segments: [], error: 'no Groq API key set' };
  let bytes: Buffer;
  try {
    bytes = await readFile(opts.wavPath);
  } catch (e) {
    return { ok: false, segments: [], error: e instanceof Error ? e.message : String(e) };
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return { ok: false, segments: [], error: 'audio piece too large for Groq' };

  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.append('model', DEFAULT_GROQ_MODEL);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    form.append('temperature', '0');
    form.append('language', opts.language || 'en');
    if (opts.prompt) form.append('prompt', opts.prompt);
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    form.append('file', new Blob([body], { type: 'audio/wav' }), 'audio.wav');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(GROQ_TRANSCRIBE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        body: form,
        signal: controller.signal
      });
      const raw = await res.text();
      if (res.ok) {
        try {
          return { ok: true, segments: parseVerboseJson(raw) };
        } catch {
          return { ok: false, segments: [], error: 'unreadable Groq response', transient: true };
        }
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < RETRIES) {
        const after = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(20, after) * 1000 : 1500 * (attempt + 1));
        continue;
      }
      return {
        ok: false,
        segments: [],
        error: `Groq ${res.status}: ${extractError(raw) || res.statusText}`,
        transient: retryable
      };
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      if (!aborted && attempt < RETRIES) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      return { ok: false, segments: [], error: aborted ? 'Groq request timed out' : e instanceof Error ? e.message : String(e), transient: true };
    } finally {
      clearTimeout(timer);
    }
  }
}
