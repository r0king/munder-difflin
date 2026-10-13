'use strict';

// Inbox (wsInbox) — the message half: reading hive mail files, merging the
// mailboxes once per message, who a message belongs to, what still needs the
// human's reply, unread watermarks, threads and search.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const M = loadTs('src/shared/workspace/inboxMessages.ts');

let seq = 0;
/** A normalised InboxMessage with sensible defaults. */
function msg(over = {}) {
  seq += 1;
  return {
    id: `m${seq}`,
    conversation: `c${seq}`,
    inReplyTo: null,
    from: 'dwight',
    to: 'god',
    act: 'inform',
    subject: `subject ${seq}`,
    body: '',
    requiresReply: false,
    needsHuman: false,
    createdAt: new Date(Date.UTC(2026, 9, 1, 12, 0, seq)).toISOString(),
    ...over
  };
}

// ─── normalizeHiveMessage ───────────────────────────────────────────────────

test('a routed hive file normalises to an InboxMessage', () => {
  const m = M.normalizeHiveMessage({
    id: '20261001-abc', conversation: 'conv-1', in_reply_to: null, from: 'angela', to: 'human',
    act: 'request', subject: 'Which logo?', body: 'logo.svg or logo_old.svg', hops: 0,
    requires_reply: true, needs_human: false, created_at: '2026-10-01T10:00:00.000Z'
  });
  assert.deepEqual(m, {
    id: '20261001-abc', conversation: 'conv-1', inReplyTo: null, from: 'angela', to: 'human',
    act: 'request', subject: 'Which logo?', body: 'logo.svg or logo_old.svg',
    requiresReply: true, needsHuman: false, createdAt: '2026-10-01T10:00:00.000Z'
  });
});

test('a raw outbox copy takes the hive defaults and the fallbacks', () => {
  const m = M.normalizeHiveMessage(
    { subject: 'status?', act: 'query' },
    { id: 'sent-jim-x', from: 'jim', createdAt: '2026-10-02T00:00:00Z' }
  );
  assert.equal(m.id, 'sent-jim-x');
  assert.equal(m.from, 'jim');
  assert.equal(m.to, 'god', 'to defaults to god, as hive.ts normalize does');
  assert.equal(m.requiresReply, true, 'a query requires a reply by default');
  assert.equal(m.conversation, 'conv-sent-jim-x');
  assert.equal(m.createdAt, '2026-10-02T00:00:00.000Z');
});

test('junk never throws and never becomes a message', () => {
  for (const raw of [null, 7, 'x', [], { subject: 'no id, no fallback' }]) {
    assert.equal(M.normalizeHiveMessage(raw), null);
  }
  assert.equal(M.normalizeHiveMessage({ id: 'a', created_at: 'not a date' }), null, 'no usable time and no fallback');
  const odd = M.normalizeHiveMessage({ id: 'a', created_at: '2026-10-01T00:00:00Z', act: 'shout', body: 42 });
  assert.equal(odd.act, 'inform');
  assert.equal(odd.body, '');
});

test('a long body is clipped at the cap and says so', () => {
  const m = M.normalizeHiveMessage({ id: 'a', created_at: '2026-10-01T00:00:00Z', body: 'x'.repeat(50) }, { maxBody: 10 });
  assert.equal(m.body.length, 10);
  assert.equal(m.clipped, true);
  const short = M.normalizeHiveMessage({ id: 'b', created_at: '2026-10-01T00:00:00Z', body: 'ok' }, { maxBody: 10 });
  assert.equal('clipped' in short, false);
});

// ─── mergeMailboxes ─────────────────────────────────────────────────────────

test('a broadcast delivered to three inboxes is one message', () => {
  const b = msg({ id: 'bc', to: 'broadcast' });
  const out = M.mergeMailboxes([b, { ...b }, { ...b }], []);
  assert.equal(out.length, 1);
});

test('a sent copy the router delivered is skipped, by id or by content', () => {
  const delivered = msg({ id: 'routed-1', from: 'jim', to: 'pam', subject: 'hi', body: 'hello' });
  const sameId = msg({ id: 'routed-1', from: 'jim', to: 'pam', subject: 'hi', body: 'hello' });
  const sameContent = msg({ id: 'sent-jim-file', from: 'jim', to: 'pam', subject: 'hi', body: 'hello' });
  const handoff = msg({ id: 'sent-jim-other', from: 'jim', to: 'codex-1', subject: 'work order', body: 'do it' });
  const out = M.mergeMailboxes([delivered], [sameId, sameContent, handoff]);
  assert.deepEqual(out.map((m) => m.id).sort(), ['routed-1', 'sent-jim-other']);
});

test('merged mail is newest first and honours the limit', () => {
  const a = msg({ createdAt: '2026-10-01T00:00:00Z' });
  const b = msg({ createdAt: '2026-10-03T00:00:00Z' });
  const c = msg({ createdAt: '2026-10-02T00:00:00Z' });
  assert.deepEqual(M.mergeMailboxes([a, b, c], []).map((m) => m.id), [b.id, c.id, a.id]);
  assert.deepEqual(M.mergeMailboxes([a, b, c], [], 2).map((m) => m.id), [b.id, c.id]);
});

test('selectForWire keeps old human mail beyond the floor-wide window', () => {
  const chatter = Array.from({ length: 5 }, (_, i) => msg({ createdAt: `2026-10-0${9 - i}T00:00:00Z` }));
  const oldAsk = msg({ to: 'human', act: 'request', requiresReply: true, createdAt: '2026-09-01T00:00:00Z' });
  const older = msg({ createdAt: '2026-08-01T00:00:00Z' });
  const all = [...chatter, oldAsk, older];
  const wire = M.selectForWire(all, 3, 100);
  assert.deepEqual(wire.map((m) => m.id), [chatter[0].id, chatter[1].id, chatter[2].id, oldAsk.id]);
  assert.equal(M.selectForWire(all, 3, 0).length, 3, 'humanLimit 0 adds nothing');
  assert.equal(M.selectForWire(all, 100, 100).length, all.length);
});

// ─── who a message is for ───────────────────────────────────────────────────

test('to-human, flagged-for-human and from-human mail belongs to the agent on the other end', () => {
  assert.equal(M.agentOf(msg({ from: 'angela', to: 'human' }), 'god-1'), 'angela');
  assert.equal(M.agentOf(msg({ from: 'angela', to: 'god', needsHuman: true }), 'god-1'), 'angela');
  assert.equal(M.agentOf(msg({ from: 'human', to: 'jim' }), 'god-1'), 'jim');
  assert.equal(M.agentOf(msg({ from: 'human', to: 'god' }), 'god-1'), 'god-1', 'the god alias folds onto his id');
  assert.equal(M.agentOf(msg({ from: 'god', to: 'human' }), 'god-1'), 'god-1');
  assert.equal(M.agentOf(msg({ from: 'jim', to: 'pam' }), 'god-1'), null, 'agent to agent is nobody\'s row');
  assert.equal(M.agentOf(msg({ from: 'human', to: 'broadcast' }), 'god-1'), null);
  assert.equal(M.agentOf(msg({ from: 'system', to: 'human' }), 'god-1'), null);
});

test('groupByAgent keeps each agent\'s conversation oldest first', () => {
  const a2 = msg({ from: 'angela', to: 'human', createdAt: '2026-10-02T00:00:00Z' });
  const a1 = msg({ from: 'human', to: 'angela', createdAt: '2026-10-01T00:00:00Z' });
  const other = msg({ from: 'jim', to: 'pam' });
  const g = M.groupByAgent([a2, other, a1], null);
  assert.deepEqual([...g.keys()], ['angela']);
  assert.deepEqual(g.get('angela').map((m) => m.id), [a1.id, a2.id]);
});

// ─── needs a reply ──────────────────────────────────────────────────────────

test('a request to the human needs a reply until the human answers it', () => {
  const ask = msg({ from: 'angela', to: 'human', act: 'request', requiresReply: true, conversation: 'logo', createdAt: '2026-10-01T10:00:00Z' });
  assert.ok(M.pendingReplyIds([ask]).has(ask.id));

  const byReplyTo = msg({ from: 'human', to: 'angela', inReplyTo: ask.id, conversation: 'other', createdAt: '2026-10-01T09:00:00Z' });
  assert.equal(M.pendingReplyIds([ask, byReplyTo]).size, 0, 'in_reply_to answers it whatever the clock says');

  const laterInThread = msg({ from: 'human', to: 'angela', conversation: 'logo', createdAt: '2026-10-01T11:00:00Z' });
  assert.equal(M.pendingReplyIds([ask, laterInThread]).size, 0, 'a later human message in the thread answers it');

  const earlierInThread = msg({ from: 'human', to: 'angela', conversation: 'logo', createdAt: '2026-10-01T08:00:00Z' });
  assert.ok(M.pendingReplyIds([ask, earlierInThread]).has(ask.id), 'what you said before the ask does not answer it');
});

test('informs and mail only flagged for the human never need YOUR reply', () => {
  const inform = msg({ from: 'jim', to: 'human', act: 'inform', requiresReply: false });
  const flagged = msg({ from: 'jim', to: 'god', act: 'request', requiresReply: true, needsHuman: true });
  assert.equal(M.pendingReplyIds([inform, flagged]).size, 0);
});

// ─── unread ─────────────────────────────────────────────────────────────────

test('the watermark is the later of the section mark and the baseline', () => {
  assert.equal(M.watermark({}, 'agent:jim'), Number.NEGATIVE_INFINITY);
  assert.equal(M.watermark({ '*': '2026-10-01T00:00:00Z' }, 'agent:jim'), Date.parse('2026-10-01T00:00:00Z'));
  assert.equal(
    M.watermark({ '*': '2026-10-01T00:00:00Z', 'agent:jim': '2026-10-05T00:00:00Z' }, 'agent:jim'),
    Date.parse('2026-10-05T00:00:00Z')
  );
  assert.equal(
    M.watermark({ '*': '2026-10-09T00:00:00Z', 'agent:jim': '2026-10-05T00:00:00Z' }, 'agent:jim'),
    Date.parse('2026-10-09T00:00:00Z'),
    'history from before the Inbox existed is never unread'
  );
});

test('only mail TO the human after the watermark is unread', () => {
  const mark = Date.parse('2026-10-01T12:00:00Z');
  assert.equal(M.isUnread(msg({ from: 'jim', to: 'human', createdAt: '2026-10-01T13:00:00Z' }), mark), true);
  assert.equal(M.isUnread(msg({ from: 'jim', to: 'human', createdAt: '2026-10-01T11:00:00Z' }), mark), false);
  assert.equal(M.isUnread(msg({ from: 'human', to: 'jim', createdAt: '2026-10-01T13:00:00Z' }), mark), false, 'your own mail');
  assert.equal(M.isUnread(msg({ from: 'jim', to: 'pam', createdAt: '2026-10-01T13:00:00Z' }), mark), false, 'chatter');
});

test('summarizeAgents orders needs-a-reply, then unread, then newest', () => {
  const marks = { '*': '2026-10-01T00:00:00Z', 'agent:pam': '2026-10-09T00:00:00Z' };
  const mail = [
    msg({ from: 'jim', to: 'human', createdAt: '2026-10-03T00:00:00Z' }), // unread
    msg({ from: 'pam', to: 'human', createdAt: '2026-10-08T00:00:00Z' }), // read (mark), newest
    msg({ from: 'angela', to: 'human', act: 'request', requiresReply: true, createdAt: '2026-10-02T00:00:00Z' }),
    msg({ from: 'human', to: 'oscar', createdAt: '2026-10-07T00:00:00Z' }) // yours only
  ];
  const rows = M.summarizeAgents(mail, null, marks, (id) => `agent:${id}`);
  assert.deepEqual(rows.map((r) => r.agentId), ['angela', 'jim', 'pam', 'oscar']);
  assert.deepEqual(rows.map((r) => [r.unread, r.needsReply]), [[1, 1], [1, 0], [0, 0], [0, 0]]);
  assert.equal(rows[2].latest.from, 'pam');
});

test('newestAt picks the latest createdAt', () => {
  assert.equal(M.newestAt([]), null);
  const a = msg({ createdAt: '2026-10-01T00:00:00.000Z' });
  const b = msg({ createdAt: '2026-10-04T00:00:00.000Z' });
  assert.equal(M.newestAt([a, b]), b.createdAt);
});

// ─── threads ────────────────────────────────────────────────────────────────

test('threads fold by conversation, newest activity first', () => {
  const t1a = msg({ conversation: 'one', subject: 'Logo', createdAt: '2026-10-01T00:00:00Z' });
  const t2 = msg({ conversation: 'two', subject: 'Tests', createdAt: '2026-10-02T00:00:00Z' });
  const t1b = msg({ conversation: 'one', subject: 'Re: Logo', createdAt: '2026-10-03T00:00:00Z' });
  const threads = M.groupThreads([t2, t1b, t1a]);
  assert.deepEqual(threads.map((t) => t.conversation), ['one', 'two']);
  assert.equal(threads[0].subject, 'Logo');
  assert.deepEqual(threads[0].messages.map((m) => m.id), [t1a.id, t1b.id]);
});

test('a reply subject carries exactly one Re:', () => {
  assert.equal(M.replySubject('Which logo?'), 'Re: Which logo?');
  assert.equal(M.replySubject('Re: re: Which logo?'), 'Re: Which logo?');
  assert.equal(M.replySubject(''), 'Re:');
});

// ─── search ─────────────────────────────────────────────────────────────────

test('parseSearch splits terms, phrases and filters', () => {
  assert.deepEqual(M.parseSearch('from:dwight "login test" Safari is:request to:'), {
    terms: ['login test', 'safari', 'to:'],
    from: ['dwight'],
    to: [],
    acts: ['request']
  });
  assert.deepEqual(M.parseSearch('is:shouting'), { terms: ['is:shouting'], from: [], to: [], acts: [] });
});

test('search matches subject, body and names, every term, any case', () => {
  const names = { dwight: 'Dwight', god: 'Michael', jim: 'Jim' };
  const nameOf = (id) => names[id] ?? id;
  const a = msg({ from: 'dwight', to: 'god', subject: 'Login test', body: 'Fails on Safari only', act: 'inform' });
  const b = msg({ from: 'jim', to: 'god', subject: 'Release notes', body: 'Draft is up', act: 'request' });
  const c = msg({ from: 'god', to: 'jim', subject: '登录测试', body: 'مرحبا', act: 'query' });
  const all = [a, b, c];
  assert.deepEqual(M.searchMessages(all, 'safari LOGIN', nameOf), [a]);
  assert.deepEqual(M.searchMessages(all, 'michael', nameOf), [a, b, c], 'a display name matches');
  assert.deepEqual(M.searchMessages(all, 'from:mich', nameOf), [c]);
  assert.deepEqual(M.searchMessages(all, 'to:jim', nameOf), [c]);
  assert.deepEqual(M.searchMessages(all, 'is:request', nameOf), [b]);
  assert.deepEqual(M.searchMessages(all, '登录', nameOf), [c]);
  assert.deepEqual(M.searchMessages(all, 'مرحبا', nameOf), [c]);
  assert.equal(M.searchMessages(all, '   ', nameOf), all, 'an empty query is the list itself');
  assert.deepEqual(M.searchMessages(all, 'nothing-matches', nameOf), []);
});

// ─── agent rows ─────────────────────────────────────────────────────────────

test('agent rows: needs-you, then unread, then activity, then the quiet roster', () => {
  const summary = (agentId, over = {}) => ({
    agentId, count: 1, unread: 0, needsReply: 0,
    latest: msg({ from: agentId, to: 'human', createdAt: over.at ?? '2026-10-01T00:00:00Z' }), ...over
  });
  const rows = M.buildAgentRows(
    ['god-1', 'dwight', 'jim', 'pam', 'angela'],
    [
      summary('jim', { at: '2026-10-05T00:00:00Z' }),
      summary('pam', { unread: 2, at: '2026-10-02T00:00:00Z' }),
      summary('worker-9', { needsReply: 1, at: '2026-09-01T00:00:00Z' })
    ],
    new Map([['angela', { count: 1, latestAt: Date.parse('2026-10-03T00:00:00Z') }]])
  );
  assert.deepEqual(rows.map((r) => r.agentId), ['angela', 'worker-9', 'pam', 'jim', 'god-1', 'dwight']);
  assert.equal(rows[0].needsYou, true);
  assert.equal(rows[0].asks, 1);
  assert.equal(rows[4].summary, null);
  assert.equal(rows[4].latestAt, Number.NEGATIVE_INFINITY);
});
