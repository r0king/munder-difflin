/**
 * Capabilities, Temps and role bundles — main-process side (owned by the
 * `wsCapabilities` unit).
 *
 * What the renderer calls directly, unchanged: the skills catalog and installs
 * (skillsLocal / skillsCatalog / skillsInstall / skillsUninstall), connections
 * (integrationsList / integrationsUpsert / integrationsSetSecret — write-only),
 * the global MCP defaults (config.mcpDefaults) and the worker list / stop
 * (listWorkers / stopWorker). What did not exist, and lives here:
 *
 *   per-agent grants   grants.json (./capabilities/grantsStore.ts) — one record
 *                      per agent, every change one atomic write; applied at the
 *                      agent's next spawn (./capabilities/spawn.ts, called from
 *                      index.ts spawnAgentCore). Skills are put in place at grant
 *                      time (./capabilities/agentSkills.ts).
 *   role bundles       preview (the diff) and apply (one write) for the eleven
 *                      bundles in shared/workspace/capabilitiesBundles.ts.
 *   MCP keys           write-only, encrypted with the integrations' secret store.
 *   Temps              ./capabilities/temps.ts — a hiring queue in front of the
 *                      existing ephemeral-worker controller, and its history.
 *
 * Channels: shared/workspace/capabilitiesIpc.ts. Every handler validates its
 * input: ids against slug patterns, kinds against the enum, MCP ids against the
 * catalog, connection ids against the registry, paths only via ids.
 */
import { app, ipcMain } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FeatureContext, FeatureModule } from './types';
import { loadCatalog, type CatalogSkill } from '../skills';
import { readConfig } from '../config';
import { enabledIds, getRecord, listRecordsRedacted } from '../integrations';
import { mcpCatalogEntry } from '../../shared/mcpCatalog';
import {
  applyBundleToGrant,
  bundleGrantDiff,
  isAgentId,
  isCapabilityItemId,
  isCapabilityKind,
  setGrantItem,
  type AgentGrant,
  type BundleContext
} from '../../shared/workspace/capabilities';
import { roleBundle } from '../../shared/workspace/capabilitiesBundles';
import {
  CAPABILITIES_CHANNELS as CH,
  MAX_MCP_KEY_CHARS,
  MAX_STATE_AGENTS,
  type BundleResult,
  type CapabilitiesChanged,
  type CapabilitiesState,
  type GrantResult
} from '../../shared/workspace/capabilitiesIpc';
import {
  agentSkillNames,
  builtinSkillNames,
  findCatalogRow,
  machineSkillNames,
  materializeSkill,
  removeAgentSkill,
  type SkillSources
} from './capabilities/agentSkills';
import { mcpKeyPresence, readGrants, removeMcpKey, saveMcpKey, updateGrant } from './capabilities/grantsStore';
import { buildSpawnInjection, type SpawnInjection, type SpawnInjectionInput } from './capabilities/spawn';
import { TempsController } from './capabilities/temps';

let ctxRef: FeatureContext | null = null;
let temps: TempsController | null = null;
/** Grant version each agent was last spawned with — "restart to apply". */
const appliedAt = new Map<string, number>();
/** Skill installs in flight, per agent. */
const installing = new Map<string, Set<string>>();
/** Last materialisation error per `<agentId>/<skill>`. */
const skillErrors = new Map<string, string>();

/** `<userData>/features/capabilities`. Works before register too: index.ts
 *  spawns (and polls the temp queue) on its own schedule. */
function dataDir(): string {
  if (ctxRef) return ctxRef.featureDataDir('capabilities');
  const dir = join(app.getPath('userData'), 'features', 'capabilities');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function hiveRoot(): string | null {
  let home: string | null = null;
  try { home = ctxRef ? ctxRef.harnessHome() : readConfig().harnessHome ?? null; } catch { home = null; }
  return home ? join(home, 'hive') : null;
}

function catalogCache(): string {
  // The same cache file the Classic skills tab uses (index.ts skills:catalog).
  return join(app.getPath('userData'), 'skill-catalog.json');
}

function changed(what: CapabilitiesChanged['what']): void {
  try { ctxRef?.broadcast(CH.changed, { what } satisfies CapabilitiesChanged); } catch { /* windows tearing down */ }
}

/* ─────────────────────────── index.ts entry points ──────────────────────── */

/**
 * This agent's grants for its spawn (MCP overlay, extra args, env). index.ts
 * calls it for every hive spawn; an agent without a grant gets its input back.
 */
export function capabilitySpawnInjection(input: SpawnInjectionInput): SpawnInjection {
  return buildSpawnInjection(input, {
    dataDir: dataDir(),
    hiveRoot: hiveRoot(),
    usableIntegrationIds: () => enabledIds(),
    recordApplied: (agentId, at) => { appliedAt.set(agentId, at); changed('grants'); }
  });
}

/** Temp hires waiting for the ephemeral-worker controller (index.ts takes
 *  these past the orchestrator-may-hire gate: the user hired them). */
export function tempRequestFiles(): string[] {
  return temps?.requestFiles() ?? [];
}

/* ──────────────────────────────── skills ────────────────────────────────── */

function skillSources(root: string): SkillSources {
  return {
    hiveRoot: root,
    builtin: new Set(builtinSkillNames()),
    repos: ctxRef?.readConfig().registeredRepos ?? [],
    catalogCache: catalogCache()
  };
}

/** Put granted skills in place without blocking the IPC reply; progress and
 *  failures surface through `state` (installing / skillErrors). */
function materializeInBackground(agentId: string, names: string[], rows: Map<string, CatalogSkill> = new Map()): void {
  const root = hiveRoot();
  if (!root || names.length === 0) return;
  const src = skillSources(root);
  const set = installing.get(agentId) ?? new Set<string>();
  installing.set(agentId, set);
  for (const name of names) {
    if (set.has(name)) continue;
    set.add(name);
    skillErrors.delete(`${agentId}/${name}`);
    void materializeSkill(agentId, name, src, rows.get(name))
      .then((res) => {
        if (!res.ok) skillErrors.set(`${agentId}/${name}`, res.error ?? 'failed');
      })
      .catch((e) => { skillErrors.set(`${agentId}/${name}`, e instanceof Error ? e.message : String(e)); })
      .finally(() => {
        set.delete(name);
        if (set.size === 0) installing.delete(agentId);
        changed('grants');
      });
  }
  changed('grants');
}

/* ─────────────────────────────── handlers ───────────────────────────────── */

function state(agentIds: unknown): CapabilitiesState {
  const root = hiveRoot();
  const builtin = builtinSkillNames();
  const builtinSet = new Set(builtin);
  const ids = Array.isArray(agentIds) ? agentIds.filter(isAgentId).slice(0, MAX_STATE_AGENTS) : [];
  const agentSkills: Record<string, string[]> = {};
  if (root) for (const id of ids) agentSkills[id] = agentSkillNames(root, id, builtinSet);
  const inst: Record<string, string[]> = {};
  for (const [id, set] of installing) inst[id] = [...set];
  return {
    hive: root !== null,
    grants: readGrants(dataDir()).agents,
    builtinSkills: builtin,
    machineSkills: machineSkillNames(),
    agentSkills,
    mcpKeys: mcpKeyPresence(),
    appliedAt: Object.fromEntries(appliedAt),
    installing: inst,
    skillErrors: Object.fromEntries(skillErrors)
  };
}

function setGrant(raw: unknown): GrantResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'bad request' };
  const r = raw as Record<string, unknown>;
  const { agentId, kind, id, on } = r;
  if (!isAgentId(agentId)) return { ok: false, error: 'bad agent id' };
  if (!isCapabilityKind(kind)) return { ok: false, error: 'bad kind' };
  if (!isCapabilityItemId(id)) return { ok: false, error: 'bad id' };
  if (typeof on !== 'boolean') return { ok: false, error: 'bad request' };
  if (kind === 'mcp' && !mcpCatalogEntry(id)) return { ok: false, error: 'unknown MCP server' };
  if (kind === 'connection' && on && !getRecord(id)) return { ok: false, error: 'unknown connection' };
  if (!hiveRoot()) return { ok: false, error: 'noHive' };

  const grant = updateGrant(dataDir(), agentId, (g) => setGrantItem(g, kind, id, on, Date.now()));
  if (kind === 'skill') {
    const root = hiveRoot()!;
    if (on) {
      const src = r.source as { owner?: unknown; name?: unknown } | undefined;
      const prefer = src && typeof src.owner === 'string' && typeof src.name === 'string' && src.owner.length <= 100 && src.name.length <= 200
        ? { owner: src.owner, name: src.name } : undefined;
      if (prefer) {
        void findCatalogRow(id, catalogCache(), prefer)
          .then((row) => materializeInBackground(agentId, [id], row ? new Map([[id, row]]) : new Map()))
          .catch(() => materializeInBackground(agentId, [id]));
      } else {
        materializeInBackground(agentId, [id]);
      }
    }
    else {
      // Taking a skill away removes it from the agent's own folder even when the
      // record had lost track of it (a folder left by an earlier grant): that
      // folder only ever holds what was given to this one agent.
      const res = removeAgentSkill(root, agentId, id, new Set(builtinSkillNames()));
      if (!res.ok && res.error !== 'built-in') console.warn('[capabilities] could not remove skill folder:', res.error);
      skillErrors.delete(`${agentId}/${id}`);
    }
  }
  changed('grants');
  return { ok: true, grant: grant ?? null };
}

function clearGrants(raw: unknown): GrantResult {
  const agentId = (raw as { agentId?: unknown } | null)?.agentId;
  if (!isAgentId(agentId)) return { ok: false, error: 'bad agent id' };
  const before = readGrants(dataDir()).agents[agentId];
  updateGrant(dataDir(), agentId, () => undefined);
  const root = hiveRoot();
  if (root && before) {
    const builtin = new Set(builtinSkillNames());
    for (const s of before.skills) removeAgentSkill(root, agentId, s, builtin);
  }
  changed('grants');
  return { ok: true, grant: null };
}

async function bundleContext(agentId: string): Promise<BundleContext> {
  const root = hiveRoot();
  const builtin = builtinSkillNames();
  let catalog: CatalogSkill[] | null = null;
  try {
    const res = await loadCatalog(catalogCache());
    catalog = res.skills.length > 0 ? res.skills : null;
  } catch { catalog = null; }
  return {
    builtinSkills: builtin,
    machineSkills: machineSkillNames(),
    agentSkills: root ? agentSkillNames(root, agentId, new Set(builtin)) : [],
    catalog,
    connections: listRecordsRedacted().map((r) => ({ id: r.id, kind: r.kind, enabled: r.enabled, hasSecret: r.hasSecret, authType: r.authType })),
    mcpKeys: mcpKeyPresence(),
    mcpDefaults: ctxRef?.readConfig().mcpDefaults
  };
}

function parseBundleRequest(raw: unknown): { agentId: string; bundleId: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const { agentId, bundleId } = raw as Record<string, unknown>;
  if (!isAgentId(agentId) || typeof bundleId !== 'string' || !roleBundle(bundleId)) return null;
  return { agentId, bundleId };
}

async function previewBundle(raw: unknown): Promise<BundleResult> {
  const req = parseBundleRequest(raw);
  if (!req) return { ok: false, error: 'bad request' };
  const grant = readGrants(dataDir()).agents[req.agentId];
  return { ok: true, diff: bundleGrantDiff(grant, roleBundle(req.bundleId)!, await bundleContext(req.agentId)) };
}

/**
 * Grant a bundle: ONE atomic write of the agent's record (every addition and
 * the role together), then the catalog skills it needs are downloaded for that
 * agent in the background. The renderer writes the role to the hive registry
 * (hivePatchAgentRole), the same call the Classic role editor makes.
 */
async function applyBundle(raw: unknown): Promise<BundleResult> {
  const req = parseBundleRequest(raw);
  if (!req) return { ok: false, error: 'bad request' };
  if (!hiveRoot()) return { ok: false, error: 'noHive' };
  const bundle = roleBundle(req.bundleId)!;
  const ctx = await bundleContext(req.agentId);
  // Recompute against the record as it is NOW (the await above may have let
  // another change land) and write inside the same synchronous step.
  let diff = bundleGrantDiff(readGrants(dataDir()).agents[req.agentId], bundle, ctx);
  const grant = updateGrant(dataDir(), req.agentId, (g) => {
    diff = bundleGrantDiff(g, bundle, ctx);
    return applyBundleToGrant(g, diff, Date.now());
  });
  const rows = new Map<string, CatalogSkill>();
  for (const i of diff.installs) rows.set(i.dir, { name: i.name, url: i.url, owner: i.owner, description: '', category: '' });
  materializeInBackground(req.agentId, diff.installs.map((i) => i.dir), rows);
  changed('grants');
  return { ok: true, diff, grant: grant ?? null };
}

function setMcpKey(raw: unknown): { ok: boolean; error?: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'bad request' };
  const { id, key } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || mcpCatalogEntry(id)?.tier !== 'secret') return { ok: false, error: 'not a keyed server' };
  if (typeof key !== 'string') return { ok: false, error: 'bad key' };
  const value = key.trim();
  if (!value || value.length > MAX_MCP_KEY_CHARS || /[\0\r\n]/.test(value)) return { ok: false, error: 'bad key' };
  const res = saveMcpKey(id, value);
  if (res.ok) changed('keys');
  return res;
}

function clearMcpKey(raw: unknown): { ok: boolean; error?: string } {
  const id = (raw as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || mcpCatalogEntry(id)?.tier !== 'secret') return { ok: false, error: 'not a keyed server' };
  removeMcpKey(id);
  changed('keys');
  return { ok: true };
}

export const capabilitiesFeature: FeatureModule = {
  name: 'capabilities',
  register(ctx) {
    ctxRef = ctx;
    temps = new TempsController({
      dataDir: ctx.featureDataDir('capabilities'),
      harnessHome: () => ctx.harnessHome(),
      claudeCommand: () => ctx.readConfig().defaultCommand,
      onChange: () => changed('temps')
    });
    temps.start();

    ipcMain.handle(CH.state, (_e, agentIds: unknown) => state(agentIds));
    ipcMain.handle(CH.setGrant, (_e, req: unknown) => setGrant(req));
    ipcMain.handle(CH.clearGrants, (_e, req: unknown) => clearGrants(req));
    ipcMain.handle(CH.previewBundle, (_e, req: unknown) => previewBundle(req));
    ipcMain.handle(CH.applyBundle, (_e, req: unknown) => applyBundle(req));
    ipcMain.handle(CH.setMcpKey, (_e, req: unknown) => setMcpKey(req));
    ipcMain.handle(CH.clearMcpKey, (_e, req: unknown) => clearMcpKey(req));
    ipcMain.handle(CH.temps, () => temps!.view());
    ipcMain.handle(CH.hireTemp, (_e, req: unknown) => temps!.hire(req));
    ipcMain.handle(CH.stopTemp, (_e, req: unknown) => temps!.stop((req as { id?: unknown } | null)?.id));
    ipcMain.handle(CH.setMaxTemps, (_e, req: unknown) => ({ ok: true, maxConcurrent: temps!.setMax((req as { n?: unknown } | null)?.n) }));
    ipcMain.handle(CH.clearTempHistory, () => { temps!.clearHistory(); return { ok: true }; });
  },
  dispose() {
    temps?.dispose();
  }
};

export type { AgentGrant };
