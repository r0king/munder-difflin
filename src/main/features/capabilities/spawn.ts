/**
 * What an agent's own grant adds to its spawn. Called from index.ts
 * spawnAgentCore for every hive spawn (Add Agent, restore, Restart & Continue,
 * a worker), right where the hive provisions the agent — the same place the
 * global MCP defaults and the built-in skills are applied, so a grant rides the
 * mechanisms that already existed rather than a parallel one:
 *
 *   MCP          the global consent map, overlaid with this agent's grants, is
 *                what hive.ensureAgent writes into its per-session settings.
 *                Secret-tier servers are the exception (see mcpSpawnOverlay):
 *                they go into a separate `--mcp-config` file WITHOUT an env
 *                block, and the key goes into the agent's environment, which
 *                the server process inherits. The key is decrypted here, in
 *                main, at spawn — the same posture as the BYOK provider keys —
 *                and never touches disk in plaintext or crosses IPC.
 *   connections  a per-agent broker token scoped to the granted, usable
 *                integration ids (workers already get one for all of them; a
 *                spawn that carries a token is left alone). teardownPty
 *                revokes it with every other PTY's.
 *   skills       already in the agent's own `.claude/skills/` (granted at grant
 *                time); `--add-dir <agent folder>` makes Claude Code load them
 *                as skills rather than leaving them as files it could read.
 *
 * An agent with no grant gets exactly the input back — no flag, no env — so
 * nothing changes for anyone who never opens Capabilities. Never throws: hive
 * provisioning must not fail because of a grant.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mcpCatalogEntry } from '../../../shared/mcpCatalog';
import {
  mcpSecretEnvName,
  mcpSpawnOverlay,
  type McpDefaultsMap
} from '../../../shared/workspace/capabilities';
import { readGrants, mcpKeyPresence, readMcpKey } from './grantsStore';
import { agentDir } from './agentSkills';

export interface SpawnInjectionInput {
  /** The PTY id — the broker grant is keyed by it, so teardownPty revokes it. */
  ptyId: string;
  /** The hive agent id the grant belongs to. */
  agentId: string;
  provider: string;
  /** config.mcpDefaults as the spawn would have used it. */
  mcpDefaults: McpDefaultsMap;
  /** Mint a broker token for these integration ids, or null when the broker is
   *  down or this spawn already carries a token (an ephemeral worker). */
  grantBroker: ((ids: string[]) => { url: string; token: string }) | null;
}

export interface SpawnInjection {
  mcpDefaults: McpDefaultsMap;
  args: string[];
  env: Record<string, string>;
}

export interface SpawnDeps {
  dataDir: string;
  hiveRoot: string | null;
  /** Integration ids that are enabled and hold their secret right now. */
  usableIntegrationIds: () => string[];
  /** Records which grant version each agent was spawned with. */
  recordApplied: (agentId: string, updatedAt: number) => void;
}

export function buildSpawnInjection(input: SpawnInjectionInput, deps: SpawnDeps): SpawnInjection {
  const passthrough: SpawnInjection = { mcpDefaults: input.mcpDefaults, args: [], env: {} };
  try {
    const grant = readGrants(deps.dataDir).agents[input.agentId];
    deps.recordApplied(input.agentId, grant?.updatedAt ?? 0);
    if (!grant) return passthrough;

    const claude = input.provider === 'claude';
    const out: SpawnInjection = { mcpDefaults: input.mcpDefaults, args: [], env: {} };

    if (claude && grant.mcp.length > 0) {
      const overlay = mcpSpawnOverlay(grant, input.mcpDefaults, mcpKeyPresence());
      out.mcpDefaults = overlay.mcpDefaults;
      const servers: Record<string, { command: string; args: string[] }> = {};
      for (const id of overlay.keyed) {
        const entry = mcpCatalogEntry(id);
        const envName = mcpSecretEnvName(id);
        const key = readMcpKey(id);
        if (!entry || !envName || !key) continue;
        servers[`munder-${id}`] = { command: entry.spec.command, args: [...entry.spec.args] };
        out.env[envName] = key;
      }
      if (Object.keys(servers).length > 0) {
        const dir = join(deps.dataDir, 'mcp');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${input.agentId}.json`);
        writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2), { encoding: 'utf8', mode: 0o600 });
        out.args.push('--mcp-config', file);
      }
    }

    if (claude && grant.skills.length > 0 && deps.hiveRoot) {
      const dir = agentDir(deps.hiveRoot, input.agentId);
      if (dir) out.args.push('--add-dir', dir);
    }

    if (grant.connections.length > 0 && input.grantBroker) {
      const usable = new Set(deps.usableIntegrationIds());
      const ids = grant.connections.filter((id) => usable.has(id));
      if (ids.length > 0) {
        const { url, token } = input.grantBroker(ids);
        out.env.MD_BROKER_URL = url;
        out.env.MD_BROKER_TOKEN = token;
      }
    }
    return out;
  } catch (e) {
    console.error('[capabilities] spawn injection failed (spawning without grants):', e);
    return passthrough;
  }
}
