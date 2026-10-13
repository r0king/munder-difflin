/**
 * Small display helpers for the orchestrator screen: money, tokens, times and
 * who-is-who. Kept apart from the components so every tab formats alike.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useStore } from '@/store/store';
import { useResolvedGodName } from '@/hooks/useResolvedGodName';
import { SYSTEM_ROUTING_SENDERS } from '@shared/workspace/orchestratorRouting';

/** Dollars always read as dollars ($4.20), whatever the interface language:
 *  the spend is billed in USD and the cap is typed in USD. */
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatUsd(n: number | null | undefined): string {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  // A spend under a cent is real money, not nothing: say so rather than "$0.00".
  if (v > 0 && v < 0.005) return '<$0.01';
  return USD.format(v);
}

/** 1.2K / 34K / 1.5M / 2.1B, trailing ".0" trimmed. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export function formatTime(ts: number, lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(ts);
  } catch {
    return new Date(ts).toLocaleTimeString();
  }
}

/** "Today", "Yesterday", or a date in the interface language. */
export function formatDay(ts: number, lang: string, t: TFunction): string {
  const d = new Date(ts);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diff === 0) return t('wsOrchestrator.time.today');
  if (diff === 1) return t('wsOrchestrator.time.yesterday');
  try {
    return new Intl.DateTimeFormat(lang, { weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  } catch {
    return d.toDateString();
  }
}

/** A short weekday for the history bars ("Mon"), from a `YYYY-MM-DD` key. */
export function formatDayKeyShort(dayKey: string, lang: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!m) return dayKey;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  try {
    return new Intl.DateTimeFormat(lang, { weekday: 'short' }).format(d);
  } catch {
    return dayKey.slice(5);
  }
}

/** The i18n key for an app-side sender ('heartbeat' → wsOrchestrator.sender.heartbeat). */
const SENDER_KEYS: Record<string, string> = {
  system: 'system',
  heartbeat: 'heartbeat',
  breaker: 'breaker',
  scheduler: 'scheduler',
  'ephemeral-worker': 'worker',
  harness: 'system',
  slack: 'slack',
  webhook: 'webhook',
  'closing-time': 'closingTime',
  trigger: 'trigger'
};

/**
 * Who-is-who for the routing log and the conversation: agent ids to names
 * (live, archived and restorable agents alike — the log outlives the roster),
 * the router's aliases, the human, and the app's own senders.
 */
export function useParticipantLabel(): { label: (id: string) => string; names: Record<string, string>; godId: string | null } {
  const { t } = useTranslation();
  const godName = useResolvedGodName();
  const agents = useStore((s) => s.agents);
  const archived = useStore((s) => s.archivedAgents);
  const restorable = useStore((s) => s.restorableAgents);
  return useMemo(() => {
    const names: Record<string, string> = {};
    for (const a of [...restorable, ...archived, ...agents]) names[a.id] = a.name;
    const god = agents.find((a) => a.isGod);
    const godId = god?.id ?? null;
    if (godId) names[godId] = god?.name || godName;
    names.god = godId ? names[godId] : godName;
    const label = (id: string): string => {
      if (id === 'human') return t('wsOrchestrator.sender.you');
      if (id === 'broadcast') return t('wsOrchestrator.sender.everyone');
      if (names[id]) return names[id];
      if (SYSTEM_ROUTING_SENDERS.has(id)) return t(`wsOrchestrator.sender.${SENDER_KEYS[id] ?? 'system'}`);
      return id;
    };
    return { label, names, godId };
  }, [agents, archived, restorable, godName, t]);
}
