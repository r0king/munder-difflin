'use strict';

// Inbox (wsInbox) — OUTSIDE: trigger-history rows folded into exchanges (held
// ones first), held counts and filters, Slack threads off the task ledger, and
// the Inbox route's `section` parser + read-mark bookkeeping.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const O = loadTs('src/shared/workspace/inboxOutside.ts');
const S = loadTs('src/shared/workspace/inboxSection.ts');

function row(over) {
  return {
    id: 'r', source: 'webhook', sourceId: 'wh-1', sourceName: 'GitHub', direction: 'inbound',
    peer: 'github', body: 'b', kind: 'directive', at: 0, ...over
  };
}

// ─── exchanges ──────────────────────────────────────────────────────────────

test('rows pair by correlationId; held exchanges float to the top', () => {
  const rows = [
    row({ id: 'in1', correlationId: 'c1', decision: 'auto-allowed', at: 100 }),
    row({ id: 'out1', correlationId: 'c1', direction: 'outbound', at: 300 }),
    row({ id: 'held', correlationId: 'c2', decision: 'pending', at: 50 }),
    row({ id: 'lone', decision: 'rejected', at: 200 })
  ];
  const ex = O.buildExchanges(rows);
  assert.deepEqual(ex.map((e) => e.key), ['c:c2', 'c:c1', 'e:lone']);
  assert.equal(ex[0].pending.id, 'held');
  assert.equal(ex[1].answered, true);
  assert.deepEqual(ex[1].msgs.map((m) => m.id), ['in1', 'out1']);
  assert.equal(ex[1].head.id, 'in1');
  assert.equal(ex[1].latestAt, 300);
});

test('held counts are per source and count only inbound pending rows', () => {
  const rows = [
    row({ id: 'a', decision: 'pending' }),
    row({ id: 'b', decision: 'pending', source: 'org' }),
    row({ id: 'c', decision: 'pending', direction: 'outbound' }),
    row({ id: 'd', decision: 'approved' })
  ];
  assert.deepEqual(O.heldCounts(rows), { webhook: 1, org: 1 });
});

test('filters: held, allowed (auto or approved), rejected', () => {
  const ex = O.buildExchanges([
    row({ id: 'p', decision: 'pending' }),
    row({ id: 'a', decision: 'auto-allowed' }),
    row({ id: 'ok', decision: 'approved' }),
    row({ id: 'no', decision: 'rejected' })
  ]);
  const ids = (f) => O.filterExchanges(ex, f).map((e) => e.head.id).sort();
  assert.deepEqual(ids('held'), ['p']);
  assert.deepEqual(ids('allowed'), ['a', 'ok']);
  assert.deepEqual(ids('rejected'), ['no']);
  assert.equal(O.filterExchanges(ex, 'all').length, 4);
});

// ─── Slack ──────────────────────────────────────────────────────────────────

test('Slack cards group by thread, oldest first, newest thread first', () => {
  const ledger = {
    tasks: [
      { id: 'slack-1.1-a', title: 'fix login', description: 'fix login please', status: 'done', result: 'Fixed in #12', createdAt: '2026-10-01T00:00:00Z', slack: { channel: 'C1', thread_ts: '1.1' } },
      { id: 'slack-1.1-b', title: 'and the tests', status: 'doing', createdAt: '2026-10-01T01:00:00Z', slack: { channel: 'C1', thread_ts: '1.1' } },
      { id: 'slack-2.2-c', title: 'release notes', status: 'todo', createdAt: '2026-10-03T00:00:00Z', slack: { channel: 'C1', thread_ts: '2.2' } },
      { id: 'not-slack', title: 'x', status: 'todo' },
      { id: 'broken', slack: { channel: 'C1' } }
    ]
  };
  const threads = O.slackThreads(ledger);
  assert.deepEqual(threads.map((t) => t.key), ['C1:2.2', 'C1:1.1']);
  const first = threads[1];
  assert.deepEqual(first.items.map((i) => [i.id, i.state]), [['slack-1.1-a', 'done'], ['slack-1.1-b', 'doing']]);
  assert.equal(first.items[0].text, 'fix login please', 'the full request, not the 80-char title');
  assert.equal(first.items[0].result, 'Fixed in #12');
  assert.equal(first.open, true);
});

test('messages still in the orchestrator\'s queue show as queued in their thread', () => {
  const queued = [
    { id: 'q1', text: 'one more thing', ts: Date.parse('2026-10-05T00:00:00Z'), slack: { channel: 'C1', thread_ts: '1.1' } },
    { id: 'q2', text: 'typed by you', ts: 1 }
  ];
  const threads = O.slackThreads({ tasks: [] }, queued);
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0].items.map((i) => [i.id, i.state, i.isTask]), [['q1', 'queued', false]]);
});

test('slackTsMs reads Slack timestamps and rejects junk', () => {
  assert.equal(O.slackTsMs('1700000000.000200'), 1700000000000);
  assert.ok(Number.isNaN(O.slackTsMs('yesterday')));
});

// ─── sections ───────────────────────────────────────────────────────────────

test('section strings parse to sections, and junk falls back to Ask me', () => {
  assert.deepEqual(S.parseInboxSection(undefined), { kind: 'askme' });
  assert.deepEqual(S.parseInboxSection('askme'), { kind: 'askme' });
  assert.deepEqual(S.parseInboxSection('everyone'), { kind: 'everyone' });
  assert.deepEqual(S.parseInboxSection('outside'), { kind: 'outside', tab: 'webhook' });
  assert.deepEqual(S.parseInboxSection('Webhooks'), { kind: 'outside', tab: 'webhook' });
  assert.deepEqual(S.parseInboxSection('slack'), { kind: 'outside', tab: 'slack' });
  assert.deepEqual(S.parseInboxSection('outside:org'), { kind: 'outside', tab: 'org' });
  assert.deepEqual(S.parseInboxSection('agent:worker-7.a_b'), { kind: 'agent', agentId: 'worker-7.a_b' });
  assert.deepEqual(S.parseInboxSection('agent:../../etc'), { kind: 'askme' });
  assert.deepEqual(S.parseInboxSection('agent:'), { kind: 'askme' });
  assert.deepEqual(S.parseInboxSection(42), { kind: 'askme' });
  assert.deepEqual(S.parseInboxSection('nonsense'), { kind: 'askme' });
});

test('format is the inverse of parse for every canonical section', () => {
  for (const s of ['askme', 'everyone', 'webhooks', 'slack', 'org', 'agent:jim']) {
    assert.equal(S.formatInboxSection(S.parseInboxSection(s)), s);
  }
  assert.ok(S.sameSection(S.parseInboxSection('outside'), S.parseInboxSection('webhooks')));
});

test('read-mark keys are validated', () => {
  for (const k of ['*', 'everyone', 'webhooks', 'slack', 'org', 'askme', 'agent:jim']) assert.ok(S.isReadMarkKey(k), k);
  for (const k of ['', 'agent:', 'agent:../x', '__proto__', 'x'.repeat(200), 7]) assert.ok(!S.isReadMarkKey(k), String(k));
});

test('a read mark only moves forward and never past now', () => {
  const now = '2026-10-12T10:00:00.000Z';
  const m1 = S.applyReadMark({}, 'agent:jim', '2026-10-10T00:00:00Z', now);
  assert.deepEqual(m1, { 'agent:jim': '2026-10-10T00:00:00.000Z' });
  assert.equal(S.applyReadMark(m1, 'agent:jim', '2026-10-09T00:00:00Z', now), null, 'backwards is a no-op');
  assert.equal(S.applyReadMark(m1, 'agent:jim', '2026-10-10T00:00:00Z', now), null, 'same is a no-op');
  assert.deepEqual(S.applyReadMark(m1, 'agent:jim', '2027-01-01T00:00:00Z', now), { 'agent:jim': now }, 'clamped to now');
  assert.equal(S.applyReadMark(m1, 'bogus', now, now), null);
  assert.equal(S.applyReadMark(m1, 'agent:jim', 'soon', now), null);
});

test('read marks are capped, dropping the oldest, and keep the baseline', () => {
  let marks = { '*': '2020-01-01T00:00:00.000Z' };
  const base = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < S.MAX_READ_MARKS + 5; i++) {
    marks = S.applyReadMark(marks, `agent:a${i}`, new Date(base + i * 1000).toISOString(), '2026-10-12T00:00:00Z');
  }
  const keys = Object.keys(marks);
  assert.equal(keys.length, S.MAX_READ_MARKS + 1);
  assert.ok(keys.includes('*'));
  assert.ok(!keys.includes('agent:a0'), 'the oldest went first');
  assert.ok(keys.includes(`agent:a${S.MAX_READ_MARKS + 4}`));
});

test('sanitizeReadMarks drops anything malformed', () => {
  assert.deepEqual(
    S.sanitizeReadMarks({ '*': '2026-10-01T00:00:00Z', 'agent:jim': 'never', bogus: '2026-10-01T00:00:00Z', everyone: 5 }),
    { '*': '2026-10-01T00:00:00Z' }
  );
  assert.deepEqual(S.sanitizeReadMarks(null), {});
  assert.deepEqual(S.sanitizeReadMarks([1]), {});
});

test('mergeReadMarks keeps the later mark per key', () => {
  assert.deepEqual(
    S.mergeReadMarks(
      { 'agent:jim': '2026-10-05T00:00:00Z', everyone: '2026-10-01T00:00:00Z' },
      { 'agent:jim': '2026-10-04T00:00:00Z', everyone: '2026-10-02T00:00:00Z', slack: '2026-10-03T00:00:00Z', org: 'junk' }
    ),
    { 'agent:jim': '2026-10-05T00:00:00Z', everyone: '2026-10-02T00:00:00Z', slack: '2026-10-03T00:00:00Z' }
  );
});
