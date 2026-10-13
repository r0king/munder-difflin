/**
 * Transcription worker (worker_threads). Everything CPU-heavy runs here, never
 * on Electron's main thread: reading and resampling WAVs, finding speech, and
 * Whisper inference through @huggingface/transformers on onnxruntime-node.
 *
 * Jobs run one at a time, in arrival order. The loaded model stays in memory
 * between jobs (main terminates the whole worker after a while idle, which is
 * what frees it).
 *
 * Why not the library's ASR pipeline call: transformers.js 3.8 cannot pass
 * Whisper a prompt (`prompt_ids` is not implemented, and a hand-built
 * `<|startofprev|>` prefix comes back in the text). So this file runs the same
 * 30 s window / 5 s stride loop the pipeline runs, puts the vocabulary prompt
 * in front of each window's decoder input, and cuts the prompt tokens off the
 * output before the library's own timestamp decoding (`_decode_asr`). The
 * dependency is pinned to an exact version for this reason.
 */
import { parentPort, workerData } from 'node:worker_threads';
import Module from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TranscriptSegment } from '../../../shared/features/transcribe';
import { PCM_SAMPLE_RATE } from '../../../shared/features/transcribe';
import { floatToInt16 } from '../../../shared/features/transcribeAudio';
import { buildVocabularyPrompt } from '../../../shared/features/vocabulary';
import { cleanSegments, levelBetween, voicedSpansFromLevels, type Span } from './meeting';
import { planChunks } from './groqPlan';
import { openPcmSource, sourceFrameLevels, type PcmSource } from './pcmSource';
import { encodeWav16 } from './wav';
import type { PreparedChunk, WorkerInit, WorkerModelRef, WorkerRequest, WorkerResponse } from './protocol';

type Transformers = typeof import('@huggingface/transformers');

const SR = PCM_SAMPLE_RATE;
const FRAME_MS = 30;
const WINDOW = 30 * SR;
const STRIDE = 5 * SR;
/** Whisper reads at most 224 prompt tokens (half its 448-token context). */
const MAX_PROMPT_TOKENS = 223;

const init: WorkerInit = (workerData as WorkerInit | undefined) ?? { threads: 2 };

// ─── Loading ────────────────────────────────────────────────────────────────

/**
 * transformers.js requires `sharp` (a native image library) at import time and
 * throws without it, though speech never touches images. Answer that one
 * require with a stub, so the worker neither loads libvips nor depends on it
 * being packaged for the platform.
 */
function stubSharp(): void {
  const M = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const original = M._load;
  const stub = (): never => {
    throw new Error('image processing is not available in the transcription worker');
  };
  M._load = function patched(this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'sharp') return stub;
    return original.call(this, request, parent, isMain);
  };
}

let tf: Transformers | null = null;
function transformers(): Transformers {
  if (!tf) {
    stubSharp();
    // A runtime require (not an import): the sharp stub above must be in place
    // before the library's module body runs, and imports are hoisted.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    tf = require('@huggingface/transformers') as Transformers;
  }
  return tf;
}

interface Loaded {
  key: string;
  // The library's model / processor / tokenizer classes are loosely typed for
  // the internals used here (_decode_asr, generate with decoder_input_ids).
  model: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  processor: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  tokenizer: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  timePrecision: number;
  /** A fresh LogitsProcessorList (holding the token suppressor) per
   *  generate() call — see suppressor(). */
  newProcessors: () => unknown;
}
let loaded: Loaded | null = null;

async function load(ref: WorkerModelRef): Promise<Loaded> {
  const key = `${ref.root}\n${ref.repo}\n${ref.dtype}`;
  if (loaded?.key === key) return loaded;
  if (loaded) {
    try { await loaded.model.dispose(); } catch { /* best effort */ }
    loaded = null;
  }
  const t = transformers();
  // Local files only: main resolved (and if need be downloaded and verified)
  // the model before sending the job. Nothing here may reach the network.
  t.env.allowRemoteModels = false;
  t.env.allowLocalModels = true;
  t.env.localModelPath = ref.root;
  t.env.cacheDir = ref.root;
  const opts = {
    dtype: ref.dtype,
    device: 'cpu',
    session_options: { intraOpNumThreads: init.threads, interOpNumThreads: 1 }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pipe: any = await (t.pipeline as any)('automatic-speech-recognition', ref.repo, opts);
  const fe = pipe.processor.feature_extractor.config;
  const next: Loaded = {
    key,
    model: pipe.model,
    processor: pipe.processor,
    tokenizer: pipe.tokenizer,
    timePrecision: fe.chunk_length / pipe.model.config.max_source_positions,
    newProcessors: () => null
  };
  next.newProcessors = suppressor(next);
  loaded = next;
  return next;
}

// ─── Local transcription ────────────────────────────────────────────────────

function promptIds(m: Loaded, lead: string, vocabulary: string[], budget: number): number[] {
  const encode = (text: string): number[] => m.tokenizer.encode(` ${text}`, { add_special_tokens: false });
  const text = buildVocabularyPrompt(vocabulary, {
    lead,
    maxTokens: Math.min(budget, MAX_PROMPT_TOKENS),
    countTokens: (s) => encode(s).length
  });
  if (!text) return [];
  const prev = m.tokenizer.model.convert_tokens_to_ids(['<|startofprev|>'])[0];
  if (typeof prev !== 'number') return [];
  return [prev, ...encode(text).slice(-MAX_PROMPT_TOKENS)];
}

/**
 * transformers.js 3.8 never applies the generation config's `suppress_tokens`
 * (the call is commented out upstream), and nothing stops the decoder from
 * emitting control tokens as "text". openai-whisper suppresses both while
 * sampling; without that, a prompt tips the model into <|nocaptions|> and it
 * stops after one token, and silence turns into ♪ and bracket tags. This
 * restores that suppression: every special token between end-of-text and the
 * first timestamp, plus the config's own list.
 *
 * Returns a factory, not a list: Whisper's generate() pushes its own
 * timestamp and begin-suppress processors onto the list it is given, so a
 * list shared across calls grows by two per 30 s window. That made every
 * window slower than the last (quadratic over a long meeting) and left a
 * stale timestamp processor, built for an earlier prompt length, cutting
 * later windows short. Each call gets a new list around the one suppressor
 * (docs/perf/whisper-logits-processor.md).
 */
function suppressor(m: Loaded): () => unknown {
  const t = transformers();
  const gc = m.model.generation_config ?? {};
  const eos: number = Array.isArray(gc.eos_token_id) ? gc.eos_token_id[0] : gc.eos_token_id;
  const ids = new Set<number>(Array.isArray(gc.suppress_tokens) ? gc.suppress_tokens : []);
  if (typeof eos === 'number' && typeof gc.no_timestamps_token_id === 'number') {
    for (let id = eos + 1; id <= gc.no_timestamps_token_id; id++) ids.add(id);
  }
  const list = [...ids];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Base = t.LogitsProcessor as any;
  class SuppressTokens extends Base {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _call(inputIds: unknown[], logits: any): unknown {
      for (let i = 0; i < inputIds.length; i++) {
        const data = logits[i].data as Float32Array;
        for (const id of list) if (id < data.length) data[id] = -Infinity;
      }
      return logits;
    }
  }
  const suppress = new SuppressTokens();
  return () => {
    const processors = new t.LogitsProcessorList();
    processors.push(suppress as never);
    return processors;
  };
}

/** Whisper's start tokens for an English-only model with timestamps. */
function initTokens(m: Pick<Loaded, 'model'>): number[] {
  const gc = m.model.generation_config ?? {};
  const start = gc.decoder_start_token_id ?? m.model.config.decoder_start_token_id;
  return [start].filter((x) => typeof x === 'number');
}

/** One voiced span, 30 s windows with 5 s strides. Exported for
 *  test/transcribe-worker.test.cjs. */
export async function transcribeSpan(
  m: Pick<Loaded, 'model' | 'processor' | 'tokenizer' | 'timePrecision' | 'newProcessors'>,
  src: Pick<PcmSource, 'read'>,
  span: Span,
  prompt: number[]
): Promise<TranscriptSegment[]> {
  const chunks: Array<{ tokens: unknown[]; stride: number[]; is_last: boolean }> = [];
  const jump = WINDOW - 2 * STRIDE;
  const decoderPrefix = prompt.length ? [...prompt, ...initTokens(m)] : null;
  let offset = span.startSample;
  for (;;) {
    const end = Math.min(offset + WINDOW, span.endSample);
    const audio = src.read(offset, end);
    const isFirst = offset === span.startSample;
    const isLast = end >= span.endSample;
    const features = await m.processor(audio);
    const generated = await m.model.generate({
      inputs: features.input_features,
      return_timestamps: true,
      logits_processor: m.newProcessors(),
      num_frames: Math.floor(audio.length / m.processor.feature_extractor.config.hop_length),
      ...(decoderPrefix ? { decoder_input_ids: decoderPrefix } : {})
    });
    let tokens: unknown[] = generated[0].tolist();
    // Drop <|startofprev|> + the prompt: what follows starts at
    // <|startoftranscript|>, exactly what the pipeline would have produced.
    if (prompt.length) tokens = tokens.slice(prompt.length);
    chunks.push({
      tokens,
      stride: [audio.length, isFirst ? 0 : STRIDE, isLast ? 0 : STRIDE].map((x) => x / SR),
      is_last: isLast
    });
    if (isLast) break;
    offset += jump;
  }
  const [, optional] = m.tokenizer._decode_asr(chunks, {
    time_precision: m.timePrecision,
    return_timestamps: true,
    force_full_sequences: false
  }) as [string, { chunks?: Array<{ timestamp: [number, number | null]; text: string }> }];
  const base = (span.startSample / SR) * 1000;
  const spanEnd = (span.endSample / SR) * 1000;
  const out: TranscriptSegment[] = [];
  for (const c of optional?.chunks ?? []) {
    const text = (c.text ?? '').trim();
    if (!text) continue;
    const s = base + (c.timestamp?.[0] ?? 0) * 1000;
    const e = c.timestamp?.[1] != null ? base + c.timestamp[1] * 1000 : spanEnd;
    out.push({ startMs: Math.round(Math.min(s, spanEnd)), endMs: Math.round(Math.min(Math.max(e, s), spanEnd)), text });
  }
  return out;
}

async function transcribe(req: Extract<WorkerRequest, { type: 'transcribe' }>): Promise<WorkerResponse> {
  const src = openPcmSource(req.wavPath);
  try {
    const durationMs = Math.round((src.length / SR) * 1000);
    const levels = sourceFrameLevels(src, FRAME_MS);
    const { spans, gate } = voicedSpansFromLevels(levels, src.length, SR, { frameMs: FRAME_MS });
    if (!spans.length) return { type: 'transcribed', id: req.id, segments: [], durationMs, gate };
    const m = await load(req.model);
    const prompt = promptIds(m, req.lead, req.vocabulary, req.promptTokens);
    const raw: TranscriptSegment[] = [];
    for (const span of spans) raw.push(...(await transcribeSpan(m, src, span, prompt)));
    const segments = cleanSegments(raw, {
      gate,
      levelAt: (a, b) => levelBetween(levels, FRAME_MS, a, b),
      vocabulary: req.vocabulary
    });
    return { type: 'transcribed', id: req.id, segments, durationMs, gate };
  } finally {
    src.close();
  }
}

// ─── Groq preparation ───────────────────────────────────────────────────────

function prepare(req: Extract<WorkerRequest, { type: 'prepare' }>): WorkerResponse {
  const src = openPcmSource(req.wavPath);
  try {
    const durationMs = Math.round((src.length / SR) * 1000);
    const levels = sourceFrameLevels(src, FRAME_MS);
    const { spans, gate } = voicedSpansFromLevels(levels, src.length, SR, { frameMs: FRAME_MS });
    mkdirSync(req.outDir, { recursive: true });
    const chunks: PreparedChunk[] = [];
    const frame = Math.round((SR * FRAME_MS) / 1000);
    for (const span of spans) {
      // Plan inside the span, cutting at its quietest moments.
      const first = Math.floor(span.startSample / frame);
      const spanLevels = levels.subarray(first, Math.ceil(span.endSample / frame));
      const plan = planChunks(span.endSample - span.startSample, {
        sampleRate: SR,
        maxChunkSec: req.maxChunkSec,
        frameLevels: spanLevels,
        frameMs: FRAME_MS
      });
      for (const c of plan) {
        const a = span.startSample + c.startSample;
        const b = span.startSample + c.endSample;
        const path = join(req.outDir, `chunk-${String(chunks.length).padStart(4, '0')}.wav`);
        writeFileSync(path, encodeWav16(floatToInt16(src.read(a, b)), SR));
        chunks.push({ path, offsetMs: Math.round((a / SR) * 1000), durationMs: Math.round(((b - a) / SR) * 1000) });
      }
    }
    return { type: 'prepared', id: req.id, durationMs, gate, frameMs: FRAME_MS, frameLevels: levels, chunks };
  } finally {
    src.close();
  }
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

let queue: Promise<void> = Promise.resolve();

function post(msg: WorkerResponse): void {
  if (msg.type === 'prepared') parentPort?.postMessage(msg, [msg.frameLevels.buffer as ArrayBuffer]);
  else parentPort?.postMessage(msg);
}

parentPort?.on('message', (req: WorkerRequest) => {
  queue = queue.then(async () => {
    try {
      post(req.type === 'transcribe' ? await transcribe(req) : prepare(req));
    } catch (e) {
      post({ type: 'error', id: req.id, error: e instanceof Error ? e.message : String(e) });
    }
  });
});
