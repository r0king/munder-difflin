/**
 * Workspace Capabilities → Temps — the controller that sits in front of the
 * ephemeral-worker machinery (src/main/features/capabilities/temps.ts), driven
 * end to end against a scratch hive on disk.
 *
 * The worker controller in index.ts is played by the test: it takes the request
 * file, puts the worker on the registry, and archives it at teardown — exactly
 * the files the real one writes. What is pinned is the temp's life as the user
 * sees it: the cap, the queue, a stop at each stage, the reason a rejected hire
 * gives, and the row a finished temp leaves (duration, tokens from the ledger,
 * done vs ended, a kept worktree), plus what an app restart does to a temp
 * that was running.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { TempsController } = loadTs('src/main/features/capabilities/temps.ts');

function scratch() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cap-temps-'));
  const hive = path.join(home, 'hive');
  const data = path.join(home, 'userdata');
  const repo = path.join(home, 'my repo'); // a space, on purpose
  for (const d of [hive, data, repo]) fs.mkdirSync(d, { recursive: true });
  return { home, hive, data, repo };
}

function controller(s, changes = { n: 0 }) {
  return new TempsController({
    dataDir: s.data,
    harnessHome: () => s.home,
    claudeCommand: () => 'claude',
    onChange: () => { changes.n++; }
  });
}

async function settle(c) {
  for (let i = 0; i < 4; i++) {
    await c.tick();
    await new Promise((r) => setTimeout(r, 5));
  }
}

function writeRegistry(s, agents, godId = 'god') {
  fs.writeFileSync(path.join(s.hive, 'registry.json'), JSON.stringify({ godId, agents }));
}

/** Play the worker controller: take the request, put the worker on the floor. */
function pickUp(s, c, id) {
  const file = c.requestFiles().find((f) => path.basename(f) === `${id}.json`);
  assert.ok(file, 'the request is waiting in the queue');
  const req = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.unlinkSync(file);
  return req;
}

test('hire → queue file → running → done: the row has duration, tokens and outcome', async () => {
  const s = scratch();
  const changes = { n: 0 };
  const c = controller(s, changes);
  const hired = c.hire({ job: 'Translate the changelog\ninto Spanish', provider: 'claude', model: 'claude-opus-4-5', cwd: s.repo, isolate: false });
  assert.equal(hired.ok, true);
  const id = hired.temp.id;
  const workerId = hired.temp.workerId;
  await settle(c);
  assert.equal(c.view().active[0].state, 'starting');
  assert.equal(c.view().running, 1);

  const req = pickUp(s, c, id);
  assert.deepEqual(
    { id: req.id, objective: req.objective, command: req.command, provider: req.provider, cwd: req.cwd, isolate: req.isolate, name: req.name },
    { id, objective: 'Translate the changelog\ninto Spanish', command: 'claude --model claude-opus-4-5', provider: 'claude', cwd: s.repo, isolate: false, name: 'Translate the changelog' }
  );

  writeRegistry(s, { [workerId]: { archived: false, lastSeen: Date.now() } });
  await settle(c);
  assert.equal(c.view().active[0].state, 'running');
  // Pretend it has been on the floor for five minutes.
  const started = Date.now() - 300_000;
  c.view().active[0].startedAt = started;

  // It works: two ledger samples (cumulative), and someone else's row.
  const row = (agent, total) => JSON.stringify({ agent_id: agent, session_id: 's1', ts: Date.now(), input: total, output: 0, cache_read: 0, cache_creation: 0, model: 'm', usd: 0 });
  fs.writeFileSync(path.join(s.hive, 'cost-ledger.jsonl'), [row(workerId, 12000), row('jim', 99999), row(workerId, 38000)].join('\n') + '\n');
  // It says it is done, and the controller tears it down.
  const outbox = path.join(s.hive, 'agents', workerId, 'outbox', '.sent');
  fs.mkdirSync(outbox, { recursive: true });
  fs.writeFileSync(path.join(outbox, 'm1.json'), JSON.stringify({ act: 'done', created_at: new Date(started + 1000).toISOString() }));
  // Torn down 48 s ago (past the settle window), after 4m 12s on the floor.
  writeRegistry(s, { [workerId]: { archived: true, lastSeen: started + 252_000 } });
  await settle(c);
  const v = c.view();
  assert.equal(v.active.length, 0);
  assert.equal(v.running, 0);
  assert.equal(v.history.length, 1);
  const h = v.history[0];
  assert.equal(h.outcome, 'done');
  assert.equal(h.tokens, 38000);
  assert.equal(h.durationMs, 252_000);
  assert.equal(h.endedAt, started + 252_000, 'the end time is the teardown, not the tick that noticed it');
  assert.equal(h.worktree, undefined, 'no worktree asked for');
  assert.ok(changes.n > 0, 'the renderer is told');

  // Persisted.
  const again = controller(s);
  assert.equal(again.view().history[0].id, id);
});

test('the cap holds: with 1 at once, the second waits queued until the first leaves', async () => {
  const s = scratch();
  const c = controller(s);
  c.setMax(1);
  const a = c.hire({ job: 'one', provider: 'claude', cwd: s.repo, isolate: false });
  const b = c.hire({ job: 'two', provider: 'claude', cwd: s.repo, isolate: false });
  await settle(c);
  const states = Object.fromEntries(c.view().active.map((t) => [t.id, t.state]));
  assert.equal(states[a.temp.id], 'starting');
  assert.equal(states[b.temp.id], 'queued');
  assert.equal(c.requestFiles().length, 1);

  // A stop before the controller took it reclaims the file: never started.
  assert.deepEqual(c.stop(a.temp.id), { ok: true });
  assert.equal(c.requestFiles().filter((f) => f.includes(a.temp.id)).length, 0);
  await settle(c);
  assert.equal(c.view().active.find((t) => t.id === b.temp.id).state, 'starting', 'the freed slot goes to the next in line');
  assert.equal(c.view().history[0].outcome, 'stopped');
  assert.equal(c.view().history[0].durationMs, null);

  // Cancelling a queued one.
  c.setMax(1);
  const d = c.hire({ job: 'three', provider: 'claude', cwd: s.repo, isolate: false });
  await settle(c);
  assert.equal(c.view().active.find((t) => t.id === d.temp.id).state, 'queued');
  assert.deepEqual(c.stop(d.temp.id), { ok: true });
  assert.ok(!c.view().active.some((t) => t.id === d.temp.id));
});

test('stopping a running temp hands back its worker id; the row says stopped', async () => {
  const s = scratch();
  const c = controller(s);
  const { temp } = c.hire({ job: 'Check every link in the docs', provider: 'codex', cwd: s.repo, isolate: false });
  await settle(c);
  pickUp(s, c, temp.id);
  writeRegistry(s, { [temp.workerId]: { archived: false, lastSeen: Date.now() } });
  await settle(c);
  assert.deepEqual(c.stop(temp.id), { ok: true, workerId: temp.workerId });
  writeRegistry(s, { [temp.workerId]: { archived: true, lastSeen: Date.now() } });
  await settle(c);
  c.view().active[0].endedAt -= 60_000;
  await settle(c);
  const h = c.view().history[0];
  assert.equal(h.outcome, 'stopped');
  assert.equal(h.tokens, null, 'no ledger rows → unknown, not zero');
});

test('a rejected hire carries the reason the controller told the orchestrator', async () => {
  const s = scratch();
  const c = controller(s);
  const { temp } = c.hire({ job: 'x', provider: 'codex', cwd: s.repo, isolate: false });
  await settle(c);
  pickUp(s, c, temp.id);
  writeRegistry(s, {}, 'michael-1');
  fs.mkdirSync(path.join(s.hive, 'spawn-requests', '.failed'), { recursive: true });
  fs.writeFileSync(path.join(s.hive, 'spawn-requests', '.failed', `${temp.id}.json`), '{}');
  const inbox = path.join(s.hive, 'agents', 'michael-1', 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, '0001.json'), JSON.stringify({
    subject: '[worker spawn rejected] engine CLI "codex" is not installed',
    body: `Spawn-request ${temp.id}.json rejected: engine CLI "codex" is not installed.`
  }));
  await settle(c);
  const h = c.view().history[0];
  assert.equal(h.outcome, 'failed');
  assert.equal(h.error, 'engine CLI "codex" is not installed');
});

test('a worktree still on disk at the end counts as kept when git cannot clear it', async () => {
  const s = scratch();
  const c = controller(s);
  const { temp } = c.hire({ job: 'refactor', provider: 'claude', cwd: s.repo, isolate: true });
  await settle(c);
  pickUp(s, c, temp.id);
  writeRegistry(s, { [temp.workerId]: { archived: false, lastSeen: Date.now() } });
  await settle(c);
  // Where spawnAgentCore puts it; not a git checkout, so git cannot vouch for it.
  const wt = path.join(s.home, 'worktrees', temp.workerId);
  fs.mkdirSync(wt, { recursive: true });
  writeRegistry(s, { [temp.workerId]: { archived: true, lastSeen: Date.now() } });
  await settle(c);
  c.view().active[0].endedAt -= 60_000;
  await settle(c);
  const h = c.view().history[0];
  assert.equal(h.outcome, 'ended', 'no done signal');
  assert.equal(h.worktree.path, wt);
  assert.equal(h.worktree.kept, true);
});

test('validation: bad requests and a missing folder are refused before anything queues', () => {
  const s = scratch();
  const c = controller(s);
  assert.deepEqual(c.hire({ job: '', provider: 'claude', cwd: s.repo }), { ok: false, error: 'job' });
  assert.deepEqual(c.hire({ job: 'x', provider: 'claude', cwd: path.join(s.home, 'nope') }), { ok: false, error: 'cwd' });
  assert.deepEqual(c.hire({ job: 'x', provider: 'custom', cwd: s.repo }), { ok: false, error: 'provider' });
  const noHive = new TempsController({ dataDir: s.data, harnessHome: () => null, claudeCommand: () => undefined, onChange: () => {} });
  assert.deepEqual(noHive.hire({ job: 'x', provider: 'claude', cwd: s.repo }), { ok: false, error: 'noHive' });
  assert.deepEqual(c.stop('temp-nope'), { ok: false, error: 'not found' });
  assert.equal(c.view().active.length, 0);
});

test('after an app restart a temp that was running settles as interrupted, not stuck holding a slot', async () => {
  const s = scratch();
  const c = controller(s);
  const { temp } = c.hire({ job: 'long job', provider: 'claude', cwd: s.repo, isolate: false });
  await settle(c);
  pickUp(s, c, temp.id);
  writeRegistry(s, { [temp.workerId]: { archived: false, lastSeen: Date.now() } });
  await settle(c);
  assert.equal(c.view().active[0].state, 'running');
  c.dispose();

  const after = controller(s);
  const rec = after.view().active[0];
  assert.equal(rec.state, 'finishing');
  assert.equal(rec.outcome, 'interrupted');
  assert.equal(after.view().running, 0);
  rec.endedAt -= 60_000;
  await settle(after);
  assert.equal(after.view().history[0].outcome, 'interrupted');
});
