/**
 * grants.json — every agent's own capability record, in one small file under
 * `<userData>/features/capabilities/`. Outside the hive on purpose: the hive is
 * a git repository every agent can write, and a grant is the user's decision
 * about what an agent may reach (a broker token, a keyed MCP server).
 *
 * Every change is ONE read-modify-write of the whole file, written to a temp
 * file and renamed over the old one, so a grant — one toggle or a whole role
 * bundle — lands completely or not at all. Main is single-threaded and these
 * calls are synchronous, so two IPC calls can never interleave a write.
 *
 * Secret-tier MCP keys live in the existing encrypted secret store
 * (main/integrations.ts, safeStorage) under `mcpkey:<id>`; this module only
 * ever asks whether one exists, and reads one MAIN-ONLY at spawn.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isEmptyGrant,
  mcpKeyRef,
  parseGrantsFile,
  secretMcpIds,
  type AgentGrant,
  type GrantsFile
} from '../../../shared/workspace/capabilities';
import { deleteSecret, getSecret, hasSecret, setSecret } from '../../integrations';

export function grantsPath(dataDir: string): string {
  return join(dataDir, 'grants.json');
}

export function readGrants(dataDir: string): GrantsFile {
  const p = grantsPath(dataDir);
  try {
    if (!existsSync(p)) return { version: 1, agents: {} };
    return parseGrantsFile(JSON.parse(readFileSync(p, 'utf8')));
  } catch {
    return { version: 1, agents: {} };
  }
}

function writeGrants(dataDir: string, file: GrantsFile): void {
  const p = grantsPath(dataDir);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, p);
}

/**
 * Replace one agent's record with what `fn` returns (undefined or an empty
 * grant deletes it). Returns the stored record, or the unchanged one when `fn`
 * hands back the same object (no write at all).
 */
export function updateGrant(
  dataDir: string,
  agentId: string,
  fn: (current: AgentGrant | undefined) => AgentGrant | undefined
): AgentGrant | undefined {
  const file = readGrants(dataDir);
  const current = file.agents[agentId];
  const next = fn(current);
  if (next === current) return current;
  if (!next || isEmptyGrant(next)) delete file.agents[agentId];
  else file.agents[agentId] = next;
  writeGrants(dataDir, file);
  return next && !isEmptyGrant(next) ? next : undefined;
}

/* ─────────────────────────────── MCP keys ───────────────────────────────── */

export function mcpKeyPresence(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const id of secretMcpIds()) out[id] = hasSecret(mcpKeyRef(id));
  return out;
}

export function saveMcpKey(id: string, key: string): { ok: boolean; error?: string } {
  return setSecret(mcpKeyRef(id), key);
}

export function removeMcpKey(id: string): void {
  deleteSecret(mcpKeyRef(id));
}

/** MAIN-ONLY. Decrypts a key for a spawn; never crosses IPC. */
export function readMcpKey(id: string): string | undefined {
  return getSecret(mcpKeyRef(id));
}
