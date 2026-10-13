/**
 * The Stapler window's view of the app. This window has NO hive store (see
 * stapler/main.tsx): agents come from the roster main caches, state from
 * feat:stapler:state (workspace/useStaplerState), dictation from the dictate
 * unit's own hook (dictate/useDictateState).
 */
import { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import type { RosterEntry } from '@shared/features/roster';
import { ORCHESTRATOR_TARGET, type StaplerTarget } from '@shared/features/stapler';

export const stapler = () => window.cth.features.stapler;

/** The roster main last received from the main window, kept live. */
export function useFeatureRoster(): RosterEntry[] {
  const [list, setList] = useState<RosterEntry[]>([]);
  useEffect(() => {
    let alive = true;
    const off = window.cth.features.onRoster((next) => { if (alive) setList(next); });
    window.cth.features.getRoster().then((next) => { if (alive) setList(next); }, () => { /* no bridge yet */ });
    return () => { alive = false; off(); };
  }, []);
  return list;
}

/**
 * The target to actually use: the remembered one if that agent is still on
 * the roster, else the orchestrator. With an empty roster (no app window has
 * pushed one yet) the remembered agent is kept — main makes the final call.
 */
export function effectiveTarget(target: StaplerTarget, roster: readonly RosterEntry[]): { target: StaplerTarget; gone: boolean } {
  if (target.kind === 'orchestrator') return { target, gone: false };
  if (roster.length === 0 || roster.some((a) => a.id === target.agentId)) return { target, gone: false };
  return { target: ORCHESTRATOR_TARGET, gone: true };
}

/** "Michael" (whoever is god on the roster), an agent's name, or a fallback. */
export function targetName(t: TFunction, target: StaplerTarget, roster: readonly RosterEntry[]): string {
  if (target.kind === 'orchestrator') {
    return roster.find((a) => a.isGod)?.name ?? t('stapler.to.orchestrator');
  }
  return roster.find((a) => a.id === target.agentId)?.name ?? t('stapler.to.unknownAgent');
}

/** Map main's short error codes to sentences; anything else is shown as is
 *  (it came from the OS or an engine and is already words). */
export function errorText(t: TFunction, code: string | undefined | null): string {
  if (!code) return t('stapler.errors.generic');
  // Codes are short words: 'unknown-agent', 'transcription failed' → unknownAgent.
  if (!/^[a-z][a-z -]{0,40}$/i.test(code)) return code;
  const key = `stapler.errors.${code.replace(/[-\s]+(\w)/g, (_m, c: string) => c.toUpperCase())}`;
  const out = t(key);
  return out === key ? code : out;
}

export function reason(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : 'failed';
}
