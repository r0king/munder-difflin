/**
 * Speech-level logic around the recogniser (pure): where the speech is, which
 * recognised text is an artefact, and how the You and Them tracks become one
 * transcript.
 *
 * Whisper never says "nothing here". Fed silence it invents text — "[BLANK_AUDIO]",
 * "Thank you.", "Thanks for watching!", or the prompt's own word list — and a
 * meeting's system track is silent whenever the user is the one talking. So:
 *   1. `findVoicedSpans` keeps the recogniser off stretches with no energy at
 *      all (it also saves the CPU an hour of silence would cost);
 *   2. `cleanSegments` drops what it still produces on quiet audio, using the
 *      segment's own energy, not just its words;
 *   3. `mergeMeeting` drops a 'you' line that is the mic hearing the speakers
 *      (the same words as a simultaneous 'them' line), then interleaves and
 *      joins runs of the same speaker.
 */
import type { TranscriptSegment } from '../../../shared/features/transcribe';
import { rms } from '../../../shared/features/transcribeAudio';

export interface Span {
  startSample: number;
  endSample: number;
}

export interface VoicedSpanOptions {
  /** Analysis frame (default 30 ms). */
  frameMs?: number;
  /** Absolute floor below which a frame is never speech (default -55 dBFS). */
  minRms?: number;
  /** A frame is voiced above noiseFloor × this (default 2.5 ≈ +8 dB). */
  floorFactor?: number;
  /** Padding kept around speech so word edges are not clipped (default 400 ms). */
  padMs?: number;
  /** Voiced runs closer than this are joined (default 1500 ms). */
  joinGapMs?: number;
  /** Runs shorter than this (after padding) are dropped as clicks (default 250 ms). */
  minSpanMs?: number;
}

/** The gate a frame must beat: the larger of the absolute floor and the
 *  recording's own noise floor (20th-percentile frame level) × factor, so a
 *  quiet room and a noisy fan are both handled. */
export function energyGate(frameLevels: Float32Array, minRms: number, floorFactor: number): number {
  if (!frameLevels.length) return minRms;
  const sorted = Float32Array.from(frameLevels).sort();
  const floor = sorted[Math.floor(sorted.length * 0.2)];
  return Math.max(minRms, floor * floorFactor);
}

export function frameRms(samples: Float32Array, sampleRate: number, frameMs = 30): Float32Array {
  const frame = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const n = Math.ceil(samples.length / frame);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rms(samples, i * frame, (i + 1) * frame);
  return out;
}

/** Spans (in samples) that contain speech-level energy. */
export function findVoicedSpans(samples: Float32Array, sampleRate: number, opts: VoicedSpanOptions = {}): Span[] {
  const frameMs = opts.frameMs ?? 30;
  const frame = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const levels = frameRms(samples, sampleRate, frameMs);
  const gate = energyGate(levels, opts.minRms ?? 0.0018, opts.floorFactor ?? 2.5);
  const pad = Math.round(((opts.padMs ?? 400) * sampleRate) / 1000);
  const joinGap = Math.round(((opts.joinGapMs ?? 1500) * sampleRate) / 1000);
  const minSpan = Math.round(((opts.minSpanMs ?? 250) * sampleRate) / 1000);

  const raw: Span[] = [];
  let runStart = -1;
  for (let i = 0; i <= levels.length; i++) {
    const voiced = i < levels.length && levels[i] > gate;
    if (voiced && runStart < 0) runStart = i;
    if (!voiced && runStart >= 0) {
      raw.push({ startSample: runStart * frame, endSample: Math.min(samples.length, i * frame) });
      runStart = -1;
    }
  }
  const out: Span[] = [];
  for (const s of raw) {
    const padded = { startSample: Math.max(0, s.startSample - pad), endSample: Math.min(samples.length, s.endSample + pad) };
    const last = out[out.length - 1];
    if (last && padded.startSample - last.endSample <= joinGap) last.endSample = Math.max(last.endSample, padded.endSample);
    else out.push(padded);
  }
  return out.filter((s) => s.endSample - s.startSample >= minSpan);
}

// ─── Artefacts ──────────────────────────────────────────────────────────────

/** Bracketed or starred non-speech tags Whisper emits: [BLANK_AUDIO], (silence),
 *  [Music], *laughs*, ♪ … ♪. */
const TAG_RE = /\[[^\]]{0,40}\]|\((?:[^)]{0,30})\)|\*[^*]{0,30}\*|[♪♫]+[^♪♫]{0,60}[♪♫]*/g;
const TAG_WORDS = /blank|silence|music|inaudible|applause|laugh|noise|static|beep|sound|no speech|indistinct|background/i;

/** Phrases Whisper is known to produce from silence or noise. Only dropped
 *  when the audio under them is quiet too: people do say "thank you". */
const HALLUCINATIONS = [
  'thank you', 'thank you very much', 'thanks', 'thanks for watching', 'thank you for watching',
  'thanks for watching and see you next time', 'please subscribe', 'subscribe to my channel',
  'like and subscribe', 'bye', 'bye bye', 'goodbye', 'you', 'okay', 'oh', 'so', 'hmm', 'um', 'uh',
  'see you next time', 'see you in the next video', 'the end'
].map((p) => normalizeWords(p).join(' '));

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Remove non-speech tags from recognised text; returns '' when nothing is left. */
export function stripTags(text: string): string {
  return text
    .replace(TAG_RE, (m) => (TAG_WORDS.test(m) || /^[♪♫]/.test(m) ? ' ' : m))
    .replace(/\s+/g, ' ')
    .trim();
}

/** A run of vocabulary terms with no other words: the prompt leaking into the
 *  output on silence ("Anthropic, Claude, Kubernetes, ARR."). */
export function looksLikePromptEcho(text: string, vocabulary: readonly string[]): boolean {
  const parts = text.split(/[,;]/).map((p) => p.replace(/[.!?]+$/g, '').trim().toLowerCase()).filter(Boolean);
  if (parts.length < 3) return false;
  const vocab = new Set(vocabulary.map((v) => v.toLowerCase()));
  const hits = parts.filter((p) => vocab.has(p)).length;
  return hits / parts.length >= 0.75;
}

export interface CleanOptions {
  /** Level above which a segment is clearly speech (from energyGate). */
  gate: number;
  /** Mono samples of the track, at `sampleRate`, for per-segment energy. */
  samples?: Float32Array;
  sampleRate?: number;
  vocabulary?: readonly string[];
}

/** Drop artefacts: tags, prompt echoes, and stock phrases over quiet audio. */
export function cleanSegments(segments: readonly TranscriptSegment[], opts: CleanOptions): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const seg of segments) {
    const text = stripTags(seg.text);
    if (!text || !/[A-Za-z0-9]/.test(text)) continue;
    if (opts.vocabulary && looksLikePromptEcho(text, opts.vocabulary)) continue;
    let level = Number.POSITIVE_INFINITY;
    if (opts.samples && opts.sampleRate) {
      const a = Math.floor((seg.startMs / 1000) * opts.sampleRate);
      const b = Math.ceil((seg.endMs / 1000) * opts.sampleRate);
      level = rms(opts.samples, a, Math.max(a + 1, b));
    }
    // Nothing above the gate under the whole segment: there was no speech.
    if (level < opts.gate * 0.6) continue;
    // A stock phrase over audio that is barely above the gate: noise, not words.
    const words = normalizeWords(text).join(' ');
    if (HALLUCINATIONS.includes(words) && level < opts.gate * 2) continue;
    out.push({ ...seg, text });
  }
  return out;
}

// ─── You + Them ─────────────────────────────────────────────────────────────

export interface MergeOptions {
  /** Same-speaker segments closer than this are joined (default 2500 ms). */
  joinGapMs?: number;
  /** A joined segment stops growing at this length (default 90 s), so a long
   *  monologue stays editable in pieces. */
  maxJoinedMs?: number;
  /** How far apart (ms) a 'you' and a 'them' line may sit and still be the
   *  same sound (default 1500 ms: device latency + segment-edge jitter). */
  echoWindowMs?: number;
  /** Share of a 'you' line's words that must appear in the overlapping
   *  'them' text for it to count as echo (default 0.7). */
  echoContainment?: number;
}

function overlaps(a: TranscriptSegment, b: TranscriptSegment, slackMs: number): boolean {
  return a.startMs <= b.endMs + slackMs && b.startMs <= a.endMs + slackMs;
}

/** Fraction of `words` found (as a multiset) in `pool`. */
function containment(words: string[], pool: string[]): number {
  if (!words.length) return 0;
  const counts = new Map<string, number>();
  for (const w of pool) counts.set(w, (counts.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of words) {
    const c = counts.get(w) ?? 0;
    if (c > 0) {
      hit++;
      counts.set(w, c - 1);
    }
  }
  return hit / words.length;
}

/** True when a 'you' segment is the mic re-recording what 'them' said. */
export function isEcho(you: TranscriptSegment, them: readonly TranscriptSegment[], opts: MergeOptions = {}): boolean {
  const slack = opts.echoWindowMs ?? 1500;
  const threshold = opts.echoContainment ?? 0.7;
  const youWords = normalizeWords(you.text);
  if (!youWords.length) return false;
  const pool = them.filter((t) => overlaps(you, t, slack)).flatMap((t) => normalizeWords(t.text));
  if (!pool.length) return false;
  // One or two words ("yeah", "okay") are too common to call an echo unless
  // they match exactly.
  if (youWords.length < 3) return youWords.join(' ') === pool.join(' ');
  return containment(youWords, pool) >= threshold;
}

function joinText(a: string, b: string): string {
  return `${a.trimEnd()} ${b.trimStart()}`.replace(/\s+/g, ' ').trim();
}

/**
 * One transcript from the two tracks: echo lines removed, everything ordered
 * by start time ('them' first on a tie — the call is what the user answers),
 * and consecutive lines of one speaker joined when the pause between them is
 * short.
 */
export function mergeMeeting(
  you: readonly TranscriptSegment[],
  them: readonly TranscriptSegment[],
  opts: MergeOptions = {}
): TranscriptSegment[] {
  const joinGap = opts.joinGapMs ?? 2500;
  const maxJoined = opts.maxJoinedMs ?? 90_000;
  const themL = them.map((s) => ({ ...s, speaker: 'them' as const }));
  const youL = you.filter((s) => !isEcho(s, themL, opts)).map((s) => ({ ...s, speaker: 'you' as const }));
  const all = [...themL, ...youL].sort(
    (a, b) => a.startMs - b.startMs || (a.speaker === b.speaker ? a.endMs - b.endMs : a.speaker === 'them' ? -1 : 1)
  );
  const out: TranscriptSegment[] = [];
  for (const s of all) {
    const last = out[out.length - 1];
    if (
      last &&
      last.speaker === s.speaker &&
      s.startMs - last.endMs <= joinGap &&
      Math.max(last.endMs, s.endMs) - last.startMs <= maxJoined
    ) {
      last.text = joinText(last.text, s.text);
      last.endMs = Math.max(last.endMs, s.endMs);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** Plain text of a transcript; meetings get "You:" / "Them:" line labels. */
export function transcriptText(segments: readonly TranscriptSegment[], labels?: { you: string; them: string }): string {
  if (!labels || !segments.some((s) => s.speaker)) return segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
  return segments.map((s) => `${s.speaker === 'them' ? labels.them : labels.you}: ${s.text}`).join('\n');
}
