/**
 * The sidebar's own preferences, persisted through the Workspace store's
 * `cth.ws.*` helpers (loadWsPref / saveWsPref — every access try/caught).
 *
 *   sidebar.keepOrder          "Keep my agent order" (global)
 *   sidebar.agentsNotesOnly    "Agents and notes only" (global)
 *   sidebar.hive.<key>         per hive: the manual agent order, the manual
 *                              project order, and which project groups are
 *                              collapsed
 *
 * Per HIVE because agent ids and project folders mean nothing across hives:
 * the hive picker can open another folder in the same window, and an order
 * saved for one floor must not be applied to a different set of agents that
 * happens to reuse an id. Floor windows already get their own localStorage
 * (a session partition each), so nothing here needs to know about floors.
 */
import { create } from 'zustand';
import { loadWsPref, saveWsPref } from '../store';
import { isIdList, mergeSavedOrder } from '@shared/workspace/sidebarOrder';

export interface HiveSidebarState {
  /** Saved agent order (flat, across projects). Only read when keepOrder. */
  agents: string[];
  /** Saved project-key order. Only read when keepOrder. */
  projects: string[];
  /** Collapsed project keys. Applies in both orders. */
  collapsed: string[];
}

const EMPTY: HiveSidebarState = { agents: [], projects: [], collapsed: [] };

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

function isHiveState(v: unknown): v is HiveSidebarState {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return isIdList(r.agents) && isIdList(r.projects) && isIdList(r.collapsed);
}

/** A short, stable key for a hive folder (djb2 → base36). The folder path
 *  itself would work but is long and personal; this is only a storage key. */
export function hiveKeyFor(harnessHome: string | null | undefined): string {
  const s = (harnessHome ?? '').trim();
  if (!s) return 'none';
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const prefKey = (hive: string): string => `sidebar.hive.${hive}`;

interface SidebarPrefsState {
  keepOrder: boolean;
  agentsNotesOnly: boolean;
  byHive: Record<string, HiveSidebarState>;
  setKeepOrder: (on: boolean) => void;
  setAgentsNotesOnly: (on: boolean) => void;
  /** Read (and cache) one hive's state. */
  hive: (hive: string) => HiveSidebarState;
  /** Persist a new VIEW order of present agents; absent agents keep their slots. */
  saveAgentOrder: (hive: string, view: string[]) => void;
  saveProjectOrder: (hive: string, view: string[]) => void;
  toggleCollapsed: (hive: string, projectKey: string) => void;
  /** Forget the manual order for this hive (Reset). */
  resetOrder: (hive: string) => void;
}

export const useSidebarPrefs = create<SidebarPrefsState>((set, get) => {
  const write = (hive: string, next: HiveSidebarState) => {
    saveWsPref(prefKey(hive), next);
    set((s) => ({ byHive: { ...s.byHive, [hive]: next } }));
  };
  return {
    keepOrder: loadWsPref('sidebar.keepOrder', false, isBool),
    agentsNotesOnly: loadWsPref('sidebar.agentsNotesOnly', false, isBool),
    byHive: {},
    setKeepOrder: (on) => {
      saveWsPref('sidebar.keepOrder', on);
      set({ keepOrder: on });
    },
    setAgentsNotesOnly: (on) => {
      saveWsPref('sidebar.agentsNotesOnly', on);
      set({ agentsNotesOnly: on });
    },
    hive: (hive) => {
      const cached = get().byHive[hive];
      if (cached) return cached;
      const loaded = loadWsPref<HiveSidebarState>(prefKey(hive), EMPTY, isHiveState);
      // Cache without a re-render: this runs during render.
      get().byHive[hive] = loaded;
      return loaded;
    },
    saveAgentOrder: (hive, view) => {
      const cur = get().hive(hive);
      write(hive, { ...cur, agents: mergeSavedOrder(cur.agents, view) });
    },
    saveProjectOrder: (hive, view) => {
      const cur = get().hive(hive);
      write(hive, { ...cur, projects: mergeSavedOrder(cur.projects, view) });
    },
    toggleCollapsed: (hive, projectKey) => {
      const cur = get().hive(hive);
      const collapsed = cur.collapsed.includes(projectKey)
        ? cur.collapsed.filter((k) => k !== projectKey)
        : [...cur.collapsed, projectKey].slice(-200);
      write(hive, { ...cur, collapsed });
    },
    resetOrder: (hive) => {
      const cur = get().hive(hive);
      write(hive, { ...cur, agents: [], projects: [] });
    }
  };
});

/** One hive's state, re-rendering when it changes. */
export function useHiveSidebarState(hive: string): HiveSidebarState {
  return useSidebarPrefs((s) => s.byHive[hive] ?? s.hive(hive));
}
