/**
 * claude.ai connectors (Figma, Gmail, …) load into every Claude session by
 * default. Royal wants them only for the roles on `claudeAiConnectorRoles`
 * (default: Designer). Everyone else's per-session settings carry
 * `disableClaudeAiConnectors: true`, so the user's own sessions and
 * ~/.claude.json are never touched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const { HiveManager } = loadTs('src/main/hive.ts');

async function settingsFor(role, claudeAiConnectorRoles) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-connectors-'));
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent(
    { id: 'a-1', name: 'A', provider: 'claude', cwd: home, role },
    { claudeAiConnectorRoles }
  );
  return JSON.parse(fs.readFileSync(inj.args[inj.args.indexOf('--settings') + 1], 'utf8'));
}

test('a role on the allowlist keeps the claude.ai connectors (case-insensitive, exact)', async () => {
  assert.equal((await settingsFor('designer', ['Designer'])).disableClaudeAiConnectors, undefined);
});

test('every other role loses them, including one that merely contains the word', async () => {
  assert.equal((await settingsFor('Software Engineer', ['Designer'])).disableClaudeAiConnectors, true);
  assert.equal((await settingsFor('Motion-design engineer', ['Designer'])).disableClaudeAiConnectors, true);
  assert.equal((await settingsFor(undefined, ['Designer'])).disableClaudeAiConnectors, true);
});

test('no allowlist leaves every session as it was', async () => {
  assert.equal((await settingsFor('Software Engineer', undefined)).disableClaudeAiConnectors, undefined);
});
