'use strict';

/**
 * HIVE_ROOT/compact-requests/<id>.json lets god /compact another agent. The
 * poller must fail what it cannot do, hold a request while the agent is busy
 * (the renderer only types at an idle prompt, so "busy" = no PostCompact yet),
 * and only call it done once the agent's own PostCompact hook says so.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { CompactRequests } = loadTs('src/main/compactRequests.ts');

function setup({ agents = { alice: {} }, live = ['alice'], ctx = {}, timeoutMs } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-req-'));
  const clock = { t: 1_000_000 };
  const queued = [];
  const q = new CompactRequests(() => dir, {
    agent: (id) => agents[id],
    live: (id) => live.includes(id),
    queue: (id, keep) => queued.push({ id, keep }),
    liveAgents: () => live,
    ctxPct: (id) => ctx[id] ?? null,
    now: () => clock.t
  }, timeoutMs);
  const drop = (name, body) => fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  const read = (sub, name) => JSON.parse(fs.readFileSync(path.join(dir, sub, name), 'utf8'));
  const pending = () => fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  return { dir, clock, queued, q, drop, read, pending };
}

test('unknown agent → .failed with a reason, never queued', () => {
  const s = setup();
  s.drop('r1.json', { agent: 'nobody' });
  s.q.tick();
  assert.deepEqual(s.pending(), []);
  assert.match(s.read('.failed', 'r1.json').reason, /unknown agent "nobody"/);
  assert.equal(s.queued.length, 0);
});

test('archived agent and an agent without a live session fail', () => {
  const s = setup({ agents: { old: { archived: true }, ghost: {} }, live: [] });
  s.drop('a.json', { agent: 'old' });
  s.drop('b.json', { agent: 'ghost' });
  s.q.tick();
  assert.match(s.read('.failed', 'a.json').reason, /archived/);
  assert.match(s.read('.failed', 'b.json').reason, /no live session/);
});

test('a busy agent waits: re-queued each tick, file stays pending', () => {
  const s = setup();
  s.drop('r.json', { agent: 'alice', keep: 'keep the auth\ndecisions' });
  s.q.tick();
  s.clock.t += 60_000;
  s.q.tick();
  assert.deepEqual(s.pending(), ['r.json']);
  assert.equal(s.queued.length, 2);
  // Control characters never reach the prompt: a newline would submit early.
  assert.deepEqual(s.queued[0], { id: 'alice', keep: 'keep the auth decisions' });
});

test('idle → compacts → PostCompact moves it to .done', () => {
  const s = setup();
  s.drop('r.json', { agent: 'alice' });
  s.q.tick();
  s.clock.t += 5_000;
  s.q.noteCompacted('alice');
  s.q.tick();
  assert.deepEqual(s.pending(), []);
  assert.equal(s.read('.done', 'r.json').agent, 'alice');
  assert.equal(s.queued.length, 1);
});

test('a PostCompact from BEFORE the request does not complete it', () => {
  const s = setup();
  s.q.noteCompacted('alice');
  s.clock.t += 1;
  s.drop('r.json', { agent: 'alice' });
  s.q.tick();
  assert.deepEqual(s.pending(), ['r.json']);
});

test('still not compacted after the timeout → .failed timeout', () => {
  const s = setup({ timeoutMs: 10_000 });
  s.drop('r.json', { agent: 'alice' });
  s.q.tick();
  s.clock.t += 10_001;
  s.q.tick();
  assert.match(s.read('.failed', 'r.json').reason, /^timeout/);
});

test('a half-written file is retried, then failed once the grace passes', () => {
  const s = setup();
  s.drop('r.json', '{"agent": "al');
  s.q.tick();
  assert.deepEqual(s.pending(), ['r.json']);
  s.clock.t += 11_000;
  s.q.tick();
  assert.match(s.read('.failed', 'r.json').reason, /unparseable/);
});

test('auto threshold files one request per agent per window, only at or above pct', () => {
  const s = setup({ agents: { alice: {}, bob: {} }, live: ['alice', 'bob'], ctx: { alice: 80, bob: 74 } });
  const rule = { pct: 75, everyMs: 30 * 60_000 };
  s.q.tick(rule);
  s.q.tick(rule);
  assert.deepEqual(s.queued.map((x) => x.id), ['alice', 'alice']); // one file, re-asked
  assert.equal(s.pending().length, 1);
  assert.match(s.pending()[0], /^auto-alice-/);
  s.clock.t += 30 * 60_000;
  s.q.tick(rule);
  assert.equal(s.pending().length, 2);
});
