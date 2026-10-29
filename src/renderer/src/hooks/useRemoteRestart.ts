/**
 * The control page's Restart (devices phase 2, item 8). Restart lives in
 * the renderer, so main asks this window and waits for the answer. It is the
 * floor's own Restart & Continue: resume when the engine can, else fresh.
 */
import { useEffect } from 'react';
import { restartAgentProcess } from '@/workspace/agents/restartAgent';

export function useRemoteRestart(): void {
  useEffect(() => window.cth.onRemoteRestart(async (agentId) => {
    const r = await restartAgentProcess(agentId, { resume: true, resumeOptional: true });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }), []);
}
