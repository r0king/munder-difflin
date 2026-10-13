/**
 * Which PROJECT an agent belongs to, for the Workspace sidebar's grouping.
 *
 * A project is the repository an agent works in. The store does not record it
 * directly, it records three hints, each wrong on its own:
 *
 *   - `cwd`: where the agent runs. With git isolation that is its own linked
 *     worktree, `<harnessHome>/worktrees/<agent-id>`, whose basename is the
 *     agent's id and names no project at all.
 *   - `project`: the basename of the folder the user picked. Right for display,
 *     useless as an identity: `~/client-a/app` and `~/client-b/app` are both
 *     "app", and keying on the name merges two unrelated repositories.
 *   - the repository root `git:mainRepo` resolves for the cwd, which follows a
 *     linked worktree back to its main checkout and folds a subfolder cwd into
 *     its repo. The real identity — but async, and null outside a repo.
 *
 * So identity is the resolved root when we have it, the normalized cwd when we
 * do not, and the picked folder's NAME only for a worktree agent whose root
 * could not be resolved (git missing, worktree deleted) — the one case where the
 * cwd is known to be meaningless. `groupAgentsByProject` then folds such a
 * name-only agent into the single path group that carries the same name, so a
 * failed lookup does not split one repo into two headers.
 *
 * Pure and import-free so node:test can load it (test/ws-sidebar-*.test.cjs).
 */

export interface ProjectAgentInput {
  id: string;
  cwd?: string;
  worktreePath?: string;
  /** The store's `Agent.project`: basename of the folder the user picked. */
  project?: string;
}

export interface ProjectIdentity {
  /** Stable grouping key: `path:<normalized root>`, `name:<lower name>`, or `none`. */
  key: string;
  /** What the group header says. */
  name: string;
  /** The folder the key came from, for tooltips. Null for name-only keys. */
  path: string | null;
}

export interface ProjectContext {
  /** The repository root `git:mainRepo` resolved for this agent's cwd: a
   *  string when resolved, null when the cwd is not in a repo, undefined while
   *  the lookup has not answered yet. */
  repoRoot?: string | null;
  /** The open hive's home (config.harnessHome) — isolated worktrees live under
   *  `<harnessHome>/worktrees/`. */
  harnessHome?: string | null;
}

/** A drive-letter (`C:\`, `c:/`) or UNC (`\\server\share`) path. */
export function isWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:([\\/]|$)/.test(p) || /^\\\\[^\\]/.test(p);
}

/**
 * One spelling per folder: forward slashes, no duplicate or trailing
 * separators, `.` segments dropped and `..` resolved lexically. Windows paths
 * are case-folded because NTFS is case-insensitive and the same folder arrives
 * as `C:\Work` from a dialog and `c:\work` from a shell. POSIX paths keep their
 * case — Linux is case-sensitive, and a case-sensitive macOS volume exists.
 */
export function normalizePath(raw: string): string {
  const input = (raw ?? '').trim();
  if (!input) return '';
  const windows = isWindowsPath(input);
  const unc = /^\\\\/.test(input) || /^\/\/[^/]/.test(input);
  let s = input.replace(/\\/g, '/');
  let prefix = '';
  if (unc) {
    prefix = '//';
    s = s.replace(/^\/+/, '');
  } else if (/^[a-zA-Z]:/.test(s)) {
    prefix = `${s.slice(0, 2)}/`;
    s = s.slice(2);
  } else if (s.startsWith('/')) {
    prefix = '/';
  }
  const out: string[] = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!prefix) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const joined = prefix + out.join('/');
  return windows || unc ? joined.toLowerCase() : joined;
}

/** Last segment on either separator (`C:\work\app` → `app`). */
export function pathBasename(p: string): string {
  const parts = (p ?? '').split(/[\\/]/).filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  // `C:` alone is a drive, not a folder name.
  return /^[a-zA-Z]:$/.test(last) && parts.length === 1 ? last.toUpperCase() : last;
}

/** Second-to-last segment, for telling two same-named projects apart. */
export function pathParentName(p: string): string {
  const parts = (p ?? '').split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

/** Is `child` the folder `parent` or inside it? Both normalized first. */
export function isPathInside(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (!c || !p) return false;
  if (c === p) return true;
  return c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

/** Does this agent run in one of the hive's isolated worktrees? */
export function isIsolatedWorktree(agent: ProjectAgentInput, harnessHome?: string | null): boolean {
  if (agent.worktreePath && agent.worktreePath.trim()) return true;
  if (!harnessHome || !agent.cwd) return false;
  const root = `${harnessHome.replace(/[\\/]+$/, '')}/worktrees`;
  return isPathInside(agent.cwd, root) && normalizePath(agent.cwd) !== normalizePath(root);
}

/** The project an agent belongs to. See the module comment for the precedence. */
export function projectIdentity(agent: ProjectAgentInput, ctx: ProjectContext = {}): ProjectIdentity {
  const root = typeof ctx.repoRoot === 'string' ? ctx.repoRoot.trim() : '';
  if (root) {
    return { key: `path:${normalizePath(root)}`, name: pathBasename(root) || root, path: root };
  }
  const picked = (agent.project ?? '').trim();
  const cwd = (agent.cwd ?? '').trim();
  if (isIsolatedWorktree(agent, ctx.harnessHome)) {
    if (picked) return { key: `name:${picked.toLowerCase()}`, name: picked, path: null };
  }
  if (cwd) {
    return { key: `path:${normalizePath(cwd)}`, name: pathBasename(cwd) || picked || cwd, path: cwd };
  }
  if (picked) return { key: `name:${picked.toLowerCase()}`, name: picked, path: null };
  return { key: 'none', name: '', path: null };
}

export interface ProjectGroup<T> {
  key: string;
  name: string;
  path: string | null;
  /** Set when another group has the same name: the parent folder's name, so
   *  the two headers read `app · client-a` and `app · client-b`. */
  detail?: string;
  members: T[];
}

/**
 * Bucket agents into project groups, in first-appearance order (callers sort
 * afterwards — see sidebarOrder.ts).
 *
 * A `name:` group whose name matches exactly ONE `path:` group (case-
 * insensitive) is folded into it: that is a worktree agent whose repo lookup
 * failed, and it belongs with its siblings. With two or more candidates the
 * name is ambiguous and the agent keeps its own group rather than being guessed
 * into the wrong repository.
 */
export function groupAgentsByProject<T>(
  agents: readonly T[],
  identityOf: (agent: T) => ProjectIdentity
): ProjectGroup<T>[] {
  const groups: ProjectGroup<T>[] = [];
  const byKey = new Map<string, ProjectGroup<T>>();
  for (const agent of agents) {
    const id = identityOf(agent);
    let g = byKey.get(id.key);
    if (!g) {
      g = { key: id.key, name: id.name, path: id.path, members: [] };
      byKey.set(id.key, g);
      groups.push(g);
    }
    g.members.push(agent);
  }

  const pathGroupsByName = new Map<string, ProjectGroup<T>[]>();
  for (const g of groups) {
    if (!g.key.startsWith('path:')) continue;
    const n = g.name.toLowerCase();
    pathGroupsByName.set(n, [...(pathGroupsByName.get(n) ?? []), g]);
  }
  const folded = new Set<ProjectGroup<T>>();
  for (const g of groups) {
    if (!g.key.startsWith('name:')) continue;
    const candidates = pathGroupsByName.get(g.name.toLowerCase()) ?? [];
    if (candidates.length !== 1) continue;
    candidates[0].members.push(...g.members);
    folded.add(g);
  }
  const out = groups.filter((g) => !folded.has(g));

  // Disambiguate headers that would read identically.
  const byName = new Map<string, ProjectGroup<T>[]>();
  for (const g of out) {
    const n = g.name.toLowerCase();
    byName.set(n, [...(byName.get(n) ?? []), g]);
  }
  for (const same of byName.values()) {
    if (same.length < 2) continue;
    for (const g of same) {
      const parent = g.path ? pathParentName(g.path) : '';
      if (parent) g.detail = parent;
    }
  }
  return out;
}
