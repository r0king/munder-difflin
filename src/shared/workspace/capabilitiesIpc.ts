/**
 * The IPC surface of Workspace → Capabilities (main/features/capabilities.ts ↔
 * preload/features/capabilities.ts), in one place so the two halves cannot
 * drift. Shapes only — no secret ever appears in any of them: MCP keys and
 * connection secrets go IN (write-only) and come back as booleans.
 */
import type { AgentGrant, BundleDiff, CapabilityKind } from './capabilities';
import type { TempRecord, TempsFile } from './capabilitiesTemps';

export const CAPABILITIES_CHANNELS = {
  state: 'feat:capabilities:state',
  setGrant: 'feat:capabilities:setGrant',
  clearGrants: 'feat:capabilities:clearGrants',
  previewBundle: 'feat:capabilities:previewBundle',
  applyBundle: 'feat:capabilities:applyBundle',
  setMcpKey: 'feat:capabilities:setMcpKey',
  clearMcpKey: 'feat:capabilities:clearMcpKey',
  temps: 'feat:capabilities:temps',
  hireTemp: 'feat:capabilities:hireTemp',
  stopTemp: 'feat:capabilities:stopTemp',
  setMaxTemps: 'feat:capabilities:setMaxTemps',
  clearTempHistory: 'feat:capabilities:clearTempHistory',
  /** main → renderer push: something changed; re-read the named slice. */
  changed: 'feat:capabilities:changed'
} as const;

/** Upper bound on agent ids one `state` call may ask about. */
export const MAX_STATE_AGENTS = 200;
/** Upper bound on a pasted key (a database URL can be long; a PEM is not a key here). */
export const MAX_MCP_KEY_CHARS = 4096;

export interface CapabilitiesState {
  /** False before a hive folder is open: nothing can be granted yet. */
  hive: boolean;
  grants: Record<string, AgentGrant>;
  /** Built-in skill folders (resources/skills) — every agent has these. */
  builtinSkills: string[];
  /** Folders in ~/.claude/skills — every Claude Code agent loads these. */
  machineSkills: string[];
  /** Skill folders in each asked-about agent's own folder, built-ins excluded. */
  agentSkills: Record<string, string[]>;
  /** Whether a key is saved, per secret-tier MCP id. */
  mcpKeys: Record<string, boolean>;
  /** Grant `updatedAt` each agent was last spawned with (this app session). */
  appliedAt: Record<string, number>;
  /** Skill installs in flight, per agent. */
  installing: Record<string, string[]>;
  /** The last materialisation error per `<agentId>/<skill>`. */
  skillErrors: Record<string, string>;
}

export interface SetGrantRequest {
  agentId: string;
  kind: CapabilityKind;
  id: string;
  on: boolean;
  /** For a catalog skill: which row to install, when two rows would land in
   *  the same folder name. */
  source?: { owner: string; name: string };
}

export type GrantResult = { ok: true; grant: AgentGrant | null } | { ok: false; error: string };

export type BundleResult = { ok: true; diff: BundleDiff; grant?: AgentGrant | null } | { ok: false; error: string };

export interface TempsState extends TempsFile {
  running: number;
  hive: boolean;
}

export type HireTempResult = { ok: true; temp: TempRecord } | { ok: false; error: string };

export interface CapabilitiesChanged {
  what: 'grants' | 'temps' | 'keys';
}
