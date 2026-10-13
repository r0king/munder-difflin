'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { beginPress, onTrigger, checkRelease, releaseGap, PRESS_TIMING } = loadTs('src/main/features/dictate/press.ts');

/** Feed a list of trigger times; return the first 'stop' time or null. */
function run(times, pollUntil) {
  let s = beginPress(times[0]);
  for (const t of times.slice(1)) {
    const r = onTrigger(s, t);
    s = r.state;
    if (r.action === 'stop') return { stop: t, via: 'press', state: s };
  }
  if (pollUntil !== undefined) {
    for (let t = times[times.length - 1]; t <= pollUntil; t += 100) {
      const r = checkRelease(s, t);
      s = r.state;
      if (r.verdict === 'stop') return { stop: t, via: 'release', state: s };
      if (r.verdict === 'toggle') return { stop: null, via: 'toggle', state: s };
    }
  }
  return { stop: null, state: s };
}

test('tap, talk, tap: the second press stops (macOS: no auto-repeat at all)', () => {
  const r = run([0, 6000]);
  assert.equal(r.stop, 6000);
  assert.equal(r.via, 'press');
});

test('a second press inside the guard is ignored (nobody dictates in under a second)', () => {
  const r = run([0, 700]);
  assert.equal(r.stop, null);
});

test('a held key on Windows (500 ms delay, 33 ms repeats) never stops while held', () => {
  const times = [0];
  for (let t = 500; t <= 5000; t += 33) times.push(t);
  const r = run(times);
  assert.equal(r.stop, null);
  assert.equal(r.state.held, true);
});

test('letting go of a held key stops it — hold to talk where the OS repeats', () => {
  const times = [0];
  for (let t = 500; t <= 4000; t += 33) times.push(t);
  const last = times[times.length - 1];
  const r = run(times, last + 2000);
  assert.equal(r.via, 'release');
  assert.ok(r.stop - last >= PRESS_TIMING.RELEASE_MIN_MS && r.stop - last <= PRESS_TIMING.RELEASE_MIN_MS + 100);
});

test('X11 defaults (660 ms delay, 40 ms repeats) and a slow 400 ms repeat rate both read as held', () => {
  const x11 = [0];
  for (let t = 660; t <= 3000; t += 40) x11.push(t);
  assert.equal(run(x11).stop, null);
  const slow = [0];
  for (let t = 1000; t <= 4000; t += 400) slow.push(t);
  const r = run(slow);
  assert.equal(r.stop, null);
  assert.equal(r.state.held, true);
  assert.equal(releaseGap(r.state), PRESS_TIMING.RELEASE_MAX_MS);
});

test('a slow tap (held ~0.6 s) keeps recording and waits for the next press', () => {
  const times = [0, 500, 533, 566, 600];
  const r = run(times, 2000);
  assert.equal(r.via, 'toggle');
  assert.equal(r.state.held, false);
  // …and the next real press stops it.
  const next = onTrigger(r.state, 7000);
  assert.equal(next.action, 'stop');
});

test('not held: release polling never stops', () => {
  const s = beginPress(0);
  assert.equal(checkRelease(s, 60_000).verdict, 'keep');
});
