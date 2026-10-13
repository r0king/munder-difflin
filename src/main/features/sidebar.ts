/**
 * Workspace sidebar — main-process side (owned by the `wsSidebar` unit).
 *
 * Two things the sidebar needs that no existing IPC serves:
 *
 *   NOTES — the user's quick markdown notes, one file each at
 *   `<harnessHome>/hive/notes/<slug>.md`. They live IN the hive on purpose:
 *   every agent can read them by path, and the hive's single-committer git
 *   history keeps every version. The file rules (slug-only addressing, no
 *   symlinks followed, atomic writes, mtime conflicts) live in
 *   ./sidebar/notesFs.ts; this module is the IPC face plus a watcher that tells
 *   every app window when the folder changes, whoever changed it — the user in
 *   another floor, or an agent.
 *
 *   FLOOR — which office this window is. With more than one floor open the
 *   sidebar header carries the office's number; main is the only place that
 *   sees every window.
 *
 * Channels:
 *   feat:sidebar:notes:list | read | write | rename | delete | search  (invoke)
 *   feat:sidebar:notes:changed   (push, app windows)
 *   feat:sidebar:floor           (invoke: this window's FloorInfo; push: the same, when floors open/close)
 */
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import type { FeatureContext, FeatureModule } from './types';
import type {
  FloorInfo,
  NoteDeleteResult,
  NoteReadResult,
  NotesListResult,
  NotesSearchResult,
  NoteWriteResult
} from '../../shared/workspace/sidebarNotes';
import {
  deleteNote,
  listNotes,
  noteDirsFor,
  readNote,
  renameNote,
  searchNotes,
  writeNote,
  type NoteDirs
} from './sidebar/notesFs';

const CH = {
  list: 'feat:sidebar:notes:list',
  read: 'feat:sidebar:notes:read',
  write: 'feat:sidebar:notes:write',
  rename: 'feat:sidebar:notes:rename',
  remove: 'feat:sidebar:notes:delete',
  search: 'feat:sidebar:notes:search',
  changed: 'feat:sidebar:notes:changed',
  floor: 'feat:sidebar:floor'
} as const;

let ctxRef: FeatureContext | null = null;

/** Resolved per call: the hive follows config (the hive picker can switch it). */
function dirs(): NoteDirs | null {
  return noteDirsFor(ctxRef?.harnessHome());
}

// ─── Notes watcher ──────────────────────────────────────────────────────────

let watcher: FSWatcher | null = null;
let watchedDir: string | null = null;
let changeTimer: NodeJS.Timeout | null = null;

function closeWatcher(): void {
  try { watcher?.close(); } catch { /* already closed */ }
  watcher = null;
  watchedDir = null;
}

/**
 * Watch the notes folder (flat, so non-recursive `fs.watch` is enough on every
 * platform) and push `feat:sidebar:notes:changed` to app windows. Bursts (a
 * temp file, then the rename) collapse into one push. Re-pointed whenever an
 * operation resolves a different folder (the hive changed).
 */
function ensureWatcher(dir: string): void {
  if (watchedDir === dir && watcher) return;
  closeWatcher();
  if (!existsSync(dir)) return;
  try {
    watcher = watch(dir, { persistent: false }, () => {
      if (changeTimer) clearTimeout(changeTimer);
      changeTimer = setTimeout(() => {
        changeTimer = null;
        ctxRef?.broadcast(CH.changed);
      }, 250);
    });
    watcher.on('error', () => closeWatcher());
    watchedDir = dir;
  } catch {
    closeWatcher();
  }
}

const watchOpts = { onDir: ensureWatcher };

// ─── Floors ─────────────────────────────────────────────────────────────────

/** webContents id → office number. Handed out lowest-free, so closing floor 2
 *  and opening another gives the new one 2 again. */
const floorNumbers = new Map<number, number>();
let floorTimer: NodeJS.Timeout | null = null;

function liveAppWindows(): BrowserWindow[] {
  return (ctxRef?.appWindows() ?? []).filter((w) => !w.isDestroyed());
}

function renumberFloors(): BrowserWindow[] {
  const wins = liveAppWindows();
  const live = new Set(wins.map((w) => w.webContents.id));
  for (const id of [...floorNumbers.keys()]) if (!live.has(id)) floorNumbers.delete(id);
  for (const w of wins) {
    const id = w.webContents.id;
    if (floorNumbers.has(id)) continue;
    const used = new Set(floorNumbers.values());
    let n = 1;
    while (used.has(n)) n++;
    floorNumbers.set(id, n);
  }
  return wins;
}

function floorInfoFor(sender: WebContents): FloorInfo {
  const wins = renumberFloors();
  return { number: floorNumbers.get(sender.id) ?? 1, count: Math.max(1, wins.length) };
}

/** A window opened or closed: every app window learns its (possibly new)
 *  number and the count. Deferred so the host has registered the new window
 *  in its app-window list (or dropped the closed one) first. */
function scheduleFloorPush(): void {
  if (floorTimer) clearTimeout(floorTimer);
  floorTimer = setTimeout(() => {
    floorTimer = null;
    for (const w of renumberFloors()) {
      try { w.webContents.send(CH.floor, floorInfoFor(w.webContents)); } catch { /* closing */ }
    }
  }, 120);
}

function onWindowCreated(_e: unknown, win: BrowserWindow): void {
  win.once('closed', scheduleFloorPush);
  scheduleFloorPush();
}

// ─── Module ─────────────────────────────────────────────────────────────────

export const sidebarFeature: FeatureModule = {
  name: 'sidebar',
  register(ctx) {
    ctxRef = ctx;
    ipcMain.handle(CH.list, (): NotesListResult => listNotes(dirs(), watchOpts));
    ipcMain.handle(CH.read, (_e, slug: unknown): NoteReadResult => readNote(dirs(), slug));
    ipcMain.handle(CH.write, (_e, req: unknown): NoteWriteResult => writeNote(dirs(), req, watchOpts));
    ipcMain.handle(CH.rename, (_e, req: unknown): NoteWriteResult => renameNote(dirs(), req));
    ipcMain.handle(CH.remove, (_e, slug: unknown): NoteDeleteResult => deleteNote(dirs(), slug));
    ipcMain.handle(CH.search, (_e, query: unknown): NotesSearchResult => searchNotes(dirs(), query));
    ipcMain.handle(CH.floor, (e: IpcMainInvokeEvent): FloorInfo => floorInfoFor(e.sender));
    // Windows created before register (the primary) are numbered on first
    // ask; later ones announce themselves here.
    app.on('browser-window-created', onWindowCreated);
    for (const w of liveAppWindows()) w.once('closed', scheduleFloorPush);
  },
  dispose() {
    closeWatcher();
    if (changeTimer) clearTimeout(changeTimer);
    if (floorTimer) clearTimeout(floorTimer);
    app.removeListener('browser-window-created', onWindowCreated);
  }
};
