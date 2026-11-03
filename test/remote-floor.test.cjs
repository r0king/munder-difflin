'use strict';

// RemoteFloor (devices phase 2, item 8): the access gate, the POST origin
// check, the body cap, answer routing, SSE change events and stop(). Bound on
// 127.0.0.1 through an injected bindAddress, on an ephemeral port.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const loadTs = require('./load-ts.cjs');

const { RemoteFloor } = loadTs('src/main/remoteFloor.ts');

const OWNER = 'royal@example.com';
const STATE = {
  agents: [{ id: 'pam', name: 'Pam', role: 'worker', device: 'local', status: 'idle',
    contextPct: 12, costTodayUsd: 0.5, remoteControlUrl: null, deliveryPaused: false }],
  questions: [{ taskId: 't1', taskTitle: 'Ship it', qIndex: 2, q: 'Which branch?' }],
  mail: [],
  devices: [{ id: 'my-lap', name: 'my-lap', state: 'online' }]
};

function fakeSource() {
  const listeners = new Set();
  const calls = [];
  const act = (name) => async (...args) => { calls.push([name, ...args]); return { ok: true }; };
  return {
    calls,
    listeners,
    fire: () => listeners.forEach((l) => l()),
    state: () => STATE,
    onChange: (l) => { listeners.add(l); return () => listeners.delete(l); },
    answerQuestion: act('answerQuestion'),
    sendMail: act('sendMail'),
    stopAgent: act('stopAgent'),
    restartAgent: act('restartAgent'),
    setAutoDelivery: act('setAutoDelivery')
  };
}

async function startFloor(t, { whois = async () => ({ login: OWNER }), owner = OWNER } = {}) {
  const source = fakeSource();
  const floor = new RemoteFloor({
    source,
    port: 0,
    whois,
    ownerLogin: async () => owner,
    bindAddress: async () => '127.0.0.1'
  });
  await floor.start();
  t.after(() => floor.stop());
  const { port } = floor.address();
  return { floor, source, base: `http://127.0.0.1:${port}`, port };
}

function postJson(base, path, body, headers = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

test('whois login matching the owner gets the page and the state', async (t) => {
  const { base } = await startFloor(t);
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Needs you/);
  const state = await fetch(base + '/api/state');
  assert.equal(state.status, 200);
  assert.deepEqual(await state.json(), STATE);
});

test('mismatch, whois failure and no whois answer are all 403', async (t) => {
  for (const opts of [
    { whois: async () => ({ login: 'someone@else.com' }) },
    { whois: async () => { throw new Error('tailscale down'); } },
    { whois: async () => null },
    { owner: null }
  ]) {
    const { base } = await startFloor(t, opts);
    assert.equal((await fetch(base + '/api/state')).status, 403);
    assert.equal((await postJson(base, '/api/mail', { agentId: 'pam', text: 'hi' })).status, 403);
  }
});

test('whois is cached per IP', async (t) => {
  let n = 0;
  const { base } = await startFloor(t, { whois: async () => { n++; return { login: OWNER }; } });
  await fetch(base + '/api/state');
  await fetch(base + '/api/state');
  assert.equal(n, 1);
});

test('a foreign Host header (DNS rebinding) is 403', async (t) => {
  const { port } = await startFloor(t);
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { host: `evil.example.com:${port}` } },
      (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('a POST without a same-origin Origin or Referer is 403', async (t) => {
  const { base, source } = await startFloor(t);
  const noOrigin = await fetch(base + '/api/mail', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'pam', text: 'hi' })
  });
  assert.equal(noOrigin.status, 403);
  assert.equal((await postJson(base, '/api/mail', { agentId: 'pam', text: 'hi' }, { origin: 'http://evil.example.com' })).status, 403);
  assert.equal((await postJson(base, '/api/mail', { agentId: 'pam', text: 'hi' }, { origin: 'http://127.0.0.1:1' })).status, 403);
  assert.equal(source.calls.length, 0);
  // A same-origin Referer is enough on its own.
  const viaReferer = await fetch(base + '/api/mail', {
    method: 'POST', headers: { 'content-type': 'application/json', referer: base + '/' },
    body: JSON.stringify({ agentId: 'pam', text: 'hi' })
  });
  assert.equal(viaReferer.status, 200);
  assert.deepEqual(source.calls, [['sendMail', 'pam', 'hi']]);
});

test('a body over 64 KB is 413 and never reaches the source', async (t) => {
  const { base, source } = await startFloor(t);
  const res = await postJson(base, '/api/mail', { agentId: 'pam', text: 'x'.repeat(70 * 1024) });
  assert.equal(res.status, 413);
  assert.equal(source.calls.length, 0);
});

test('answering calls source.answerQuestion with the parsed fields', async (t) => {
  const { base, source } = await startFloor(t);
  const res = await postJson(base, '/api/answer', { taskId: 't1', qIndex: 2, text: '  main, please \n' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(source.calls, [['answerQuestion', 't1', 2, 'main, please']]);
  // Bad fields are a 400, not a call.
  assert.equal((await postJson(base, '/api/answer', { taskId: 't1', qIndex: '2', text: 'x' })).status, 400);
  assert.equal((await postJson(base, '/api/answer', { taskId: 't1', qIndex: 1, text: '  ' })).status, 400);
  assert.equal(source.calls.length, 1);
});

test('agent actions route to the source', async (t) => {
  const { base, source } = await startFloor(t);
  assert.equal((await postJson(base, '/api/agents/pam/stop', {})).status, 200);
  assert.equal((await postJson(base, '/api/agents/pam/restart', {})).status, 200);
  assert.equal((await postJson(base, '/api/agents/pam/delivery', { paused: true })).status, 200);
  assert.equal((await postJson(base, '/api/agents/pam/delivery', {})).status, 400);
  assert.deepEqual(source.calls, [['stopAgent', 'pam'], ['restartAgent', 'pam'], ['setAutoDelivery', 'pam', true]]);
});

/** Open /events and collect what arrives; resolves once the headers are in. */
function openEvents(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      let buf = '';
      const ended = new Promise((r) => res.on('end', r));
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      resolve({ res, req, ended, text: () => buf });
    });
    req.on('error', reject);
  });
}

async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('SSE delivers a change event with the state', async (t) => {
  const { port, source } = await startFloor(t);
  const sse = await openEvents(port);
  t.after(() => sse.req.destroy());
  assert.equal(sse.res.statusCode, 200);
  assert.match(sse.res.headers['content-type'], /text\/event-stream/);
  await until(() => sse.text().includes('retry:'));
  source.fire();
  await until(() => sse.text().includes('event: change'));
  const data = /event: change\ndata: (.*)\n\n/.exec(sse.text())[1];
  assert.deepEqual(JSON.parse(data), STATE);
});

test('stop() closes open SSE streams and the server', async (t) => {
  const { floor, port, base, source } = await startFloor(t);
  const sse = await openEvents(port);
  await until(() => sse.text().includes('retry:'));
  await floor.stop();
  await sse.ended;
  assert.equal(source.listeners.size, 0);
  await assert.rejects(fetch(base + '/api/state'));
});

test('no Tailscale address means no server until one appears', async (t) => {
  const floor = new RemoteFloor({ source: fakeSource(), port: 0, bindAddress: async () => null });
  t.after(() => floor.stop());
  await floor.start();
  assert.equal(floor.address(), null);
});
