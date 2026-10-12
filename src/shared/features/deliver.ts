/**
 * The delivery contract: how ANY feature hands text (and files) to an agent or
 * to the orchestrator.
 *
 * There is exactly one implementation, `deliverToAgent` in
 * src/renderer/src/workspace/deliver.ts, and it rides the message queue the
 * composer already uses — the same idle-only, draft-safe, pause-aware drain in
 * useHive. Main-process features (the Stapler, dictation, webhooks of the
 * future) call `ctx.deliverToAgent(req)`, which forwards the request to the
 * main window's renderer over `feat:deliver`; renderer features import the
 * function directly. Nothing types into a PTY on its own.
 */

export type DeliverTarget =
  | { kind: 'orchestrator' }
  | { kind: 'agent'; agentId: string };

/**
 * 'queue' — the composer's Send: parks the message until the agent is free.
 * 'steer' — lands on the agent's next turn. Busy Claude agents get it through
 *           the hook-return channel (control:steer); an idle agent, or an engine
 *           without that channel, gets it at the FRONT of its queue, released
 *           past the floor's delivery pause (the queue's "send now").
 */
export type DeliverMode = 'queue' | 'steer';

export interface DeliverRequest {
  target: DeliverTarget;
  text: string;
  /** Absolute paths. Delivered as an "Attached files:" block the agent Reads —
   *  the same convention as the composer and Slack inbound. */
  attachments?: string[];
  mode?: DeliverMode;
  /** Who sent it ('stapler', 'dictate', 'memory', …). Diagnostics only. */
  source?: string;
}

export interface DeliverResult {
  ok: boolean;
  error?: string;
}

/** Upper bound on one delivery's text. A queued message is persisted to
 *  localStorage and roster.json; a runaway transcript must not blow either. */
export const MAX_DELIVER_TEXT = 200_000;
/** Upper bound on attachments per delivery (the Stapler sends up to eight shots). */
export const MAX_DELIVER_ATTACHMENTS = 64;

/** Validate an untrusted value (it crosses IPC twice) as a DeliverRequest. */
export function isDeliverRequest(value: unknown): value is DeliverRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const t = r.target as Record<string, unknown> | undefined;
  if (!t || typeof t !== 'object') return false;
  if (t.kind === 'agent') {
    if (typeof t.agentId !== 'string' || !t.agentId) return false;
  } else if (t.kind !== 'orchestrator') {
    return false;
  }
  if (typeof r.text !== 'string' || r.text.length > MAX_DELIVER_TEXT) return false;
  if (r.attachments !== undefined) {
    if (!Array.isArray(r.attachments) || r.attachments.length > MAX_DELIVER_ATTACHMENTS) return false;
    if (!r.attachments.every((p) => typeof p === 'string' && p.length > 0)) return false;
  }
  if (r.mode !== undefined && r.mode !== 'queue' && r.mode !== 'steer') return false;
  if (r.source !== undefined && typeof r.source !== 'string') return false;
  return true;
}

/** Last path segment on either separator — the renderer has no `path`. */
export function attachmentName(absPath: string): string {
  const parts = absPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? absPath;
}

/**
 * The text an agent actually receives: the message, then an "Attached files:"
 * block listing each path with its name. Byte-for-byte the composer's format
 * (MessageQueueComposer.queueIt) so an agent's prompt reads the same however
 * the files arrived. Duplicate paths are listed once.
 */
export function composeDeliveryText(text: string, attachments?: readonly string[]): string {
  const files = [...new Set((attachments ?? []).filter((p) => typeof p === 'string' && p.trim()))];
  if (!files.length) return text;
  const head = text.trim() ? `${text}\n\nAttached files:\n` : 'Attached files:\n';
  return head + files.map((p) => `- ${p} (${attachmentName(p)})`).join('\n');
}
