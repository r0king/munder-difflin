'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { buildConversation, filterConversation, MAX_CONVERSATION_BODY } =
  loadTs('src/shared/workspace/orchestratorConversation.ts');

const mail = (id, from, to, iso, extra = {}) => ({
  id, from, to, act: 'request', subject: `s-${id}`, body: `b-${id}`,
  direction: to === 'god' ? 'inbox' : 'outbox', archived: true, created_at: iso, ...extra
});

test('mail and prompts merge into one timeline, oldest first', () => {
  const items = buildConversation(
    [
      mail('m2', 'dwight', 'god', '2026-06-15T10:00:00Z'),
      mail('m1', 'god', 'dwight', '2026-06-15T09:00:00Z')
    ],
    [{ id: 7, text: 'ship it', ts: Date.parse('2026-06-15T09:30:00Z') }],
    'god'
  );
  assert.deepEqual(items.map((i) => i.key), ['mail:m1', 'prompt:7', 'mail:m2']);
  assert.equal(items[0].outgoing, true);
  assert.equal(items[1].from, 'human');
  assert.equal(items[2].outgoing, false);
});

test('a delivered message seen in two mailboxes appears once', () => {
  const items = buildConversation(
    [mail('m1', 'god', 'dwight', '2026-06-15T09:00:00Z'), mail('m1', 'god', 'dwight', '2026-06-15T09:00:00Z', { direction: 'inbox' })],
    [],
    'god'
  );
  assert.equal(items.length, 1);
});

test('unread = pending in his inbox from someone else', () => {
  const [pending, handled] = buildConversation(
    [
      mail('a', 'angela', 'god', '2026-06-15T09:00:00Z', { direction: 'inbox', archived: false, requires_reply: true }),
      mail('b', 'angela', 'god', '2026-06-15T09:01:00Z', { direction: 'inbox', archived: true })
    ],
    [],
    'god'
  );
  assert.equal(pending.unread, true);
  assert.equal(pending.needsReply, true);
  assert.equal(handled.unread, false);
});

test('the limit keeps the newest; junk rows and blank prompts are skipped; bodies are clipped', () => {
  const many = [];
  for (let i = 0; i < 30; i++) many.push(mail(`m${i}`, 'jim', 'god', new Date(Date.UTC(2026, 5, 15, 0, i)).toISOString()));
  const items = buildConversation([...many, null, { id: '' }], [{ id: 1, text: '   ', ts: 5 }], 'god', 10);
  assert.equal(items.length, 10);
  assert.equal(items[9].key, 'mail:m29');
  const long = buildConversation([mail('x', 'jim', 'god', '2026-06-15T00:00:00Z', { body: 'y'.repeat(MAX_CONVERSATION_BODY + 50) })], [], 'god');
  assert.equal(long[0].body.length, MAX_CONVERSATION_BODY);
});

test('an unparseable timestamp sorts first instead of throwing', () => {
  const items = buildConversation([mail('ok', 'jim', 'god', '2026-06-15T00:00:00Z'), mail('bad', 'jim', 'god', 'garbage')], [], 'god');
  assert.deepEqual(items.map((i) => i.key), ['mail:bad', 'mail:ok']);
});

test('filterConversation splits "with you" from "the floor"', () => {
  const items = buildConversation(
    [
      mail('h', 'human', 'god', '2026-06-15T09:00:00Z'),
      mail('q', 'angela', 'human', '2026-06-15T09:05:00Z'),
      mail('f', 'god', 'dwight', '2026-06-15T09:10:00Z')
    ],
    [{ id: 1, text: 'hello', ts: Date.parse('2026-06-15T09:20:00Z') }],
    'god'
  );
  assert.deepEqual(filterConversation(items, 'you').map((i) => i.key), ['mail:h', 'mail:q', 'prompt:1']);
  assert.deepEqual(filterConversation(items, 'floor').map((i) => i.key), ['mail:f']);
  assert.equal(filterConversation(items, 'all').length, 4);
});
