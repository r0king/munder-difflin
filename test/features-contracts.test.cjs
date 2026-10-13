'use strict';

// The feature layer's shared contracts (src/shared/features/*): the shapes that
// cross IPC between main, the app window and the Stapler's windows. Every one
// of them is validated at the boundary, so these validators are the security
// and correctness edge of the whole bridge.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { isDeliverRequest, composeDeliveryText, attachmentName, MAX_DELIVER_TEXT } =
  loadTs('src/shared/features/deliver.ts');
const { isWorkspaceRoute, cleanRoute, sameRoute, normalizeUiMode, DEFAULT_WORKSPACE_ROUTE } =
  loadTs('src/shared/features/route.ts');
const { mergeEnableFeatures } = loadTs('src/shared/features/switches.ts');
const { sanitizeRoster } = loadTs('src/shared/features/roster.ts');
const { featChannel, FEAT_BRIDGE } = loadTs('src/shared/features/channels.ts');

// --- deliver ---------------------------------------------------------------

test('a delivery request is validated before it is trusted', () => {
  assert.ok(isDeliverRequest({ target: { kind: 'orchestrator' }, text: 'hi' }));
  assert.ok(isDeliverRequest({ target: { kind: 'agent', agentId: 'jim-1' }, text: '', attachments: ['/a.png'], mode: 'steer', source: 'stapler' }));
  for (const bad of [
    null, 'text', [],
    { text: 'no target' },
    { target: { kind: 'agent' }, text: 'no id' },
    { target: { kind: 'agent', agentId: '' }, text: 'empty id' },
    { target: { kind: 'everyone' }, text: 'unknown kind' },
    { target: { kind: 'orchestrator' } },
    { target: { kind: 'orchestrator' }, text: 'x', attachments: '/a.png' },
    { target: { kind: 'orchestrator' }, text: 'x', attachments: [''] },
    { target: { kind: 'orchestrator' }, text: 'x', mode: 'shout' },
    { target: { kind: 'orchestrator' }, text: 'x', source: 7 },
    { target: { kind: 'orchestrator' }, text: 'x'.repeat(MAX_DELIVER_TEXT + 1) }
  ]) {
    assert.equal(isDeliverRequest(bad), false, JSON.stringify(bad)?.slice(0, 80));
  }
});

test('attachments travel in the composer\'s exact "Attached files:" format', () => {
  assert.equal(composeDeliveryText('look', []), 'look');
  assert.equal(composeDeliveryText('look'), 'look');
  assert.equal(
    composeDeliveryText('look at this', ['/tmp/shot 1.png', '/tmp/shot 1.png', 'C:\\Users\\me\\notes.pdf']),
    'look at this\n\nAttached files:\n- /tmp/shot 1.png (shot 1.png)\n- C:\\Users\\me\\notes.pdf (notes.pdf)'
  );
  // No text: just the block (the composer allows a files-only send).
  assert.equal(composeDeliveryText('  ', ['/a/b.png']), 'Attached files:\n- /a/b.png (b.png)');
  assert.equal(attachmentName('/a/b/'), 'b');
});

// --- routes ----------------------------------------------------------------

test('workspace routes are validated and reduced to their own keys', () => {
  assert.ok(isWorkspaceRoute({ kind: 'agents' }));
  assert.ok(isWorkspaceRoute({ kind: 'agent', agentId: 'a1' }));
  assert.ok(isWorkspaceRoute({ kind: 'orchestrator', tab: 'budget' }));
  assert.ok(isWorkspaceRoute({ kind: 'memory', query: 'login' }));
  assert.ok(isWorkspaceRoute(DEFAULT_WORKSPACE_ROUTE));
  for (const bad of [null, {}, { kind: 'settings' }, { kind: 'agent' }, { kind: 'agent', agentId: 3 }, { kind: 'inbox', section: 1 }]) {
    assert.equal(isWorkspaceRoute(bad), false, JSON.stringify(bad));
  }
  assert.deepEqual(cleanRoute({ kind: 'tasks', evil: true }), { kind: 'tasks' });
  assert.deepEqual(cleanRoute({ kind: 'agent', agentId: 'a', tab: 'x' }), { kind: 'agent', agentId: 'a' });
  assert.deepEqual(cleanRoute({ kind: 'orchestrator', tab: '' }), { kind: 'orchestrator' });
  assert.ok(sameRoute({ kind: 'inbox' }, { kind: 'inbox', section: undefined }));
  assert.ok(!sameRoute({ kind: 'agent', agentId: 'a' }, { kind: 'agent', agentId: 'b' }));
});

test('only an explicit "workspace" leaves Classic', () => {
  assert.equal(normalizeUiMode('workspace'), 'workspace');
  for (const v of [undefined, null, 'classic', 'pro', 1]) assert.equal(normalizeUiMode(v), 'classic');
});

// --- switches --------------------------------------------------------------

test('Chromium feature flags merge into one de-duplicated list', () => {
  assert.equal(mergeEnableFeatures(undefined, []), '');
  assert.equal(mergeEnableFeatures('', ['A', 'B']), 'A,B');
  assert.equal(mergeEnableFeatures('X, A', ['A', ' B ', '', 'X']), 'X,A,B');
});

// --- roster ----------------------------------------------------------------

test('the roster main caches is sanitised entry by entry', () => {
  assert.deepEqual(sanitizeRoster('nope'), []);
  const out = sanitizeRoster([
    { id: 'god', name: 'Michael', isGod: true, status: 'working', model: 'opus', cwd: '/secret', note: 'private' },
    { id: 'jim', name: 'Jim', status: 'dancing', provider: 'codex', project: 'app' },
    { id: 'jim', name: 'Jim again', status: 'idle' },
    { id: '', name: 'nobody' },
    { name: 'no id' },
    null
  ]);
  assert.deepEqual(out, [
    { id: 'god', name: 'Michael', isGod: true, status: 'working', model: 'opus' },
    { id: 'jim', name: 'Jim', isGod: false, status: 'offline', provider: 'codex', project: 'app' }
  ]);
});

// --- channels --------------------------------------------------------------

test('every feature channel lives under feat:', () => {
  assert.equal(featChannel('tasks', 'list'), 'feat:tasks:list');
  for (const ch of Object.values(FEAT_BRIDGE)) assert.match(ch, /^feat:/);
  assert.equal(new Set(Object.values(FEAT_BRIDGE)).size, Object.values(FEAT_BRIDGE).length, 'duplicate bridge channel');
});
