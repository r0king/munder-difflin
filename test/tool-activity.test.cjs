'use strict';

/**
 * A long tool call prints nothing, so quiet-PTY checks read a hooked `git
 * commit` running the test suite as idle (seen live 2026-10-26). These pin the
 * busy signal they consult instead: PreToolUse opens a call, PostToolUse closes
 * it, turn boundaries clear it, and a lost call expires.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { activityLabel, busyFor, busyText, isIdleNotice, trackTool, MAX_IN_FLIGHT_MS } = loadTs('src/shared/toolActivity.ts');

test('labels: tests and hooked commits, other shell, other tools', () => {
  assert.equal(activityLabel('Bash', { command: 'cd x && python -m pytest -q' }), 'running tests');
  assert.equal(activityLabel('Bash', { command: 'git commit -m "wip"' }), 'running tests');
  assert.equal(activityLabel('run_shell_command', { command: 'npm run test' }), 'running tests');
  assert.equal(activityLabel('shell', { command: ['bash', '-lc', 'npx vitest run'] }), 'running tests');
  assert.equal(activityLabel('Bash', { command: 'ls -la' }), 'running shell');
  assert.equal(activityLabel('Bash', undefined), 'running shell');
  assert.equal(activityLabel('Read', { file_path: '/x' }), 'using Read');
});

test('PreToolUse opens a call and its PostToolUse closes it; parallel calls overlap', () => {
  const m = new Map();
  trackTool(m, 'a', 'PreToolUse', 'running tests', 1000);
  trackTool(m, 'a', 'PreToolUse', 'using Read', 2000);
  assert.equal(busyFor(m, 'a', 3000).label, 'running tests');
  assert.equal(busyFor(m, 'a', 3000).since, 1000);
  trackTool(m, 'a', 'PostToolUse', '', 3000);
  assert.ok(busyFor(m, 'a', 3000), 'one call still open');
  trackTool(m, 'a', 'PostToolUse', '', 4000);
  assert.equal(busyFor(m, 'a', 4000), undefined);
  assert.equal(busyFor(m, 'other', 4000), undefined);
});

test('turn boundaries clear an interrupted call', () => {
  for (const [event, idle] of [['Stop', false], ['UserPromptSubmit', false], ['SessionStart', false], ['Notification', true]]) {
    const m = new Map();
    trackTool(m, 'a', 'PreToolUse', 'running shell', 0);
    trackTool(m, 'a', event, '', 1, idle);
    assert.equal(busyFor(m, 'a', 2), undefined, event);
  }
  const m = new Map();
  trackTool(m, 'a', 'PreToolUse', 'running shell', 0);
  trackTool(m, 'a', 'Notification', '', 1, false); // a permission prompt is not the end
  assert.ok(busyFor(m, 'a', 2));
});

test('a lost call stops counting after the ceiling, and a new call restarts the clock', () => {
  const m = new Map();
  trackTool(m, 'a', 'PreToolUse', 'running shell', 0);
  assert.ok(busyFor(m, 'a', MAX_IN_FLIGHT_MS));
  assert.equal(busyFor(m, 'a', MAX_IN_FLIGHT_MS + 1), undefined);
  trackTool(m, 'a', 'PreToolUse', 'running tests', MAX_IN_FLIGHT_MS + 5);
  assert.equal(busyFor(m, 'a', MAX_IN_FLIGHT_MS + 6).since, MAX_IN_FLIGHT_MS + 5);
});

test('idle notice and elapsed text', () => {
  assert.equal(isIdleNotice('Notification', 'idle_prompt'), true);
  assert.equal(isIdleNotice('Notification', undefined, 'Claude is waiting for your input'), true);
  assert.equal(isIdleNotice('Notification', 'permission_prompt', 'Claude needs your permission'), false);
  assert.equal(isIdleNotice('Stop', 'idle'), false);
  assert.equal(busyText({ open: 1, since: 0, label: 'running tests' }, 59_000), 'running tests');
  assert.equal(busyText({ open: 1, since: 0, label: 'running tests' }, 4 * 60_000 + 5), 'running tests 4m');
});
