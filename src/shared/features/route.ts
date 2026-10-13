/**
 * Workspace routing contract, shared by the renderer shell (workspace/store.ts),
 * the feature bridge (`feat:navigate`) and main (`ctx.navigateMainWindow`).
 *
 * A route is plain JSON so it can cross IPC and sit in localStorage. Anything
 * that arrives from outside the renderer — main, a persisted value from an older
 * build — goes through `isWorkspaceRoute` first; an unknown kind is dropped, not
 * guessed at.
 */

export type UiMode = 'classic' | 'workspace';

export type WorkspaceRoute =
  | { kind: 'agents' }
  | { kind: 'agent'; agentId: string }
  | { kind: 'orchestrator'; tab?: string }
  | { kind: 'tasks' }
  | { kind: 'inbox'; section?: string }
  | { kind: 'automations' }
  | { kind: 'memory'; query?: string }
  | { kind: 'capabilities'; tab?: string }
  | { kind: 'stapler' };

export type WorkspaceRouteKind = WorkspaceRoute['kind'];

export const WORKSPACE_ROUTE_KINDS: readonly WorkspaceRouteKind[] = [
  'agents', 'agent', 'orchestrator', 'tasks', 'inbox', 'automations', 'memory', 'capabilities', 'stapler'
];

/** Where the Workspace opens when nothing else has been chosen. */
export const DEFAULT_WORKSPACE_ROUTE: WorkspaceRoute = { kind: 'orchestrator' };

/** `uiMode` as stored in config, normalised. Anything but 'workspace' is
 *  Classic — the mode every existing install already has. */
export function normalizeUiMode(value: unknown): UiMode {
  return value === 'workspace' ? 'workspace' : 'classic';
}

const optionalString = (v: unknown): boolean => v === undefined || typeof v === 'string';

/** Validate an untrusted value as a WorkspaceRoute. Extra keys are tolerated
 *  (they are dropped by `cleanRoute`), wrong types are not. */
export function isWorkspaceRoute(value: unknown): value is WorkspaceRoute {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  switch (r.kind) {
    case 'agents':
    case 'tasks':
    case 'automations':
    case 'stapler':
      return true;
    case 'agent':
      return typeof r.agentId === 'string' && r.agentId.length > 0;
    case 'orchestrator':
    case 'capabilities':
      return optionalString(r.tab);
    case 'inbox':
      return optionalString(r.section);
    case 'memory':
      return optionalString(r.query);
    default:
      return false;
  }
}

/** A validated route reduced to exactly its own keys, so a route that rode in
 *  over IPC cannot smuggle extra state into the store or localStorage. */
export function cleanRoute(route: WorkspaceRoute): WorkspaceRoute {
  switch (route.kind) {
    case 'agent': return { kind: 'agent', agentId: route.agentId };
    case 'orchestrator': return route.tab ? { kind: 'orchestrator', tab: route.tab } : { kind: 'orchestrator' };
    case 'capabilities': return route.tab ? { kind: 'capabilities', tab: route.tab } : { kind: 'capabilities' };
    case 'inbox': return route.section ? { kind: 'inbox', section: route.section } : { kind: 'inbox' };
    case 'memory': return route.query ? { kind: 'memory', query: route.query } : { kind: 'memory' };
    default: return { kind: route.kind };
  }
}

/** Structural equality, for "is this nav item the current route". */
export function sameRoute(a: WorkspaceRoute, b: WorkspaceRoute): boolean {
  return JSON.stringify(cleanRoute(a)) === JSON.stringify(cleanRoute(b));
}
