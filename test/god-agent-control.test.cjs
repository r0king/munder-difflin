'use strict';

/**
 * God may type a command into a worker (act `command`) and answer a worker's
 * permission prompt (act `permission`), gated by orchestratorMayControlAgents.
 * Both acts are intercepted in routeOnce right after `msg.from = id`, so the
 * sender is the owning outbox directory and a `from` field cannot forge god.
 * Every refusal bounces to god and logs `agent-control-refused`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t, { control = true, emitOk = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-god-control-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const handoffs = [];
  const hive = new HiveManager(() => home, (channel, payload) => {
    if (channel === 'hive:terminalHandoff') { handoffs.push(payload); return emitOk; }
    return true;
  });
  hive.setOrchestratorMayControlAgents(control);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'dwight-1', name: 'Dwight', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'prep-1', name: 'Prep', provider: 'claude', cwd: home, isAssistant: true });
  const outbox = (id) => path.join(home, 'hive', 'agents', id, 'outbox');
  const write = (id, partial, name = `m-${Math.random().toString(36).slice(2)}.json`) => {
    fs.writeFileSync(path.join(outbox(id), name), JSON.stringify(partial), 'utf8');
    hive.routeOnce();
  };
  return { hive, handoffs, write, outbox };
}

const entries = (hive, kind) => hive.logTail(500).filter((e) => e.kind === kind);
const refusals = (hive) => entries(hive, 'agent-control-refused');

test('every refusal bounces to god and is logged', async (t) => {
  const cases = [
    ['toggle-off', { control: false }, 'god-1', { to: 'jim-1', act: 'command', body: '/model sonnet' }],
    ['not-god', {}, 'jim-1', { to: 'dwight-1', act: 'command', body: 'hi' }],
    ['bad-target', {}, 'god-1', { to: 'god-1', act: 'command', body: 'hi' }],
    ['bad-target', {}, 'god-1', { to: 'human', act: 'command', body: 'hi' }],
    ['bad-target', {}, 'god-1', { to: 'broadcast', act: 'command', body: 'hi' }],
    ['bad-target', {}, 'god-1', { to: 'nobody-9', act: 'command', body: 'hi' }],
    ['assistant-target', {}, 'god-1', { to: 'prep-1', act: 'command', body: 'hi' }],
    ['empty-command', {}, 'god-1', { to: 'jim-1', act: 'command', body: '  \x1b\x07 ' }],
    ['bad-decision', {}, 'god-1', { to: 'jim-1', act: 'permission', in_reply_to: 'r1', body: 'maybe' }],
    ['not-god', {}, 'jim-1', { to: 'dwight-1', act: 'permission', in_reply_to: 'r1', body: 'allow' }],
    ['toggle-off', { control: false }, 'god-1', { to: 'jim-1', act: 'permission', in_reply_to: 'r1', body: 'allow' }],
  ];
  for (const [reason, opts, sender, msg] of cases) {
    const { hive, handoffs, write } = await floor(t, opts);
    let answered = 0;
    hive.setPermissionAnswerer(() => { answered++; return true; });
    write(sender, { subject: 'x', ...msg });
    const log = refusals(hive);
    assert.equal(log.length, 1, `${reason} ${msg.to}: one log entry`);
    assert.equal(log[0].reason, reason);
    assert.equal(hive.inbox('god-1').filter((m) => m.subject.startsWith('[refused')).length, 1, `${reason} ${msg.to}: bounced`);
    assert.equal(handoffs.length, 0, 'nothing reached a terminal');
    assert.equal(answered, 0, 'no permission was answered');
  }
});

test('an archived target is refused', async (t) => {
  const { hive, write } = await floor(t);
  hive.setArchived('jim-1', true);
  write('god-1', { to: 'jim-1', act: 'command', body: 'hi' });
  assert.equal(refusals(hive)[0].reason, 'archived-target');
});

test('a worker cannot command or approve, even claiming from: god', async (t) => {
  const { hive, handoffs, write } = await floor(t);
  let answered = 0;
  hive.setPermissionAnswerer(() => { answered++; return true; });
  write('jim-1', { from: 'god', to: 'dwight-1', act: 'command', body: 'rm -rf' });
  write('jim-1', { from: 'god-1', to: 'dwight-1', act: 'permission', in_reply_to: 'r1', body: 'allow' });
  assert.equal(handoffs.length, 0);
  assert.equal(answered, 0);
  assert.deepEqual(refusals(hive).map((e) => e.reason), ['not-god', 'not-god']);
  assert.equal(refusals(hive)[0].from, 'jim-1', 'the sender is the outbox owner');
});

test('a command is emitted raw, control chars stripped, newlines kept', async (t) => {
  const { hive, handoffs, write, outbox } = await floor(t);
  write('god-1', { to: 'jim-1', act: 'command', subject: 's', body: '/model\x1b[201~ sonnet\nline2\r\x00\x7f' }, 'cmd.json');
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].raw, true);
  assert.equal(handoffs[0].to, 'jim-1');
  assert.equal(handoffs[0].body, '/model[201~ sonnet\nline2');
  assert.equal(entries(hive, 'god-command').length, 1);
  assert.equal(entries(hive, 'god-command')[0].to, 'jim-1');
  assert.ok(fs.existsSync(path.join(outbox('god-1'), '.sent', 'cmd.json')), 'archived like any message');
  assert.equal(refusals(hive).length, 0);
});

test('a command is cut to 10000 characters', async (t) => {
  const { handoffs, write } = await floor(t);
  write('god-1', { to: 'jim-1', act: 'command', body: 'a'.repeat(10050) });
  assert.equal(handoffs[0].body.length, 10000);
});

test('a failed handoff bounces to god', async (t) => {
  const { hive, write } = await floor(t, { emitOk: false });
  write('god-1', { to: 'jim-1', act: 'command', body: 'hi' });
  assert.equal(hive.inbox('god-1').filter((m) => m.subject.startsWith('[undeliverable')).length, 1);
  assert.equal(entries(hive, 'god-command').length, 0);
});

test('a valid permission reaches the handler', async (t) => {
  const { hive, write } = await floor(t);
  const seen = [];
  hive.setPermissionAnswerer((id, agent, decision) => { seen.push([id, agent, decision]); return true; });
  write('god-1', { to: 'jim-1', act: 'permission', in_reply_to: 'req-7', body: 'deny' });
  assert.deepEqual(seen, [['req-7', 'jim-1', 'deny']]);
  assert.equal(hive.inbox('god-1').length, 0, 'no bounce on success');
  assert.equal(refusals(hive).length, 0);
});

test('a false or missing handler bounces stale', async (t) => {
  const { hive, write } = await floor(t);
  write('god-1', { to: 'jim-1', act: 'permission', in_reply_to: 'req-7', body: 'allow' });
  hive.setPermissionAnswerer(() => false);
  write('god-1', { to: 'jim-1', act: 'permission', in_reply_to: 'req-8', body: 'allow' });
  const stale = hive.inbox('god-1').filter((m) => m.subject.startsWith('[stale'));
  assert.equal(stale.length, 2);
});

test('a refusal cannot loop: bounces are never re-routed', async (t) => {
  const { hive, write } = await floor(t);
  write('god-1', { to: 'god-1', act: 'command', body: 'hi' });
  hive.routeOnce(); hive.routeOnce();
  assert.equal(refusals(hive).length, 1);
  assert.equal(hive.inbox('god-1').length, 1);
});

test('useHive enqueues a raw handoff verbatim', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/renderer/src/hooks/useHive.ts'), 'utf8');
  assert.match(src, /if \(msg\.raw\) \{[^}]*enqueueMessage\(target\.id, msg\.body\);\s*return;\s*\}/);
  const raw = src.indexOf('if (msg.raw)');
  assert.ok(raw > 0 && raw < src.indexOf('terminalWorkOrderPrompt(msg)'), 'raw branch precedes the work-order wrapper');
});
