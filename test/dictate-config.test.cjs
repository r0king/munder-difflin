'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { sanitizeDictateConfig, applyDictatePatch } = loadTs('src/main/features/dictate/config.ts');
const { defaultDictateConfig, MAX_MAX_SECONDS, MIN_MAX_SECONDS } = loadTs('src/shared/features/dictate.ts');

test('a missing or corrupt settings file reads as the defaults', () => {
  assert.deepEqual(sanitizeDictateConfig(undefined, 'linux'), defaultDictateConfig('linux'));
  assert.deepEqual(sanitizeDictateConfig('nope', 'darwin'), defaultDictateConfig('darwin'));
  assert.deepEqual(sanitizeDictateConfig([1, 2], 'win32'), defaultDictateConfig('win32'));
});

test('each bad stored field falls back on its own; good ones are kept and normalised', () => {
  const c = sanitizeDictateConfig({
    enabled: true, accelerator: 'ctrl+shift+d', cancelAccelerator: 'Space', pasteMode: 'type',
    restoreClipboard: 'yes', maxSeconds: 99999
  }, 'linux');
  assert.equal(c.enabled, true);
  assert.equal(c.accelerator, 'Control+Shift+D');
  assert.equal(c.cancelAccelerator, 'Escape');
  assert.equal(c.pasteMode, 'paste');
  assert.equal(c.restoreClipboard, true);
  assert.equal(c.maxSeconds, MAX_MAX_SECONDS);
});

test('a hand-edited reserved shortcut cannot lock the user out', () => {
  assert.equal(sanitizeDictateConfig({ accelerator: 'Ctrl+V' }, 'win32').accelerator, 'Control+Alt+Space');
});

test('patch: fields apply, accelerators normalise, seconds clamp', () => {
  const cur = defaultDictateConfig('darwin');
  const r = applyDictatePatch(cur, { enabled: true, accelerator: 'option+shift+d', maxSeconds: 3, pasteMode: 'clipboard', junk: 1 }, 'darwin');
  assert.equal(r.ok, true);
  assert.equal(r.config.enabled, true);
  assert.equal(r.config.accelerator, 'Alt+Shift+D');
  assert.equal(r.config.maxSeconds, MIN_MAX_SECONDS);
  assert.equal(r.config.pasteMode, 'clipboard');
  assert.equal('junk' in r.config, false);
});

test('patch: an invalid field is refused whole and named', () => {
  const cur = defaultDictateConfig('linux');
  assert.deepEqual(applyDictatePatch(cur, { accelerator: 'Q' }, 'linux'), { ok: false, field: 'accelerator', error: 'needs-modifier' });
  assert.deepEqual(applyDictatePatch(cur, { cancelAccelerator: 'Control+Alt+Space' }, 'linux'), { ok: false, field: 'cancelAccelerator', error: 'conflict' });
  assert.deepEqual(applyDictatePatch(cur, { pasteMode: 'type' }, 'linux'), { ok: false, field: 'pasteMode', error: 'invalid' });
  assert.deepEqual(applyDictatePatch(cur, { maxSeconds: 'long' }, 'linux'), { ok: false, field: 'maxSeconds', error: 'invalid' });
  assert.deepEqual(applyDictatePatch(cur, { enabled: 'on' }, 'linux'), { ok: false, field: 'enabled', error: 'invalid' });
  assert.deepEqual(applyDictatePatch(cur, { accelerator: 'x'.repeat(200) }, 'linux'), { ok: false, field: 'accelerator', error: 'syntax' });
});

test('patch: the two keys may be swapped in one go', () => {
  const cur = { ...defaultDictateConfig('linux'), accelerator: 'Control+Alt+D', cancelAccelerator: 'Control+Alt+E' };
  const r = applyDictatePatch(cur, { accelerator: 'Control+Alt+E', cancelAccelerator: 'Control+Alt+D' }, 'linux');
  assert.equal(r.ok, true);
  assert.equal(r.config.accelerator, 'Control+Alt+E');
});

test('patch: a non-object patch changes nothing', () => {
  const cur = defaultDictateConfig('linux');
  assert.deepEqual(applyDictatePatch(cur, null, 'linux'), { ok: true, config: cur });
});
