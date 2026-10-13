'use strict';

// The agent room's conversation: five sources merged into one time-ordered
// thread, with the duplicates a real floor produces (a send that later shows
// up in the transcript, a terminal line that is also in the history) folded.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { buildConversation, sameMessage, comparableText, lastItemKey } =
  loadTs('src/shared/workspace/agentsConversation.ts');

const T0 = Date.parse('2026-10-12T10:00:00Z');
const min = (n) => T0 + n * 60_000;

const empty = () => ({ sends: [], transcript: [], hive: [], asks: [], history: [] });

test('a send that arrives in the transcript appears once, marked delivered', () => {
  const src = empty();
  src.sends.push({ id: 's1', ts: min(0), text: 'Then run the Safari case alone', mode: 'send' });
  src.transcript.push({ kind: 'prompt', ts: min(5), id: 'p1', text: 'Then run the Safari case alone' });
  src.transcript.push({ kind: 'reply', ts: min(6), id: 'r1', text: 'Running it now.' });
  const items = buildConversation(src, { agentId: 'dwight' });
  assert.deepEqual(items.map((i) => i.kind), ['send', 'reply']);
  assert.equal(items[0].delivered, true);
  assert.equal(items[0].author, 'you');
  assert.equal(items[1].author, 'agent');
});

test('a send with attachments matches the prompt it became', () => {
  const body = 'Look at this\n\nAttached files:\n- /tmp/a b.png (a b.png)';
  assert.ok(sameMessage(body, 'Look at this\n\nAttached files:\n- /tmp/a b.png (a b.png)'));
  assert.equal(comparableText(body), 'look at this');
});

test('a prompt BEFORE the send (outside clock slack) is not that send', () => {
  const src = empty();
  src.sends.push({ id: 's1', ts: min(10), text: 'status?', mode: 'send' });
  src.transcript.push({ kind: 'prompt', ts: min(0), id: 'p0', text: 'status?' });
  const items = buildConversation(src, { agentId: 'a' });
  assert.equal(items.length, 2);
  assert.equal(items.find((i) => i.kind === 'send').delivered, undefined);
});

test('a steer to an idle agent (typed as a prompt) folds into the steer', () => {
  const src = empty();
  src.sends.push({ id: 's1', ts: min(0), text: 'use the staging db', mode: 'steer' });
  src.transcript.push({ kind: 'prompt', ts: min(0.2), id: 'p1', text: 'use the staging db' });
  const items = buildConversation(src, { agentId: 'a' });
  assert.deepEqual(items.map((i) => i.kind), ['steer']);
  assert.equal(items[0].delivered, true);
});

test('a terminal line in the history is kept once and attributed to you', () => {
  const src = empty();
  src.history.push({ ts: min(1), text: 'git status' });
  src.transcript.push({ kind: 'prompt', ts: min(1) + 900, id: 'p1', text: 'git status' });
  const items = buildConversation(src, { agentId: 'a' });
  assert.equal(items.length, 1);
  assert.equal(items[0].author, 'you');
  assert.equal(items[0].byYou, true);
});

test('history with no transcript (other engines) still shows', () => {
  const src = empty();
  src.history.push({ ts: min(1), text: 'hello codex' });
  const items = buildConversation(src, { agentId: 'a' });
  assert.equal(items.length, 1);
  assert.equal(items[0].author, 'you');
});

test('a prompt nobody here sent reads as from the floor', () => {
  const src = empty();
  src.transcript.push({ kind: 'prompt', ts: min(1), id: 'p1', text: 'Work order from Michael' });
  const [item] = buildConversation(src, { agentId: 'a' });
  assert.equal(item.author, 'other');
});

test('inbox-wake nudges are dropped as plumbing', () => {
  const src = empty();
  src.transcript.push({ kind: 'prompt', ts: min(1), id: 'p1', text: 'You have new hive inbox message(s) — at least: x. Read your inbox' });
  assert.equal(buildConversation(src, { agentId: 'a' }).length, 0);
});

test('only the last reply of a turn is an item; the earlier ones ride as notes', () => {
  const src = empty();
  src.transcript.push({ kind: 'prompt', ts: min(0), id: 'p', text: 'go' });
  src.transcript.push({ kind: 'reply', ts: min(1), id: 'r1', text: 'Let me look.' });
  src.transcript.push({ kind: 'tool', ts: min(2), id: 't', text: 'npm test', tool: 'Bash' });
  src.transcript.push({ kind: 'reply', ts: min(3), id: 'r2', text: 'All green.' });
  src.transcript.push({ kind: 'prompt', ts: min(4), id: 'p2', text: 'next' });
  src.transcript.push({ kind: 'reply', ts: min(5), id: 'r3', text: 'On it.' });
  const items = buildConversation(src, { agentId: 'a' });
  assert.deepEqual(items.map((i) => i.text), ['go', 'All green.', 'next', 'On it.']);
  assert.deepEqual(items[1].notes, ['Let me look.']);
  assert.equal(items[3].notes, undefined);
});

test('hive mail is deduped by id and attributed', () => {
  const src = empty();
  const mail = { id: 'm1', from: 'dwight', to: 'god', act: 'inform', subject: 'Done', body: 'fixed', ts: min(2), direction: 'outbox' };
  src.hive.push(mail, { ...mail }, { id: 'm2', from: 'human', to: 'dwight', act: 'request', subject: 'Q', body: 'why?', ts: min(1), direction: 'inbox', requiresReply: true }, { id: 'm3', from: 'jim', to: 'dwight', act: 'query', subject: 'hey', body: 'b', ts: min(3), direction: 'inbox' });
  const items = buildConversation(src, { agentId: 'dwight' });
  assert.deepEqual(items.map((i) => [i.id, i.author]), [['mail-m2', 'you'], ['mail-m1', 'agent'], ['mail-m3', 'other']]);
  assert.equal(items[0].requiresReply, true);
});

test('asks and answers: question first, answer after, open flag', () => {
  const src = empty();
  src.asks.push({ taskId: 't1', taskTitle: 'Logo', q: 'Which logo?', a: 'logo.svg', askedAt: min(1), answeredAt: min(1) });
  src.asks.push({ taskId: 't2', taskTitle: 'Copy', q: 'Tone?', askedAt: min(2) });
  const items = buildConversation(src, { agentId: 'a' });
  assert.deepEqual(items.map((i) => i.kind), ['ask', 'answer', 'ask']);
  assert.equal(items[0].open, false);
  assert.equal(items[2].open, true);
});

test('time order across sources, newest N kept', () => {
  const src = empty();
  for (let i = 0; i < 30; i++) src.sends.push({ id: `s${i}`, ts: min(30 - i), text: `msg ${30 - i}`, mode: 'send' });
  const items = buildConversation(src, { agentId: 'a', limit: 10 });
  assert.equal(items.length, 10);
  assert.equal(items[0].text, 'msg 21');
  assert.equal(items[9].text, 'msg 30');
  assert.ok(lastItemKey(items).startsWith('send-s0'));
  assert.equal(lastItemKey([]), '');
});

test('malformed source entries are ignored', () => {
  const src = { sends: [null, { id: 'x', ts: 1, text: '', mode: 'send' }], transcript: [null], hive: [null, { id: 3 }], asks: [null, { q: '' }] };
  assert.deepEqual(buildConversation(src, { agentId: 'a' }), []);
});
