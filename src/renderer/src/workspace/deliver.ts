/**
 * deliverToAgent — THE way any feature sends text (and files) to an agent or
 * to the orchestrator. Main-process features reach it through `feat:deliver`
 * (useFeatureBridge); renderer features import it.
 *
 * It adds no delivery mechanism of its own. Both modes ride paths the app
 * already trusts:
 *
 *   'queue'  enqueueMessage — exactly the composer's Send. The message parks in
 *            the agent's queue and useHive's drain types it in once the agent
 *            is idle, its prompt holds no user draft or open picker, the floor
 *            is not paused, and the boot grace is over (docs/message-queue.md).
 *
 *   'steer'  lands on the agent's NEXT turn:
 *            - a busy Claude agent gets it as a steer note (control:steer): the
 *              hook server injects it as additionalContext at the next
 *              PostToolUse/UserPromptSubmit, without typing into the TUI.
 *            - an idle agent — where a steer note would just sit until the
 *              next prompt — or an engine without that hook channel, gets it at
 *              the FRONT of its queue, released past the floor pause (the
 *              queue's "send now"). Still idle-gated and draft-safe.
 *
 * Attachments are absolute paths, delivered as the composer's "Attached
 * files:" block (composeDeliveryText) for the agent to Read. Images ride the
 * same way — the agent CLIs read image files by path.
 *
 * The orchestrator is addressed by ROLE: whoever is god on the roster, or the
 * fixed 'god' id while he is still booting (his queue drains once he is up —
 * the same thing Slack inbound does).
 */
import { useStore, type Agent } from '@/store/store';
import { inferAgentProvider, isClaudeProvider } from '@shared/agentProvider';
import {
  composeDeliveryText,
  isDeliverRequest,
  type DeliverRequest,
  type DeliverResult
} from '@shared/features/deliver';

export type { DeliverRequest, DeliverResult, DeliverMode, DeliverTarget } from '@shared/features/deliver';
export { composeDeliveryText } from '@shared/features/deliver';

/** God's fixed hive id (useHive's GOD_ID). */
const GOD_ID = 'god';

/** Resolve a request's target to the agent id whose queue it goes in. */
function resolveTargetId(req: DeliverRequest, agents: Agent[], archived: Agent[]): { id: string } | { error: string } {
  if (req.target.kind === 'orchestrator') {
    return { id: agents.find((a) => a.isGod)?.id ?? GOD_ID };
  }
  const id = req.target.agentId;
  if (agents.some((a) => a.id === id)) return { id };
  if (archived.some((a) => a.id === id)) return { error: `agent ${id} is archived` };
  return { error: `unknown agent: ${id}` };
}

/** Queue `body` and move it to the front, released past the floor pause. */
function sendNow(agentId: string, body: string): void {
  const s = useStore.getState();
  s.enqueueMessage(agentId, body);
  // enqueueMessage returns nothing; find what it just appended. It trims, and
  // it may have declined a duplicate /compact or inbox nudge — then there is
  // nothing of ours to release, which is fine.
  const queue = useStore.getState().messageQueues[agentId] ?? [];
  const mine = [...queue].reverse().find((m) => m.text === body.trim());
  if (mine) s.releaseQueuedMessage(agentId, mine.id);
}

export async function deliverToAgent(req: DeliverRequest): Promise<DeliverResult> {
  if (!isDeliverRequest(req)) return { ok: false, error: 'invalid delivery request' };
  const body = composeDeliveryText(req.text, req.attachments);
  if (!body.trim()) return { ok: false, error: 'nothing to send' };

  const state = useStore.getState();
  const target = resolveTargetId(req, state.agents, state.archivedAgents);
  if ('error' in target) return { ok: false, error: target.error };

  if ((req.mode ?? 'queue') === 'queue') {
    state.enqueueMessage(target.id, body);
    return { ok: true };
  }

  // Steer.
  const agent = state.agents.find((a) => a.id === target.id);
  const busy = !!agent?.ptyId && agent.status !== 'idle';
  if (agent && busy && isClaudeProvider(inferAgentProvider(agent.command, agent.provider))) {
    try {
      const snap = await window.cth.controlSteer(agent.id, body);
      if (snap) return { ok: true };
    } catch { /* fall back to the queue below */ }
  }
  sendNow(target.id, body);
  return { ok: true };
}
