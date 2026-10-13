'use strict';

// Local models (src/main/features/transcribe/models.ts) and the system-audio
// plan (src/renderer/src/stapler/audio/systemAudio.ts): which copy of a model
// is used, how a downloaded file is verified, and how "Them" is captured on
// each platform.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { MODELS, modelSize, modelDir, fileUrl, resolveModel, isComplete, fileVerifier } = loadTs('src/main/features/transcribe/models.ts');
const { planSystemAudio, isMonitorLabel, loopbackFailure } = loadTs('src/renderer/src/stapler/audio/systemAudio.ts');

test('the catalog pins both models, q8, with real sizes and checksums', () => {
  assert.equal(MODELS.base.repo, 'onnx-community/whisper-base.en');
  assert.equal(MODELS.large.repo, 'onnx-community/whisper-small.en');
  for (const m of Object.values(MODELS)) {
    assert.match(m.revision, /^[0-9a-f]{40}$/);
    assert.equal(m.dtype, 'q8');
    for (const f of m.files) {
      assert.ok(f.size > 0 && (f.sha256 || f.gitOid), f.path);
      assert.ok(!f.path.includes('..') && !path.isAbsolute(f.path));
    }
    assert.ok(m.files.some((f) => f.path === 'onnx/encoder_model_quantized.onnx'));
    assert.ok(m.files.some((f) => f.path === 'onnx/decoder_model_merged_quantized.onnx'));
  }
  // ~80 MB bundled, ~252 MB for the larger download.
  assert.ok(Math.abs(modelSize(MODELS.base) / 1e6 - 79.6) < 0.5);
  assert.ok(Math.abs(modelSize(MODELS.large) / 1e6 - 251.8) < 0.5);
  assert.equal(
    fileUrl(MODELS.base, MODELS.base.files[0]),
    `https://huggingface.co/onnx-community/whisper-base.en/resolve/${MODELS.base.revision}/config.json`
  );
});

test('resolution order: bundled, then the cache, else missing', () => {
  const spec = MODELS.base;
  const sizes = new Map();
  const probe = { sizeOf: (p) => sizes.get(p) ?? -1 };
  const fill = (root) => { for (const f of spec.files) sizes.set(path.join(modelDir(root, spec), ...f.path.split('/')), f.size); };
  const roots = { bundled: '/app/resources/models', cache: '/data/models' };
  assert.deepEqual(resolveModel(spec, roots, probe), { state: 'missing', root: null });
  fill('/data/models');
  assert.deepEqual(resolveModel(spec, roots, probe), { state: 'cached', root: '/data/models' });
  fill('/app/resources/models');
  assert.deepEqual(resolveModel(spec, roots, probe), { state: 'bundled', root: '/app/resources/models' });
  // A truncated file makes a copy incomplete.
  sizes.set(path.join(modelDir('/app/resources/models', spec), 'onnx', 'encoder_model_quantized.onnx'), 10);
  assert.equal(isComplete('/app/resources/models', spec, probe), false);
  assert.deepEqual(resolveModel(spec, { bundled: null, cache: '/data/models' }, probe).state, 'cached');
});

test('downloaded bytes are verified: sha256 for weights, git blob id for small files', () => {
  const content = Buffer.from('{"hello":1}\n');
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const gitOid = crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
  const a = fileVerifier({ path: 'x', size: content.length, sha256 });
  a.update(content.subarray(0, 4));
  a.update(content.subarray(4));
  assert.ok(a.matches());
  const b = fileVerifier({ path: 'x', size: content.length, gitOid });
  b.update(content);
  assert.ok(b.matches());
  const c = fileVerifier({ path: 'x', size: content.length, sha256 });
  c.update(Buffer.from('tampered'));
  assert.ok(!c.matches());
});

// --- system audio ------------------------------------------------------------

const inputs = [
  { deviceId: 'mic1', label: 'MacBook Pro Microphone' },
  { deviceId: 'bh', label: 'BlackHole 2ch (Virtual)' },
  { deviceId: 'mon1', label: 'Monitor of Built-in Audio Analog Stereo' }
];

test('a chosen device always wins', () => {
  assert.deepEqual(planSystemAudio({ mode: 'loopback', chosenDeviceId: 'bh', inputs, loopbackArmed: true }), { kind: 'device', deviceId: 'bh', label: 'BlackHole 2ch (Virtual)' });
  // Unplugged: fall back to loopback when there is one, else say so.
  assert.deepEqual(planSystemAudio({ mode: 'loopback', chosenDeviceId: 'gone', inputs, loopbackArmed: true }), { kind: 'loopback' });
  assert.deepEqual(planSystemAudio({ mode: 'monitor', chosenDeviceId: 'gone', inputs, loopbackArmed: false }), { kind: 'none', notice: 'device-missing' });
  // Without labels (no permission yet) the id is trusted.
  const blank = inputs.map((d) => ({ ...d, label: '' }));
  assert.equal(planSystemAudio({ mode: 'device', chosenDeviceId: 'gone', inputs: blank, loopbackArmed: false }).kind, 'device');
});

test('automatic: loopback on Windows/macOS, a monitor source on Linux, else a notice', () => {
  assert.deepEqual(planSystemAudio({ mode: 'loopback', chosenDeviceId: '', inputs, loopbackArmed: true }), { kind: 'loopback' });
  assert.deepEqual(planSystemAudio({ mode: 'monitor', chosenDeviceId: '', inputs, loopbackArmed: false }), { kind: 'monitor', deviceId: 'mon1', label: 'Monitor of Built-in Audio Analog Stereo' });
  assert.deepEqual(planSystemAudio({ mode: 'monitor', chosenDeviceId: '', inputs: inputs.slice(0, 2), loopbackArmed: false }), { kind: 'none', notice: 'no-monitor' });
  assert.deepEqual(planSystemAudio({ mode: 'device', chosenDeviceId: '', inputs, loopbackArmed: false }), { kind: 'none', notice: 'unsupported' });
  // Loopback mode, but main did not arm it (e.g. an older macOS): no loopback attempt.
  assert.deepEqual(planSystemAudio({ mode: 'loopback', chosenDeviceId: '', inputs, loopbackArmed: false }), { kind: 'none', notice: 'unsupported' });
});

test('monitor labels and loopback failures are recognised', () => {
  assert.ok(isMonitorLabel('Monitor of Built-in Audio'));
  assert.ok(isMonitorLabel('alsa_output.pci-0000_00_1f.3.analog-stereo.monitor'));
  assert.ok(!isMonitorLabel('USB Monitor Speakers Mic'));
  assert.equal(loopbackFailure({ name: 'NotAllowedError' }), 'permission');
  assert.equal(loopbackFailure({ name: 'NoAudioTrack' }), 'no-audio');
  assert.equal(loopbackFailure(new Error('x')), 'no-audio');
});
