/**
 * What the Inbox screen and its bell derive from the three sources: who is
 * who, what waits on the human, and the per-agent rows. The rules themselves
 * live in src/shared/workspace/inbox*.ts (tested); this file only joins them
 * to the stores and to i18n.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useStore } from '@/store/store';
import { askedAtMs, compareByNewestAsk } from '@/components/askMeOrder';
import { openQuestion, useHiveTasks, waitsOnHuman, type HiveTask, type HumanQA } from '../useHiveTasks';
import {
  BROADCAST,
  GOD_ALIAS,
  HUMAN,
  SYSTEM,
  buildAgentRows,
  canonicalParty,
  pendingOptions,
  pendingReplyIds,
  summarizeAgents,
  type AgentRow,
  type InboxMessage,
  type NameOf
} from '@shared/workspace/inboxMessages';
import { agentSectionKey } from '@shared/workspace/inboxSection';
import { useInboxMail } from './mailStore';

// ─── Names ──────────────────────────────────────────────────────────────────

/** The orchestrator's hive id when he is on the roster. */
export function useGodId(): string | null {
  return useStore((s) => s.agents.find((a) => a.isGod)?.id ?? null);
}

/**
 * id → display name for every party a message can name: live, archived and
 * restorable agents by their name, the orchestrator by his role alias too,
 * and the pseudo-parties ("human" is You) in the user's language.
 */
export function useNameOf(): NameOf {
  const { t } = useTranslation();
  // A names-only key: the store's agent objects change on every status tick,
  // and nothing here should re-render (or re-run a search) for those.
  const key = useStore((s) => [s.restorableAgents, s.archivedAgents, s.agents]
    .map((list) => list.map((a) => `${a.id}\u0001${a.name}\u0001${a.isGod ? 1 : 0}`).join('\u0002'))
    .join('\u0003'));
  return useMemo(() => {
    const { agents, archivedAgents, restorableAgents } = useStore.getState();
    const names = new Map<string, string>();
    for (const list of [restorableAgents, archivedAgents, agents]) for (const a of list) names.set(a.id, a.name);
    const god = agents.find((a) => a.isGod);
    return (id: string) => {
      if (id === HUMAN) return t('wsInbox.party.you');
      if (id === BROADCAST) return t('wsInbox.party.everyone');
      if (id === SYSTEM) return t('wsInbox.party.system');
      if (id === GOD_ALIAS) return god?.name ?? names.get(GOD_ALIAS) ?? t('wsInbox.party.orchestrator');
      return names.get(id) ?? id;
    };
    // `key` stands for the three lists read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, t]);
}

// ─── What waits on you ──────────────────────────────────────────────────────

export type WaitingItem =
  | { kind: 'ask'; key: string; task: HiveTask; question: HumanQA; agentId: string; at: number }
  | { kind: 'reply'; key: string; message: InboxMessage; agentId: string; at: number };

/** Who an open ask belongs to: the card's owner, else the orchestrator who
 *  wrote it. */
export function askOwner(task: HiveTask, godId: string | null): string {
  const owner = typeof task.assignee === 'string' && task.assignee ? task.assignee : GOD_ALIAS;
  return canonicalParty(owner, godId);
}

export interface WaitingModel {
  /** Asks on cards and requests addressed to you, newest first. */
  items: WaitingItem[];
  loaded: boolean;
  /** Every card, for the cascade count. */
  tasks: HiveTask[];
}

/**
 * Everything waiting on the human, newest first — the Ask me section and the
 * bell. Two kinds, one list:
 *   - an open question on a blocked card (the ledger's humanQA, the Classic
 *     ASK ME set), and
 *   - a request, query or proposal an agent addressed `to: "human"` that you
 *     have not replied to ("→ You · needs a reply").
 * Ordered by when it was asked with the ASK ME board's own comparator, so a
 * question without a usable time sorts last rather than throwing.
 */
export function useWaitingOnYou(): WaitingModel {
  const { tasks, loaded: tasksLoaded } = useHiveTasks();
  const { messages, marks, loaded: mailLoaded } = useInboxMail();
  const godId = useGodId();
  return useMemo(() => {
    const items: WaitingItem[] = [];
    for (const task of tasks) {
      if (!waitsOnHuman(task)) continue;
      const question = openQuestion(task);
      if (!question) continue;
      items.push({
        kind: 'ask', key: `ask:${task.id}`, task, question,
        agentId: askOwner(task, godId), at: askedAtMs(question) ?? Number.NaN
      });
    }
    const pending = pendingReplyIds(messages, pendingOptions(godId, marks));
    for (const m of messages) {
      if (!pending.has(m.id)) continue;
      items.push({
        kind: 'reply', key: `msg:${m.id}`, message: m,
        agentId: canonicalParty(m.from, godId), at: Date.parse(m.createdAt)
      });
    }
    const asked = (i: WaitingItem) => ({ askedAt: i.kind === 'ask' ? i.question.askedAt : i.message.createdAt });
    items.sort((a, b) => compareByNewestAsk(asked(a), asked(b)));
    return { items, loaded: tasksLoaded && mailLoaded, tasks };
  }, [tasks, messages, marks, godId, tasksLoaded, mailLoaded]);
}

// ─── Agent rows ─────────────────────────────────────────────────────────────

/** The left list's agent rows (see buildAgentRows for the order). */
export function useAgentRows(waiting: WaitingItem[]): AgentRow[] {
  // The orchestrator heads the roster: he is the human's proxy on the floor.
  // The send-only prep assistant never talks to you; it is left off unless it
  // somehow has mail (then buildAgentRows adds it from the summaries). Read as
  // a joined string so a status tick does not rebuild the rows.
  const rosterKey = useStore((s) => s.agents
    .filter((a) => !a.isAssistant)
    .sort((a, b) => Number(!!b.isGod) - Number(!!a.isGod))
    .map((a) => a.id)
    .join('\u0001'));
  const { messages, marks } = useInboxMail();
  const godId = useGodId();
  return useMemo(() => {
    const roster = rosterKey ? rosterKey.split('\u0001') : [];
    const summaries = summarizeAgents(messages, godId, marks, agentSectionKey);
    const asks = new Map<string, { count: number; latestAt: number }>();
    for (const item of waiting) {
      if (item.kind !== 'ask') continue;
      const prev = asks.get(item.agentId);
      const at = Number.isFinite(item.at) ? item.at : Number.NEGATIVE_INFINITY;
      asks.set(item.agentId, { count: (prev?.count ?? 0) + 1, latestAt: Math.max(prev?.latestAt ?? Number.NEGATIVE_INFINITY, at) });
    }
    return buildAgentRows(roster, summaries, asks);
  }, [rosterKey, messages, marks, godId, waiting]);
}

// ─── Message reply drafts ───────────────────────────────────────────────────

/**
 * Unsent replies to messages, by message id. Ask me answers keep using the
 * hive store's `answerDrafts` (shared with the Classic ASK ME tab); a reply to
 * a message has no card to key it by, so it lives here — in memory, which is
 * enough to survive switching sections, screens or closing the bell.
 */
export const useReplyDrafts = create<{ drafts: Record<string, string>; set: (id: string, text: string) => void }>((set) => ({
  drafts: {},
  set: (id, text) => set((s) => {
    const drafts = { ...s.drafts };
    if (text) drafts[id] = text;
    else delete drafts[id];
    return { drafts };
  })
}));

// ─── Time ───────────────────────────────────────────────────────────────────

const DAY = 86_400_000;

/**
 * "5 min ago" / "yesterday" / "12 Oct" in the app language, via
 * Intl.RelativeTimeFormat — so Chinese and Arabic read naturally without a
 * hand-built unit string per language.
 */
export function relativeTime(ms: number, lng: string, now = Date.now()): string {
  if (!Number.isFinite(ms)) return '';
  const diff = ms - now;
  const abs = Math.abs(diff);
  try {
    if (abs < 45_000) return new Intl.RelativeTimeFormat(lng, { numeric: 'auto' }).format(0, 'second');
    const rtf = new Intl.RelativeTimeFormat(lng, { numeric: 'auto', style: 'short' });
    if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
    if (abs < DAY) return rtf.format(Math.round(diff / 3_600_000), 'hour');
    if (abs < 7 * DAY) return rtf.format(Math.round(diff / DAY), 'day');
    const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
    return new Date(ms).toLocaleDateString(lng, sameYear
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** Full local date-time, for a tooltip. */
export function fullTime(ms: number, lng: string): string {
  if (!Number.isFinite(ms)) return '';
  try { return new Date(ms).toLocaleString(lng); } catch { return new Date(ms).toISOString(); }
}

/** The translated act word ("request", "inform", …). */
export function actLabel(t: TFunction, act: string): string {
  return t(`wsInbox.act.${act}`, { defaultValue: act });
}
