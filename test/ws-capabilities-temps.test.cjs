/**
 * Workspace Capabilities → Temps — the pure half of "hire an agent for one job"
 * (src/shared/workspace/capabilitiesTemps.ts).
 *
 * A temp leaves a row behind: the job, how long it ran, the tokens it used, and
 * any worktree it kept. Each of those is computed here, and each has a way to be
 * silently wrong — a token total that counts a cumulative counter twice (or
 * forgets the half before an app restart), a duration measured from the click
 * instead of the start, a worktree reported "kept" when git could not say. The
 * queue rule ("1 of 3 running") is pinned too.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const T = loadTs('src/shared/workspace/capabilitiesTemps.ts');

const rec = (over = {}) => ({
  id: 'temp-a', workerId: 'worker-temp-a', job: 'Translate the changelog', provider: 'claude',
  cwd: '/repo', isolate: true, state: 'queued', createdAt: 1000, ...over
});

/* ──────────────────────────────── requests ──────────────────────────────── */

test('validateTempRequest: job, engine and folder are required; model is shape-checked', () => {
  const ok = T.validateTempRequest({ job: '  Check every link in the docs ', provider: 'claude', cwd: '/r', model: 'claude-opus-4-5' });
  assert.deepEqual(ok, { ok: true, value: { job: 'Check every link in the docs', provider: 'claude', model: 'claude-opus-4-5', cwd: '/r', isolate: true } });
  assert.equal(T.validateTempRequest({ job: 'x', provider: 'claude', cwd: '/r', isolate: false }).value.isolate, false);
  assert.deepEqual(T.validateTempRequest({ job: ' ', provider: 'claude', cwd: '/r' }), { ok: false, error: 'job' });
  assert.deepEqual(T.validateTempRequest({ job: 'x'.repeat(4001), provider: 'claude', cwd: '/r' }), { ok: false, error: 'jobTooLong' });
  assert.deepEqual(T.validateTempRequest({ job: 'x', provider: 'custom', cwd: '/r' }), { ok: false, error: 'provider' });
  assert.deepEqual(T.validateTempRequest({ job: 'x', provider: 'nope', cwd: '/r' }), { ok: false, error: 'provider' });
  assert.deepEqual(T.validateTempRequest({ job: 'x', provider: 'claude', cwd: '' }), { ok: false, error: 'cwd' });
  assert.deepEqual(T.validateTempRequest({ job: 'x', provider: 'claude', cwd: '/r', model: 'opus & calc' }), { ok: false, error: 'model' });
  assert.deepEqual(T.validateTempRequest(null), { ok: false, error: 'bad request' });
});

test('ids, names and the command line', () => {
  const id = T.newTempId(1_700_000_000_000, () => 0.5);
  assert.match(id, /^temp-[a-z0-9]+-[a-z0-9]{4}$/);
  assert.equal(T.tempWorkerId(id), `worker-${id}`);
  assert.equal(T.tempDisplayName('\n  Translate   the changelog\nmore'), 'Translate the changelog');
  assert.equal(T.tempDisplayName('x'.repeat(60)).length, 40);
  assert.equal(T.tempCommandLine('claude', undefined, 'claude'), 'claude');
  assert.equal(T.tempCommandLine('claude', 'claude-opus-4-5', '/opt/bin/claude'), '/opt/bin/claude --model claude-opus-4-5');
  assert.equal(T.tempCommandLine('antigravity', 'Gemini 3.1 Pro (High)').endsWith('"Gemini 3.1 Pro (High)"'), true);
});

/* ─────────────────────────────── the queue ──────────────────────────────── */

test('the cap: queued temps start oldest first, never past the limit', () => {
  const active = [
    rec({ id: 'temp-1', state: 'running' }),
    rec({ id: 'temp-2', state: 'queued', createdAt: 30 }),
    rec({ id: 'temp-3', state: 'queued', createdAt: 20 }),
    rec({ id: 'temp-4', state: 'finishing' }),
    rec({ id: 'temp-5', state: 'starting' })
  ];
  assert.equal(T.runningCount(active), 2, 'finishing has left the floor; it no longer holds a slot');
  assert.deepEqual(T.nextToSubmit(active, 3).map((t) => t.id), ['temp-3']);
  assert.deepEqual(T.nextToSubmit(active, 4).map((t) => t.id), ['temp-3', 'temp-2']);
  assert.deepEqual(T.nextToSubmit(active, 2), []);
  assert.equal(T.clampMaxTemps(0), 1);
  assert.equal(T.clampMaxTemps(99), 8);
  assert.equal(T.clampMaxTemps('3'), 3);
});

/* ──────────────────────────────── tokens ────────────────────────────────── */

const row = (agent, session, total, extra = {}) => JSON.stringify({
  agent_id: agent, session_id: session, ts: 1, input: total, output: 0, cache_read: 0, cache_creation: 0, model: 'm', usd: 0, ...extra
});

test('token fold: peak of each cumulative session, summed; other agents ignored', () => {
  const lines = [
    row('worker-temp-a', 's1', 1000),
    row('worker-temp-a', 's1', 25000),
    row('someone-else', 's9', 999999),
    row('worker-temp-a', 's1', 30000, { output: 8000 }),
    row('worker-temp-a', 's2', 500),
    'not json',
    ''
  ];
  assert.equal(T.foldLedgerTokens(lines, 'worker-temp-a'), 38000 + 500);
  assert.equal(T.foldLedgerTokens(lines, 'nobody'), null, 'no rows → unknown, not zero');
});

test('token fold: a counter reset inside one session keeps the earlier peak', () => {
  const lines = [row('w', 's', 10000), row('w', 's', 20000), row('w', 's', 300), row('w', 's', 4000)];
  assert.equal(T.foldLedgerTokens(lines, 'w'), 24000);
});

test('token fold: an agent id that is a prefix of another does not steal its rows', () => {
  const lines = [row('worker-temp-a', 's', 100), row('worker-temp-ab', 's', 5000)];
  assert.equal(T.foldLedgerTokens(lines, 'worker-temp-a'), 100);
});

/* ─────────────────────────────── settling ───────────────────────────────── */

test('outcome: failed wins, then a done signal, then a stop, else ended', () => {
  assert.equal(T.settleOutcome({ outcome: 'failed' }, true), 'failed');
  assert.equal(T.settleOutcome({ stopRequested: true }, true), 'done');
  assert.equal(T.settleOutcome({ stopRequested: true }, false), 'stopped');
  assert.equal(T.settleOutcome({}, false), 'ended');
  assert.equal(T.settleOutcome({ outcome: 'interrupted' }, false), 'interrupted');
});

test('kept-worktree verdict: gone → not kept; on disk → git decides; unknown → kept', () => {
  assert.equal(T.worktreeVerdict({ isolate: false, path: '/w', exists: true, unmerged: null }), undefined);
  assert.equal(T.worktreeVerdict({ isolate: true, path: null, exists: false, unmerged: null }), undefined);
  assert.deepEqual(T.worktreeVerdict({ isolate: true, path: '/w', exists: false, unmerged: null }), { path: '/w', kept: false });
  assert.deepEqual(
    T.worktreeVerdict({ isolate: true, path: '/w', exists: true, unmerged: { keep: true, branch: 'agent/x', detail: '2 commits ahead' } }),
    { path: '/w', kept: true, branch: 'agent/x', detail: '2 commits ahead' }
  );
  assert.equal(T.worktreeVerdict({ isolate: true, path: '/w', exists: true, unmerged: { keep: false } }).kept, false);
  assert.deepEqual(T.worktreeVerdict({ isolate: true, path: '/w', exists: true, unmerged: null }), { path: '/w', kept: true, detail: 'unknown' });
});

test('history row: duration from start (not the click), tokens and worktree carried', () => {
  const r = T.buildHistoryRow(rec({ startedAt: 10_000, model: 'm1' }), {
    endedAt: 10_000 + 252_000, outcome: 'done', tokens: 38000, worktree: { path: '/w', kept: true }
  });
  assert.equal(r.durationMs, 252_000);
  assert.equal(T.formatDuration(r.durationMs), '4m 12s');
  assert.equal(T.formatTokens(r.tokens), '38k');
  assert.equal(r.model, 'm1');
  assert.deepEqual(r.worktree, { path: '/w', kept: true });
  const never = T.buildHistoryRow(rec({ error: 'engine CLI "codex" is not installed' }), { endedAt: 5, outcome: 'failed', tokens: null });
  assert.equal(never.durationMs, null);
  assert.equal(never.error, 'engine CLI "codex" is not installed');
});

test('history is newest first, bounded, and replaces a row for the same temp', () => {
  let h = [];
  for (let i = 0; i < 5; i++) h = T.pushHistory(h, { id: `temp-${i}`, endedAt: i }, 3);
  assert.deepEqual(h.map((r) => r.id), ['temp-4', 'temp-3', 'temp-2']);
  h = T.pushHistory(h, { id: 'temp-3', endedAt: 9 }, 3);
  assert.deepEqual(h.map((r) => r.id), ['temp-3', 'temp-4', 'temp-2']);
});

test('parseTempsFile keeps valid records and drops the rest', () => {
  const f = T.parseTempsFile({
    maxConcurrent: 50,
    active: [rec({ state: 'running', startedAt: 5 }), rec({ id: 'evil/../x' }), rec({ state: 'weird' })],
    history: [
      { id: 'temp-z', job: 'j', provider: 'codex', outcome: 'done', endedAt: 9, durationMs: 4, tokens: 7, worktree: { path: '/w', kept: true } },
      { id: 'temp-y', job: 'j', provider: 'codex', outcome: 'exploded', endedAt: 9 }
    ]
  });
  assert.equal(f.maxConcurrent, 8);
  assert.deepEqual(f.active.map((a) => a.id), ['temp-a']);
  assert.equal(f.active[0].workerId, 'worker-temp-a');
  assert.deepEqual(f.history.map((h) => h.id), ['temp-z']);
  assert.deepEqual(f.history[0].worktree, { path: '/w', kept: true });
  assert.deepEqual(T.parseTempsFile(null), { version: 1, maxConcurrent: 3, active: [], history: [] });
});

test('formatting', () => {
  assert.equal(T.formatDuration(45_000), '45s');
  assert.equal(T.formatDuration(160_000), '2m 40s');
  assert.equal(T.formatDuration(3_780_000), '1h 03m');
  assert.equal(T.formatDuration(null), '—');
  assert.equal(T.formatTokens(950), '950');
  assert.equal(T.formatTokens(1500), '1.5k');
  assert.equal(T.formatTokens(21_000), '21k');
  assert.equal(T.formatTokens(1_200_000), '1.2M');
  assert.equal(T.formatTokens(null), '—');
});
