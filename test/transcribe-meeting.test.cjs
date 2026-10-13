'use strict';

// Speech-level logic (src/main/features/transcribe/meeting.ts): finding the
// speech, dropping what Whisper invents on silence, and turning the You and
// Them tracks into one transcript.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  findVoicedSpans, voicedSpansFromLevels, energyGate, frameRms, levelBetween, stripTags,
  looksLikePromptEcho, cleanSegments, isEcho, mergeMeeting, transcriptText, normalizeWords
} = loadTs('src/main/features/transcribe/meeting.ts');

const SR = 16000;
const seg = (startMs, endMs, text, speaker) => ({ startMs, endMs, text, ...(speaker ? { speaker } : {}) });

function signal(parts) {
  // parts: [seconds, amplitude]
  const total = parts.reduce((n, [s]) => n + Math.round(s * SR), 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const [s, a] of parts) {
    const n = Math.round(s * SR);
    for (let i = 0; i < n; i++) out[o + i] = a * Math.sin((2 * Math.PI * 220 * i) / SR);
    o += n;
  }
  return out;
}

// --- voiced spans ------------------------------------------------------------

test('speech between silences becomes padded spans; silence and clicks do not', () => {
  const s = signal([[2, 0], [1.5, 0.2], [3, 0], [0.05, 0.3], [3, 0], [2, 0.1], [1, 0]]);
  const spans = findVoicedSpans(s, SR);
  assert.equal(spans.length, 2, JSON.stringify(spans));
  const [a, b] = spans;
  assert.ok(Math.abs(a.startSample / SR - (2 - 0.4)) < 0.05);
  assert.ok(Math.abs(a.endSample / SR - (3.5 + 0.4)) < 0.05);
  assert.ok(b.startSample / SR > 9 && b.endSample / SR <= 12);
});

test('nearby speech runs are joined into one span', () => {
  const s = signal([[1, 0], [1, 0.2], [1, 0], [1, 0.2], [1, 0]]);
  assert.equal(findVoicedSpans(s, SR).length, 1);
});

test('pure silence and very quiet noise yield nothing', () => {
  assert.deepEqual(findVoicedSpans(new Float32Array(SR * 5), SR), []);
  const quiet = signal([[5, 0.001]]);
  assert.deepEqual(findVoicedSpans(quiet, SR), []);
});

test('the gate rises with a noisy room, so steady noise is not speech', () => {
  const levels = Float32Array.from([...Array(80).fill(0.02), ...Array(20).fill(0.2)]);
  const gate = energyGate(levels, 0.0018, 2.5);
  assert.ok(gate > 0.02 && gate < 0.2, `gate ${gate}`);
  const { spans } = voicedSpansFromLevels(levels, 100 * 480, SR, { frameMs: 30 });
  assert.equal(spans.length, 1);
});

test('levelBetween averages frame energy over a time range', () => {
  const levels = frameRms(signal([[1, 0], [1, 0.5]]), SR, 30);
  assert.ok(levelBetween(levels, 30, 0, 900) < 1e-6);
  assert.ok(Math.abs(levelBetween(levels, 30, 1100, 1900) - 0.5 / Math.SQRT2) < 0.02);
  assert.equal(levelBetween(new Float32Array(0), 30, 0, 100), 0);
});

// --- artefacts -----------------------------------------------------------------

test('non-speech tags are stripped, real parentheses are kept', () => {
  assert.equal(stripTags('[BLANK_AUDIO]'), '');
  assert.equal(stripTags(' [ Silence ] (music) ♪ la la ♪ '), '');
  assert.equal(stripTags('*laughs* That works.'), 'That works.');
  assert.equal(stripTags('Ship it (after review) today.'), 'Ship it (after review) today.');
  assert.equal(stripTags('[inaudible] we need more GPUs'), 'we need more GPUs');
});

test('a run of vocabulary terms is the prompt echoing, a sentence is not', () => {
  const vocab = ['Anthropic', 'Claude', 'Kubernetes', 'ARR'];
  assert.ok(looksLikePromptEcho('Anthropic, Claude, Kubernetes, ARR.', vocab));
  assert.ok(!looksLikePromptEcho('Claude runs on Kubernetes.', vocab));
  assert.ok(!looksLikePromptEcho('apples, pears, plums', vocab));
});

test('stock phrases are dropped over quiet audio and kept over speech', () => {
  const gate = 0.01;
  const quiet = () => 0.012; // barely above the gate
  const loud = () => 0.2;
  const silent = () => 0.001;
  const segs = [seg(0, 1000, ' Thank you.'), seg(1000, 3000, 'Let us ship the release.'), seg(3000, 4000, '[BLANK_AUDIO]')];
  assert.deepEqual(cleanSegments(segs, { gate, levelAt: quiet }).map((s) => s.text), ['Let us ship the release.']);
  assert.deepEqual(cleanSegments(segs, { gate, levelAt: loud }).map((s) => s.text), ['Thank you.', 'Let us ship the release.']);
  assert.deepEqual(cleanSegments(segs, { gate, levelAt: silent }), []);
  // Without audio levels only the text checks run.
  assert.deepEqual(cleanSegments(segs, { gate }).map((s) => s.text), ['Thank you.', 'Let us ship the release.']);
});

// --- You + Them ----------------------------------------------------------------

test('a you line that repeats a simultaneous them line is the mic hearing the speakers', () => {
  const them = [seg(1000, 4000, 'We should move the launch to Thursday.', 'them')];
  assert.ok(isEcho(seg(1200, 4100, 'we should move the launch to thursday'), them));
  assert.ok(!isEcho(seg(1200, 4100, 'I disagree, Friday is better for the team'), them));
  // Same words, but minutes apart: a quote, not an echo.
  assert.ok(!isEcho(seg(60000, 63000, 'We should move the launch to Thursday.'), them));
  // Two common words only count when they match exactly.
  assert.ok(!isEcho(seg(1000, 1500, 'okay sure'), [seg(900, 1600, 'okay, so the plan is', 'them')]));
  assert.ok(isEcho(seg(1000, 1500, 'Okay.'), [seg(900, 1600, 'okay', 'them')]));
});

test('tracks interleave by start time, echoes go, and runs of one speaker join', () => {
  const you = [
    seg(0, 2000, 'Hi, can you hear me?'),
    seg(2500, 4000, 'Great.'),
    seg(6200, 8000, 'We should move the launch'), // echo of them
    seg(12000, 14000, 'Agreed, Thursday it is.')
  ];
  const them = [seg(4500, 6000, 'Yes, loud and clear.'), seg(6000, 8200, 'We should move the launch.'), seg(9000, 11000, 'To Thursday.')];
  const out = mergeMeeting(you, them);
  assert.deepEqual(out.map((s) => [s.speaker, s.text]), [
    ['you', 'Hi, can you hear me? Great.'],
    ['them', 'Yes, loud and clear. We should move the launch. To Thursday.'],
    ['you', 'Agreed, Thursday it is.']
  ]);
  assert.equal(out[0].startMs, 0);
  assert.equal(out[0].endMs, 4000);
  assert.equal(out[1].endMs, 11000);
});

test('a long pause or a long monologue starts a new segment', () => {
  const you = [seg(0, 1000, 'One.'), seg(10000, 11000, 'Two.')];
  assert.equal(mergeMeeting(you, []).length, 2);
  const many = Array.from({ length: 50 }, (_, i) => seg(i * 3000, i * 3000 + 2500, `Part ${i}.`));
  const merged = mergeMeeting(many, []);
  assert.ok(merged.length >= 2);
  for (const s of merged) assert.ok(s.endMs - s.startMs <= 90000);
});

test('either track may be empty', () => {
  assert.deepEqual(mergeMeeting([], []), []);
  assert.equal(mergeMeeting([], [seg(0, 1, 'x')])[0].speaker, 'them');
});

test('transcript text: labels for meetings, plain text otherwise', () => {
  assert.equal(transcriptText([seg(0, 1, ' Hello '), seg(1, 2, 'world.')]), 'Hello world.');
  assert.equal(
    transcriptText([seg(0, 1, 'Hi.', 'you'), seg(1, 2, 'Hello.', 'them')], { you: 'You', them: 'Them' }),
    'You: Hi.\nThem: Hello.'
  );
  assert.deepEqual(normalizeWords("It's GPT-4, isn't it?"), ['its', 'gpt', '4', 'isnt', 'it']);
});
