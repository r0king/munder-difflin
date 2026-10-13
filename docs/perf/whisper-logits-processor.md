# Whisper worker: one logits-processor list per window

## The problem

`transcribe-worker.ts` passed the same `LogitsProcessorList` (holding our token
suppressor) to every `model.generate()` call. transformers.js 3.8's Whisper
`generate()` pushes a `WhisperTimeStampLogitsProcessor` and a
`SuppressTokensAtBeginLogitsProcessor` onto the list it is handed, so the shared
list grew by two processors per 30 s window for the life of the worker (the
worker stays up between jobs). Every decoding step runs every processor, so each
window got slower than the last — quadratic over a long meeting — and a
timestamp processor built for an earlier, longer prompt could end later windows
early.

## The fix

The worker keeps the one suppressor and builds a fresh list around it for each
`generate()` call (`suppressor()` returns a factory). Regression test:
`test/transcribe-worker.test.cjs` checks every call receives a new list holding
only the suppressor.

## Benchmark

`tools/bench/whisper-window-latency.cjs` runs the real worker in a worker thread
and transcribes the same recording N times in a row. Every job decodes the same
3 windows, so job 12 should take as long as job 2 (job 1 also loads the model).

Setup (as printed by the script): Intel Xeon @ 2.10 GHz, 4 vCPUs (shared with
other work), Linux 6.18, Node v22.22.0 (Electron 32 runs the same worker code);
model `onnx-community/whisper-base.en` q8 (the bundled one), 2 ONNX threads;
audio: 57.5 s, the JFK sample repeated 4 times with 0.6 s gaps (one voiced span,
3 windows per job), 12 jobs = 36 windows.

| | job 2 | job 12 | job 12 / job 2 |
|---|---|---|---|
| Before (shared list) | 10 361 ms | 20 429 ms | 1.97 |
| After (fresh list) | 8 727 ms | 8 871 ms | 1.02 |

Before, latency climbed by ~1 s per job (2 s per 57 s of audio already
transcribed); job 2 was already slower than after because job 1 had left six
extra processors behind. After, it is flat. At the meeting scale the review
measured with the same model (one 30 s window: 2.97 s fresh, 13.5 s after 90
earlier windows, 22.8 s after 180), an hour of audio no longer costs several
times its first minutes.

## Reproduce

```sh
node tools/fetch-whisper-model.cjs            # puts whisper-base.en under resources/models
node tools/bench/whisper-window-latency.cjs --models resources/models --wav <16 kHz mono WAV, ~1 min of speech> --jobs 12
```

Before: run the same command on the parent commit of this fix.
