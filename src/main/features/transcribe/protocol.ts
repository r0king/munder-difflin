/**
 * Messages between main (localEngine.ts) and the transcription worker
 * (transcribe-worker.ts). Types only.
 */
import type { TranscriptSegment } from '../../../shared/features/transcribe';

export interface WorkerModelRef {
  /** Models root to point transformers.js at (`env.localModelPath`). */
  root: string;
  repo: string;
  dtype: 'q8';
}

export type WorkerRequest =
  | {
      type: 'transcribe';
      id: number;
      wavPath: string;
      model: WorkerModelRef;
      /** Caller text that goes before the vocabulary in the prompt. */
      lead: string;
      /** Vocabulary, priority order (user words first). */
      vocabulary: string[];
      /** Token budget for the prompt. */
      promptTokens: number;
    }
  | {
      /** Groq path: find the speech, cut it into ≤ maxChunkSec WAV files. */
      type: 'prepare';
      id: number;
      wavPath: string;
      outDir: string;
      maxChunkSec: number;
    };

export interface PreparedChunk {
  path: string;
  offsetMs: number;
  durationMs: number;
}

export type WorkerResponse =
  | { type: 'transcribed'; id: number; segments: TranscriptSegment[]; durationMs: number; gate: number }
  | {
      type: 'prepared';
      id: number;
      durationMs: number;
      gate: number;
      frameMs: number;
      frameLevels: Float32Array;
      chunks: PreparedChunk[];
    }
  | { type: 'error'; id: number; error: string };

export interface WorkerInit {
  /** ONNX intra-op threads. */
  threads: number;
}
