'use strict';

// The worker's window loop (src/main/features/transcribe/transcribe-worker.ts)
// with a stand-in model. Whisper's generate() pushes its own timestamp and
// begin-suppress processors onto the logits-processor list it is handed; a
// list shared across calls therefore grew by two per 30 s window, slowing
// every window down and leaving stale processors behind
// (docs/perf/whisper-logits-processor.md). Each call must get a fresh list.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { transcribeSpan } = loadTs('src/main/features/transcribe/transcribe-worker.ts');

const SR = 16000;
const SUPPRESS = { name: 'suppress' };

/** A model whose generate() does to the list what transformers.js 3.8 does. */
function fakeLoaded(newProcessors) {
  const seen = [];
  return {
    seen,
    loaded: {
      newProcessors,
      timePrecision: 0.02,
      processor: Object.assign(async (audio) => ({ input_features: audio }), {
        feature_extractor: { config: { hop_length: 160 } }
      }),
      tokenizer: { _decode_asr: () => ['', { chunks: [] }] },
      model: {
        generation_config: { decoder_start_token_id: 50257 },
        config: { decoder_start_token_id: 50257 },
        async generate({ logits_processor: list }) {
          seen.push({ list, length: list.processors.length, first: list.processors[0] });
          list.processors.push({ name: 'timestamps' }, { name: 'begin-suppress' });
          return [{ tolist: () => [50257] }];
        }
      }
    }
  };
}

const freshList = () => ({ processors: [SUPPRESS], push(p) { this.processors.push(p); } });
const src = { read: (a, b) => new Float32Array(Math.max(0, b - a)) };

test('every window gets a fresh list holding only the token suppressor', async () => {
  const { seen, loaded } = fakeLoaded(freshList);
  // 100 s of speech: windows at 0, 20, 40, 60 and 80 s.
  await transcribeSpan(loaded, src, { startSample: 0, endSample: 100 * SR }, []);
  await transcribeSpan(loaded, src, { startSample: 0, endSample: 45 * SR }, [50361, 1, 2]);
  assert.ok(seen.length >= 7, `expected several windows, got ${seen.length}`);
  for (const call of seen) {
    assert.equal(call.length, 1);
    assert.equal(call.first, SUPPRESS);
  }
  assert.equal(new Set(seen.map((c) => c.list)).size, seen.length, 'no list is reused');
});

test('a shared list (the old behaviour) is caught: it grows by two per window', async () => {
  const shared = freshList();
  const { seen, loaded } = fakeLoaded(() => shared);
  await transcribeSpan(loaded, src, { startSample: 0, endSample: 100 * SR }, []);
  assert.deepEqual(seen.map((c) => c.length), seen.map((_, i) => 1 + 2 * i));
});
