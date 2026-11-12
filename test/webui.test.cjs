'use strict';

// Web UI bridge (src/main/webui.ts): IPC capture, wire serialization, runtime
// config resolution, and request routing (auth, invoke, sendSync, SSE mirror,
// static safety) — all through mock req/res, no sockets and no Electron.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  installIpcCapture, resetIpcCaptureForTests,
  encodeWire, decodeWire,
  resolveWebUiRuntimeConfig, WebUiServer, WEB_UI_DEFAULT_PORT
} = loadTs('src/main/webui.ts');

/** A minimal ipcMain stand-in with the real registration surface. */
function fakeIpcMain() {
  const handled = new Map();
  const on = new Map();
  return {
    handled,
    onMap: on,
    handle(channel, fn) { handled.set(channel, fn); },
    removeHandler(channel) { handled.delete(channel); },
    on(channel, fn) { on.set(channel, fn); return this; }
  };
}

function mockReq({ url = '/', method = 'GET', headers = {} } = {}) {
  const req = new EventEmitter();
  req.url = url;
  req.method = method;
  req.headers = headers;
  req.destroy = () => {};
  return req;
}

function mockRes() {
  return {
    statusCode: null,
    headers: null,
    chunks: [],
    ended: false,
    writableEnded: false,
    destroyed: false,
    writableLength: 0,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? {}; },
    write(chunk) { this.chunks.push(String(chunk)); return true; },
    end(chunk) { if (chunk != null) this.chunks.push(String(chunk)); this.ended = true; this.writableEnded = true; },
    destroy() { this.destroyed = true; },
    get body() { return this.chunks.join(''); },
    get json() { return JSON.parse(this.body); }
  };
}

function makeServer(overrides = {}) {
  return new WebUiServer({
    host: '0.0.0.0',
    port: WEB_UI_DEFAULT_PORT,
    token: 'sekrit',
    rendererDir: path.join(os.tmpdir(), 'webui-no-renderer'),
    preloadFile: path.join(os.tmpdir(), 'webui-no-preload.js'),
    clientDir: path.join(os.tmpdir(), 'webui-no-client'),
    getSender: () => ({ mock: 'sender' }),
    version: '0.0.0-test',
    ...overrides
  });
}

/** Drive route() with a POST body and wait for the JSON response. */
async function post(server, url, payload, headers = {}) {
  const req = mockReq({ url, method: 'POST', headers: { cookie: 'md_webui=sekrit', 'x-md-webui': '1', ...headers } });
  const res = mockRes();
  server.route(req, res);
  req.emit('data', Buffer.from(JSON.stringify(payload)));
  req.emit('end');
  for (let i = 0; i < 50 && !res.ended; i++) await new Promise((r) => setImmediate(r));
  assert.ok(res.ended, 'response ended');
  return res;
}

test('installIpcCapture records handle/on registrations and honors removeHandler', async () => {
  resetIpcCaptureForTests();
  const ipc = fakeIpcMain();
  installIpcCapture(ipc);
  ipc.handle('math:add', (_evt, a, b) => a + b);
  ipc.on('sync:ping', (evt) => { evt.returnValue = 'pong'; });

  const server = makeServer();
  let res = await post(server, '/__webui/invoke', { channel: 'math:add', args: [2, 3] });
  assert.deepEqual(res.json, { ok: true, value: 5 });

  res = await post(server, '/__webui/sendSync', { channel: 'sync:ping', args: [] });
  assert.deepEqual(res.json, { ok: true, value: 'pong' });

  ipc.removeHandler('math:add');
  res = await post(server, '/__webui/invoke', { channel: 'math:add', args: [] });
  assert.equal(res.statusCode, 404);

  // The original registration still reached the real ipcMain both times.
  assert.ok(ipc.onMap.has('sync:ping'));
});

test('bridged invoke passes getSender() as event.sender and surfaces handler throws', async () => {
  resetIpcCaptureForTests();
  const ipc = fakeIpcMain();
  installIpcCapture(ipc);
  let seenSender = null;
  ipc.handle('who:sent', (evt) => { seenSender = evt.sender; return 'ok'; });
  ipc.handle('boom', () => { throw new Error('kapow'); });

  const server = makeServer();
  await post(server, '/__webui/invoke', { channel: 'who:sent', args: [] });
  assert.deepEqual(seenSender, { mock: 'sender' });

  const res = await post(server, '/__webui/invoke', { channel: 'boom', args: [] });
  assert.deepEqual(res.json, { ok: false, error: 'kapow' });
});

test('dialog channels are blocked with a cancel-shaped result, never invoked', async () => {
  resetIpcCaptureForTests();
  const ipc = fakeIpcMain();
  installIpcCapture(ipc);
  let called = false;
  ipc.handle('dialog:chooseFolder', () => { called = true; return { ok: true, path: '/x' }; });

  const server = makeServer();
  const res = await post(server, '/__webui/invoke', { channel: 'dialog:chooseFolder', args: [] });
  assert.equal(called, false);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.value.ok, false);
  assert.match(res.json.value.error, /web UI/);
});

test('encodeWire/decodeWire round-trip plain data and binary payloads', () => {
  const bytes = new Uint8Array([0, 1, 254, 255]);
  const input = { ok: true, nested: { list: [1, 'two', null], bytes }, mime: 'image/png' };
  const wire = JSON.parse(JSON.stringify(encodeWire(input)));
  const out = decodeWire(wire);
  assert.equal(out.ok, true);
  assert.deepEqual(out.nested.list, [1, 'two', null]);
  assert.ok(out.nested.bytes instanceof Uint8Array);
  assert.deepEqual(Array.from(out.nested.bytes), [0, 1, 254, 255]);
  // Cycles fail loudly instead of hanging the serializer.
  const cyc = {}; cyc.self = cyc;
  assert.throws(() => encodeWire(cyc), /cyclic/);
});

test('resolveWebUiRuntimeConfig: defaults, config, and env overrides', () => {
  // The default bind is LOOPBACK: enabling the server must never expose the
  // harness to the network as a side effect. LAN reach is an explicit opt-in.
  const off = resolveWebUiRuntimeConfig(undefined, {});
  assert.deepEqual(off, { enabled: false, host: '127.0.0.1', port: WEB_UI_DEFAULT_PORT, token: null, loopback: true });

  const cfg = resolveWebUiRuntimeConfig(
    { enabled: true, port: 5001, host: '127.0.0.1', token: 'abc' }, {});
  assert.deepEqual(cfg, { enabled: true, host: '127.0.0.1', port: 5001, token: 'abc', loopback: true });

  const env = resolveWebUiRuntimeConfig(
    { enabled: false, port: 5001 },
    { MD_WEBUI: '1', MD_WEBUI_PORT: '5002', MD_WEBUI_HOST: '0.0.0.0', MD_WEBUI_TOKEN: 't0k' });
  assert.deepEqual(env, { enabled: true, host: '0.0.0.0', port: 5002, token: 't0k', loopback: false });

  // MD_WEBUI=0 force-disables even when the config says on.
  assert.equal(resolveWebUiRuntimeConfig({ enabled: true }, { MD_WEBUI: '0' }).enabled, false);
  // Garbage port falls back to the default.
  assert.equal(resolveWebUiRuntimeConfig({ enabled: true }, { MD_WEBUI_PORT: 'nope' }).port, WEB_UI_DEFAULT_PORT);
});

test('start() refuses a non-loopback bind without a token', async () => {
  const server = makeServer({ token: null, host: '0.0.0.0' });
  const res = await server.start();
  assert.equal(res.ok, false);
  assert.match(res.error, /token/);
});

test('loopback is no exception: no token, no start, and no request gets through', async () => {
  // A web page in this machine's browser can POST to 127.0.0.1, and Tailscale
  // Serve hands every tailnet request to this port from 127.0.0.1.
  const server = makeServer({ token: null, host: '127.0.0.1' });
  assert.equal((await server.start()).ok, false);
  const res = mockRes();
  server.route(mockReq({ url: '/' }), res);
  assert.equal(res.statusCode, 401);
});

test('a call without the X-MD-WebUI header never reaches a handler, cookie or not', async () => {
  resetIpcCaptureForTests();
  const ipc = fakeIpcMain();
  installIpcCapture(ipc);
  let called = 0;
  ipc.handle('pty:spawn', () => { called++; return { ok: true }; });
  ipc.on('sync:ping', (e) => { called++; e.returnValue = 'pong'; });
  const server = makeServer();
  for (const url of ['/__webui/invoke', '/__webui/sendSync']) {
    const res = await post(server, url, { channel: url.endsWith('invoke') ? 'pty:spawn' : 'sync:ping', args: [] }, { 'x-md-webui': undefined });
    assert.equal(res.statusCode, 403, url);
  }
  assert.equal(called, 0, 'a cross-site form post must not run anything');
  resetIpcCaptureForTests();
});

test('auth: 401 without token, ?token= exchanges for a cookie via 302', () => {
  const server = makeServer();
  let res = mockRes();
  server.route(mockReq({ url: '/' }), res);
  assert.equal(res.statusCode, 401);

  res = mockRes();
  server.route(mockReq({ url: '/?token=sekrit' }), res);
  assert.equal(res.statusCode, 302);
  assert.match(res.headers['Set-Cookie'], /^md_webui=sekrit; HttpOnly/);

  // Wrong token stays locked out.
  res = mockRes();
  server.route(mockReq({ url: '/?token=wrong' }), res);
  assert.equal(res.statusCode, 401);

  // Health stays reachable for probes.
  res = mockRes();
  server.route(mockReq({ url: '/__webui/health' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
});

test('static serving refuses path traversal out of the renderer root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-static-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<head></head><body>app</body>');
  const server = makeServer({ rendererDir: dir });

  const res = mockRes();
  server.route(mockReq({ url: '/..%2f..%2fetc%2fpasswd', headers: { cookie: 'md_webui=sekrit' } }), res);
  assert.ok(res.statusCode === 403 || res.statusCode === 404);

  // index.html is served with the three bridge scripts injected before the bundle.
  const idx = mockRes();
  server.route(mockReq({ url: '/', headers: { cookie: 'md_webui=sekrit' } }), idx);
  assert.equal(idx.statusCode, 200);
  assert.match(idx.body, /__webui\/boot\.js.*__webui\/preload\.js.*__webui\/cleanup\.js/s);
  // Browsers have no `process`; the injected head scripts must carry the HOST's
  // platform/arch (the machine the agents run on) for boot.js to build the shim.
  assert.match(idx.body, /window\.__mdHostProcess=/, 'host process data missing');
  assert.match(idx.body, /"platform":"[a-z]+"/);
});

test('SSE: connected clients receive mirrored webContents sends', () => {
  const server = makeServer();
  const req = mockReq({ url: '/__webui/events', headers: { cookie: 'md_webui=sekrit' } });
  const res = mockRes();
  server.route(req, res);
  assert.equal(server.clientCount, 1);

  server.broadcastEvent('pty:data:abc', ['hello \n world']);
  const frame = res.chunks.find((c) => c.startsWith('data: '));
  assert.ok(frame, 'got an SSE data frame');
  const evt = JSON.parse(frame.slice('data: '.length));
  assert.equal(evt.channel, 'pty:data:abc');
  assert.deepEqual(evt.args, ['hello \n world']);

  // A closed client is dropped from the fan-out set.
  req.emit('close');
  assert.equal(server.clientCount, 0);
});

// ── boot.js actually runs: execute it in a browser-ish sandbox ──────────────

test('boot.js builds the process shim and a working electron stand-in', () => {
  const vm = require('node:vm');
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'webui-client', 'boot.js'), 'utf8');
  const sandbox = {
    window: {},
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36' },
    EventSource: class { onmessage = null; close() {} },
    fetch: async () => ({ json: async () => ({ ok: true, value: null }) }),
    XMLHttpRequest: class { open() {} setRequestHeader() {} send() { this.status = 200; this.responseText = '{"ok":true,"value":null}'; } },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    setTimeout, clearTimeout, console,
    Promise, JSON, Math, Date, Object, Array, String, Number, BigInt, Error, Uint8Array, ArrayBuffer
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const w = sandbox.window;

  // The shim exists, is built from the injected host data (server is linux/x64
  // in production), and covers the members the preload + vendored libs touch.
  assert.equal(w.process.platform, 'darwin'); // UA fallback — no host data injected here
  assert.equal(typeof w.process.arch, 'string');
  // Realm-safe: objects created inside the vm have a different Array/Object
  // prototype, so compare structurally by length/keys, never deepStrictEqual.
  assert.equal(w.process.listeners('x').length, 0);
  assert.equal(w.process.listenerCount('x'), 0);
  assert.equal(typeof w.process.nextTick, 'function');
  assert.equal(Object.keys(w.process.env).length, 0);
  // With host data injected (what webui.ts serves), the HOST's platform wins
  // over the viewing device's UA.
  const sandbox2 = { ...sandbox, window: {}, __mdHostProcess: undefined };
  vm.createContext(sandbox2);
  sandbox2.window.__mdHostProcess = { platform: 'linux', arch: 'x64', version: 'v22.6.0' };
  vm.runInContext(code, sandbox2);
  assert.equal(sandbox2.window.process.platform, 'linux');
  assert.equal(sandbox2.window.process.arch, 'x64');
  assert.equal(sandbox2.window.process.version, 'v22.6.0');

  // The electron stand-in still works end to end: exposeInMainWorld → window.cth.
  const exposed = {};
  w.require('electron').contextBridge.exposeInMainWorld('cth', exposed);
  assert.equal(w.cth, exposed);
});
