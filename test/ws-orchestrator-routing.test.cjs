'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  parseRoutingLine,
  parseRoutingLog,
  filterRouting,
  routingInvolves,
  routingParticipants,
  resolveRoutingId,
  MAX_ROUTING_SUBJECT
} = loadTs('src/shared/workspace/orchestratorRouting.ts');

/** Lines in the exact shapes HiveManager.appendLog writes. */
const msg = (ts, from, to, subject, delivered, extra = {}) =>
  JSON.stringify({ ts, kind: 'message', from, to, act: 'request', subject, id: `m${ts}`, delivered, ...extra });
const handoff = (ts, from, to, delivered) =>
  JSON.stringify({ ts, kind: 'terminal-handoff', from, to, act: 'inform', subject: 'work order', id: `h${ts}`, delivered });
const drop = (ts, from, to, reason) => JSON.stringify({ ts, kind: 'drop', reason, from, to, id: `d${ts}` });
const archived = (ts, from, to) => JSON.stringify({ ts, kind: 'archived-recipient', from, to, id: `a${ts}`, act: 'request' });
const lifecycle = (ts) => JSON.stringify({ ts, kind: 'spawn', agentId: 'dwight', name: 'Dwight' });

const LOG = [
  lifecycle(1),
  msg(10, 'god', 'dwight', 'Fix the flaky login test', ['dwight']),
  msg(20, 'dwight', 'god', 'Login test fixed', ['god']),
  msg(30, 'human', 'god', 'Ship the release notes', ['god']),
  msg(40, 'angela', 'human', 'Which logo is current?', ['god']),
  msg(50, 'god', 'broadcast', 'Standup in five', ['dwight', 'angela', 'jim']),
  handoff(60, 'god', 'pam', true),
  handoff(70, 'god', 'kimi', false),
  drop(80, 'god', 'ghost', 'no-inbox'),
  archived(90, 'god', 'toby'),
  msg(100, 'heartbeat', 'god', 'Heartbeat', ['god']),
  '{"ts": 110, "kind": "message", "from": "god"', // torn tail
  ''
].join('\n');

test('parseRoutingLine maps each routing kind and skips lifecycle lines', () => {
  assert.equal(parseRoutingLine(lifecycle(1)), null);
  const m = parseRoutingLine(msg(10, 'god', 'dwight', 'Fix it', ['dwight']));
  assert.equal(m.kind, 'message');
  assert.equal(m.id, 'm10');
  assert.deepEqual(m.delivered, ['dwight']);
  assert.equal(m.reason, null);
  assert.deepEqual(parseRoutingLine(handoff(60, 'god', 'pam', true)).delivered, ['pam']);
  assert.deepEqual(parseRoutingLine(handoff(70, 'god', 'kimi', false)).delivered, []);
  const d = parseRoutingLine(drop(80, 'god', 'ghost', 'no-inbox'));
  assert.equal(d.kind, 'drop');
  assert.equal(d.reason, 'no-inbox');
  assert.equal(parseRoutingLine(archived(90, 'god', 'toby')).kind, 'archived');
});

test('parseRoutingLine never throws on junk', () => {
  for (const junk of ['', 'not json', '{', '[]', 'null', '{"kind":"message"}', '{"ts":5,"kind":"message"}',
    JSON.stringify({ ts: 'x', kind: 'message', from: 'a' })]) {
    assert.equal(parseRoutingLine(junk), null, junk);
  }
  // A malformed `delivered` array keeps only strings.
  const e = parseRoutingLine(JSON.stringify({ ts: 5, kind: 'message', from: 'a', to: 'b', delivered: ['b', 3, null, ''] }));
  assert.deepEqual(e.delivered, ['b']);
});

test('long subjects are clipped', () => {
  const e = parseRoutingLine(msg(5, 'a', 'b', 'x'.repeat(MAX_ROUTING_SUBJECT * 2), ['b']));
  assert.equal(e.subject.length, MAX_ROUTING_SUBJECT);
  assert.ok(e.subject.endsWith('…'));
});

test('parseRoutingLog keeps file order, drops a cut first line and honours the limit', () => {
  const all = parseRoutingLog(LOG);
  assert.equal(all.length, 10);
  assert.deepEqual(all.map((e) => e.ts), [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  // Cut mid-file: the first line is partial.
  const cut = parseRoutingLog(`me": "x"}\n${msg(5, 'a', 'b', 's', ['b'])}`, { skipFirstLine: true });
  assert.equal(cut.length, 1);
  const newest = parseRoutingLog(LOG, { limit: 3 });
  assert.deepEqual(newest.map((e) => e.ts), [80, 90, 100]);
  // Keys are unique.
  assert.equal(new Set(all.map((e) => e.key)).size, all.length);
});

test('routingInvolves resolves the god/human aliases to the orchestrator', () => {
  const [toDwight, fromDwight, fromHuman, toHuman, broadcast] = parseRoutingLog(LOG);
  assert.equal(resolveRoutingId('god', 'michael'), 'michael');
  assert.equal(resolveRoutingId('human', 'michael'), 'michael');
  assert.equal(resolveRoutingId('dwight', 'michael'), 'dwight');
  assert.equal(routingInvolves(toDwight, 'dwight', 'michael'), true);
  assert.equal(routingInvolves(fromDwight, 'michael', 'michael'), true); // to: 'god'
  assert.equal(routingInvolves(toHuman, 'michael', 'michael'), true);    // to: 'human' routes to god
  assert.equal(routingInvolves(fromHuman, 'human', 'michael'), true);
  assert.equal(routingInvolves(toDwight, 'human', 'michael'), false);
  assert.equal(routingInvolves(broadcast, 'jim', 'michael'), true);      // reached via delivered
  assert.equal(routingInvolves(broadcast, 'pam', 'michael'), false);
});

test('filterRouting by agent, by kind and by free text (all terms must match)', () => {
  const all = parseRoutingLog(LOG);
  const names = { michael: 'Michael', dwight: 'Dwight Schrute', angela: 'Angela' };

  const dwight = filterRouting(all, { agentId: 'dwight', godId: 'michael' });
  assert.deepEqual(dwight.map((e) => e.ts), [10, 20, 50]);

  const system = filterRouting(all, { agentId: 'system', godId: 'michael' });
  assert.deepEqual(system.map((e) => e.ts), [100]);

  const problems = filterRouting(all, { kinds: ['drop', 'archived'] });
  assert.deepEqual(problems.map((e) => e.ts), [80, 90]);

  // Display names are searchable, case-insensitively.
  assert.deepEqual(filterRouting(all, { query: 'schrute', names, godId: 'michael' }).map((e) => e.ts), [10, 20, 50]);
  // Several terms narrow.
  assert.deepEqual(filterRouting(all, { query: 'dwight login', names, godId: 'michael' }).map((e) => e.ts), [10, 20]);
  // Drop reasons and message ids are searchable.
  assert.deepEqual(filterRouting(all, { query: 'no-inbox' }).map((e) => e.ts), [80]);
  assert.deepEqual(filterRouting(all, { query: 'm30' }).map((e) => e.ts), [30]);
  // Empty filter is the identity.
  assert.equal(filterRouting(all, {}).length, all.length);
  // Combined: agent + text.
  assert.deepEqual(filterRouting(all, { agentId: 'dwight', godId: 'michael', query: 'standup' }).map((e) => e.ts), [50]);
});

test('routingParticipants: most active first, aliases resolved, system folded, broadcast skipped', () => {
  const all = parseRoutingLog(LOG);
  const people = routingParticipants(all, 'michael');
  assert.equal(people[0], 'michael');
  assert.ok(people.includes('human'));
  assert.ok(people.includes('system'));
  assert.ok(!people.includes('broadcast'));
  assert.ok(!people.includes('god'));
  assert.ok(!people.includes('heartbeat'));
  assert.ok(people.includes('jim'));
});
