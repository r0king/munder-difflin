/**
 * CAPABILITIES — the pure half of Workspace → Capabilities: what each agent has
 * been granted, what a role bundle would change, and the floor-wide "who has
 * what" matrix.
 *
 * Three kinds of capability, each riding a mechanism the app already had:
 *
 *   skill       a folder holding SKILL.md. Built-in skills are copied into every
 *               agent's own `.claude/skills/` at spawn (hive.copyBundledSkills);
 *               machine-wide ones in ~/.claude/skills reach every Claude Code
 *               agent. A per-agent grant puts the folder in THAT agent's own
 *               skills dir — the same place the built-ins already live.
 *   mcp         an MCP_CATALOG id. The global consent map (config.mcpDefaults)
 *               reaches every Claude Code agent; a per-agent grant layers on top
 *               of it at that agent's next spawn.
 *   connection  an integration record (shared/integrations.ts). Ephemeral
 *               workers get every enabled one through the loopback broker; a
 *               per-agent grant gives a regular agent its own broker token
 *               scoped to just the granted ids.
 *
 * Grants are stored per agent as ONE record, so "set this agent up" — one
 * toggle or a whole role bundle — is always a single atomic write of that
 * record (main/features/capabilities). Nothing here touches disk.
 */
import { MCP_CATALOG, mcpCatalogEntry } from '../mcpCatalog';

/* ───────────────────────────────── records ──────────────────────────────── */

export type CapabilityKind = 'skill' | 'mcp' | 'connection';

export const CAPABILITY_KINDS: readonly CapabilityKind[] = ['skill', 'mcp', 'connection'];

/** One agent's own grants. The arrays hold ids, never specs or secrets. */
export interface AgentGrant {
  /** Skill folder names placed in this agent's own skills dir. */
  skills: string[];
  /** MCP_CATALOG ids enabled for this agent on top of the global defaults. */
  mcp: string[];
  /** Integration record ids this agent may reach through the broker. */
  connections: string[];
  /** The role bundle last applied, if any. */
  bundle?: string;
  /** The job string that bundle set (also written to the hive registry). */
  role?: string;
  /** epoch ms of the last write — compared against the grant an agent was
   *  spawned with to tell "restart to apply" apart from "applied". */
  updatedAt: number;
}

export interface GrantsFile {
  version: 1;
  agents: Record<string, AgentGrant>;
}

/** Caps that keep a hand-edited or hostile file from growing without bound. */
export const MAX_GRANT_ITEMS = 64;
export const MAX_GRANT_AGENTS = 500;
const MAX_ROLE_CHARS = 200;

/** Skill folder / MCP id / integration id: a plain slug, the same shape
 *  main/skills.ts `safeSkillDirName` accepts — no separators, no dot-dot. */
const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Agent ids are `<name-slug>-<base36>`, `worker-<req>`, `god`… A name made only
 *  of non-Latin letters slugs to a leading `-`, so that is allowed; separators
 *  and dot-dot are not (the id becomes a directory name under hive/agents). */
const AGENT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function isCapabilityItemId(v: unknown): v is string {
  return typeof v === 'string' && ITEM_ID_RE.test(v) && !v.includes('..');
}

export function isAgentId(v: unknown): v is string {
  return typeof v === 'string' && AGENT_ID_RE.test(v) && !v.includes('..') && v !== '.';
}

export function isCapabilityKind(v: unknown): v is CapabilityKind {
  return typeof v === 'string' && (CAPABILITY_KINDS as readonly string[]).includes(v);
}

export function emptyGrant(now: number): AgentGrant {
  return { skills: [], mcp: [], connections: [], updatedAt: now };
}

/** Valid, de-duplicated, bounded — order of first appearance kept. */
function cleanIds(raw: unknown, valid: (id: string) => boolean = () => true): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (!isCapabilityItemId(v) || !valid(v) || out.includes(v)) continue;
    out.push(v);
    if (out.length >= MAX_GRANT_ITEMS) break;
  }
  return out;
}

/** Normalise one stored grant. MCP ids outside the catalog are dropped (a
 *  grant can only ever reference the bundled allowlist, like a hire manifest). */
export function normalizeGrant(raw: unknown): AgentGrant | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const updatedAt = typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) && r.updatedAt > 0 ? r.updatedAt : 0;
  const grant: AgentGrant = {
    skills: cleanIds(r.skills),
    mcp: cleanIds(r.mcp, (id) => !!mcpCatalogEntry(id)),
    connections: cleanIds(r.connections),
    updatedAt
  };
  if (typeof r.bundle === 'string' && isCapabilityItemId(r.bundle)) grant.bundle = r.bundle;
  if (typeof r.role === 'string' && r.role.trim()) grant.role = r.role.trim().slice(0, MAX_ROLE_CHARS);
  return grant;
}

/** Parse grants.json tolerantly: anything unreadable becomes "no grants". */
export function parseGrantsFile(raw: unknown): GrantsFile {
  const out: GrantsFile = { version: 1, agents: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const agents = (raw as { agents?: unknown }).agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return out;
  let n = 0;
  for (const [id, g] of Object.entries(agents as Record<string, unknown>)) {
    if (!isAgentId(id)) continue;
    const grant = normalizeGrant(g);
    if (!grant) continue;
    out.agents[id] = grant;
    if (++n >= MAX_GRANT_AGENTS) break;
  }
  return out;
}

/** True when a grant holds nothing worth keeping on disk. */
export function isEmptyGrant(g: AgentGrant | undefined): boolean {
  return !g || (g.skills.length === 0 && g.mcp.length === 0 && g.connections.length === 0 && !g.bundle && !g.role);
}

function listFor(g: AgentGrant, kind: CapabilityKind): string[] {
  return kind === 'skill' ? g.skills : kind === 'mcp' ? g.mcp : g.connections;
}

function withList(g: AgentGrant, kind: CapabilityKind, list: string[]): AgentGrant {
  if (kind === 'skill') return { ...g, skills: list };
  if (kind === 'mcp') return { ...g, mcp: list };
  return { ...g, connections: list };
}

/** Turn one item on or off. Returns the SAME object when nothing changes, so
 *  the caller can skip the write. */
export function setGrantItem(
  current: AgentGrant | undefined,
  kind: CapabilityKind,
  id: string,
  on: boolean,
  now: number
): AgentGrant {
  const base = current ?? emptyGrant(0);
  const list = listFor(base, kind);
  const has = list.includes(id);
  if (has === on) return base;
  if (on && list.length >= MAX_GRANT_ITEMS) return base;
  const next = on ? [...list, id] : list.filter((x) => x !== id);
  return { ...withList(base, kind, next), updatedAt: now };
}

/** Is an item granted to this agent? */
export function hasGrant(g: AgentGrant | undefined, kind: CapabilityKind, id: string): boolean {
  return !!g && listFor(g, kind).includes(id);
}

/* ─────────────────────────────── skill refs ─────────────────────────────── */

/** A catalog row as main/skills.ts parses it — only the fields used here. */
export interface CatalogSkillLike {
  name: string;
  url: string;
  owner: string;
}

/**
 * The folder name main/skills.ts `installSkill` will create for a catalog row,
 * so a bundle can be matched against what is installed BEFORE anything is
 * downloaded. Mirrors installSkill exactly: a `tree/<ref>/<path>` source lands in
 * the path's last segment (`…/skills/emails` → `emails`, which is how
 * `email-sequence` installs), a whole-repo source in the row's name. Anything
 * installSkill would refuse (a blob link, a name with spaces) → null.
 */
export function catalogSkillDirName(row: CatalogSkillLike): string | null {
  const clean = row.url.trim().replace(/[#?].*$/, '').replace(/\/+$/, '');
  const tree = /^https:\/\/github\.com\/[^/]+\/[^/]+\/tree\/[^/]+\/?(.*)$/.exec(clean);
  let seed: string;
  if (tree) seed = tree[1] || row.name;
  else if (/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(clean)) seed = row.name;
  else if (/^https:\/\/(www\.)?officialskills\.sh\//i.test(clean)) seed = row.name;
  else return null;
  const base = seed.trim().split('/').pop() ?? '';
  return isCapabilityItemId(base) ? base : null;
}

/** `owner/name`, lower-cased owner — how bundles name a catalog skill. */
export function catalogKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name}`;
}

/* ─────────────────────────────── bundle diff ────────────────────────────── */

/** A skill a bundle wants: one of the app's built-in skills, or a row of the
 *  public catalog (resolved to its folder name at run time). */
export type BundleSkillRef =
  | { kind: 'builtin'; id: string }
  | { kind: 'catalog'; owner: string; name: string };

export interface RoleBundle {
  /** Stable slug — also the i18n key under `wsCapabilities.bundles.<id>`. */
  id: string;
  /** The job string written to the agent (hive registry role / card). */
  role: string;
  skills: BundleSkillRef[];
  /** MCP_CATALOG ids. */
  mcp: string[];
  /** Integration TEMPLATE ids (`idSuggestion`) — matched to the user's
   *  registered records by id or by kind at grant time. */
  connections: string[];
  /** What the bundle's description promises but nothing in the app provides
   *  yet — shown, never hidden (i18n key under `wsCapabilities.gaps`). */
  gaps: string[];
}

/** What the app knows at grant time, gathered by the caller. */
export interface BundleContext {
  /** Built-in skill folder names (every agent already has these). */
  builtinSkills: string[];
  /** Skill folders reachable machine-wide (~/.claude/skills). */
  machineSkills: string[];
  /** Skill folders already in this agent's own skills dir. */
  agentSkills: string[];
  /** The loaded catalog, or null while it is unavailable. */
  catalog: CatalogSkillLike[] | null;
  /** Registered integration records (redacted view). */
  connections: Array<{ id: string; kind: string; enabled: boolean; hasSecret: boolean; authType: string }>;
  /** Saved secret per secret-tier MCP id. */
  mcpKeys: Record<string, boolean>;
  /** Global MCP consent (config.mcpDefaults). */
  mcpDefaults?: Record<string, { enabled: boolean }>;
}

export type DiffState =
  /** Already in place for this agent (granted, built-in, or machine-wide). */
  | 'has'
  /** The grant will add it and nothing else is needed. */
  | 'add'
  /** The grant will add it, but it needs something from the user first. */
  | 'addNeeds'
  /** Cannot be granted: it does not exist here. */
  | 'missing';

export type DiffNote =
  | 'builtin'          // ships with the app
  | 'machine'          // installed for every agent on this machine
  | 'install'          // will be downloaded from the catalog for this agent
  | 'notInCatalog'     // the catalog has no such (installable) row right now
  | 'catalogOffline'   // the catalog could not be loaded
  | 'needsKey'         // a secret-tier server or connection with no saved key
  | 'notSetUp'         // no registered connection of that kind
  | 'disabled';        // registered but switched off

export interface DiffRow {
  kind: CapabilityKind;
  /** What the grant record will hold (skill folder, MCP id, connection id). */
  id: string;
  /** For catalog skills: `owner/name`; for connections: the template id. */
  ref: string;
  state: DiffState;
  note?: DiffNote;
}

export interface BundleDiff {
  bundleId: string;
  role: string;
  rows: DiffRow[];
  /** Ids the grant record will gain, per kind (what `applyBundle` writes). */
  add: { skills: string[]; mcp: string[]; connections: string[] };
  /** Catalog rows to download for this agent (subset of add.skills). */
  installs: Array<{ dir: string; owner: string; name: string; url: string }>;
  gaps: string[];
  /** Nothing would change. */
  noop: boolean;
}

/** Which registered record satisfies a bundle's connection template id:
 *  a record with that exact id first, else the first record of that kind
 *  (`github` is a kind; the YC templates are all `custom-rest`, so they can
 *  only match by id). */
export function matchConnection(
  templateId: string,
  records: BundleContext['connections']
): BundleContext['connections'][number] | null {
  const byId = records.find((r) => r.id === templateId);
  if (byId) return byId;
  if (templateId === 'github') return records.find((r) => r.kind === 'github') ?? null;
  return null;
}

/** Can this record be used right now (enabled, and holding its secret if it needs one)? */
export function connectionUsable(r: { enabled: boolean; hasSecret: boolean; authType: string }): boolean {
  return r.enabled && (r.authType === 'none' || r.hasSecret);
}

/**
 * Bundle → grant diff: for every skill, MCP server and connection a role bundle
 * names, what granting it to this agent would do. Pure; the confirm sheet
 * renders it and `applyBundleToGrant` writes exactly its `add` lists.
 */
export function bundleGrantDiff(
  current: AgentGrant | undefined,
  bundle: RoleBundle,
  ctx: BundleContext
): BundleDiff {
  const rows: DiffRow[] = [];
  const add = { skills: [] as string[], mcp: [] as string[], connections: [] as string[] };
  const installs: BundleDiff['installs'] = [];
  const granted = current ?? emptyGrant(0);

  for (const ref of bundle.skills) {
    if (ref.kind === 'builtin') {
      rows.push({
        kind: 'skill', id: ref.id, ref: ref.id,
        state: ctx.builtinSkills.includes(ref.id) ? 'has' : 'missing',
        note: ctx.builtinSkills.includes(ref.id) ? 'builtin' : 'notInCatalog'
      });
      continue;
    }
    const key = catalogKey(ref.owner, ref.name);
    const row = ctx.catalog?.find((c) => c.owner.toLowerCase() === ref.owner.toLowerCase() && c.name === ref.name) ?? null;
    const dir = row ? catalogSkillDirName(row) : null;
    if (!dir) {
      rows.push({ kind: 'skill', id: ref.name, ref: key, state: 'missing', note: ctx.catalog ? 'notInCatalog' : 'catalogOffline' });
      continue;
    }
    if (ctx.builtinSkills.includes(dir)) {
      rows.push({ kind: 'skill', id: dir, ref: key, state: 'has', note: 'builtin' });
    } else if (ctx.machineSkills.includes(dir)) {
      rows.push({ kind: 'skill', id: dir, ref: key, state: 'has', note: 'machine' });
    } else if (granted.skills.includes(dir) && ctx.agentSkills.includes(dir)) {
      rows.push({ kind: 'skill', id: dir, ref: key, state: 'has' });
    } else {
      // Granted-but-not-on-disk counts as "add" too: applying the bundle is
      // also how a half-finished install gets retried.
      const installed = ctx.agentSkills.includes(dir);
      rows.push({ kind: 'skill', id: dir, ref: key, state: 'add', note: installed ? undefined : 'install' });
      if (!granted.skills.includes(dir)) add.skills.push(dir);
      if (!installed && row) installs.push({ dir, owner: row.owner, name: row.name, url: row.url });
    }
  }

  for (const id of bundle.mcp) {
    const entry = mcpCatalogEntry(id);
    if (!entry) { rows.push({ kind: 'mcp', id, ref: id, state: 'missing', note: 'notInCatalog' }); continue; }
    const globallyOn = (ctx.mcpDefaults?.[id]?.enabled ?? entry.defaultEnabled) &&
      // A write/secret server is only "on for everyone" with explicit consent
      // (hive.buildDefaultMcpServers applies the same rule).
      (entry.tier === 'safe-readonly' || ctx.mcpDefaults?.[id]?.enabled === true);
    const needsKey = entry.tier === 'secret' && !ctx.mcpKeys[id];
    if (granted.mcp.includes(id)) {
      rows.push({ kind: 'mcp', id, ref: id, state: needsKey ? 'addNeeds' : 'has', note: needsKey ? 'needsKey' : undefined });
    } else if (globallyOn && entry.tier !== 'secret') {
      rows.push({ kind: 'mcp', id, ref: id, state: 'has', note: 'machine' });
    } else {
      add.mcp.push(id);
      rows.push({ kind: 'mcp', id, ref: id, state: needsKey ? 'addNeeds' : 'add', note: needsKey ? 'needsKey' : undefined });
    }
  }

  for (const templateId of bundle.connections) {
    const rec = matchConnection(templateId, ctx.connections);
    if (!rec) { rows.push({ kind: 'connection', id: templateId, ref: templateId, state: 'missing', note: 'notSetUp' }); continue; }
    const usable = connectionUsable(rec);
    const note: DiffNote | undefined = usable ? undefined : !rec.enabled ? 'disabled' : 'needsKey';
    if (granted.connections.includes(rec.id)) {
      rows.push({ kind: 'connection', id: rec.id, ref: templateId, state: usable ? 'has' : 'addNeeds', note });
    } else {
      add.connections.push(rec.id);
      rows.push({ kind: 'connection', id: rec.id, ref: templateId, state: usable ? 'add' : 'addNeeds', note });
    }
  }

  const roleChanges = (current?.role ?? '') !== bundle.role || current?.bundle !== bundle.id;
  const noop = !roleChanges && add.skills.length === 0 && add.mcp.length === 0 && add.connections.length === 0 && installs.length === 0;
  return { bundleId: bundle.id, role: bundle.role, rows, add, installs, gaps: [...bundle.gaps], noop };
}

/** Apply a diff's additions to the grant: a UNION, never a removal — a bundle
 *  sets an agent up, it does not take away what the user granted by hand. */
export function applyBundleToGrant(current: AgentGrant | undefined, diff: BundleDiff, now: number): AgentGrant {
  const base = current ?? emptyGrant(0);
  const union = (a: string[], b: string[]) => [...a, ...b.filter((x) => !a.includes(x))].slice(0, MAX_GRANT_ITEMS);
  return {
    skills: union(base.skills, diff.add.skills),
    mcp: union(base.mcp, diff.add.mcp),
    connections: union(base.connections, diff.add.connections),
    bundle: diff.bundleId,
    role: diff.role,
    updatedAt: now
  };
}

/* ───────────────────────────── spawn overlay ────────────────────────────── */

export type McpDefaultsMap = Record<string, { enabled: boolean }> | undefined;

/**
 * The MCP picture for one agent's spawn: which catalog servers the hive writes
 * into its per-session settings (`mcpDefaults` overlay), and which secret-tier
 * servers ride in separately with their key (`keyed`).
 *
 * Secret-tier servers are pulled OUT of the hive overlay on purpose: the hive
 * writes a catalog entry's `env` verbatim, and the catalog's secret values are
 * empty placeholders — an empty `GITHUB_PERSONAL_ACCESS_TOKEN` would shadow the
 * real one. The caller writes them to a separate MCP config with no `env` key and
 * puts the key in the agent's environment, which the server process inherits.
 * A granted secret server with no saved key is simply skipped (the UI says so).
 */
export function mcpSpawnOverlay(
  grant: AgentGrant | undefined,
  global: McpDefaultsMap,
  keys: Record<string, boolean>
): { mcpDefaults: Record<string, { enabled: boolean }>; keyed: string[]; skippedNoKey: string[] } {
  const out: Record<string, { enabled: boolean }> = { ...(global ?? {}) };
  const keyed: string[] = [];
  const skippedNoKey: string[] = [];
  for (const id of grant?.mcp ?? []) {
    const entry = mcpCatalogEntry(id);
    if (!entry) continue;
    if (entry.tier === 'secret') {
      // Never let the hive write the blank-env copy for THIS agent; the keyed
      // copy (or nothing) replaces it.
      out[id] = { enabled: false };
      if (keys[id]) keyed.push(id);
      else skippedNoKey.push(id);
    } else {
      out[id] = { enabled: true };
    }
  }
  return { mcpDefaults: out, keyed, skippedNoKey };
}

/** The env var a secret-tier catalog server reads its key from. */
export function mcpSecretEnvName(id: string): string | null {
  const env = mcpCatalogEntry(id)?.spec.env;
  if (!env) return null;
  const names = Object.keys(env);
  return names.length > 0 ? names[0] : null;
}

/** The secret-store handle for a catalog server's key (main-only). */
export function mcpKeyRef(id: string): string {
  return `mcpkey:${id}`;
}

/** Secret-tier catalog ids — the ones that take a key. */
export function secretMcpIds(): string[] {
  return MCP_CATALOG.filter((e) => e.tier === 'secret').map((e) => e.id);
}

/* ───────────────────────────── who has what ─────────────────────────────── */

export type CellState =
  /** Every agent of this engine has it (built-in, machine-wide, global default). */
  | 'everyone'
  /** Granted to this agent and in effect. */
  | 'granted'
  /** Granted, but the agent is running on an older setup — restart to apply. */
  | 'pending'
  /** Granted, but it cannot work until a key is saved (or it is switched on). */
  | 'needsKey'
  /** Granted, but the skill folder is not in place yet (installing, or failed). */
  | 'missing'
  | 'none'
  /** This agent's engine does not read this kind of capability. */
  | 'unsupported';

export interface WhoAgent {
  id: string;
  name: string;
  /** Provider id ('claude', 'codex', …). */
  provider: string;
  isGod?: boolean;
  /** Has a live terminal right now. */
  live: boolean;
}

export interface WhoInputs {
  agents: WhoAgent[];
  grants: Record<string, AgentGrant>;
  /** Skill folders in ~/.claude/skills (every Claude Code agent loads them). */
  machineSkills: string[];
  /** Skill folders in each agent's own skills dir, built-ins excluded. */
  agentSkills: Record<string, string[]>;
  /** config.mcpDefaults. */
  mcpDefaults: McpDefaultsMap;
  mcpKeys: Record<string, boolean>;
  connections: Array<{ id: string; label: string; enabled: boolean; hasSecret: boolean; authType: string }>;
  /** Grant `updatedAt` each agent was last spawned with (main records it). */
  appliedAt: Record<string, number>;
}

export interface WhoColumn {
  key: string;
  kind: CapabilityKind;
  id: string;
  label: string;
}

export interface WhoRow {
  agent: WhoAgent;
  cells: Record<string, CellState>;
  /** How many columns this agent has in any form (everyone/granted/pending). */
  count: number;
  pendingRestart: boolean;
}

export interface WhoMatrix {
  columns: WhoColumn[];
  rows: WhoRow[];
}

/** Engines that read Claude Code skills and MCP settings. Everything else gets
 *  'unsupported' in those columns rather than a misleading 'none'. */
function readsClaudeExtensions(provider: string): boolean {
  return provider === 'claude';
}

export function whoColumnKey(kind: CapabilityKind, id: string): string {
  return `${kind}:${id}`;
}

/** True when this agent runs on an older grant than the one on disk. */
export function needsRestart(agent: WhoAgent, grant: AgentGrant | undefined, appliedAt: Record<string, number>): boolean {
  if (!agent.live || !grant || grant.updatedAt <= 0) return false;
  return grant.updatedAt > (appliedAt[agent.id] ?? 0);
}

/**
 * Assemble the floor-wide matrix: one row per agent, one column per capability
 * anyone has. Columns appear only when SOMEONE has the capability (a matrix of
 * 40 empty catalog columns answers nothing); the full catalogs live on the
 * Marketplace and Installed tabs.
 */
export function buildWhoHasWhat(input: WhoInputs): WhoMatrix {
  const columns: WhoColumn[] = [];
  const seen = new Set<string>();
  const addCol = (kind: CapabilityKind, id: string, label: string) => {
    const key = whoColumnKey(kind, id);
    if (seen.has(key)) return;
    seen.add(key);
    columns.push({ key, kind, id, label });
  };

  const agentIds = new Set(input.agents.map((a) => a.id));
  const grantsOnFloor = Object.entries(input.grants).filter(([id]) => agentIds.has(id));

  // Skills: machine-wide first (alphabetical), then per-agent ones.
  for (const s of [...input.machineSkills].sort((a, b) => a.localeCompare(b))) addCol('skill', s, s);
  const perAgentSkills = new Set<string>();
  for (const a of input.agents) for (const s of input.agentSkills[a.id] ?? []) perAgentSkills.add(s);
  for (const [, g] of grantsOnFloor) for (const s of g.skills) perAgentSkills.add(s);
  for (const s of [...perAgentSkills].sort((a, b) => a.localeCompare(b))) addCol('skill', s, s);

  // MCP: catalog order, only servers on for everyone or granted to someone.
  const globalOn = (id: string): boolean => {
    const e = mcpCatalogEntry(id);
    if (!e) return false;
    const consented = input.mcpDefaults?.[id]?.enabled;
    const on = consented ?? e.defaultEnabled;
    return on && (e.tier === 'safe-readonly' || consented === true);
  };
  const grantedMcp = new Set(grantsOnFloor.flatMap(([, g]) => g.mcp));
  for (const e of MCP_CATALOG) {
    if (globalOn(e.id) || grantedMcp.has(e.id)) addCol('mcp', e.id, e.label);
  }

  // Connections: every registered record, plus granted ids whose record is gone.
  for (const c of input.connections) addCol('connection', c.id, c.label);
  for (const [, g] of grantsOnFloor) for (const id of g.connections) addCol('connection', id, id);

  const machine = new Set(input.machineSkills);
  const rows: WhoRow[] = input.agents.map((agent) => {
    const grant = input.grants[agent.id];
    const restart = needsRestart(agent, grant, input.appliedAt);
    const claude = readsClaudeExtensions(agent.provider);
    const own = new Set(input.agentSkills[agent.id] ?? []);
    const cells: Record<string, CellState> = {};
    let count = 0;
    for (const col of columns) {
      let state: CellState = 'none';
      if (col.kind === 'skill') {
        if (!claude) state = 'unsupported';
        else if (machine.has(col.id)) state = 'everyone';
        else if (own.has(col.id)) state = grant?.skills.includes(col.id) && restart ? 'pending' : 'granted';
        else if (grant?.skills.includes(col.id)) state = 'missing';
      } else if (col.kind === 'mcp') {
        const entry = mcpCatalogEntry(col.id);
        const granted = !!grant?.mcp.includes(col.id);
        if (!claude) state = 'unsupported';
        else if (granted && entry?.tier === 'secret' && !input.mcpKeys[col.id]) state = 'needsKey';
        else if (granted) state = restart ? 'pending' : 'granted';
        else if (globalOn(col.id)) state = 'everyone';
      } else {
        const granted = !!grant?.connections.includes(col.id);
        if (granted) {
          const rec = input.connections.find((c) => c.id === col.id);
          state = !rec || !connectionUsable(rec) ? 'needsKey' : restart ? 'pending' : 'granted';
        }
      }
      if (state === 'everyone' || state === 'granted' || state === 'pending') count++;
      cells[col.key] = state;
    }
    return { agent, cells, count, pendingRestart: restart };
  });

  // God first, then by name — the orchestrator reads as the head of the table.
  rows.sort((a, b) => Number(!!b.agent.isGod) - Number(!!a.agent.isGod) || a.agent.name.localeCompare(b.agent.name));
  return { columns, rows };
}
