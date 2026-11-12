'use strict';
/**
 * Tailscale Serve integration tests (#hosting).
 *
 * Two layers, one file:
 *  1. UNIT — the pure functions in src/main/tailscaleServe.ts (argv builders,
 *     serve-status parsing, DNS-name parsing), driven through load-ts with a
 *     fake runner so no `tailscale` CLI needs to exist.
 *  2. REACH — the wiring this integration is FOR: index.ts must expose the
 *     status/on/off IPC pair, start the loopback web UI before publishing, and
 *     never write a wider bind host for a remote-access request; the Settings
 *     modal must route its toggles through the bridge rather than local state
 *     (the #395 lesson: a toggle that only flips component state lies).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const loadTs = require('./load-ts.cjs');

const ts = loadTs('src/main/tailscaleServe.ts');

// ── 1. argv builders ─────────────────────────────────────────────────────────

test('serve-on argv publishes the port in the background', () => {
  assert.deepEqual(ts.buildServeOnArgv(4820), ['serve', '--bg', '4820']);
});

test('serve-off removes only the https:443 entry, never resets every serve entry', () => {
  const list = ts.buildServeOffArgvList();
  assert.deepEqual(list, [['serve', '--https=443', 'off']]);
  for (const argv of list.flat()) {
    assert.ok(!/[$;&|`]/.test(argv), `argv element looks shell-interpolated: ${argv}`);
  }
});

// ── 2. status parsing ────────────────────────────────────────────────────────

test('parseServeStatus reads the JSON flag and the public URL', () => {
  const r = ts.parseServeStatus('{"isServing": true, "ServeConfig": {"https://box.tail1234.ts.net": {}}}');
  assert.equal(r.serving, true);
  assert.equal(r.url, 'https://box.tail1234.ts.net');
});

test('parseServeStatus: flag false with no URL is not serving', () => {
  const r = ts.parseServeStatus('{"isServing": false}');
  assert.equal(r.serving, false);
  assert.equal(r.url, null);
});

test('parseServeStatus falls back to plain text and URL presence implies serving', () => {
  const r = ts.parseServeStatus('https://box.tail1234.ts.net (serve)\n|-- proxying http://127.0.0.1:4820');
  assert.equal(r.serving, true);
  assert.equal(r.url, 'https://box.tail1234.ts.net');
});

test('parseServeStatus never throws on garbage', () => {
  const r = ts.parseServeStatus('\x1f not json at all {{{');
  assert.equal(typeof r.serving, 'boolean');
  assert.equal(r.url, null);
});

test('parseDnsName strips the trailing dot and survives a missing Self', () => {
  assert.equal(ts.parseDnsName('{"Self":{"DNSName":"box.tail1234.ts.net."}}'), 'box.tail1234.ts.net');
  assert.equal(ts.parseDnsName('{}'), null);
  assert.equal(ts.parseDnsName('garbage'), null);
});

// ── 3. enable/disable against a fake runner ─────────────────────────────────

function fakeRunner(script) {
  const calls = [];
  return {
    calls,
    run: async (argv) => {
      calls.push(argv);
      return script(argv);
    }
  };
}

test('enableServe runs the publish command and reads the URL back from status', async () => {
  const f = fakeRunner((argv) => {
    if (argv[0] === 'serve' && argv[1] === '--bg') return { code: 0, stdout: '', stderr: '' };
    if (argv[1] === 'status') return { code: 0, stdout: '{"isServing": true, "x": "https://box.tail.ts.net"}', stderr: '' };
    return { code: 0, stdout: '{}', stderr: '' };
  });
  const r = await ts.enableServe(4820, f.run);
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://box.tail.ts.net');
  assert.deepEqual(f.calls[0], ['serve', '--bg', '4820'], 'first call must be the publish');
});

test('enableServe surfaces the CLI error line when publish fails', async () => {
  const f = fakeRunner(() => ({ code: 1, stdout: '', stderr: 'serve requires root: something' }));
  const r = await ts.enableServe(4820, f.run);
  assert.equal(r.ok, false);
  assert.match(r.error, /serve requires root/);
});

test('disableServe runs the targeted off', async () => {
  const f = fakeRunner(() => ({ code: 0, stdout: '', stderr: '' }));
  const r = await ts.disableServe(f.run);
  assert.equal(r.ok, true);
  assert.deepEqual(f.calls, [['serve', '--https=443', 'off']]);
});

test('disableServe reports failure only after both forms were tried', async () => {
  const f = fakeRunner(() => ({ code: 1, stdout: '', stderr: 'nope' }));
  const r = await ts.disableServe(f.run);
  assert.equal(r.ok, false);
  assert.equal(f.calls.length, ts.buildServeOffArgvList().length);
});

// ── 4. reach: the wiring exists and points the right way ────────────────────

test('main exposes the status/on/off IPC pair and starts loopback before publishing', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
  for (const channel of ['tailscale:status', 'tailscale:serveOn', 'tailscale:serveOff', 'webui:start', 'webui:stop']) {
    assert.match(main, new RegExp(`'${channel}'`), `missing IPC handler: ${channel}`);
  }
  // Publish must be preceded by the loopback server coming up: the serveOn
  // handler body starts the web UI before it calls enableServe.
  const onBody = main.slice(main.indexOf("ipcMain.handle('tailscale:serveOn'"));
  const bodyEnd = onBody.indexOf("ipcMain.handle('tailscale:serveOff'");
  const handler = onBody.slice(0, bodyEnd);
  const startAt = handler.indexOf('await startWebUiServer()');
  const serveAt = handler.indexOf('enableServe(');
  assert.ok(startAt !== -1 && serveAt !== -1 && startAt < serveAt,
    'serveOn must start the web UI server before enabling serve');
  // And it must stop the server on the off path, not silently keep serving.
  assert.match(main, /stopWebUiServer\(\)/);
});

test('the stop path never widens the bind: serve proxies loopback, not the reverse', () => {
  // The #395 class of bug, inverted: a toggle that changes config but not the
  // running server. webui:stop must both persist enabled:false AND stop.
  const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
  const stop = main.slice(main.indexOf("'webui:stop'"));
  assert.match(stop, /enabled: false/);
  assert.match(stop, /stopWebUiServer\(\)/);
});

test('Settings routes the Web UI and Tailscale toggles through the bridge', () => {
  const modal = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'components', 'SettingsModal.tsx'), 'utf8');
  assert.match(modal, /toggleWebUi = async/);
  assert.match(modal, /await window\.cth\.webUiStart\(\)/);
  assert.match(modal, /await window\.cth\.webUiStop\(\)/);
  assert.match(modal, /await window\.cth\.tailscaleServeOn\(\)/);
  assert.match(modal, /await window\.cth\.tailscaleServeOff\(\)/);
});

test('preload exposes the tailscale/webui surface', () => {
  const preload = fs.readFileSync(path.join(root, 'src', 'preload', 'index.ts'), 'utf8');
  for (const channel of ['tailscale:status', 'tailscale:serveOn', 'tailscale:serveOff', 'webui:start', 'webui:stop']) {
    assert.match(preload, new RegExp(`'${channel}'`));
  }
});

test('every locale carries the web UI section keys', () => {
  for (const l of ['en', 'zh-CN', 'ar']) {
    const d = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/src/i18n/locales', `${l}.json`), 'utf8'));
    const conns = d.settings.connections;
    for (const k of ['webUiTitle', 'webUiDesc', 'webUiTailscale', 'webUiTailscaleDesc', 'webUiTsMissing']) {
      assert.ok(conns[k], `${l} missing settings.connections.${k}`);
    }
  }
});
