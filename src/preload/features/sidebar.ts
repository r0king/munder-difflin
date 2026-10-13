/**
 * `window.cth.features.sidebar` — owned by the `wsSidebar` unit. The Workspace sidebar.
 *
 * Notes (files under `<harnessHome>/hive/notes/`, addressed by slug only — main
 * owns the folder and validates every name) and this window's office number.
 * See src/main/features/sidebar.ts.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  FloorInfo,
  NoteDeleteResult,
  NoteReadResult,
  NoteRenameRequest,
  NotesListResult,
  NotesSearchResult,
  NoteWriteRequest,
  NoteWriteResult
} from '../../shared/workspace/sidebarNotes';

export const sidebarApi = {
  /** Every note, newest first (metadata only). */
  notesList: (): Promise<NotesListResult> => ipcRenderer.invoke('feat:sidebar:notes:list'),
  /** One note with its body and absolute path. */
  notesRead: (slug: string): Promise<NoteReadResult> => ipcRenderer.invoke('feat:sidebar:notes:read', slug),
  /** Create (no slug) or overwrite (slug + the `expectedUpdatedAt` it was
   *  loaded at; a mismatch answers `conflict` with the version on disk). */
  notesWrite: (req: NoteWriteRequest): Promise<NoteWriteResult> => ipcRenderer.invoke('feat:sidebar:notes:write', req),
  /** New title; the file is renamed to match when the title slugs differently. */
  notesRename: (req: NoteRenameRequest): Promise<NoteWriteResult> => ipcRenderer.invoke('feat:sidebar:notes:rename', req),
  notesDelete: (slug: string): Promise<NoteDeleteResult> => ipcRenderer.invoke('feat:sidebar:notes:delete', slug),
  /** Ranked full-text search over titles and bodies. */
  notesSearch: (query: string): Promise<NotesSearchResult> => ipcRenderer.invoke('feat:sidebar:notes:search', query),
  /** The notes folder changed (the user, another floor, or an agent). */
  onNotesChanged: (cb: () => void): (() => void) => {
    const listener = () => cb();
    ipcRenderer.on('feat:sidebar:notes:changed', listener);
    return () => ipcRenderer.removeListener('feat:sidebar:notes:changed', listener);
  },
  /** Which office this window is, and how many are open. */
  floorInfo: (): Promise<FloorInfo> => ipcRenderer.invoke('feat:sidebar:floor'),
  /** Pushed when a floor opens or closes (numbers and the count can change). */
  onFloorInfo: (cb: (info: FloorInfo) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, info: FloorInfo) => cb(info);
    ipcRenderer.on('feat:sidebar:floor', listener);
    return () => ipcRenderer.removeListener('feat:sidebar:floor', listener);
  }
};
