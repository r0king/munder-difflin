'use strict';

// Main-side reads behind the Workspace agent cards and rooms: ids are refused
// before they get near a path, the mailbox is deduped and redacted, the
// transcript is found from the registry's session id, a crash log path is only
// ever one inside the hive's own crashes/ folder, and the send log is bounded.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const readers = loadTs('src/main/features/agents/readers.ts');
const sendLog = loadTs('src/main/features/agents/sendLog.ts');

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v));
}

test('agent ids: slugs only, and the join stays under <hive>/agents', () => {
  const root = path.join(os.tmpdir(), 'hive-root');
  for (const bad of ['..', '../x', 'a/b', 'a\\b', '.hidden', '', 'x'.repeat(200), 'a..b', 7, null]) {
    assert.equal(readers.isSafeAgentId(bad), false, String(bad));
    if (typeof bad === 'string') assert.equal(readers.agentDir(root, bad), null);
  }
  assert.equal(readers.isSafeAgentId('dwight-3f2a'), true);
  assert.equal(readers.agentDir(root, 'god'), path.resolve(root, 'agents', 'god'));
});

test('mailbox: all four folders, deduped by id, time-ordered, secrets redacted', (t) => {
  const root = tmp(t, 'ws-agents-mail-');
  const base = path.join(root, 'agents', 'dwight');
  const msg = (id, from, to, ts, body) => ({ id, conversation: 'c', in_reply_to: null, from, to, act: 'inform', subject: 's', body, hops: 0, requires_reply: false, needs_human: false, created_at: ts });
  writeJson(path.join(base, 'inbox', 'a.json'), msg('m1', 'god', 'dwight', '2026-10-12T10:00:00Z', 'do it'));
  writeJson(path.join(base, 'inbox', '.done', 'b.json'), msg('m0', 'jim', 'dwight', '2026-10-12T09:00:00Z', 'old'));
  writeJson(path.join(base, 'outbox', '.sent', 'c.json'), msg('m2', 'dwight', 'god', '2026-10-12T11:00:00Z', 'key sk-ant-abcdefghijklmnopqrstuvwxyz0123'));
  writeJson(path.join(base, 'outbox', '.sent', 'dup.json'), msg('m2', 'dwight', 'god', '2026-10-12T11:00:00Z', 'dup'));
  fs.writeFileSync(path.join(base, 'outbox', 'broken.json'), '{nope');
  const mail = readers.readMailbox(root, 'dwight');
  assert.deepEqual(mail.map((m) => m.id), ['m0', 'm1', 'm2']);
  assert.ok(!mail[2].body.includes('sk-ant-abcdefghijklmnop'), 'a key never crosses IPC');
  assert.match(mail[2].body, /\[redacted\]/);
  assert.equal(readers.latestMailFrom(root, 'dwight').id, 'm2');
  assert.deepEqual(readers.readMailbox(root, '../dwight'), []);
});

test('asks: every question and answer on the agent\'s cards', (t) => {
  const root = tmp(t, 'ws-agents-asks-');
  writeJson(path.join(root, 'tasks.json'), { tasks: [
    { id: 'bmt-17', title: 'Swap the logo', assignee: 'angela', status: 'blocked', humanQA: [
      { q: 'Which logo?', askedAt: '2026-10-12T10:00:00Z', a: 'logo.svg', answeredAt: '2026-10-12T10:05:00Z' },
      { q: 'Archive the old one?', askedAt: '2026-10-12T10:10:00Z' }
    ] },
    { id: 'bmt-18', title: 'Other', assignee: 'jim', humanQA: [{ q: 'x' }] },
    'garbage'
  ] });
  const asks = readers.readAsks(root, 'angela');
  assert.equal(asks.length, 2);
  assert.equal(asks[0].a, 'logo.svg');
  assert.equal(asks[1].a, undefined);
  assert.equal(asks[1].askedAt, Date.parse('2026-10-12T10:10:00Z'));
});

test('transcript: found from the registry session, else by scanning projects; other engines have none', (t) => {
  const home = tmp(t, 'ws-agents-home-');
  // os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const root = tmp(t, 'ws-agents-reg-');
  const cwd = path.join(home, 'My Repo');
  writeJson(path.join(root, 'registry.json'), { godId: 'god', agents: {
    dwight: { id: 'dwight', provider: 'claude', cwd, sessionId: 'aaaaaaaa-1111-2222-3333-444444444444' },
    jim: { id: 'jim', provider: 'claude', cwd: '/elsewhere', sessionId: 'bbbbbbbb-1111-2222-3333-444444444444' },
    pam: { id: 'pam', provider: 'codex', cwd },
    kevin: { id: 'kevin', provider: 'claude', cwd, sessionId: '../../etc' }
  } });
  const projects = path.join(home, '.claude', 'projects');
  const direct = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'aaaaaaaa-1111-2222-3333-444444444444.jsonl');
  const lines = [
    JSON.stringify({ type: 'assistant', uuid: 'a', timestamp: '2026-10-12T10:00:00Z', message: { id: 'm', content: [{ type: 'text', text: 'Token ghp_abcdefghijklmnopqrstuvwxyz123456 rotated.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
    JSON.stringify({ type: 'user', uuid: 'u', timestamp: '2026-10-12T10:00:05Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '3 passed' }] } })
  ].join('\n');
  fs.mkdirSync(path.dirname(direct), { recursive: true });
  fs.writeFileSync(direct, lines);
  const scanned = path.join(projects, 'some-other-dir', 'bbbbbbbb-1111-2222-3333-444444444444.jsonl');
  fs.mkdirSync(path.dirname(scanned), { recursive: true });
  fs.writeFileSync(scanned, lines);

  assert.deepEqual(readers.locateTranscript(root, 'dwight'), { path: direct });
  assert.deepEqual(readers.locateTranscript(root, 'jim'), { path: scanned });
  assert.deepEqual(readers.locateTranscript(root, 'pam'), { missing: 'engine' });
  assert.deepEqual(readers.locateTranscript(root, 'kevin'), { missing: 'none' });
  assert.deepEqual(readers.locateTranscript(root, 'nobody'), { missing: 'none' });

  const events = readers.readTranscriptTail(direct, 64 * 1024);
  assert.ok(events.every((e) => !e.text.includes('ghp_abcdefghij')), 'transcript text is redacted');

  const act = readers.readActivity(root, 'dwight');
  assert.match(act.lastReply.text, /rotated/);
  assert.equal(act.lastTool.text, 'npm test');
  assert.equal(act.lastResult.text, '3 passed');
});

test('last exit: newest record for the agent; a crash log outside crashes/ is not offered', (t) => {
  const root = tmp(t, 'ws-agents-exit-');
  const inside = path.join(root, 'crashes', 'x-dwight.log');
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, 'tail');
  const log = [
    { ts: 1, kind: 'agent-exit', agentId: 'dwight', exitCode: 1, signal: null, abnormal: true, tailPath: inside },
    { ts: 2, kind: 'archive', agentId: 'dwight' },
    { ts: 3, kind: 'agent-exit', agentId: 'jim', exitCode: 2, signal: null, tailPath: '/etc/passwd' },
    { ts: 4, kind: 'agent-exit', agentId: 'dwight', exitCode: 0, signal: 4, tailPath: '/etc/passwd' }
  ].map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'log.jsonl'), log);
  assert.deepEqual(readers.readLastExit(root, 'dwight'), { ts: 4, exitCode: 0, signal: 4, tailPath: null });
  assert.equal(readers.readLastExit(root, 'jim').tailPath, null);
  assert.equal(readers.readLastExit(root, 'pam'), null);
  fs.writeFileSync(path.join(root, 'log.jsonl'), log.split('\n').slice(0, 1).join('\n'));
  assert.equal(readers.readLastExit(root, 'dwight').tailPath, path.resolve(inside));
});

test('send log: per hive and agent, refuses bad ids, reads back in order', (t) => {
  const data = tmp(t, 'ws-agents-sends-');
  const hiveA = '/hives/a';
  assert.equal(sendLog.appendSend(data, hiveA, '../x', { text: 'hi', mode: 'send' }), null);
  sendLog.appendSend(data, hiveA, 'dwight', { text: 'first', mode: 'send' });
  sendLog.appendSend(data, hiveA, 'dwight', { text: 'second', mode: 'steer' });
  sendLog.appendSend(data, '/hives/b', 'dwight', { text: 'other hive', mode: 'send' });
  const got = sendLog.readSends(data, hiveA, 'dwight');
  assert.deepEqual(got.map((s) => [s.text, s.mode]), [['first', 'send'], ['second', 'steer']]);
  assert.equal(sendLog.readSends(data, '/hives/b', 'dwight').length, 1);
  assert.deepEqual(sendLog.readSends(data, hiveA, 'nobody'), []);
  const long = sendLog.appendSend(data, hiveA, 'dwight', { text: 'x'.repeat(30_000), mode: 'send' });
  assert.ok(long.text.length <= 20_001);
});
