/**
 * "Open this note in the sidebar" — the one way another screen (Memory's note
 * drawer) hands a note to the sidebar's editor.
 *
 * The request is parked in a tiny store rather than sent as an event, because
 * the editor may not exist yet: a collapsed sidebar is not mounted at all, so
 * `openSidebarNote` expands it first and NotesSection picks the request up
 * when it mounts (or at once, when it is already on screen). "Agents and
 * notes only" needs nothing: it hides the nav, never the notes.
 *
 * Notes are named by slug only, exactly as main lists them; the sidebar never
 * learns a path from the caller.
 */
import { create } from 'zustand';
import { isValidNoteSlug } from '@shared/workspace/sidebarNotes';
import { useWorkspace } from '../store';

export interface OpenNoteRequest {
  slug: string;
  /** Bumped per request, so asking for the note that is already open still
   *  brings it back into view. */
  seq: number;
}

interface OpenNoteState {
  pending: OpenNoteRequest | null;
  /** NotesSection takes the request it has acted on, so a remount (collapse,
   *  expand) does not reopen a note the user has since closed. */
  take: (seq: number) => void;
}

let seq = 0;

export const useSidebarNoteRequest = create<OpenNoteState>((set, get) => ({
  pending: null,
  take: (n) => { if (get().pending?.seq === n) set({ pending: null }); }
}));

/** Expand the sidebar and open `slug` in its notes editor. False for a name
 *  that is not a sidebar note (nothing changes then). */
export function openSidebarNote(slug: string): boolean {
  if (!isValidNoteSlug(slug)) return false;
  const ws = useWorkspace.getState();
  if (ws.sidebarCollapsed) ws.setSidebarCollapsed(false);
  useSidebarNoteRequest.setState({ pending: { slug, seq: ++seq } });
  return true;
}
