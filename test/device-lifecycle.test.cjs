'use strict';
/**
 * Devices, Task 8: the lifecycle decisions that must never go wrong. A
 * terminal that dies with the link is a detach, not an agent that ended. After
 * a crash, or a quit while a device was offline, the next connect keeps the
 * sessions the restore flow brings back and kills the rest.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const dc = loadTs('src/main/deviceCommands.ts');

test('only a definite "no such session" on an online device ends the agent', () => {
  assert.equal(dc.isDetach('online', 1), false, 'has-session said no: the agent ended');
  assert.equal(dc.isDetach('online', 0), true, 'still running there: a detach');
  assert.equal(dc.isDetach('online', -1), true, 'the check itself failed: never archive on a guess');
  assert.equal(dc.isDetach('offline', -1), true, 'link down: a detach');
  assert.equal(dc.isDetach('connecting', 1), true);
});

test('a device offline at quit: the next connect keeps what the restore flow brings back and kills the rest', () => {
  const roster = {
    agents: [{ id: 'jim', device: 'my-lap', cwd: '/r/jim' }, { id: 'pam', cwd: '/r/pam' }],
    restorable: [{ id: 'dev.1', device: 'my-lap', cwd: '/r/dev' }, { id: 'kev', device: 'other-lap' }, null, 'junk']
  };
  const keep = dc.rosterAgentsOn(roster, 'my-lap');
  assert.deepEqual(keep, [{ id: 'jim', cwd: '/r/jim' }, { id: 'dev.1', cwd: '/r/dev' }]);
  const plan = dc.planReconcile(dc.parseTmuxLs('md-jim\nmd-dev-1\nmd-stopped-before-quit\n'), keep.map((a) => a.id));
  assert.deepEqual(plan, { keep: ['md-jim', 'md-dev-1'], kill: ['md-stopped-before-quit'] });
  assert.deepEqual(dc.rosterAgentsOn(null, 'my-lap'), []);
});
