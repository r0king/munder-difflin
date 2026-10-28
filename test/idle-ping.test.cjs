'use strict';

/**
 * Idle ping (#4 from god, 2026-10-28): an agent idle with an empty inbox never
 * receives a prompt, so context rules like "Idle time: propose quality work"
 * never fire. The wake beat pings it once per idle stretch. The latch is what
 * bounds the cost: an agent that answers its ping in a short turn and goes quiet
 * again is not pinged again until it gets mail or does real work.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { WorkerWakeWatchdog, IDLE_PING_REARM_MS } = loadTs('src/main/workerWake.ts');

const NOW = 100_000_000;
const MIN = 60_000;
const IDLE = 20 * MIN;

function idle(overrides = {}) {
  return {
    agentId: 'oscar',
    ptyId: 'pty-oscar',
    lastOutputAt: NOW - 25 * MIN,
    inboxIds: [],
    autoDeliveryPaused: false,
    paused: false,
    halted: false,
    ...overrides
  };
}

test('an agent quiet past the threshold with an empty inbox is pinged once', () => {
  const w = new WorkerWakeWatchdog();
  assert.deepEqual(w.idlePings([idle()], NOW, IDLE), ['oscar']);
  // Answered with a one-line "waiting on tests", then quiet again: no second ping.
  w.noteHook('oscar', 'Stop', undefined, NOW + MIN);
  assert.deepEqual(w.idlePings([idle({ lastOutputAt: NOW + MIN })], NOW + 30 * MIN, IDLE), []);
});

test('mail or real work after the ping re-arms it', () => {
  const w = new WorkerWakeWatchdog();
  w.idlePings([idle()], NOW, IDLE);
  w.idlePings([idle({ inboxIds: ['m1'] })], NOW + MIN, IDLE); // god replied with work
  assert.deepEqual(w.idlePings([idle({ lastOutputAt: NOW + 2 * MIN })], NOW + 30 * MIN, IDLE), ['oscar']);

  const v = new WorkerWakeWatchdog();
  v.idlePings([idle()], NOW, IDLE);
  v.noteHook('oscar', 'PostToolUse', undefined, NOW + IDLE_PING_REARM_MS + MIN); // worked on its own proposal
  v.noteHook('oscar', 'Stop', undefined, NOW + IDLE_PING_REARM_MS + 2 * MIN);
  assert.deepEqual(v.idlePings([idle({ lastOutputAt: NOW + IDLE_PING_REARM_MS + 2 * MIN })], NOW + 60 * MIN, IDLE), ['oscar']);
});

test('not pinged: busy, mail pending, god, paused, halted, no terminal, off', () => {
  const w = new WorkerWakeWatchdog();
  assert.deepEqual(w.idlePings([
    idle({ agentId: 'a', lastOutputAt: NOW - 5 * MIN }),
    idle({ agentId: 'b', inboxIds: ['m1'] }),
    idle({ agentId: 'c', isGod: true }),
    idle({ agentId: 'd', paused: true }),
    idle({ agentId: 'e', halted: true }),
    idle({ agentId: 'f', autoDeliveryPaused: true }),
    idle({ agentId: 'g', ptyId: undefined }),
    idle({ agentId: 'h', lastOutputAt: 0 })
  ], NOW, IDLE), []);
  assert.deepEqual(w.idlePings([idle()], NOW, 0), []);
});

test('an open permission prompt is never typed into, however old', () => {
  const w = new WorkerWakeWatchdog();
  w.noteHook('oscar', 'PostToolUse', undefined, NOW - 40 * MIN);
  w.noteHook('oscar', 'Notification', 'Claude needs your permission to use Bash', NOW - 30 * MIN);
  assert.deepEqual(w.idlePings([idle()], NOW, IDLE), []);
});

test('a silent tool call (a hooked commit running the suite) is busy, not idle', () => {
  const w = new WorkerWakeWatchdog();
  w.noteHook('oscar', 'PreToolUse', undefined, NOW - 25 * MIN);
  assert.deepEqual(w.idlePings([idle()], NOW, IDLE), []);
  // Past an hour the call is presumed lost (an interrupt fires no Stop).
  assert.deepEqual(w.idlePings([idle()], NOW + 40 * MIN, IDLE), ['oscar']);
});

test('a turn that ended with Stop is idle again', () => {
  const w = new WorkerWakeWatchdog();
  w.noteHook('oscar', 'PreToolUse', undefined, NOW - 30 * MIN);
  w.noteHook('oscar', 'Stop', undefined, NOW - 26 * MIN);
  assert.deepEqual(w.idlePings([idle()], NOW, IDLE), ['oscar']);
});
