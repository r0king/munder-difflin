/**
 * Small display helpers shared by the agent cards and rooms: the engine/model
 * label, names for hive ids, times, and the ticket key prefix for this floor.
 */
import type { TFunction } from 'i18next';
import type { Agent } from '@/store/store';
import { inferAgentProvider, modelsForProvider, providerPreset } from '@/store/config';

/** "Claude Code · Opus 4.7" — the engine, then the model as its picker names
 *  it (the raw id when the picker does not know it, "default" when unset). */
export function engineModelLabel(t: TFunction, agent: Pick<Agent, 'command' | 'provider' | 'model'>): { engine: string; model: string } {
  const provider = inferAgentProvider(agent.command, agent.provider);
  const preset = providerPreset(provider);
  const known = agent.model ? modelsForProvider(provider).find((m) => m.id === agent.model) : undefined;
  return {
    engine: preset.label,
    model: known?.label ?? agent.model ?? t('wsAgents.card.defaultModel')
  };
}

/** A display name for a hive id: the human, an agent on (or recently off) the
 *  floor, or the id itself. */
export function nameForId(t: TFunction, id: string, agents: readonly Agent[], godName: string): string {
  if (id === 'human') return t('wsAgents.room.you');
  if (id === 'god') return godName;
  const a = agents.find((x) => x.id === id);
  if (a) return a.isGod ? godName : a.name;
  if (id === 'broadcast') return t('wsAgents.room.everyone');
  return id;
}

/** "14:02" today, "12 Oct 14:02" otherwise, in the UI language. */
export function formatWhen(ts: number, lang: string, now = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  try {
    return new Intl.DateTimeFormat(lang, sameDay
      ? { hour: '2-digit', minute: '2-digit' }
      : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

/** The hive folder's name, for the ticket key (wsTasks' deriveTaskKey). */
export function homeFolderName(home: string | null | undefined): string {
  return (home ?? '').split(/[\\/]+/).filter(Boolean).pop() ?? '';
}
