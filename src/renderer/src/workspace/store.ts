/**
 * Workspace shell state — which screen is open and how the sidebar sits.
 *
 * Deliberately a SEPARATE zustand store from @/store/store: that one is the
 * hive's roster (agents, queues, selection) and is shared by both interfaces;
 * this one is purely the Workspace's presentation state and means nothing in
 * Classic. Units read and write it through `navigate` — never by setting
 * `route` directly — so the canonicalisation below always applies.
 *
 * Persisted to localStorage under `cth.ws.*`, every access in a try/catch the
 * way App.tsx and the main store do it (storage can be unavailable, and a
 * thrown quota error must not take the shell down).
 */
import { create } from 'zustand';
import { useStore } from '@/store/store';
import {
  DEFAULT_WORKSPACE_ROUTE,
  cleanRoute,
  isWorkspaceRoute,
  type WorkspaceRoute,
  type WorkspaceRouteKind
} from '@shared/features/route';

export type { WorkspaceRoute, WorkspaceRouteKind };
export { DEFAULT_WORKSPACE_ROUTE, isWorkspaceRoute, sameRoute } from '@shared/features/route';

export const WS_SIDEBAR_MIN = 200;
export const WS_SIDEBAR_MAX = 560;
export const WS_SIDEBAR_DEFAULT = 248;

const LS_ROUTE = 'cth.ws.route';
const LS_COLLAPSED = 'cth.ws.sidebarCollapsed';
const LS_WIDTH = 'cth.ws.sidebarWidth';

// ─── Per-unit preferences ───────────────────────────────────────────────────

/**
 * Read a persisted Workspace preference (`cth.ws.<key>`), e.g. the Tasks
 * screen's chosen view: `loadWsPref('tasks.view', 'board', isView)`.
 * Namespace your key with your unit (`tasks.`, `inbox.`, …). Returns
 * `fallback` when the value is missing, unparseable or fails `validate`.
 */
export function loadWsPref<T>(key: string, fallback: T, validate?: (v: unknown) => v is T): T {
  try {
    const raw = window.localStorage.getItem(`cth.ws.${key}`);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (validate ? validate(parsed) : parsed !== null && parsed !== undefined) return parsed as T;
  } catch { /* unavailable or corrupt — fall back */ }
  return fallback;
}

/** Persist a Workspace preference (`cth.ws.<key>`). Best-effort. */
export function saveWsPref(key: string, value: unknown): void {
  try { window.localStorage.setItem(`cth.ws.${key}`, JSON.stringify(value)); } catch { /* best-effort */ }
}

// ─── Store ──────────────────────────────────────────────────────────────────

export interface WorkspaceState {
  route: WorkspaceRoute;
  /** Go somewhere. Validates and canonicalises: an agent route for the
   *  orchestrator becomes the orchestrator route, and an agent route also
   *  SELECTS that agent in the hive store, so the IDE, focus mode and
   *  hold-Option-to-talk all follow what is on screen. */
  navigate: (route: WorkspaceRoute) => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  sidebarWidth: number;
  /** Clamped to [WS_SIDEBAR_MIN, WS_SIDEBAR_MAX] and persisted. */
  setSidebarWidth: (px: number) => void;
}

export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return WS_SIDEBAR_DEFAULT;
  return Math.min(WS_SIDEBAR_MAX, Math.max(WS_SIDEBAR_MIN, Math.round(px)));
}

const initialRoute: WorkspaceRoute = loadWsPref<WorkspaceRoute>('route', DEFAULT_WORKSPACE_ROUTE, isWorkspaceRoute);
const initialCollapsed = loadWsPref<boolean>('sidebarCollapsed', false, (v): v is boolean => typeof v === 'boolean');
const initialWidth = clampSidebarWidth(
  loadWsPref<number>('sidebarWidth', WS_SIDEBAR_DEFAULT, (v): v is number => typeof v === 'number')
);

/** God's id when he is on the roster (the orchestrator is addressed by role,
 *  not by id, everywhere in the Workspace). */
function godId(): string | null {
  return useStore.getState().agents.find((a) => a.isGod)?.id ?? null;
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  route: cleanRoute(initialRoute),
  navigate: (next) => {
    if (!isWorkspaceRoute(next)) return;
    let route = cleanRoute(next);
    const hive = useStore.getState();
    if (route.kind === 'agent') {
      const agentId = route.agentId;
      const target = hive.agents.find((a) => a.id === agentId);
      if (target?.isGod) route = { kind: 'orchestrator' };
      else if (target && hive.selectedId !== target.id) hive.select(target.id);
    }
    if (route.kind === 'orchestrator') {
      const god = godId();
      if (god && hive.selectedId !== god) hive.select(god);
    }
    if (JSON.stringify(route) === JSON.stringify(get().route)) return;
    try { window.localStorage.setItem(LS_ROUTE, JSON.stringify(route)); } catch { /* best-effort */ }
    set({ route });
  },
  sidebarCollapsed: initialCollapsed,
  toggleSidebar: () => get().setSidebarCollapsed(!get().sidebarCollapsed),
  setSidebarCollapsed: (collapsed) => {
    try { window.localStorage.setItem(LS_COLLAPSED, JSON.stringify(collapsed)); } catch { /* best-effort */ }
    set({ sidebarCollapsed: collapsed });
  },
  sidebarWidth: initialWidth,
  setSidebarWidth: (px) => {
    const width = clampSidebarWidth(px);
    if (width === get().sidebarWidth) return;
    try { window.localStorage.setItem(LS_WIDTH, JSON.stringify(width)); } catch { /* best-effort */ }
    set({ sidebarWidth: width });
  }
}));

/** Non-hook access for event handlers and the feature bridge. */
export function navigateWorkspace(route: WorkspaceRoute): void {
  useWorkspace.getState().navigate(route);
}
