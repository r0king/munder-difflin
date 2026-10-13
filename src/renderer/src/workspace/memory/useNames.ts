/**
 * Who an agent id is, for the Memory screen: the live roster's name first (it
 * follows renames as they happen), then the archived and restorable lists,
 * then what main read from the hive registry for this answer — an agent that
 * left the floor months ago still wrote the note.
 */
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type Agent } from '@/store/store';
import { dayLabel, parseNoteDate } from '@shared/workspace/memoryFormat';
import type { MemoryAgentInfo, MemoryAnswer } from '@shared/workspace/memoryTypes';

export interface NameBook {
  name(id: string): string;
  role(id: string): string | undefined;
  /** The live (on the floor, not archived) agent, if any. */
  live(id: string): Agent | undefined;
  isGod(id: string): boolean;
}

export function useNameBook(answers: ReadonlyArray<MemoryAnswer | null | undefined>): NameBook {
  const agents = useStore((s) => s.agents);
  const archived = useStore((s) => s.archivedAgents);
  const restorable = useStore((s) => s.restorableAgents);
  const people = useMemo(() => {
    const m = new Map<string, MemoryAgentInfo>();
    for (const a of answers) for (const p of a?.people ?? []) if (!m.has(p.id)) m.set(p.id, p);
    return m;
  }, [answers]);

  return useMemo<NameBook>(() => {
    const find = (id: string): Agent | undefined =>
      agents.find((a) => a.id === id) ?? archived.find((a) => a.id === id) ?? restorable.find((a) => a.id === id);
    return {
      name: (id) => find(id)?.name || people.get(id)?.name || id,
      role: (id) => people.get(id)?.role || find(id)?.description || undefined,
      live: (id) => agents.find((a) => a.id === id && !a.archived),
      isGod: (id) => !!(find(id)?.isGod || people.get(id)?.isGod)
    };
  }, [agents, archived, restorable, people]);
}

/** "today", "yesterday", "Tuesday", "Sep 1" — for a note's ISO date. */
export function useWhen(): (iso: string | undefined) => string | undefined {
  const { t, i18n } = useTranslation();
  return useCallback((iso) => {
    const d = parseNoteDate(iso);
    if (!d) return undefined;
    const label = dayLabel(d, new Date(), i18n.language || 'en');
    if (label.kind === 'today') return t('wsMemory.note.today');
    if (label.kind === 'yesterday') return t('wsMemory.note.yesterday');
    return label.text;
  }, [t, i18n.language]);
}
