'use strict';

// Inbox (wsInbox) — the main-process mailbox reader against a real temporary
// hive: every folder read, each message once, the raw outbox copy mapped to
// its sender, secrets redacted before clipping, junk and symlinks skipped,
// and a second scan parsing only what is new.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { MailboxScanner } = loadTs('src/main/features/inbox/scan.ts');

const redact = (s) => s.replace(/sk-[A-Za-z0-9]{8,}/g, '[redacted]');

function hive() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws inbox scan '));
  const write = (rel, data) => {
    const p = path.join(root, 'agents', ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data));
    return p;
  };
  return { root, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function routed(id, over = {}) {
  return {
    id, conversation: `conv-${id}`, in_reply_to: null, from: 'jim', to: 'pam', act: 'inform',
    subject: `s-${id}`, body: `b-${id}`, hops: 0, requires_reply: false, needs_human: false,
    created_at: '2026-10-01T10:00:00.000Z', ...over
  };
}

test('reads inbox, inbox/.done and outbox/.sent once per message, newest first', async (t) => {
  const h = hive();
  t.after(h.cleanup);
  h.write('pam/inbox/m1.json', routed('m1', { created_at: '2026-10-01T10:00:00Z' }));
  h.write('pam/inbox/.done/m2.json', routed('m2', { created_at: '2026-10-02T10:00:00Z' }));
  // A broadcast sits in two inboxes under one id.
  h.write('pam/inbox/bc.json', routed('bc', { to: 'broadcast', created_at: '2026-10-03T10:00:00Z' }));
  h.write('dwight/inbox/.done/bc.json', routed('bc', { to: 'broadcast', created_at: '2026-10-03T10:00:00Z' }));
  // The raw outbox copy of m1 (no id; the router minted it) must not double it.
  h.write('jim/outbox/.sent/1700-x.json', { to: 'pam', subject: 's-m1', body: 'b-m1' });
  // A terminal handoff never reached an inbox: only the raw copy exists.
  h.write('jim/outbox/.sent/1700-y.json', { to: 'codex-1', subject: 'work order', body: 'do it', from: 'spoofed', created_at: '2026-10-04T10:00:00Z' });

  const scanner = new MailboxScanner({ redact });
  const out = await scanner.scan(h.root);
  assert.deepEqual(out.map((m) => m.id), ['sent-jim-1700-y', 'bc', 'm2', 'm1']);
  const handoff = out[0];
  assert.equal(handoff.from, 'jim', 'the owning outbox is the sender, as the router decides');
  assert.equal(handoff.to, 'codex-1');
});

test('secrets are redacted before the body is clipped', async (t) => {
  const h = hive();
  t.after(h.cleanup);
  const secret = 'sk-ABCDEFGHIJKLMNOP';
  h.write('god/inbox/s.json', routed('s', { subject: `key ${secret}`, body: `${'x'.repeat(10)}${secret}` }));
  const scanner = new MailboxScanner({ redact, maxBody: 14 });
  const [m] = await scanner.scan(h.root);
  assert.equal(m.subject, 'key [redacted]');
  assert.equal(m.body, 'xxxxxxxxxx[red', 'clipped AFTER redaction: no half-secret survives');
  assert.equal(m.clipped, true);
});

test('junk, quarantined, oversized and symlinked files are skipped', async (t) => {
  const h = hive();
  t.after(h.cleanup);
  h.write('pam/inbox/ok.json', routed('ok'));
  h.write('pam/inbox/broken.json', '{ not json');
  h.write('pam/inbox/notes.txt', 'hello');
  h.write('jim/outbox/.sent/bad-1.json', routed('bad'));
  h.write('pam/inbox/big.json', JSON.stringify(routed('big', { body: 'y'.repeat(5000) })));
  const outside = path.join(h.root, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify(routed('linked')));
  try {
    fs.symlinkSync(outside, path.join(h.root, 'agents', 'pam', 'inbox', 'link.json'));
  } catch { /* symlinks unavailable (Windows without privilege) — the rest still holds */ }
  const scanner = new MailboxScanner({ redact, maxFileBytes: 2000 });
  const out = await scanner.scan(h.root);
  assert.deepEqual(out.map((m) => m.id), ['ok']);
});

test('a second scan parses only new files and forgets deleted ones', async (t) => {
  const h = hive();
  t.after(h.cleanup);
  h.write('pam/inbox/a.json', routed('a'));
  h.write('pam/inbox/b.json', routed('b'));
  const scanner = new MailboxScanner({ redact });
  assert.equal((await scanner.scan(h.root)).length, 2);
  assert.equal(scanner.parsed, 2);

  // Draining a message is a rename into .done under the same name: no re-read.
  fs.mkdirSync(path.join(h.root, 'agents', 'pam', 'inbox', '.done'), { recursive: true });
  fs.renameSync(path.join(h.root, 'agents', 'pam', 'inbox', 'a.json'), path.join(h.root, 'agents', 'pam', 'inbox', '.done', 'a.json'));
  h.write('pam/inbox/c.json', routed('c'));
  fs.rmSync(path.join(h.root, 'agents', 'pam', 'inbox', 'b.json'));
  const out = await scanner.scan(h.root);
  assert.deepEqual(out.map((m) => m.id).sort(), ['a', 'c']);
  assert.equal(scanner.parsed, 3, 'only c.json was parsed again');
});

test('a missing hive is an empty floor, and concurrent scans share one read', async (t) => {
  const h = hive();
  t.after(h.cleanup);
  const scanner = new MailboxScanner({ redact });
  assert.deepEqual(await scanner.scan(path.join(h.root, 'nope')), []);
  h.write('pam/inbox/a.json', routed('a'));
  const [x, y] = await Promise.all([scanner.scan(h.root), scanner.scan(h.root)]);
  assert.equal(x, y);
  assert.equal(scanner.parsed, 1);
});
