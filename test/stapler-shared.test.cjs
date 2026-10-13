'use strict';

/**
 * The Stapler's IPC contract (src/shared/features/stapler.ts): the screenshot
 * region math both sides of the overlay depend on (CSS px in the overlay,
 * physical px in main's crop), and the validators every untrusted value goes
 * through.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const s = loadTs('src/shared/features/stapler.ts');

test('regionFromPoints normalises a drag in any direction and clamps to the view', () => {
  const view = { width: 1440, height: 900 };
  assert.deepEqual(s.regionFromPoints({ x: 100, y: 200 }, { x: 40, y: 50 }, view), { x: 40, y: 50, width: 60, height: 150 });
  assert.deepEqual(s.regionFromPoints({ x: -20, y: 850 }, { x: 1500, y: 1000 }, view), { x: 0, y: 850, width: 1440, height: 50 });
});

test('a click is not a region', () => {
  assert.equal(s.isUsableRegion({ x: 0, y: 0, width: 3, height: 300 }), false);
  assert.equal(s.isUsableRegion({ x: 0, y: 0, width: 8, height: 8 }), true);
  assert.equal(s.isUsableRegion(null), false);
});

test('fitRegion clamps a remembered region into a smaller display, rejects junk', () => {
  const r = s.fitRegion({ x: 2000, y: 1000, width: 800, height: 600 }, { width: 1440, height: 900 });
  assert.deepEqual(r, { x: 640, y: 300, width: 800, height: 600 });
  assert.equal(s.fitRegion({ x: 'a', y: 0, width: 10, height: 10 }, { width: 100, height: 100 }), null);
  assert.equal(s.fitRegion({ x: 0, y: 0, width: 2, height: 2 }, { width: 100, height: 100 }), null);
  assert.equal(s.fitRegion({ x: 0, y: 0, width: 50, height: 50 }, { width: 0, height: 100 }), null);
});

test('regionToPixels scales by what was captured, at Retina 2x', () => {
  const view = { width: 1440, height: 900 };
  const image = { width: 2880, height: 1800 };
  assert.deepEqual(s.regionToPixels({ x: 10, y: 20, width: 100, height: 50 }, view, image), { x: 20, y: 40, width: 200, height: 100 });
});

test('regionToPixels at a fractional 1.25x never loses an edge pixel and stays in the image', () => {
  const view = { width: 1536, height: 864 };
  const image = { width: 1920, height: 1080 };
  const px = s.regionToPixels({ x: 1, y: 1, width: 3, height: 3 }, view, image);
  // 1.25 → floor; 5 → ceil: covers every physical pixel the CSS rect touches.
  assert.deepEqual(px, { x: 1, y: 1, width: 4, height: 4 });
  const edge = s.regionToPixels({ x: 1530, y: 860, width: 6, height: 4 }, view, image);
  assert.equal(edge.x + edge.width, 1920);
  assert.equal(edge.y + edge.height, 1080);
});

test('regionToPixels uses the real capture size, not an assumed scale factor', () => {
  // A Linux portal handed back a 1600x1000 image for a 1440x900 display.
  const px = s.regionToPixels({ x: 0, y: 0, width: 1440, height: 900 }, { width: 1440, height: 900 }, { width: 1600, height: 1000 });
  assert.deepEqual(px, { x: 0, y: 0, width: 1600, height: 1000 });
});

test('targets: only the two shapes, reduced to their own keys', () => {
  assert.equal(s.isStaplerTarget({ kind: 'orchestrator' }), true);
  assert.equal(s.isStaplerTarget({ kind: 'agent', agentId: 'jim' }), true);
  assert.equal(s.isStaplerTarget({ kind: 'agent', agentId: '' }), false);
  assert.equal(s.isStaplerTarget({ kind: 'agent', agentId: 'x'.repeat(201) }), false);
  assert.equal(s.isStaplerTarget({ kind: 'everyone' }), false);
  assert.equal(s.isStaplerTarget(null), false);
  assert.deepEqual(s.cleanTarget({ kind: 'agent', agentId: 'jim', extra: 1 }), { kind: 'agent', agentId: 'jim' });
  assert.equal(s.sameTarget({ kind: 'agent', agentId: 'a' }, { kind: 'agent', agentId: 'a' }), true);
  assert.equal(s.sameTarget({ kind: 'agent', agentId: 'a' }, { kind: 'orchestrator' }), false);
});

test('send requests are bounded', () => {
  assert.equal(s.isStaplerSendRequest({ target: { kind: 'orchestrator' }, text: 'hi' }), true);
  assert.equal(s.isStaplerSendRequest({ target: { kind: 'orchestrator' }, text: 'x'.repeat(s.MAX_NOTE_CHARS + 1) }), false);
  assert.equal(s.isStaplerSendRequest({ target: { kind: 'orchestrator' } }), false);
});

test('sanitizeSegments: speakers default to you, times are sane, text is capped', () => {
  const out = s.sanitizeSegments([
    { speaker: 'them', startMs: 1000, endMs: 500, text: 'hello' },
    { speaker: 'robot', startMs: -5, endMs: 10, text: 'hi' },
    { text: 42 },
    null,
    { startMs: 0, endMs: 1, text: 'y'.repeat(s.MAX_SEGMENT_CHARS + 10) }
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { speaker: 'them', startMs: 1000, endMs: 1000, text: 'hello' });
  assert.deepEqual(out[1], { speaker: 'you', startMs: 0, endMs: 10, text: 'hi' });
  assert.equal(out[2].text.length, s.MAX_SEGMENT_CHARS);
  assert.deepEqual(s.sanitizeSegments('nope'), []);
});

test('sanitizeMeetingPatch keeps only valid fields; title is one line', () => {
  assert.equal(s.sanitizeMeetingPatch(null), null);
  assert.equal(s.sanitizeMeetingPatch({ nothing: true }), null);
  assert.deepEqual(s.sanitizeMeetingPatch({ title: '  Weekly\nsync  ', description: 'd' }), { title: 'Weekly sync', description: 'd' });
  const p = s.sanitizeMeetingPatch({ segments: [{ text: 'a', speaker: 'them', startMs: 0, endMs: 1 }] });
  assert.equal(p.segments[0].speaker, 'them');
});

test('sanitizeMeetingFinish requires ok and fills an error for a failure', () => {
  assert.equal(s.sanitizeMeetingFinish({}), null);
  assert.deepEqual(s.sanitizeMeetingFinish({ ok: false, durationMs: 5 }), { ok: false, durationMs: 5, segments: [], error: 'transcription failed' });
  const ok = s.sanitizeMeetingFinish({ ok: true, durationMs: 1.6, segments: [{ text: 'x', startMs: 0, endMs: 1 }], engine: 'local' });
  assert.equal(ok.durationMs, 2);
  assert.equal(ok.engine, 'local');
  assert.equal(ok.segments.length, 1);
});

test('formatDuration', () => {
  assert.equal(s.formatDuration(0), '0:00');
  assert.equal(s.formatDuration(42_000), '0:42');
  assert.equal(s.formatDuration(725_000), '12:05');
  assert.equal(s.formatDuration(3_723_000), '1:02:03');
  assert.equal(s.formatDuration(NaN), '0:00');
});

test('session ids fit the transcribe unit\'s shape', () => {
  const { isValidSessionId } = loadTs('src/shared/features/transcribe.ts');
  const msg = s.newSessionId('message', 1_760_000_000_000, () => 0.5);
  const mtg = s.newSessionId('meeting');
  assert.match(msg, /^stapler-msg-/);
  assert.match(mtg, /^stapler-mtg-/);
  for (const id of [msg, mtg]) {
    assert.equal(s.isSessionId(id), true);
    assert.equal(isValidSessionId(id), true);
  }
  assert.equal(s.isSessionId('../../etc'), false);
});

test('panels and modes', () => {
  assert.equal(s.isStaplerPanel('compose'), true);
  assert.equal(s.isStaplerPanel('evil'), false);
  assert.equal(s.isStaplerMode('ring'), true);
  assert.equal(s.isStaplerMode('panel '), false);
});
