/**
 * The roster snapshot main keeps for its features.
 *
 * Main does not know the renderer's agents (the store owns them), but the
 * Stapler's "To" menu, dictation and any main-side feature need a list to pick
 * from. The renderer pushes this minimal, PII-free view over `feat:roster`
 * whenever the roster changes (debounced, see useFeatureBridge), and main serves
 * it back to feature windows — which must never import the renderer store
 * themselves (see docs/WORKSPACE_UNITS.md, "stapler window").
 */
import { WS_AGENT_STATUSES, type WsAgentStatus } from '../workspace/agentStatus';

export interface RosterEntry {
  id: string;
  name: string;
  isGod: boolean;
  model?: string;
  provider?: string;
  /** The agent's project (basename of its repo), for grouping in pickers. */
  project?: string;
  status: WsAgentStatus;
}

/** Hard cap on entries accepted from a renderer. */
const MAX_ROSTER = 500;
const MAX_FIELD = 200;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_FIELD) : undefined;

/** Keep only well-formed entries, trimmed to their own keys. Never throws. */
export function sanitizeRoster(value: unknown): RosterEntry[] {
  if (!Array.isArray(value)) return [];
  const out: RosterEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, MAX_ROSTER)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = str(r.id);
    const name = str(r.name);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const status = (WS_AGENT_STATUSES as readonly string[]).includes(r.status as string)
      ? (r.status as WsAgentStatus)
      : 'offline';
    const entry: RosterEntry = { id, name, isGod: r.isGod === true, status };
    const model = str(r.model);
    const provider = str(r.provider);
    const project = str(r.project);
    if (model) entry.model = model;
    if (provider) entry.provider = provider;
    if (project) entry.project = project;
    out.push(entry);
  }
  return out;
}
