'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  linuxSession, chooseInsertStrategy, pasteCommand, classifyPasteFailure, shouldRestoreClipboard,
  MAC_PASTE_SCRIPT, WIN_PASTE_SCRIPT
} = loadTs('src/main/features/dictate/strategy.ts');

const tools = (o = {}) => ({ xdotool: false, wtype: false, powershell: false, ...o });
const base = (o = {}) => ({ platform: 'linux', env: {}, tools: tools(), accessibilityTrusted: false, pasteMode: 'paste', ...o });

test('linux session: XDG_SESSION_TYPE wins, then WAYLAND_DISPLAY, then DISPLAY', () => {
  assert.equal(linuxSession({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' }), 'wayland');
  assert.equal(linuxSession({ XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0' }), 'x11');
  assert.equal(linuxSession({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }), 'wayland');
  assert.equal(linuxSession({ DISPLAY: ':1' }), 'x11');
  assert.equal(linuxSession({ XDG_SESSION_TYPE: 'tty' }), 'unknown');
});

test('macOS: System Events when trusted, else clipboard + Accessibility explanation', () => {
  assert.deepEqual(chooseInsertStrategy(base({ platform: 'darwin', accessibilityTrusted: true })), { strategy: 'osascript' });
  assert.deepEqual(chooseInsertStrategy(base({ platform: 'darwin' })), { strategy: 'clipboard', notice: 'accessibility' });
});

test('Windows: SendKeys through PowerShell, clipboard without it', () => {
  assert.deepEqual(chooseInsertStrategy(base({ platform: 'win32', tools: tools({ powershell: true }) })), { strategy: 'sendkeys' });
  assert.deepEqual(chooseInsertStrategy(base({ platform: 'win32' })), { strategy: 'clipboard', notice: 'no-powershell' });
});

test('Linux X11: xdotool when installed', () => {
  const env = { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' };
  assert.deepEqual(chooseInsertStrategy(base({ env, tools: tools({ xdotool: true }) })), { strategy: 'xdotool' });
  assert.deepEqual(chooseInsertStrategy(base({ env })), { strategy: 'clipboard', notice: 'no-xdotool' });
});

test('Linux Wayland: wtype when installed, otherwise Wayland says why it cannot (even with xdotool)', () => {
  const env = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' };
  assert.deepEqual(chooseInsertStrategy(base({ env, tools: tools({ wtype: true }) })), { strategy: 'wtype' });
  assert.deepEqual(chooseInsertStrategy(base({ env, tools: tools({ xdotool: true }) })), { strategy: 'clipboard', notice: 'wayland' });
  assert.deepEqual(chooseInsertStrategy(base({ env: {} })), { strategy: 'clipboard', notice: 'no-display' });
});

test('"clipboard only" overrides every platform', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const r = chooseInsertStrategy(base({ platform, pasteMode: 'clipboard', accessibilityTrusted: true, tools: tools({ powershell: true, xdotool: true }) }));
    assert.deepEqual(r, { strategy: 'clipboard', notice: 'user-choice' });
  }
  assert.equal(chooseInsertStrategy(base({ platform: 'other' })).notice, 'unsupported-platform');
});

test('paste commands are argv arrays with constant scripts — never the dictated text', () => {
  const paths = { osascript: '/usr/bin/osascript', powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', xdotool: '/usr/bin/xdotool', wtype: '/usr/bin/wtype' };
  assert.deepEqual(pasteCommand('osascript', paths), { file: '/usr/bin/osascript', args: ['-e', MAC_PASTE_SCRIPT] });
  assert.deepEqual(pasteCommand('xdotool', paths).args, ['key', '--clearmodifiers', 'ctrl+v']);
  assert.equal(pasteCommand('sendkeys', paths).args.at(-1), WIN_PASTE_SCRIPT);
  assert.deepEqual(pasteCommand('wtype', paths).args, ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl']);
  assert.equal(pasteCommand('xdotool', { ...paths, xdotool: null }), null);
  assert.equal(pasteCommand('clipboard', paths), null);
  assert.equal(pasteCommand('in-app', paths), null);
});

test('osascript failures map to the grant that is missing', () => {
  assert.equal(classifyPasteFailure('osascript', '0:63: execution error: Not authorized to send Apple events to System Events. (-1743)'), 'automation');
  assert.equal(classifyPasteFailure('osascript', 'execution error: System Events got an error: osascript is not allowed to send keystrokes. (1002)'), 'accessibility');
  assert.equal(classifyPasteFailure('osascript', 'something else'), 'paste-failed');
  assert.equal(classifyPasteFailure('wtype', 'Compositor does not support the virtual keyboard protocol'), 'wtype-failed');
  assert.equal(classifyPasteFailure('xdotool', 'Error'), 'paste-failed');
});

test('the old clipboard comes back only if nobody copied in between', () => {
  assert.equal(shouldRestoreClipboard('dictated words', 'dictated words'), true);
  assert.equal(shouldRestoreClipboard('something the user copied', 'dictated words'), false);
});
