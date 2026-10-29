import { existsSync } from 'node:fs';
import { lstat, readlink, realpath, symlink, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RemoteExec } from './git';
import { linkDepsCommand } from './deviceCommands';

export type DepLink =
  | { ok: true; skipped: boolean }
  | { ok: false; error: string };

export type DepUnlink =
  | { ok: true; removed: boolean }
  | { ok: false; error: string };

/** Link the base checkout's dependencies into an isolated worktree. On a
 *  device (`remote`) the same rule runs there as one shell command. */
export async function linkWorktreeDeps(baseDir: string, worktreeDir: string, remote?: RemoteExec): Promise<DepLink> {
  if (remote) {
    const r = await remote.exec(linkDepsCommand(baseDir, worktreeDir));
    return r.ok
      ? { ok: true, skipped: !r.stdout.includes('linked') }
      : { ok: false, error: r.error ?? (r.stderr.trim() || `exit ${r.code}`) };
  }
  const baseNodeModules = join(baseDir, 'node_modules');
  const worktreeNodeModules = join(worktreeDir, 'node_modules');
  if (!existsSync(baseNodeModules)) return { ok: true, skipped: true };

  try {
    await lstat(worktreeNodeModules);
    return { ok: true, skipped: true };
  } catch {
    // node_modules does not exist in this worktree yet.
  }

  try {
    await symlink(baseNodeModules, worktreeNodeModules, process.platform === 'win32' ? 'junction' : null);
    return { ok: true, skipped: false };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** Remove the dependency link before testing whether a worktree is dirty. */
export async function unlinkWorktreeDeps(baseDir: string, worktreeDir: string): Promise<DepUnlink> {
  const baseNodeModules = join(baseDir, 'node_modules');
  const worktreeNodeModules = join(worktreeDir, 'node_modules');

  try {
    const stat = await lstat(worktreeNodeModules);
    if (!stat.isSymbolicLink()) return { ok: true, removed: false };
    const linkTarget = await readlink(worktreeNodeModules);
    const [baseTarget, worktreeTarget] = await Promise.all([
      realpath(baseNodeModules),
      realpath(resolve(worktreeDir, linkTarget))
    ]);
    if (baseTarget !== worktreeTarget) return { ok: true, removed: false };
    await unlink(worktreeNodeModules);
    return { ok: true, removed: true };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return { ok: true, removed: false };
    return { ok: false, error: String(error) };
  }
}
