/**
 * Workspace Capabilities — the pure logic behind per-agent grants
 * (src/shared/workspace/capabilities.ts).
 *
 * Worth pinning: the grant record is the ONE atomic unit a bundle writes, so its
 * normalisation must drop anything that could reach a spawn as more than an id;
 * the bundle diff must tell "already has it" from "will add" from "cannot" (a
 * bundle that over-promises is worse than one that says what is missing); the
 * spawn overlay must never let the hive write a secret server's blank key for an
 * agent that has the real one; and the matrix must say "restart to apply" only
 * when the live process really is behind.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const C = loadTs('src/shared/workspace/capabilities.ts');
const { roleBundle } = loadTs('src/shared/workspace/capabilitiesBundles.ts');

/* ───────────────────────────── ids & records ────────────────────────────── */

test('item and agent ids reject separators and dot-dot', () => {
  for (const ok of ['docx', 'md-audit', 'github-token', 'a.b_c']) assert.ok(C.isCapabilityItemId(ok), ok);
  for (const bad of ['', '../x', 'a/b', 'a\\b', '.hidden', 'a..b', 'x'.repeat(65), 7]) assert.ok(!C.isCapabilityItemId(bad), String(bad));
  for (const ok of ['dwight-kq3x', 'worker-temp-1', '--kq3x', 'god']) assert.ok(C.isAgentId(ok), ok);
  for (const bad of ['', '.', '..', 'a/b', 'a..b', 'x'.repeat(129)]) assert.ok(!C.isAgentId(bad), bad);
});

test('normalizeGrant drops unknown MCP ids, junk and duplicates', () => {
  const g = C.normalizeGrant({
    skills: ['docx', 'docx', '../etc', 3],
    mcp: ['git', 'not-a-server', 'github-token'],
    connections: ['github', 'github'],
    bundle: 'software-engineer',
    role: '  Software Engineer  ',
    updatedAt: 42,
    extra: 'ignored'
  });
  assert.deepEqual(g, {
    skills: ['docx'], mcp: ['git', 'github-token'], connections: ['github'],
    bundle: 'software-engineer', role: 'Software Engineer', updatedAt: 42
  });
  assert.equal(C.normalizeGrant(null), null);
  assert.equal(C.normalizeGrant([]), null);
});

test('parseGrantsFile tolerates garbage and skips bad agent ids', () => {
  assert.deepEqual(C.parseGrantsFile('nope'), { version: 1, agents: {} });
  const f = C.parseGrantsFile({ agents: { 'dwight-1': { skills: ['pdf'], updatedAt: 1 }, '../x': { skills: ['pdf'] }, 'jim-2': 'bad' } });
  assert.deepEqual(Object.keys(f.agents), ['dwight-1']);
});

test('setGrantItem adds, removes, and returns the same object for a no-op', () => {
  const g0 = C.emptyGrant(1);
  const g1 = C.setGrantItem(g0, 'mcp', 'git', true, 10);
  assert.deepEqual(g1.mcp, ['git']);
  assert.equal(g1.updatedAt, 10);
  assert.equal(C.setGrantItem(g1, 'mcp', 'git', true, 11), g1, 'already on → same object (no write)');
  const g2 = C.setGrantItem(g1, 'mcp', 'git', false, 12);
  assert.deepEqual(g2.mcp, []);
  assert.equal(g2.updatedAt, 12);
  assert.ok(C.hasGrant(g1, 'mcp', 'git'));
  assert.ok(!C.hasGrant(undefined, 'mcp', 'git'));
  assert.ok(C.isEmptyGrant(g2));
});

/* ─────────────────────────────── skill dirs ─────────────────────────────── */

test('catalogSkillDirName mirrors installSkill: tree path tail, else the row name', () => {
  const dir = (url, name = 'x') => C.catalogSkillDirName({ name, url, owner: 'o' });
  assert.equal(dir('https://github.com/anthropics/skills/tree/main/skills/docx', 'docx'), 'docx');
  assert.equal(dir('https://github.com/coreyhaines31/marketingskills/tree/main/skills/emails', 'email-sequence'), 'emails');
  assert.equal(dir('https://github.com/Digidai/product-manager-skills', 'product-manager-skills'), 'product-manager-skills');
  assert.equal(dir('https://github.com/a/b/tree/main', 'whole-repo'), 'whole-repo');
  assert.equal(dir('https://github.com/a/b/blob/main/skills/x/SKILL.md', 'x'), null, 'a blob link is not installable');
  assert.equal(dir('https://github.com/a/b', 'MCP Server'), null, 'a name with spaces is not a folder');
  assert.equal(dir('https://example.com/x', 'x'), null);
});

/* ─────────────────────────────── bundle diff ────────────────────────────── */

const CATALOG = [
  { owner: 'obra', name: 'systematic-debugging', url: 'https://github.com/obra/superpowers/tree/main/skills/systematic-debugging' },
  { owner: 'obra', name: 'test-driven-development', url: 'https://github.com/obra/superpowers/tree/main/skills/test-driven-development' }
  // mattpocock/code-review deliberately absent → "not in catalog"
];

function ctx(over = {}) {
  return {
    builtinSkills: ['md-audit', 'capabilities'],
    machineSkills: ['test-driven-development'],
    agentSkills: [],
    catalog: CATALOG,
    connections: [{ id: 'gh', kind: 'github', enabled: true, hasSecret: true, authType: 'github' }],
    mcpKeys: {},
    mcpDefaults: undefined,
    ...over
  };
}

test('bundle diff: built-in and machine-wide skills are already had; catalog rows install for the agent', () => {
  const d = C.bundleGrantDiff(undefined, roleBundle('software-engineer'), ctx());
  const skill = (ref) => d.rows.find((r) => r.kind === 'skill' && r.ref === ref);
  assert.deepEqual(skill('md-audit'), { kind: 'skill', id: 'md-audit', ref: 'md-audit', state: 'has', note: 'builtin' });
  assert.equal(skill('obra/test-driven-development').state, 'has');
  assert.equal(skill('obra/test-driven-development').note, 'machine');
  assert.equal(skill('obra/systematic-debugging').state, 'add');
  assert.equal(skill('obra/systematic-debugging').note, 'install');
  assert.equal(skill('mattpocock/code-review').state, 'missing');
  assert.equal(skill('mattpocock/code-review').note, 'notInCatalog');
  assert.deepEqual(d.add.skills, ['systematic-debugging']);
  assert.deepEqual(d.installs.map((i) => i.dir), ['systematic-debugging']);
});

test('bundle diff: an unloaded catalog says so instead of claiming the skill does not exist', () => {
  const d = C.bundleGrantDiff(undefined, roleBundle('software-engineer'), ctx({ catalog: null }));
  assert.equal(d.rows.find((r) => r.ref === 'obra/systematic-debugging').note, 'catalogOffline');
});

test('bundle diff: MCP — safe defaults already on, secret servers need a key, connections match by kind', () => {
  const d = C.bundleGrantDiff(undefined, roleBundle('software-engineer'), ctx());
  const mcp = (id) => d.rows.find((r) => r.kind === 'mcp' && r.id === id);
  assert.equal(mcp('filesystem').state, 'has');    // safe-readonly, default on
  assert.equal(mcp('github-token').state, 'addNeeds');
  assert.equal(mcp('github-token').note, 'needsKey');
  assert.deepEqual(d.add.mcp, ['github-token', 'db']);
  const conn = d.rows.find((r) => r.kind === 'connection');
  assert.deepEqual(conn, { kind: 'connection', id: 'gh', ref: 'github', state: 'add', note: undefined });
  assert.deepEqual(d.add.connections, ['gh']);

  const keyed = C.bundleGrantDiff(undefined, roleBundle('software-engineer'), ctx({ mcpKeys: { 'github-token': true } }));
  assert.equal(keyed.rows.find((r) => r.id === 'github-token').state, 'add');
});

test('bundle diff: a globally switched-off safe server is added per agent', () => {
  const d = C.bundleGrantDiff(undefined, roleBundle('software-engineer'), ctx({ mcpDefaults: { git: { enabled: false } } }));
  assert.ok(d.add.mcp.includes('git'));
});

test('bundle diff: connections that are not set up, off, or keyless are reported', () => {
  const pm = roleBundle('product-manager');
  const none = C.bundleGrantDiff(undefined, pm, ctx({ connections: [] }));
  assert.deepEqual(none.rows.filter((r) => r.kind === 'connection').map((r) => [r.ref, r.state, r.note]),
    [['linear', 'missing', 'notSetUp'], ['jira', 'missing', 'notSetUp']]);
  const off = C.bundleGrantDiff(undefined, pm, ctx({ connections: [
    { id: 'linear', kind: 'custom-rest', enabled: false, hasSecret: true, authType: 'header' },
    { id: 'jira', kind: 'custom-rest', enabled: true, hasSecret: false, authType: 'header' }
  ] }));
  assert.deepEqual(off.rows.filter((r) => r.kind === 'connection').map((r) => [r.id, r.state, r.note]),
    [['linear', 'addNeeds', 'disabled'], ['jira', 'addNeeds', 'needsKey']]);
  assert.deepEqual(off.gaps, ['oauthMail']);
});

test('applyBundleToGrant is a union that sets the role; re-applying is a no-op diff', () => {
  const se = roleBundle('software-engineer');
  const hand = { skills: ['my-skill'], mcp: ['time'], connections: [], updatedAt: 5 };
  const d = C.bundleGrantDiff(hand, se, ctx({ mcpKeys: { 'github-token': true, db: true } }));
  const g = C.applyBundleToGrant(hand, d, 100);
  assert.deepEqual(g.skills, ['my-skill', 'systematic-debugging']);
  assert.deepEqual(g.mcp, ['time', 'github-token', 'db']);
  assert.deepEqual(g.connections, ['gh']);
  assert.equal(g.bundle, 'software-engineer');
  assert.equal(g.role, 'Software Engineer');
  assert.equal(g.updatedAt, 100);

  const again = C.bundleGrantDiff(g, se, ctx({ mcpKeys: { 'github-token': true, db: true }, agentSkills: ['systematic-debugging'] }));
  assert.equal(again.noop, true);
  // Granted but not on disk yet → the bundle retries the install, no new grant.
  const retry = C.bundleGrantDiff(g, se, ctx({ mcpKeys: { 'github-token': true, db: true } }));
  assert.deepEqual(retry.add.skills, []);
  assert.deepEqual(retry.installs.map((i) => i.dir), ['systematic-debugging']);
  assert.equal(retry.noop, false);
});

/* ───────────────────────────── spawn overlay ────────────────────────────── */

test('mcpSpawnOverlay: safe grants switch on; secret grants leave the hive map and ride keyed', () => {
  const grant = { skills: [], mcp: ['git', 'github-token', 'db'], connections: [], updatedAt: 1 };
  const o = C.mcpSpawnOverlay(grant, { git: { enabled: false }, 'github-token': { enabled: true } }, { 'github-token': true });
  assert.deepEqual(o.mcpDefaults.git, { enabled: true });
  assert.deepEqual(o.mcpDefaults['github-token'], { enabled: false }, 'no blank-key copy for this agent');
  assert.deepEqual(o.mcpDefaults.db, { enabled: false });
  assert.deepEqual(o.keyed, ['github-token']);
  assert.deepEqual(o.skippedNoKey, ['db']);
  // No grant → the global map, untouched.
  const g = { time: { enabled: false } };
  assert.deepEqual(C.mcpSpawnOverlay(undefined, g, {}).mcpDefaults, g);
});

test('secret MCP env names and key refs come from the catalog', () => {
  assert.equal(C.mcpSecretEnvName('github-token'), 'GITHUB_PERSONAL_ACCESS_TOKEN');
  assert.equal(C.mcpSecretEnvName('db'), 'DATABASE_URL');
  assert.equal(C.mcpSecretEnvName('git'), null);
  assert.equal(C.mcpKeyRef('db'), 'mcpkey:db');
  assert.deepEqual(C.secretMcpIds(), ['github-token', 'db', 'email-calendar', 'search-with-key']);
});

/* ───────────────────────────── who has what ─────────────────────────────── */

function whoInput(over = {}) {
  return {
    agents: [
      { id: 'jim', name: 'Jim', provider: 'claude', live: true },
      { id: 'god', name: 'Michael', provider: 'claude', live: true, isGod: true },
      { id: 'kev', name: 'Kevin', provider: 'codex', live: true }
    ],
    grants: {
      jim: { skills: ['docx', 'pdf'], mcp: ['github-token', 'db'], connections: ['gh', 'gone'], updatedAt: 50 },
      ghost: { skills: ['never-shown'], mcp: ['time'], connections: [], updatedAt: 1 }
    },
    machineSkills: ['zeta', 'alpha'],
    agentSkills: { jim: ['docx'] },
    mcpDefaults: undefined,
    mcpKeys: { db: true },
    connections: [{ id: 'gh', label: 'GitHub', enabled: true, hasSecret: true, authType: 'github' }],
    appliedAt: { jim: 50 },
    ...over
  };
}

test('matrix columns: machine skills, then per-agent ones; only MCP someone has; grants of agents off the floor ignored', () => {
  const m = C.buildWhoHasWhat(whoInput());
  assert.deepEqual(m.columns.map((c) => c.key), [
    'skill:alpha', 'skill:zeta', 'skill:docx', 'skill:pdf',
    'mcp:sequential-thinking', 'mcp:time', 'mcp:fetch', 'mcp:context7', 'mcp:filesystem', 'mcp:git',
    'mcp:github-token', 'mcp:db',
    'connection:gh', 'connection:gone'
  ]);
  assert.ok(!m.columns.some((c) => c.id === 'never-shown'));
});

test('matrix cells: everyone / granted / missing / needsKey / unsupported, god first', () => {
  const m = C.buildWhoHasWhat(whoInput());
  assert.deepEqual(m.rows.map((r) => r.agent.id), ['god', 'jim', 'kev']);
  const jim = m.rows.find((r) => r.agent.id === 'jim').cells;
  assert.equal(jim['skill:alpha'], 'everyone');
  assert.equal(jim['skill:docx'], 'granted');
  assert.equal(jim['skill:pdf'], 'missing', 'granted but not on disk');
  assert.equal(jim['mcp:git'], 'everyone');
  assert.equal(jim['mcp:github-token'], 'needsKey');
  assert.equal(jim['mcp:db'], 'granted');
  assert.equal(jim['connection:gh'], 'granted');
  assert.equal(jim['connection:gone'], 'needsKey', 'a granted record that no longer exists cannot work');
  const god = m.rows.find((r) => r.agent.id === 'god').cells;
  assert.equal(god['mcp:db'], 'none');
  assert.equal(god['connection:gh'], 'none');
  const kev = m.rows.find((r) => r.agent.id === 'kev').cells;
  assert.equal(kev['skill:alpha'], 'unsupported');
  assert.equal(kev['mcp:git'], 'unsupported');
});

test('restart to apply: only a live agent whose grant is newer than its spawn', () => {
  const later = C.buildWhoHasWhat(whoInput({ appliedAt: { jim: 10 } }));
  const jim = later.rows.find((r) => r.agent.id === 'jim');
  assert.equal(jim.pendingRestart, true);
  assert.equal(jim.cells['mcp:db'], 'pending');
  assert.equal(jim.cells['skill:docx'], 'pending');
  const off = C.buildWhoHasWhat(whoInput({
    appliedAt: {},
    agents: [{ id: 'jim', name: 'Jim', provider: 'claude', live: false }]
  }));
  assert.equal(off.rows[0].pendingRestart, false, 'an agent that is not running has nothing to restart');
});
