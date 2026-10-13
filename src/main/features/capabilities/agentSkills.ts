/**
 * Per-agent skill folders — the "skill" half of a capability grant.
 *
 * Every agent already HAS a skills folder of its own: `<hive>/agents/<id>/.claude/skills/`,
 * which hive.ensureAgent refills with the app's built-in skills on every spawn
 * (copyBundledSkills — copy-over, never a wipe, so anything else in the folder
 * survives a restart). A per-agent grant is just another folder in there. That
 * keeps a granted skill to THAT agent: ~/.claude/skills would hand it to every
 * Claude Code agent on the machine.
 *
 * Where a granted skill comes from, in order:
 *   1. built in, or already in ~/.claude/skills → nothing to do (it has it);
 *   2. already in the agent's folder → nothing to do;
 *   3. a project skill (`<repo>/.claude/skills/<name>`) of a registered repo →
 *      copied in;
 *   4. a row of the public catalog → downloaded by main/skills.ts `installSkill`
 *      (all of its size, depth and containment limits apply unchanged), then
 *      moved from ~/.claude/skills into the agent's folder. installSkill only
 *      writes into ~/.claude/skills; moving the finished folder reuses its
 *      hardening instead of keeping a second copy of a downloader that treats
 *      every byte as hostile.
 *
 * Paths are only ever built from validated ids joined under known roots, and
 * re-checked for containment after resolution.
 */
import { app } from 'electron';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { installSkill, uninstallSkill, loadCatalog, type CatalogSkill } from '../../skills';
import { catalogSkillDirName, isAgentId, isCapabilityItemId } from '../../../shared/workspace/capabilities';

/** The app's built-in skills (mirrors index.ts skillsResourceDir). */
export function builtinSkillsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'skills') : join(app.getAppPath(), 'resources', 'skills');
}

export function machineSkillsDir(): string {
  return join(homedir(), '.claude', 'skills');
}

/** Folder names under `dir` that hold a SKILL.md. */
function skillFolders(dir: string): string[] {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
    return readdirSync(dir).filter((name) => {
      if (!isCapabilityItemId(name)) return false;
      try { return statSync(join(dir, name)).isDirectory() && existsSync(join(dir, name, 'SKILL.md')); } catch { return false; }
    }).sort();
  } catch { return []; }
}

export function builtinSkillNames(): string[] {
  return skillFolders(builtinSkillsDir());
}

export function machineSkillNames(): string[] {
  return skillFolders(machineSkillsDir());
}

/** `<hive>/agents/<id>` for a validated id, or null. */
export function agentDir(hiveRoot: string, agentId: string): string | null {
  if (!isAgentId(agentId)) return null;
  const root = resolve(hiveRoot, 'agents');
  const dir = resolve(root, agentId);
  return dir.startsWith(root + sep) && basename(dir) === agentId ? dir : null;
}

function agentSkillsDir(hiveRoot: string, agentId: string): string | null {
  const dir = agentDir(hiveRoot, agentId);
  return dir ? join(dir, '.claude', 'skills') : null;
}

/** Skill folders in an agent's own folder, built-ins excluded. */
export function agentSkillNames(hiveRoot: string, agentId: string, builtin: ReadonlySet<string>): string[] {
  const dir = agentSkillsDir(hiveRoot, agentId);
  return dir ? skillFolders(dir).filter((n) => !builtin.has(n)) : [];
}

/** Remove a granted folder from an agent. Built-ins are refused: they come
 *  back on the next spawn anyway, and removing one would only confuse. */
export function removeAgentSkill(hiveRoot: string, agentId: string, name: string, builtin: ReadonlySet<string>): { ok: boolean; error?: string } {
  if (!isCapabilityItemId(name)) return { ok: false, error: 'bad skill name' };
  if (builtin.has(name)) return { ok: false, error: 'built-in' };
  const dir = agentSkillsDir(hiveRoot, agentId);
  if (!dir) return { ok: false, error: 'bad agent id' };
  const target = resolve(dir, name);
  if (!target.startsWith(resolve(dir) + sep)) return { ok: false, error: 'outside the agent folder' };
  if (!existsSync(target)) return { ok: true };
  if (!existsSync(join(target, 'SKILL.md'))) return { ok: false, error: 'not a skill folder' };
  try {
    rmSync(target, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type MaterializeHow = 'builtin' | 'machine' | 'present' | 'copied' | 'installed';

export interface MaterializeResult {
  ok: boolean;
  how?: MaterializeHow;
  error?: string;
}

/** Copy one skill folder into the agent's folder (no-op when already there). */
function copyInto(src: string, hiveRoot: string, agentId: string, name: string): MaterializeResult {
  const dir = agentSkillsDir(hiveRoot, agentId);
  if (!dir) return { ok: false, error: 'bad agent id' };
  const agentRoot = agentDir(hiveRoot, agentId)!;
  if (!existsSync(agentRoot)) return { ok: false, error: 'agent has no hive folder yet' };
  const dest = resolve(dir, name);
  if (!dest.startsWith(resolve(dir) + sep)) return { ok: false, error: 'outside the agent folder' };
  if (existsSync(join(dest, 'SKILL.md'))) return { ok: true, how: 'present' };
  try {
    mkdirSync(dir, { recursive: true });
    // dereference:false — a symlink inside a skill is copied as a link, never
    // followed out of the folder.
    cpSync(src, dest, { recursive: true, force: true, dereference: false });
    return { ok: true, how: 'copied' };
  } catch (e) {
    try { rmSync(dest, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Installs share ~/.claude/skills as a staging area, so they run one at a time. */
let installChain: Promise<unknown> = Promise.resolve();

function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = installChain.then(job, job);
  installChain = run.catch(() => undefined);
  return run;
}

/** Download a catalog row and hand the finished folder to one agent. */
function installForAgent(row: CatalogSkill, hiveRoot: string, agentId: string, name: string): Promise<MaterializeResult> {
  return serial(async () => {
    const res = await installSkill(row.url, row.name);
    if (!res.ok) {
      // Somebody installed it for the whole machine already: every Claude Code
      // agent loads it, this one included.
      if (/^Already installed at /.test(res.error) && existsSync(join(machineSkillsDir(), name, 'SKILL.md'))) {
        return { ok: true, how: 'machine' as const };
      }
      return { ok: false, error: res.error };
    }
    const copied = copyInto(res.path, hiveRoot, agentId, basename(res.path));
    // Take it back out of the machine-wide folder whatever happened: it was
    // only staged there. uninstallSkill re-proves it is a skill folder inside
    // a skills root before deleting anything.
    const removed = uninstallSkill(res.path, { cwds: [] });
    if (!removed.ok) console.warn('[capabilities] could not unstage', res.path, removed.error);
    return copied.ok ? { ok: true, how: 'installed' as const } : copied;
  });
}

export interface SkillSources {
  hiveRoot: string;
  builtin: ReadonlySet<string>;
  /** Registered repos (config.registeredRepos), for project skills. */
  repos: string[];
  /** Where the skills catalog is cached (shared with the Classic tab). */
  catalogCache: string;
}

/** Find a catalog row whose installed folder would be `name`. */
export async function findCatalogRow(name: string, catalogCache: string, prefer?: { owner: string; name: string }): Promise<CatalogSkill | null> {
  const { skills } = await loadCatalog(catalogCache);
  if (prefer) {
    const exact = skills.find((s) => s.owner === prefer.owner.toLowerCase() && s.name === prefer.name);
    if (exact && catalogSkillDirName(exact) === name) return exact;
  }
  return skills.find((s) => catalogSkillDirName(s) === name) ?? null;
}

/** Make sure a granted skill is actually in place for this agent. */
export async function materializeSkill(
  agentId: string,
  name: string,
  src: SkillSources,
  catalogRow?: CatalogSkill | null
): Promise<MaterializeResult> {
  if (!isCapabilityItemId(name)) return { ok: false, error: 'bad skill name' };
  if (src.builtin.has(name)) return { ok: true, how: 'builtin' };
  if (existsSync(join(machineSkillsDir(), name, 'SKILL.md'))) return { ok: true, how: 'machine' };
  const own = agentSkillsDir(src.hiveRoot, agentId);
  if (!own) return { ok: false, error: 'bad agent id' };
  if (existsSync(join(own, name, 'SKILL.md'))) return { ok: true, how: 'present' };
  for (const repo of src.repos) {
    if (typeof repo !== 'string' || !repo) continue;
    const p = join(repo, '.claude', 'skills', name);
    if (existsSync(join(p, 'SKILL.md'))) return copyInto(p, src.hiveRoot, agentId, name);
  }
  const row = catalogRow ?? await findCatalogRow(name, src.catalogCache).catch(() => null);
  if (!row) return { ok: false, error: 'notFound' };
  return installForAgent(row, src.hiveRoot, agentId, name);
}
