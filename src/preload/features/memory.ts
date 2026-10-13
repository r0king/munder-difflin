/**
 * `window.cth.features.memory` — owned by the `wsMemory` unit. Memory search.
 *
 * Add members here and nowhere else; the object is spread into the bridge as
 * is, so its type IS the renderer's type. Channels: MEMORY_CHANNELS
 * (src/shared/workspace/memoryTypes.ts), handled in src/main/features/memory.ts.
 *
 * Semantic memory's install/enable status is NOT here: the screen reads it
 * through the existing `window.cth.memoryStatus()`, whose poll is also what
 * arms the palace's mine loop after a late install.
 */
import { ipcRenderer } from 'electron';
import {
  MEMORY_CHANNELS,
  type MemoryNoteRef,
  type MemoryNoteText,
  type MemorySearchResult,
  type MemoryStats
} from '../../shared/workspace/memoryTypes';

export const memoryApi = {
  /** Exact matches: the literal words, over memory, tickets, board, notes. */
  search: (query: string): Promise<MemorySearchResult> => ipcRenderer.invoke(MEMORY_CHANNELS.search, query),
  /** By meaning: MemPalace's semantic search, grouped the same way. */
  meaning: (query: string): Promise<MemorySearchResult> => ipcRenderer.invoke(MEMORY_CHANNELS.meaning, query),
  /** Topic / ticket / note counts for the header. */
  stats: (): Promise<MemoryStats> => ipcRenderer.invoke(MEMORY_CHANNELS.stats),
  /** The full text behind one note result. */
  readNote: (ref: MemoryNoteRef): Promise<MemoryNoteText> => ipcRenderer.invoke(MEMORY_CHANNELS.readNote, ref)
};
