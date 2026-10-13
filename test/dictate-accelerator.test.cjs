'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  defaultAccelerator,
  normalizeAccelerator,
  parseAccelerator,
  validateAccelerator,
  formatAccelerator,
  acceleratorFromKeyEvent,
  defaultDictateConfig,
  toDictatePlatform
} = loadTs('src/shared/features/dictate.ts');

test('defaults: Option+Space on the Mac, Control+Alt+Space on Windows and Linux', () => {
  assert.equal(defaultAccelerator('darwin'), 'Alt+Space');
  assert.equal(defaultAccelerator('win32'), 'Control+Alt+Space');
  assert.equal(defaultAccelerator('linux'), 'Control+Alt+Space');
  assert.equal(defaultDictateConfig('linux').enabled, false, 'off until the user turns it on');
});

test('every platform default passes its own validation', () => {
  for (const p of ['darwin', 'win32', 'linux', 'other']) {
    const c = defaultDictateConfig(p);
    assert.equal(validateAccelerator(c.accelerator, p, 'toggle', c.cancelAccelerator).ok, true, p);
    assert.equal(validateAccelerator(c.cancelAccelerator, p, 'cancel', c.accelerator).ok, true, p);
  }
});

test('aliases and order normalise to one canonical spelling', () => {
  assert.equal(normalizeAccelerator('ctrl+alt+space', 'linux'), 'Control+Alt+Space');
  assert.equal(normalizeAccelerator('Space+Alt+Ctrl', 'linux'), 'Control+Alt+Space');
  assert.equal(normalizeAccelerator('Option+Space', 'darwin'), 'Alt+Space');
  assert.equal(normalizeAccelerator('CmdOrCtrl+Shift+D', 'darwin'), 'Shift+Command+D');
  assert.equal(normalizeAccelerator('CmdOrCtrl+Shift+D', 'win32'), 'Control+Shift+D');
  assert.equal(normalizeAccelerator('Super+F5', 'linux'), 'Super+F5');
  assert.equal(normalizeAccelerator('esc', 'linux'), 'Escape');
  assert.equal(normalizeAccelerator('Ctrl+Enter', 'linux'), 'Control+Return');
});

test('syntax errors: unknown tokens, two keys, empty parts, modifiers only', () => {
  assert.equal(parseAccelerator('Ctrl+Hyper+A', 'linux'), null);
  assert.equal(parseAccelerator('A+B', 'linux'), null);
  assert.equal(parseAccelerator('Ctrl++', 'linux'), null);
  assert.deepEqual(validateAccelerator('', 'linux', 'toggle'), { ok: false, error: 'empty' });
  assert.deepEqual(validateAccelerator('Ctrl+Hyper', 'linux', 'toggle'), { ok: false, error: 'syntax' });
  assert.deepEqual(validateAccelerator('Ctrl+Alt', 'linux', 'toggle'), { ok: false, error: 'no-key' });
});

test('a shortcut that would steal typing is refused', () => {
  assert.equal(validateAccelerator('Space', 'linux', 'toggle').error, 'needs-modifier');
  assert.equal(validateAccelerator('Shift+A', 'darwin', 'toggle').error, 'needs-modifier');
  assert.equal(validateAccelerator('Escape', 'linux', 'toggle').error, 'needs-modifier');
  // Function keys type nothing, so they may stand alone.
  assert.equal(validateAccelerator('F13', 'linux', 'toggle').ok, true);
});

test('the cancel key may be a bare Escape (it is only registered during a dictation)', () => {
  assert.deepEqual(validateAccelerator('Esc', 'darwin', 'cancel'), { ok: true, accelerator: 'Escape' });
  assert.equal(validateAccelerator('Q', 'darwin', 'cancel').error, 'needs-modifier');
});

test('OS and editing chords are reserved', () => {
  assert.equal(validateAccelerator('Cmd+Space', 'darwin', 'toggle').error, 'reserved');
  assert.equal(validateAccelerator('Cmd+V', 'darwin', 'toggle').error, 'reserved');
  assert.equal(validateAccelerator('Ctrl+V', 'win32', 'toggle').error, 'reserved');
  assert.equal(validateAccelerator('Alt+Tab', 'linux', 'toggle').error, 'reserved');
  assert.equal(validateAccelerator('Ctrl+Alt+Delete', 'win32', 'toggle').error, 'reserved');
  // Ctrl+V is ordinary on the Mac (Command is the paste key there).
  assert.equal(validateAccelerator('Ctrl+V', 'darwin', 'toggle').ok, true);
});

test("the Stapler's meeting shortcut and the other dictation key are conflicts", () => {
  assert.equal(validateAccelerator('Shift+Cmd+Space', 'darwin', 'toggle').error, 'conflict');
  assert.equal(validateAccelerator('Ctrl+Shift+Space', 'linux', 'toggle').error, 'conflict');
  assert.equal(validateAccelerator('Ctrl+Alt+D', 'linux', 'cancel', 'Control+Alt+D').error, 'conflict');
});

test('display: symbols on the Mac, names elsewhere', () => {
  assert.equal(formatAccelerator('Alt+Space', 'darwin'), '⌥Space');
  assert.equal(formatAccelerator('Control+Alt+Shift+Command+K', 'darwin'), '⌃⌥⇧⌘K');
  assert.equal(formatAccelerator('Control+Alt+Space', 'win32'), 'Ctrl+Alt+Space');
  assert.equal(formatAccelerator('Escape', 'darwin'), 'Esc');
  assert.equal(formatAccelerator('not a chord++', 'linux'), 'not a chord++');
});

test('a keydown becomes an accelerator by physical key, not by the character typed', () => {
  // ⌥Space on a Mac produces key " " (nbsp); code is what counts.
  const ev = { key: ' ', code: 'Space', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false };
  assert.equal(acceleratorFromKeyEvent(ev, 'darwin'), 'Alt+Space');
  const win = { key: 'd', code: 'KeyD', ctrlKey: true, altKey: true, shiftKey: false, metaKey: true };
  assert.equal(acceleratorFromKeyEvent(win, 'win32'), 'Control+Alt+Super+D');
  // Only a modifier is down: keep waiting.
  const mod = { key: 'Control', code: 'ControlLeft', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false };
  assert.equal(acceleratorFromKeyEvent(mod, 'linux'), null);
});

test('platform normalisation', () => {
  assert.equal(toDictatePlatform('darwin'), 'darwin');
  assert.equal(toDictatePlatform('freebsd'), 'other');
  assert.equal(toDictatePlatform(undefined), 'other');
});
