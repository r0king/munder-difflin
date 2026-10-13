'use strict';

/**
 * The puck's To menu "remembers who you picked" — but a remembered agent who
 * has since left the floor must not swallow the message: it falls back to the
 * orchestrator, and says so. Also: main's short error codes become sentences.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const b = loadTs('src/renderer/src/stapler/bridge.ts');
const en = require('../src/renderer/src/i18n/features/stapler.en.json');

const roster = [
  { id: 'god', name: 'Michael', isGod: true, status: 'idle' },
  { id: 'jim', name: 'Jim', isGod: false, status: 'working', project: 'web' }
];

/** A tiny t(): looks the key up in the English fragment, echoes it if missing. */
const t = (key, vars = {}) => {
  const v = key.replace(/^stapler\./, '').split('.').reduce((o, k) => (o ? o[k] : undefined), en);
  if (typeof v !== 'string') return key;
  return v.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
};

test('effectiveTarget keeps a present agent, falls back for a departed one', () => {
  assert.deepEqual(b.effectiveTarget({ kind: 'agent', agentId: 'jim' }, roster), { target: { kind: 'agent', agentId: 'jim' }, gone: false });
  assert.deepEqual(b.effectiveTarget({ kind: 'agent', agentId: 'pam' }, roster), { target: { kind: 'orchestrator' }, gone: true });
  assert.deepEqual(b.effectiveTarget({ kind: 'orchestrator' }, roster).gone, false);
  // No roster yet (no office window): keep the pick, main decides.
  assert.deepEqual(b.effectiveTarget({ kind: 'agent', agentId: 'pam' }, []).gone, false);
});

test('targetName uses whoever is god, never a hardcoded name', () => {
  assert.equal(b.targetName(t, { kind: 'orchestrator' }, roster), 'Michael');
  assert.equal(b.targetName(t, { kind: 'orchestrator' }, [{ ...roster[0], name: 'Deangelo' }]), 'Deangelo');
  assert.equal(b.targetName(t, { kind: 'orchestrator' }, []), en.to.orchestrator);
  assert.equal(b.targetName(t, { kind: 'agent', agentId: 'jim' }, roster), 'Jim');
  assert.equal(b.targetName(t, { kind: 'agent', agentId: 'x' }, roster), en.to.unknownAgent);
});

test('errorText maps codes to sentences and passes real messages through', () => {
  assert.equal(b.errorText(t, 'unknown-agent'), en.errors.unknownAgent);
  assert.equal(b.errorText(t, 'transcription failed'), en.errors.transcriptionFailed);
  assert.equal(b.errorText(t, 'timeout'), en.errors.timeout);
  assert.equal(b.errorText(t, null), en.errors.generic);
  assert.equal(b.errorText(t, 'Permission denied by system (NotAllowedError)'), 'Permission denied by system (NotAllowedError)');
  assert.equal(b.errorText(t, 'something unheard of'), 'something unheard of');
});
