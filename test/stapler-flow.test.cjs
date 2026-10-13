'use strict';

/**
 * Record message / Record meeting state machine
 * (src/renderer/src/stapler/flow.ts). "Record message never gets stuck":
 * every waiting phase times out, a recording has a maximum length, a late
 * answer from a cancelled session cannot move the current one, and a failed
 * send keeps what was written.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const f = loadTs('src/renderer/src/stapler/flow.ts');
const run = (events, s = f.initialFlow(0)) => events.reduce(f.flowReducer, s);

const SID = 'stapler-msg-abc-000001';

test('message: idle → starting → recording → stopping → transcribing → review → sending → done → idle', () => {
  let s = run([{ type: 'start', kind: 'message', sessionId: SID, now: 1 }]);
  assert.equal(s.phase, 'starting');
  assert.equal(f.isBusy(s), true);
  s = f.flowReducer(s, { type: 'started', sessionId: SID, now: 10 });
  assert.equal(s.phase, 'recording');
  assert.equal(s.startedAt, 10);
  assert.equal(f.elapsedMs(s, 1010), 1000);
  s = f.flowReducer(s, { type: 'stop', now: 2000 });
  assert.equal(s.phase, 'stopping');
  s = f.flowReducer(s, { type: 'stopped', sessionId: SID, durationMs: 1990, now: 2100 });
  assert.equal(s.phase, 'transcribing');
  assert.equal(s.recordedMs, 1990);
  s = f.flowReducer(s, { type: 'transcribed', sessionId: SID, text: ' Fix the login bug. ', now: 3000 });
  assert.equal(s.phase, 'review');
  assert.equal(s.text, 'Fix the login bug.');
  assert.equal(f.canSend(s, 0), true);
  s = f.flowReducer(s, { type: 'edit', text: 'Fix the login bug today.' });
  s = f.flowReducer(s, { type: 'send', now: 3100 });
  assert.equal(s.phase, 'sending');
  s = f.flowReducer(s, { type: 'sent', now: 3200 });
  assert.equal(s.phase, 'done');
  assert.equal(s.text, '');
  s = f.flowReducer(s, { type: 'tick', now: 3200 + f.DONE_LINGER_MS });
  assert.equal(s.phase, 'idle');
});

test('a transcript is appended to what was already typed', () => {
  assert.equal(f.appendTranscript('Look at this:', 'the header is broken'), 'Look at this:\n\nthe header is broken');
  assert.equal(f.appendTranscript('', ' hi '), 'hi');
  assert.equal(f.appendTranscript('kept', '   '), 'kept');
  let s = { ...f.initialFlow(0), text: 'Typed first' };
  s = run([
    { type: 'start', kind: 'message', sessionId: SID, now: 1 },
    { type: 'started', sessionId: SID, now: 2 },
    { type: 'stop', now: 3 },
    { type: 'stopped', sessionId: SID, durationMs: 1, now: 4 },
    { type: 'transcribed', sessionId: SID, text: 'then spoken', now: 5 }
  ], s);
  assert.equal(s.text, 'Typed first\n\nthen spoken');
});

test('meeting: transcribed goes straight to done, and does not touch the note', () => {
  const s = run([
    { type: 'edit', text: 'a note' },
    { type: 'start', kind: 'meeting', sessionId: SID, now: 1 },
    { type: 'started', sessionId: SID, now: 2 },
    { type: 'stop', now: 3 },
    { type: 'stopped', sessionId: SID, durationMs: 1, now: 4 },
    { type: 'transcribed', sessionId: SID, text: '', now: 5 }
  ]);
  assert.equal(s.phase, 'done');
  assert.equal(s.kind, 'meeting');
});

test('stale answers from another session are ignored', () => {
  let s = run([{ type: 'start', kind: 'message', sessionId: SID, now: 1 }]);
  s = f.flowReducer(s, { type: 'started', sessionId: 'stapler-msg-old-999999', now: 2 });
  assert.equal(s.phase, 'starting');
  s = f.flowReducer(s, { type: 'fail', error: 'late', sessionId: 'stapler-msg-old-999999', now: 3 });
  assert.equal(s.phase, 'starting');
});

test('every waiting phase times out into an error ("never gets stuck")', () => {
  let s = run([{ type: 'start', kind: 'message', sessionId: SID, now: 0 }]);
  s = f.flowReducer(s, { type: 'tick', now: f.PHASE_TIMEOUT_MS.starting + 1 });
  assert.equal(s.phase, 'error');
  assert.equal(s.error, f.TIMEOUT_ERROR);
  assert.equal(s.failedIn, 'starting');

  s = run([
    { type: 'start', kind: 'message', sessionId: SID, now: 0 },
    { type: 'started', sessionId: SID, now: 1 },
    { type: 'stop', now: 2 }
  ]);
  s = f.flowReducer(s, { type: 'tick', now: 2 + f.PHASE_TIMEOUT_MS.stopping + 1 });
  assert.equal(s.phase, 'error');
  assert.equal(s.failedIn, 'stopping');
});

test('transcription deadline scales with the recording length', () => {
  const base = f.PHASE_TIMEOUT_MS.transcribing;
  const short = { ...f.initialFlow(0), phase: 'transcribing', recordedMs: 30_000 };
  const long = { ...f.initialFlow(0), phase: 'transcribing', recordedMs: 2 * 60 * 60_000 };
  assert.equal(f.phaseTimeout(short), base);
  assert.equal(f.phaseTimeout(long), 4 * 60 * 60_000);
  assert.equal(f.flowReducer({ ...long, since: 0 }, { type: 'tick', now: base + 1 }).phase, 'transcribing');
});

test('a recording past its maximum length stops itself', () => {
  let s = run([
    { type: 'start', kind: 'message', sessionId: SID, now: 0 },
    { type: 'started', sessionId: SID, now: 0 }
  ]);
  s = f.flowReducer(s, { type: 'tick', now: f.MAX_RECORDING_MS.message });
  assert.equal(s.phase, 'stopping');
  assert.equal(s.autoStopped, true);
});

test('a failed send goes back to review with the text intact', () => {
  let s = { ...f.initialFlow(0), text: 'Do not lose me' };
  s = f.flowReducer(s, { type: 'send', now: 1 });
  s = f.flowReducer(s, { type: 'fail', error: 'unknown-agent', now: 2 });
  assert.equal(s.phase, 'review');
  assert.equal(s.error, 'unknown-agent');
  assert.equal(s.text, 'Do not lose me');
  // A send that never answers times out the same way.
  s = f.flowReducer(f.flowReducer(s, { type: 'send', now: 10 }), { type: 'tick', now: 10 + f.PHASE_TIMEOUT_MS.sending + 1 });
  assert.equal(s.phase, 'review');
  assert.equal(s.error, f.TIMEOUT_ERROR);
});

test('retry: a failed transcription is retried as-is; other failures reset', () => {
  let s = run([
    { type: 'start', kind: 'message', sessionId: SID, now: 0 },
    { type: 'started', sessionId: SID, now: 0 },
    { type: 'stop', now: 1 },
    { type: 'stopped', sessionId: SID, durationMs: 1, now: 2 },
    { type: 'fail', error: 'model missing', sessionId: SID, now: 3 }
  ]);
  assert.equal(s.failedIn, 'transcribing');
  s = f.flowReducer(s, { type: 'retry', now: 4 });
  assert.equal(s.phase, 'transcribing');
  assert.equal(s.sessionId, SID);

  s = run([
    { type: 'start', kind: 'message', sessionId: SID, now: 0 },
    { type: 'fail', error: 'mic denied', sessionId: SID, now: 1 }
  ]);
  s = f.flowReducer(s, { type: 'retry', now: 2 });
  assert.equal(s.phase, 'idle');
  assert.equal(s.error, null);
});

test('cancel always lands in idle and keeps typed text; discard clears it', () => {
  for (const upTo of [1, 2, 3, 4]) {
    const events = [
      { type: 'edit', text: 'typed' },
      { type: 'start', kind: 'message', sessionId: SID, now: 0 },
      { type: 'started', sessionId: SID, now: 0 },
      { type: 'stop', now: 1 },
      { type: 'stopped', sessionId: SID, durationMs: 1, now: 2 }
    ].slice(0, upTo + 1);
    const s = f.flowReducer(run(events), { type: 'cancel', now: 5 });
    assert.equal(s.phase, 'idle');
    assert.equal(s.sessionId, null);
    assert.equal(s.text, 'typed');
  }
  const d = f.flowReducer({ ...f.initialFlow(0), text: 'x', phase: 'review' }, { type: 'discard', now: 1 });
  assert.equal(d.text, '');
  assert.equal(d.phase, 'idle');
});

test('a second start while busy is ignored; stop during starting cancels (nothing recorded yet)', () => {
  let s = run([{ type: 'start', kind: 'meeting', sessionId: SID, now: 0 }]);
  const again = f.flowReducer(s, { type: 'start', kind: 'meeting', sessionId: 'stapler-mtg-new-000002', now: 1 });
  assert.equal(again.sessionId, SID);
  // A double press of the meeting shortcut must not leave a junk meeting.
  s = f.flowReducer(s, { type: 'stop', now: 1 });
  assert.equal(s.phase, 'idle');
  assert.equal(s.sessionId, null);
  // The late 'started' of the cancelled session moves nothing.
  assert.equal(f.flowReducer(s, { type: 'started', sessionId: SID, now: 2 }).phase, 'idle');
});

test('canSend needs text or attachments, and an idle phase', () => {
  const idle = f.initialFlow(0);
  assert.equal(f.canSend(idle, 0), false);
  assert.equal(f.canSend(idle, 2), true);
  assert.equal(f.canSend({ ...idle, text: '  ' }, 0), false);
  assert.equal(f.canSend({ ...idle, phase: 'recording', text: 'x' }, 0), false);
});
