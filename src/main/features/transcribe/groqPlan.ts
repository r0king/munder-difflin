/**
 * Splitting long audio for Groq (pure).
 *
 * Groq takes at most 25 MB per request. At 16 kHz mono 16-bit that is ~13 min;
 * we cut at ≤ 10 min, and not blindly on the 10-minute mark: each cut is moved
 * back to the quietest moment in the preceding window so a word is not sliced
 * in half. Segment times from each piece are then shifted by the piece's start.
 */
import type { TranscriptSegment } from '../../../shared/features/transcribe';

export interface ChunkPlanOptions {
  sampleRate: number;
  /** Longest piece, seconds (default 600). */
  maxChunkSec?: number;
  /** Hard byte cap per piece, including the 44-byte header (default 24 MB:
   *  the 25 MB limit with a margin for the multipart envelope). */
  maxBytes?: number;
  bytesPerSample?: number;
  /** How far before a cap to look for a quiet cut point, seconds (default 20). */
  searchBackSec?: number;
  /** Per-frame levels of the whole track (e.g. frameRms at `frameMs`). When
   *  absent, cuts land exactly on the cap. */
  frameLevels?: Float32Array;
  frameMs?: number;
}

export interface Chunk {
  startSample: number;
  endSample: number;
}

export function planChunks(totalSamples: number, opts: ChunkPlanOptions): Chunk[] {
  const sr = opts.sampleRate;
  const bps = opts.bytesPerSample ?? 2;
  const byCap = Math.floor(((opts.maxBytes ?? 24 * 1024 * 1024) - 44) / bps);
  const maxLen = Math.max(1, Math.min(Math.floor((opts.maxChunkSec ?? 600) * sr), byCap));
  const searchBack = Math.floor((opts.searchBackSec ?? 20) * sr);
  const frameLen = opts.frameLevels && opts.frameMs ? Math.max(1, Math.round((opts.frameMs * sr) / 1000)) : 0;

  const chunks: Chunk[] = [];
  let start = 0;
  while (start < totalSamples) {
    let end = Math.min(totalSamples, start + maxLen);
    if (end < totalSamples && frameLen && opts.frameLevels) {
      // Quietest frame boundary in (end - searchBack, end]; never shrink a
      // piece below half its maximum, so a noisy stretch cannot make tiny pieces.
      const lo = Math.max(start + Math.floor(maxLen / 2), end - searchBack);
      let best = end;
      let bestLevel = Number.POSITIVE_INFINITY;
      for (let f = Math.ceil(lo / frameLen); f * frameLen <= end; f++) {
        const level = opts.frameLevels[f] ?? Number.POSITIVE_INFINITY;
        if (level < bestLevel) {
          bestLevel = level;
          best = f * frameLen;
        }
      }
      end = Math.min(end, Math.max(start + 1, best));
    }
    chunks.push({ startSample: start, endSample: end });
    start = end;
  }
  return chunks;
}

/** Shift each piece's segments by the piece's start time and concatenate. */
export function stitchSegments(
  pieces: ReadonlyArray<{ offsetMs: number; segments: readonly TranscriptSegment[] }>
): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const p of pieces) {
    for (const s of p.segments) {
      out.push({ ...s, startMs: Math.round(s.startMs + p.offsetMs), endMs: Math.round(s.endMs + p.offsetMs) });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}
