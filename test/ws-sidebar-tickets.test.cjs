'use strict';

// Workspace sidebar: the ticket an agent is on (its key chip and hover card),
// read from a hand-written task ledger whose fields cannot be trusted in type.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  ticketStatus,
  ticketLastUpdate,
  ticketTitle,
  ticketAssignee,
  descriptionExcerpt,
  currentTicketsByAgent,
  countDoing
} = loadTs('src/shared/workspace/sidebarTickets.ts');

test('status falls back to todo for anything unknown', () => {
  assert.equal(ticketStatus({ id: 'a', status: 'doing' }), 'doing');
  assert.equal(ticketStatus({ id: 'a', status: 'in-progress' }), 'todo');
  assert.equal(ticketStatus({ id: 'a' }), 'todo');
});

test('last update is the newest stamp or Q&A time, whatever it is called', () => {
  const card = {
    id: 'bmt-12',
    createdAt: '2026-10-01T09:00:00Z',
    updatedAt: '2026-10-03T09:00:00Z',
    humanQA: [{ q: '?', askedAt: '2026-10-02T09:00:00Z', answeredAt: '2026-10-04T09:00:00Z' }, null, 'junk']
  };
  assert.equal(ticketLastUpdate(card), Date.parse('2026-10-04T09:00:00Z'));
  assert.equal(ticketLastUpdate({ id: 'x', created_at: '2026-01-01T00:00:00Z' }), Date.parse('2026-01-01T00:00:00Z'));
  // Epoch seconds written by hand are read as seconds.
  assert.equal(ticketLastUpdate({ id: 'x', updatedAt: 1_760_000_000 }), 1_760_000_000_000);
  assert.equal(ticketLastUpdate({ id: 'x', updatedAt: 'not a date', createdAt: {} }), null);
});

test('title and assignee tolerate wrong types', () => {
  assert.equal(ticketTitle({ id: 'a', title: '  Fix\nthe  login ' }), 'Fix the login');
  assert.equal(ticketTitle({ id: 'a', title: 5 }), '');
  assert.equal(ticketAssignee({ id: 'a', assignee: ' dwight ' }), 'dwight');
  assert.equal(ticketAssignee({ id: 'a', assignee: '' }), null);
  assert.equal(ticketAssignee({ id: 'a', assignee: ['x'] }), null);
});

test('description excerpt strips markdown and cuts on a word', () => {
  assert.equal(
    descriptionExcerpt('## Goal\n- [ ] **Fix** the [cookie](http://x) in `auth.ts`\n```js\ncode()\n```\nDone.'),
    'Goal Fix the cookie in auth.ts Done.'
  );
  const long = descriptionExcerpt('word '.repeat(100), 50);
  assert.ok(long.length <= 50 && long.endsWith('…') && !long.includes('wor…'));
  assert.equal(descriptionExcerpt(undefined), '');
});

test('current ticket: doing beats blocked, newest wins, to-do and done never count', () => {
  const cards = [
    { id: 'bmt-1', assignee: 'dwight', status: 'done', updatedAt: '2026-10-09T00:00:00Z' },
    { id: 'bmt-2', assignee: 'dwight', status: 'blocked', updatedAt: '2026-10-08T00:00:00Z' },
    { id: 'bmt-3', assignee: 'dwight', status: 'doing', updatedAt: '2026-10-01T00:00:00Z' },
    { id: 'bmt-4', assignee: 'dwight', status: 'doing', updatedAt: '2026-10-05T00:00:00Z' },
    { id: 'bmt-5', assignee: 'angela', status: 'blocked' },
    { id: 'bmt-6', assignee: 'jim', status: 'todo' },
    { id: 'bmt-7', status: 'doing' }
  ];
  const map = currentTicketsByAgent(cards);
  assert.equal(map.get('dwight').id, 'bmt-4');
  assert.equal(map.get('angela').id, 'bmt-5');
  assert.equal(map.has('jim'), false);
  assert.equal(map.size, 2);
});

test('current ticket without timestamps: the later card in the ledger wins', () => {
  const map = currentTicketsByAgent([
    { id: 'a-1', assignee: 'pam', status: 'doing' },
    { id: 'a-2', assignee: 'pam', status: 'doing' }
  ]);
  assert.equal(map.get('pam').id, 'a-2');
});

test('countDoing counts the Doing column only', () => {
  assert.equal(countDoing([{ id: '1', status: 'doing' }, { id: '2', status: 'doing' }, { id: '3', status: 'blocked' }, { id: '4' }]), 2);
});
