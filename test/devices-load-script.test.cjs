'use strict';
/**
 * Devices, Task 12: the two scripts. The smoke script SSHes to a real device
 * and is run by hand only, so here it is only parsed. The load sampler runs
 * for real, with 3 samples and no wait.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const smoke = path.join(root, 'scripts/devices-smoke.sh');
const load = path.join(root, 'scripts/devices-load.sh');

test('both scripts parse', () => {
  for (const s of [smoke, load]) execFileSync('bash', ['-n', s]);
});

test('the load sampler writes its CSV and the summary', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-devices-load-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = execFileSync('bash', [load, 'selftest', '3', '0'], { env: { ...process.env, DEVICES_LOAD_DIR: dir }, encoding: 'utf8' });
  assert.match(out, /^samples=3 load1_p50=\d+\.\d+ load1_p95=\d+\.\d+$/m);
  assert.match(out, /^mem_available_min_mb=\d+$/m);
  const csv = fs.readFileSync(path.join(dir, 'devices-load-selftest.csv'), 'utf8').trim().split('\n');
  assert.equal(csv[0], 'epoch,load1,mem_available_mb');
  assert.equal(csv.length, 4);
});
