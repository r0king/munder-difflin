'use strict';

/**
 * MemoryManager.resolveBin / refreshAsync — finding the mempalace CLI without
 * blocking the main process.
 *
 * bin() looks synchronously through a login shell (up to 3s). The Workspace's
 * meaning search and the memory status poll now await resolveBin() first, so
 * these pin what that relies on: one shared lookup, its answer in the same
 * cache bin() reads, a missing CLI looked for again, the old answer serving
 * while a fresh look runs, and refreshAsync arming the mine loop exactly like
 * refresh() (see memory-rearm.test.cjs).
 *
 * The lookup itself is stubbed: the real one probes this machine's PATH.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { MemoryManager } = loadTs('src/main/memory.ts');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A manager whose async lookup answers `state.bin` and counts its calls. */
function manager(t, opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-memory-bin-'));
  const state = { bin: opts.bin ?? null, lookups: 0, gate: null };
  const memory = new MemoryManager(() => home, () => ({ enabled: true, model: 'minilm' }));
  memory.lookupBinAsync = async () => {
    state.lookups++;
    if (state.gate) await state.gate.promise;
    if (state.bin instanceof Error) throw state.bin;
    return state.bin;
  };
  t.after(() => { memory.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  return { memory, state };
}

test('concurrent callers share one lookup, and bin() then answers from its cache', async (t) => {
  const { memory, state } = manager(t, { bin: '/fake/bin/mempalace' });
  const [a, b] = await Promise.all([memory.resolveBin(), memory.resolveBin()]);
  assert.equal(a, '/fake/bin/mempalace');
  assert.equal(b, '/fake/bin/mempalace');
  assert.equal(state.lookups, 1);
  // The synchronous path never runs again: the answer is already cached.
  assert.equal(memory.bin(), '/fake/bin/mempalace');
  assert.equal(memory.status().available, true);
});

test('a found CLI is kept; only `fresh` looks again', async (t) => {
  const { memory, state } = manager(t, { bin: '/fake/bin/mempalace' });
  await memory.resolveBin();
  await memory.resolveBin();
  assert.equal(state.lookups, 1);
  state.bin = '/moved/bin/mempalace';
  assert.equal(await memory.resolveBin({ fresh: true }), '/moved/bin/mempalace');
  assert.equal(state.lookups, 2);
});

test('a missing CLI is looked for again, so an install needs no restart', async (t) => {
  const { memory, state } = manager(t);
  assert.equal(await memory.resolveBin(), null);
  assert.equal(memory.status().available, false);
  state.bin = '/fake/bin/mempalace';
  assert.equal(await memory.resolveBin(), '/fake/bin/mempalace');
  assert.equal(state.lookups, 2);
  assert.equal(memory.status().available, true);
});

test('while a fresh look runs, the previous answer keeps serving bin()', async (t) => {
  const { memory, state } = manager(t, { bin: '/old/mempalace' });
  await memory.resolveBin();
  state.gate = deferred();
  state.bin = '/new/mempalace';
  const pending = memory.resolveBin({ fresh: true });
  assert.equal(memory.bin(), '/old/mempalace', 'no fall-back to the blocking lookup mid-flight');
  state.gate.resolve();
  assert.equal(await pending, '/new/mempalace');
  assert.equal(memory.bin(), '/new/mempalace');
});

test('a lookup that fails reads as "not installed" and clears the in-flight slot', async (t) => {
  const { memory, state } = manager(t);
  state.bin = new Error('spawn EACCES');
  assert.equal(await memory.resolveBin(), null);
  assert.equal(memory.bin(), null);
  state.bin = '/fake/bin/mempalace';
  assert.equal(await memory.resolveBin(), '/fake/bin/mempalace');
});

test('refreshAsync arms the mine loop after a late install, once', async (t) => {
  const { memory, state } = manager(t);
  memory.start();
  assert.equal(memory.mineTimer, null, 'nothing to start before the install');
  assert.equal((await memory.refreshAsync()).available, false);
  assert.equal(memory.mineTimer, null);

  state.bin = '/fake/bin/mempalace';
  const status = await memory.refreshAsync();
  assert.equal(status.available, true);
  assert.equal(status.active, true);
  const timer = memory.mineTimer;
  assert.notEqual(timer, null);
  await memory.refreshAsync();
  assert.equal(memory.mineTimer, timer, 'one writer, one loop');
  assert.equal(state.lookups, 3, 'every poll looks afresh, like refresh()');
});
