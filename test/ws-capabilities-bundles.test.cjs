/**
 * Workspace Capabilities — the eleven role bundles are DATA that points at
 * other people's lists (the MCP catalog, the integration templates, the app's
 * own skills folder). A typo there fails silently: the bundle card would show a
 * "missing" row for something that exists. These pin every reference.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { ROLE_BUNDLES, FEATURED_BUNDLE_IDS, roleBundle } = loadTs('src/shared/workspace/capabilitiesBundles.ts');
const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');
const { INTEGRATION_TEMPLATES } = loadTs('src/shared/integrations.ts');

const SKILLS_DIR = path.resolve(__dirname, '..', 'resources', 'skills');
const I18N_DIR = path.resolve(__dirname, '..', 'src', 'renderer', 'src', 'i18n', 'features');

test('there are exactly eleven bundles with unique slug ids', () => {
  assert.equal(ROLE_BUNDLES.length, 11);
  const ids = ROLE_BUNDLES.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9-]*$/);
});

test('the five featured bundles exist and lead the list in order', () => {
  assert.deepEqual(FEATURED_BUNDLE_IDS, ROLE_BUNDLES.slice(0, 5).map((b) => b.id));
  for (const id of FEATURED_BUNDLE_IDS) assert.ok(roleBundle(id));
  assert.equal(roleBundle('nope'), undefined);
});

test('every MCP reference is a catalog id', () => {
  const ids = new Set(MCP_CATALOG.map((e) => e.id));
  for (const b of ROLE_BUNDLES) for (const id of b.mcp) assert.ok(ids.has(id), `${b.id}: unknown MCP id ${id}`);
});

test('every connection reference is an integration template', () => {
  const ids = new Set(INTEGRATION_TEMPLATES.map((t) => t.idSuggestion));
  for (const b of ROLE_BUNDLES) for (const id of b.connections) assert.ok(ids.has(id), `${b.id}: unknown template ${id}`);
});

test('every built-in skill reference is a folder with a SKILL.md in resources/skills', () => {
  for (const b of ROLE_BUNDLES) {
    for (const s of b.skills) {
      if (s.kind !== 'builtin') continue;
      assert.ok(fs.existsSync(path.join(SKILLS_DIR, s.id, 'SKILL.md')), `${b.id}: no built-in skill ${s.id}`);
    }
  }
});

test('catalog references are owner + name pairs in the shape the parser reports', () => {
  for (const b of ROLE_BUNDLES) {
    for (const s of b.skills) {
      if (s.kind !== 'catalog') continue;
      assert.match(s.owner, /^[a-z0-9-]+$/, `${b.id}: owner must be the lower-cased GitHub owner`);
      assert.ok(s.name && !/\s/.test(s.name), `${b.id}: ${s.name}`);
    }
  }
});

test('the spec\'s promises are kept: the engineer gets code, git, GitHub, docs, a database and an audit skill', () => {
  const se = roleBundle('software-engineer');
  for (const id of ['filesystem', 'git', 'github-token', 'context7', 'db']) assert.ok(se.mcp.includes(id), id);
  assert.ok(se.connections.includes('github'));
  assert.ok(se.skills.some((s) => s.kind === 'builtin' && s.id === 'md-audit'));
  const pm = roleBundle('product-manager');
  assert.ok(pm.mcp.includes('email-calendar') && pm.mcp.includes('search-with-key'));
  assert.ok(pm.connections.includes('linear') || pm.connections.includes('jira'));
});

test('every bundle and gap has a name in all three languages', () => {
  for (const lng of ['en', 'zh-CN', 'ar']) {
    const json = JSON.parse(fs.readFileSync(path.join(I18N_DIR, `wsCapabilities.${lng}.json`), 'utf8'));
    for (const b of ROLE_BUNDLES) {
      assert.ok(json.bundles?.[b.id]?.name, `${lng}: bundles.${b.id}.name`);
      assert.ok(json.bundles?.[b.id]?.summary, `${lng}: bundles.${b.id}.summary`);
      for (const g of b.gaps) assert.ok(json.gaps?.[g], `${lng}: gaps.${g}`);
    }
  }
});
