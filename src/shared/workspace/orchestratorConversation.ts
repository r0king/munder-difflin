/**
 * The orchestrator's conversation — one timeline built from the two places his
 * talk is recorded:
 *
 *   - his MAILBOX (inbox + outbox, handled and pending), read through
 *     `hive:messages` with secrets already redacted in main: what the floor
 *     and the human's dispatches sent him, and what he sent the floor;
 *   - the PROMPTS the human typed into his terminal (`history:list`), the
 *     other half of "his conversation with you".
 *
 * Queued-but-undelivered composer messages are not here: the composer shows
 * those itself, with their own controls.
 *
 * Import-free on purpose so node:test loads it through test/load-ts.cjs.
 */

/** The fields of a hive message this needs (VoiceMessage in the preload). */
export interface MailLike {
  id: string;
  from: string;
  to: string;
  act: string;
  subject: string;
  body: string;
  direction: 'inbox' | 'outbox';
  archived: boolean;
  created_at: string;
  requires_reply?: boolean;
}

/** A prompt-history row (CommandHistoryEntry in the preload). */
export interface PromptLike {
  id: number;
  text: string;
  ts: number;
}

export interface ConversationItem {
  key: string;
  ts: number;
  kind: 'mail' | 'prompt';
  /** Author: an agent id, 'human' or an app sender ('heartbeat', …). */
  from: string;
  /** Addressee as written ('god', 'human', 'broadcast' or an agent id). */
  to: string;
  act: string | null;
  subject: string;
  body: string;
  /** Mail still waiting in his inbox — he has not read it yet. */
  unread: boolean;
  /** He wrote it. */
  outgoing: boolean;
  /** The sender asked for an answer. */
  needsReply: boolean;
}

export type ConversationScope = 'all' | 'you' | 'floor';

/** Upper bound on one rendered body; the full text is in the hive files. */
export const MAX_CONVERSATION_BODY = 4000;

const clip = (s: string): string => (s.length > MAX_CONVERSATION_BODY ? `${s.slice(0, MAX_CONVERSATION_BODY - 1)}…` : s);

/** True when an id names the orchestrator (his own id or the router's alias). */
function isGod(id: string, godId: string): boolean {
  return id === godId || id === 'god';
}

/**
 * Merge mail and prompts into one timeline, oldest first, at most `limit`
 * items (the newest). Mail is de-duplicated by id: a delivered message exists
 * in both the sender's outbox and the recipient's inbox.
 */
export function buildConversation(
  mail: readonly MailLike[],
  prompts: readonly PromptLike[],
  godId: string,
  limit = 200
): ConversationItem[] {
  const out: ConversationItem[] = [];
  const seen = new Set<string>();
  for (const m of mail) {
    if (!m || typeof m.id !== 'string' || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    const parsed = Date.parse(m.created_at);
    out.push({
      key: `mail:${m.id}`,
      ts: Number.isFinite(parsed) ? parsed : 0,
      kind: 'mail',
      from: m.from,
      to: m.to,
      act: m.act || null,
      subject: m.subject ?? '',
      body: clip(m.body ?? ''),
      unread: m.direction === 'inbox' && !m.archived && !isGod(m.from, godId),
      outgoing: isGod(m.from, godId),
      needsReply: m.requires_reply === true
    });
  }
  for (const p of prompts) {
    if (!p || typeof p.text !== 'string' || !p.text.trim()) continue;
    out.push({
      key: `prompt:${p.id}`,
      ts: Number.isFinite(p.ts) ? p.ts : 0,
      kind: 'prompt',
      from: 'human',
      to: godId,
      act: null,
      subject: '',
      body: clip(p.text),
      unread: false,
      outgoing: false,
      needsReply: false
    });
  }
  // Stable: equal timestamps keep insertion order (mail before prompts).
  const sorted = out.map((item, i) => ({ item, i })).sort((a, b) => a.item.ts - b.item.ts || a.i - b.i).map((x) => x.item);
  return sorted.length > limit ? sorted.slice(sorted.length - limit) : sorted;
}

/** 'you' = what passed between him and the human; 'floor' = everything else. */
export function filterConversation(items: readonly ConversationItem[], scope: ConversationScope): ConversationItem[] {
  if (scope === 'all') return [...items];
  const withYou = (c: ConversationItem): boolean => c.kind === 'prompt' || c.from === 'human' || c.to === 'human';
  return items.filter((c) => (scope === 'you' ? withYou(c) : !withYou(c)));
}
