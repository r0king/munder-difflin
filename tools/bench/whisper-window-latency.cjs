#!/usr/bin/env node
/**
 * Whisper latency over a long-lived transcription worker.
 *
 * Runs the real worker (src/main/features/transcribe/transcribe-worker.ts,
 * loaded through test/load-ts.cjs) in a worker thread, as the app does, and
 * sends it the same recording `--jobs` times in a row. Every job decodes the
 * same windows, so job N should take as long as job 1. If anything inside the
 * worker grows per window (docs/perf/whisper-logits-processor.md), the later
 * jobs get slower and the "last / first" ratio climbs above ~1.
 *
 *   node tools/bench/whisper-window-latency.cjs --models <root> --wav <file.wav> [--jobs 10] [--threads 2]
 *
 *   --models   folder holding onnx-community/whisper-base.en (the bundled model:
 *              resources/models after `node tools/fetch-whisper-model.cjs`)
 *   --wav      16 kHz mono 16-bit WAV with speech (any length; ~1 min = 3 windows)
 *   --jobs     how many times to transcribe it (default 10)
 *   --threads  ONNX intra-op threads (default 2, what a 4-core machine gets)
 *
 * Needs the dev dependencies (typescript for the loader, @huggingface/transformers).
 */
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Worker } = require('node:worker_threads');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const repoRoot = path.resolve(__dirname, '..', '..');
const models = arg('models', path.join(repoRoot, 'resources', 'models'));
const wav = arg('wav', '');
const jobs = Math.max(1, Number(arg('jobs', '10')) || 10);
const threads = Math.max(1, Number(arg('threads', '2')) || 2);

if (!wav || !fs.existsSync(wav)) {
  console.error('usage: node tools/bench/whisper-window-latency.cjs --models <root> --wav <file.wav> [--jobs 10] [--threads 2]');
  process.exit(2);
}
if (!fs.existsSync(path.join(models, 'onnx-community', 'whisper-base.en'))) {
  console.error(`no onnx-community/whisper-base.en under ${models}`);
  process.exit(2);
}

const boot = `require(${JSON.stringify(path.join(repoRoot, 'test', 'load-ts.cjs'))})('src/main/features/transcribe/transcribe-worker.ts');`;
const w = new Worker(boot, { eval: true, workerData: { threads } });
const vocab = require(path.join(repoRoot, 'test', 'load-ts.cjs'))('src/shared/features/vocabulary.ts');

const cpu = os.cpus()[0]?.model ?? 'unknown CPU';
console.log(`# ${cpu} x${os.cpus().length}, node ${process.version}, ${os.platform()} ${os.release()}`);
console.log(`# model onnx-community/whisper-base.en q8, threads ${threads}, wav ${path.basename(wav)} (${(fs.statSync(wav).size / 32000).toFixed(1)} s), jobs ${jobs}`);

const times = [];
let next = 1;
function send() {
  const t0 = process.hrtime.bigint();
  const id = next++;
  w.once('message', (m) => {
    if (m.type === 'error') {
      console.error('worker error:', m.error);
      process.exit(1);
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    times.push(ms);
    console.log(`job ${String(id).padStart(3)}: ${ms.toFixed(0).padStart(6)} ms  ${m.segments.length} segments`);
    if (id < jobs) send();
    else finish();
  });
  w.postMessage({
    type: 'transcribe',
    id,
    wavPath: wav,
    model: { root: models, repo: 'onnx-community/whisper-base.en', dtype: 'q8' },
    lead: '',
    vocabulary: vocab.mergeVocabulary([]),
    promptTokens: 120
  });
}

function finish() {
  // Job 1 includes loading the model; job 2 is the clean baseline.
  const base = times[Math.min(1, times.length - 1)];
  const last = times[times.length - 1];
  console.log(`baseline (job 2): ${base.toFixed(0)} ms, last (job ${times.length}): ${last.toFixed(0)} ms, last/baseline: ${(last / base).toFixed(2)}`);
  void w.terminate();
}

w.on('error', (e) => {
  console.error('worker failed:', e);
  process.exit(1);
});
send();
