#!/usr/bin/env node
/**
 * The standard screenshot set, on one Vite server + one Chromium:
 *
 *   node tools/screenshot-harness/shoot-all.mjs
 *   node tools/screenshot-harness/shoot-all.mjs --only classic-light,workspace-tasks-light
 *   node tools/screenshot-harness/shoot-all.mjs --out-dir /tmp/before   # e.g. before/after a change
 *
 * Writes <name>.png + <name>.json per shot and summary.json to
 * tools/screenshot-harness/out/ (or --out-dir), prints a summary table, and
 * exits 1 when any shot had an uncaught page error (2 on a harness failure).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startHarness, shoot, OUT_DIR, describeShot } from './shoot.mjs';
import { coverage } from './mock-cth.mjs';

export const STANDARD_SET = [
  { name: 'classic-light', mode: 'classic', theme: 'light' },
  { name: 'classic-dark', mode: 'classic', theme: 'dark' },
  ...['orchestrator', 'agents', 'tasks', 'inbox', 'automations', 'memory', 'capabilities', 'stapler']
    .map((route) => ({ name: `workspace-${route}-light`, mode: 'workspace', route, theme: 'light' })),
  { name: 'workspace-orchestrator-dark', mode: 'workspace', route: 'orchestrator', theme: 'dark' },
  { name: 'stapler-puck', entry: 'stapler', hash: 'puck', theme: 'light' },
  { name: 'stapler-overlay', entry: 'stapler', hash: 'overlay', theme: 'light' }
];

function table(rows) {
  const head = ['file', 'size', 'console errors', 'uncaught', 'csp', 'fallback', 'status'];
  const body = rows.map((r) => [
    relative(process.cwd(), r.pngPath ?? r.png ?? r.name),
    r.pngBytes ? `${(r.pngBytes / 1024).toFixed(0)} KB` : '-',
    String(r.consoleErrors?.length ?? '-'),
    String(r.pageErrors?.length ?? '-'),
    String(r.cspViolations?.length ?? '-'),
    String(Object.keys(r.fallbackCalls ?? {}).length),
    r.harnessError ? 'HARNESS' : r.pageErrors?.length ? 'FAIL' : 'ok'
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      only: { type: 'string' },
      'out-dir': { type: 'string' },
      concurrency: { type: 'string' },
      platform: { type: 'string' },
      settle: { type: 'string' },
      csp: { type: 'string' },
      port: { type: 'string' },
      verbose: { type: 'boolean', short: 'v' }
    }
  });
  const outDir = values['out-dir'] ? resolve(process.cwd(), values['out-dir']) : OUT_DIR;
  mkdirSync(outDir, { recursive: true });
  const only = values.only ? new Set(values.only.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const shots = STANDARD_SET.filter((s) => !only || only.has(s.name));
  if (!shots.length) {
    console.error(`no shots match --only ${values.only}; known: ${STANDARD_SET.map((s) => s.name).join(', ')}`);
    return 2;
  }
  const concurrency = Math.max(1, Number(values.concurrency ?? 2));

  try {
    const c = coverage();
    console.log(`[harness] preload: ${c.total} members, ${c.mocked} mocked explicitly, ${c.fallbackOnly.length} on the Proxy fallback (node tools/screenshot-harness/mock-cth.mjs --coverage)`);
  } catch (err) {
    console.log(`[harness] coverage check skipped: ${err.message}`);
  }

  const t0 = Date.now();
  let harness;
  try {
    harness = await startHarness({ csp: values.csp, port: values.port });
  } catch (err) {
    console.error(`[harness] failed to start: ${err?.stack ?? err}`);
    return 2;
  }

  const results = new Array(shots.length);
  const run = async (i) => {
    const s = shots[i];
    const { name, ...opts } = s;
    try {
      results[i] = await shoot(harness, {
        ...opts,
        name,
        platform: values.platform,
        settle: values.settle,
        csp: values.csp,
        out: join(outDir, `${name}.png`)
      });
    } catch (err) {
      results[i] = { name, harnessError: String(err?.stack ?? err), pageErrors: [], consoleErrors: [], notes: [], pngBytes: 0, durationMs: 0, jsonPath: join(outDir, `${name}.json`) };
    }
    console.log(describeShot(results[i]));
  };

  try {
    // The first page alone: on a cold .vite-cache, Vite optimises deps on the
    // first request and may reload that page once; later pages then hit a
    // warm cache.
    await run(0);
    let next = 1;
    const worker = async () => { while (next < shots.length) await run(next++); };
    await Promise.all(Array.from({ length: Math.min(concurrency, shots.length - 1) }, worker));
  } finally {
    await harness.close();
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${table(results)}\n`);
  const failed = results.filter((r) => r.pageErrors?.length);
  const broken = results.filter((r) => r.harnessError);
  console.log(`${results.length} shots in ${elapsed}s · ${failed.length} with uncaught errors · ${broken.length} harness failures · ${relative(process.cwd(), outDir)}/`);
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({
    elapsedSec: Number(elapsed),
    shots: results.map((r) => ({
      name: r.name, png: r.png, pngBytes: r.pngBytes, ok: r.ok, harnessError: r.harnessError ?? null,
      consoleErrors: r.consoleErrors?.length ?? 0, pageErrors: r.pageErrors?.length ?? 0,
      firstError: r.pageErrors?.[0] ?? r.consoleErrors?.[0] ?? null,
      csp: r.cspViolations?.length ?? 0, fallback: r.fallbackCalls ?? {}
    }))
  }, null, 2));
  if (broken.length) return 2;
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => { console.error(err?.stack ?? err); process.exit(2); });
