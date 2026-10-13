'use strict';

// Recording sessions on disk (src/main/features/transcribe/sessions.ts,
// retention.ts) and the shared contract's validators
// (src/shared/features/transcribe.ts): ids that cannot escape the sessions
// folder, PCM that only its owner can append, WAV headers patched on
// finalize, and recordings deleted on schedule.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { SessionStore, MAX_CHUNK_BYTES } = loadTs('src/main/features/transcribe/sessions.ts');
const { selectExpired, TRANSCRIBED_TTL_MS, UNTRANSCRIBED_TTL_MS } = loadTs('src/main/features/transcribe/retention.ts');
const { parseWav } = loadTs('src/main/features/transcribe/wav.ts');
const {
  isValidSessionId, newSessionId, sanitizeSettingsPatch, normalizeSettings, DEFAULT_TRANSCRIBE_SETTINGS, MAX_CUSTOM_WORDS
} = loadTs('src/shared/features/transcribe.ts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tx-sessions-'));
const pcm = (n, v = 1000) => new Uint8Array(Int16Array.from({ length: n }, () => v).buffer);
const HOUR = 60 * 60 * 1000;

test('session ids: shaped like a single folder name, nothing a path can be built from', () => {
  for (const id of ['mf3k2a-0a1b2c3d4e5f', newSessionId(), 'a', 'A_b-9']) assert.ok(isValidSessionId(id), id);
  for (const id of ['', '../x', '..', '.', 'a/b', 'a\\b', 'C:x', '-lead', '_lead', 'x'.repeat(97), 'a b', 'é', null, 5, {}]) {
    assert.ok(!isValidSessionId(id), JSON.stringify(id));
  }
  assert.notEqual(newSessionId(), newSessionId());
});

test('settings patches from the renderer are sanitised field by field', () => {
  assert.deepEqual(sanitizeSettingsPatch(null), {});
  assert.deepEqual(sanitizeSettingsPatch({ engine: 'apple' }), { engine: 'apple' });
  assert.deepEqual(sanitizeSettingsPatch({ engine: 'whisper.cpp', micDeviceId: 7 }), {});
  const words = sanitizeSettingsPatch({ customVocabulary: [' Zensible ', 'zensible', 'two  words', '', 3, 'x'.repeat(49), 'ok\u0007'] }).customVocabulary;
  assert.deepEqual(words, ['Zensible', 'two words', 'ok']);
  const many = sanitizeSettingsPatch({ customVocabulary: Array.from({ length: 500 }, (_, i) => `w${i}`) }).customVocabulary;
  assert.equal(many.length, MAX_CUSTOM_WORDS);
  assert.deepEqual(normalizeSettings({ engine: 'nope', customVocabulary: 'x' }), DEFAULT_TRANSCRIBE_SETTINGS);
});

test('begin → append → finalize writes valid WAVs with patched headers', () => {
  const root = tmp();
  try {
    const store = new SessionStore(root);
    const id = newSessionId();
    assert.deepEqual(store.begin({ sessionId: id, mic: true, system: true }, 7), { ok: true });
    assert.ok(store.anyOpen());
    assert.ok(store.append(id, 7, 'mic', pcm(16000)));
    assert.ok(store.append(id, 7, 'mic', pcm(8000)));
    assert.ok(store.append(id, 7, 'system', pcm(16000)));
    const r = store.finalize(id, 7);
    assert.equal(r.ok, true);
    assert.equal(r.durationMs, 1500);
    assert.ok(r.micWav.endsWith(path.join(id, 'mic.wav')));
    const info = parseWav(fs.readFileSync(r.micWav));
    assert.equal(info.dataBytes, 24000 * 2);
    assert.equal(fs.readFileSync(r.micWav).readUInt32LE(40), 48000);
    assert.ok(!store.anyOpen());
    // Finalizing again reports what is on disk.
    const again = store.finalize(id, 7);
    assert.equal(again.ok, true);
    assert.equal(again.micWav, r.micWav);
    assert.equal(store.sessionOfPath(r.micWav), id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('only the owner may append, finalize or cancel; bad chunks are dropped', () => {
  const root = tmp();
  try {
    const store = new SessionStore(root);
    const id = newSessionId();
    store.begin({ sessionId: id, mic: true, system: false }, 1);
    assert.equal(store.append(id, 2, 'mic', pcm(10)), false, 'other renderer');
    assert.equal(store.append(id, 1, 'system', pcm(10)), false, 'track not requested');
    assert.equal(store.append(id, 1, 'mic', new Uint8Array(3)), false, 'odd byte count');
    assert.equal(store.append(id, 1, 'mic', new Uint8Array(MAX_CHUNK_BYTES + 2)), false, 'oversized');
    assert.equal(store.append('nope', 1, 'mic', pcm(10)), false, 'unknown session');
    assert.equal(store.finalize(id, 2).ok, false);
    assert.equal(store.cancel(id, 2), false);
    assert.ok(store.isOpen(id));
    assert.deepEqual(store.begin({ sessionId: id, mic: true, system: false }, 1).ok, false, 'no reuse');
    assert.deepEqual(store.begin({ sessionId: '../escape', mic: true, system: false }, 1).ok, false);
    assert.deepEqual(store.begin({ sessionId: newSessionId(), mic: false, system: false }, 1).ok, false);
    // Nothing recorded → finalize says so.
    const r = store.finalize(id, 1);
    assert.equal(r.ok, false);
    assert.match(r.error, /no audio/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cancel deletes the recording, also right after its owner stopped it', () => {
  const root = tmp();
  try {
    const store = new SessionStore(root);
    const a = newSessionId();
    store.begin({ sessionId: a, mic: true, system: false }, 1);
    store.append(a, 1, 'mic', pcm(100));
    assert.ok(store.cancel(a, 1));
    assert.ok(!fs.existsSync(path.join(root, a)));

    const b = `${newSessionId()}b`;
    store.begin({ sessionId: b, mic: true, system: false }, 1);
    store.append(b, 1, 'mic', pcm(100));
    store.finalize(b, 1);
    assert.equal(store.cancel(b, 2), false, 'not the recorder');
    assert.ok(fs.existsSync(path.join(root, b)));
    assert.ok(store.cancel(b, 1), 'the recorder discards its review');
    assert.ok(!fs.existsSync(path.join(root, b)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a path outside the sessions folder belongs to no session', () => {
  const root = tmp();
  const outside = tmp();
  try {
    const store = new SessionStore(root);
    const f = path.join(outside, 'x.wav');
    fs.writeFileSync(f, 'x');
    assert.equal(store.sessionOfPath(f), null);
    assert.equal(store.sessionOfPath('relative.wav'), null);
    assert.equal(store.sessionOfPath(path.join(root, '..', path.basename(outside), 'x.wav')), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('retention: 24 h after transcription, 7 days if never, never while recording', () => {
  const now = Date.UTC(2026, 9, 12, 12);
  const s = [
    { id: 'fresh', createdAt: now - HOUR },
    { id: 'done-recently', createdAt: now - 3 * HOUR, transcribedAt: now - 2 * HOUR },
    { id: 'done-yesterday', createdAt: now - 30 * HOUR, transcribedAt: now - TRANSCRIBED_TTL_MS - 1 },
    { id: 'abandoned', createdAt: now - UNTRANSCRIBED_TTL_MS - 1 },
    { id: 'old-but-open', createdAt: now - UNTRANSCRIBED_TTL_MS - 1 }
  ];
  assert.deepEqual(selectExpired(s, now, (id) => id === 'old-but-open'), ['done-yesterday', 'abandoned']);
});

test('the sweep deletes expired folders and ages a folder without metadata by mtime', () => {
  const root = tmp();
  try {
    const store = new SessionStore(root);
    const t0 = Date.now();
    const a = `${newSessionId()}a`;
    store.begin({ sessionId: a, mic: true, system: false }, 1, t0);
    store.append(a, 1, 'mic', pcm(100));
    store.finalize(a, 1, t0);
    store.markTranscribed(a, t0);
    const stray = path.join(root, 'strayfolder1');
    fs.mkdirSync(stray);
    fs.mkdirSync(path.join(root, '..dots'), { recursive: true });
    assert.deepEqual(store.sweep(t0 + HOUR), []);
    assert.deepEqual(store.sweep(t0 + TRANSCRIBED_TTL_MS + 1), [a]);
    assert.ok(!fs.existsSync(path.join(root, a)));
    assert.deepEqual(store.sweep(t0 + UNTRANSCRIBED_TTL_MS + 60_000), ['strayfolder1']);
    assert.ok(fs.existsSync(path.join(root, '..dots')), 'invalid names are never touched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
