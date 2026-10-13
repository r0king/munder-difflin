'use strict';

// Groq path (src/main/features/transcribe/groqPlan.ts, groqEngine.ts): long
// audio is cut into ≤ 10 min / < 25 MB pieces at quiet moments, and each
// piece's segment times are shifted back onto the recording's clock.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { planChunks, stitchSegments } = loadTs('src/main/features/transcribe/groqPlan.ts');
const { parseVerboseJson } = loadTs('src/main/features/transcribe/groqEngine.ts');

const SR = 16000;

test('pieces cover the audio exactly, each within the time and byte caps', () => {
  const total = SR * 60 * 47 + 123; // 47 minutes
  const chunks = planChunks(total, { sampleRate: SR });
  assert.equal(chunks[0].startSample, 0);
  assert.equal(chunks.at(-1).endSample, total);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    assert.ok(c.endSample > c.startSample);
    assert.ok(c.endSample - c.startSample <= SR * 600, `piece ${i} too long`);
    assert.ok((c.endSample - c.startSample) * 2 + 44 <= 24 * 1024 * 1024, `piece ${i} too big`);
    if (i) assert.equal(c.startSample, chunks[i - 1].endSample);
  }
  assert.equal(chunks.length, 5);
});

test('the byte cap wins when it is the tighter one', () => {
  const chunks = planChunks(SR * 60 * 30, { sampleRate: SR, maxChunkSec: 3600, maxBytes: 10 * 1024 * 1024 });
  for (const c of chunks) assert.ok((c.endSample - c.startSample) * 2 + 44 <= 10 * 1024 * 1024);
});

test('cuts move back to the quietest moment before the cap', () => {
  const frameMs = 30;
  const frames = Math.ceil((SR * 25) / 480);
  const levels = new Float32Array(frames).fill(0.2);
  // A pause at 8.1 s, inside the 5 s search window before the 10 s cap.
  const pause = Math.round(8100 / frameMs);
  levels[pause] = 0.001;
  const chunks = planChunks(SR * 25, { sampleRate: SR, maxChunkSec: 10, searchBackSec: 5, frameLevels: levels, frameMs });
  assert.equal(chunks[0].endSample, pause * 480);
  // Never shrinks below half the maximum, even with silence early on.
  levels.fill(0.2);
  levels[10] = 0;
  const c2 = planChunks(SR * 25, { sampleRate: SR, maxChunkSec: 10, searchBackSec: 9.5, frameLevels: levels, frameMs });
  assert.ok(c2[0].endSample >= SR * 5);
});

test('short audio is one piece; empty audio is none', () => {
  assert.deepEqual(planChunks(SR * 3, { sampleRate: SR }), [{ startSample: 0, endSample: SR * 3 }]);
  assert.deepEqual(planChunks(0, { sampleRate: SR }), []);
});

test('stitching shifts each piece by its offset and orders the result', () => {
  const out = stitchSegments([
    { offsetMs: 600000, segments: [{ startMs: 0, endMs: 1500, text: 'b' }] },
    { offsetMs: 0, segments: [{ startMs: 100, endMs: 900, text: 'a' }] }
  ]);
  assert.deepEqual(out, [
    { startMs: 100, endMs: 900, text: 'a' },
    { startMs: 600000, endMs: 601500, text: 'b' }
  ]);
});

test("Groq's verbose_json becomes segments; Whisper's no-speech guesses are dropped", () => {
  const raw = JSON.stringify({
    text: 'Hello there. Thank you.',
    duration: 4,
    segments: [
      { start: 0, end: 1.5, text: ' Hello there.', no_speech_prob: 0.01, avg_logprob: -0.2 },
      { start: 1.5, end: 4, text: ' Thank you.', no_speech_prob: 0.9, avg_logprob: -1.4 },
      { start: 4, end: 3, text: '   ' }
    ]
  });
  assert.deepEqual(parseVerboseJson(raw), [{ startMs: 0, endMs: 1500, text: 'Hello there.' }]);
  // A plain-text body with no segments still yields one segment.
  assert.deepEqual(parseVerboseJson(JSON.stringify({ text: ' Hi ', duration: 2 })), [{ startMs: 0, endMs: 2000, text: 'Hi' }]);
  assert.deepEqual(parseVerboseJson(JSON.stringify({ text: '' })), []);
});
