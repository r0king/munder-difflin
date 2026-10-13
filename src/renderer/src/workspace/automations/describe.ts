/**
 * Words for the Automations list: the "when" of a schedule, the one-line
 * description of every row, and relative times.
 *
 * The decisions (which day set, which unit, what a mode lets through) are made
 * in @shared/workspace/automations and tested there; this file only turns those
 * structured answers into sentences through i18next, so each language builds
 * its own sentence instead of reading English fragments in a new order.
 */
import type { TFunction } from 'i18next';
import {
  describeWhen,
  firstLine,
  intervalPhrase,
  webhookGate,
  type IntervalPhrase,
  type MissionRecord,
  type WhenPhrase
} from '@shared/workspace/automations';
import type { ContextRule, WebhookTrigger } from '@shared/triggers';
import type { HouseRule } from '@shared/workspace/automationsRules';

/** An interval as words: "every 2 hours", "every hour". Singular and plural
 *  are separate keys rather than i18next plurals, so the three locale files
 *  keep identical key trees (Arabic alone has six plural forms). */
export function intervalWords(t: TFunction, p: IntervalPhrase): string {
  const one = p.count === 1;
  return t(`wsAutomations.every.${p.unit}${one ? 'One' : 'Many'}`, { count: p.count });
}

/** Short weekday names in the UI language, Sunday first like Date.getDay(). */
function dayName(lang: string, day: number, style: 'short' | 'long'): string {
  // 2023-01-01 was a Sunday; noon UTC is the same calendar day everywhere.
  const d = new Date(Date.UTC(2023, 0, 1 + day, 12));
  try {
    return new Intl.DateTimeFormat(lang, { weekday: style, timeZone: 'UTC' }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en', { weekday: style, timeZone: 'UTC' }).format(d);
  }
}

/** "Mon, Wed and Fri" — the language's own list conjunction. */
function joinList(lang: string, parts: string[]): string {
  try {
    return new Intl.ListFormat(lang, { style: 'long', type: 'conjunction' }).format(parts);
  } catch {
    return parts.join(', ');
  }
}

/** The "when" as one phrase, capitalised to open a sentence. */
export function whenWords(t: TFunction, lang: string, w: WhenPhrase): string {
  switch (w.kind) {
    case 'weekly':
      if (w.set === 'days') {
        if (w.days.length === 1) {
          // "Fridays at 17:00": a per-day key, because "on Fridays" is a
          // different word from "Friday" in most languages, not a suffix.
          return t(`wsAutomations.when.onDay.${w.days[0]}`, { time: w.time });
        }
        return t('wsAutomations.when.days', {
          days: joinList(lang, w.days.map((d) => dayName(lang, d, 'short'))),
          time: w.time
        });
      }
      return t(`wsAutomations.when.${w.set}`, { time: w.time });
    case 'interval':
      return t('wsAutomations.when.interval', { every: intervalWords(t, w.every) });
    case 'heartbeat':
      return t('wsAutomations.when.heartbeat', { every: intervalWords(t, w.every) });
    default:
      return t('wsAutomations.when.unset');
  }
}

export function longDayName(lang: string, day: number): string {
  return dayName(lang, day, 'long');
}

/** "the orchestrator's name", "Everyone", an agent's name, or the raw id for
 *  an agent that has left the floor (marked so it does not read as live). */
export function targetName(
  t: TFunction,
  to: string,
  agents: ReadonlyArray<{ id: string; name: string; isGod?: boolean }>,
  archived: ReadonlyArray<{ id: string; name: string }> = []
): string {
  if (to === 'broadcast') return t('wsAutomations.target.everyone');
  if (to === 'god') return agents.find((a) => a.isGod)?.name ?? t('wsAutomations.target.orchestrator');
  const live = agents.find((a) => a.id === to);
  if (live) return live.name;
  const gone = archived.find((a) => a.id === to);
  return t('wsAutomations.target.gone', { name: gone?.name ?? to });
}

/** A schedule's row line: "Weekdays at 09:00, Michael: Sort new issues into tickets". */
export function scheduleLine(t: TFunction, lang: string, m: MissionRecord, target: string): string {
  const when = whenWords(t, lang, describeWhen(m));
  if (m.kind === 'heartbeat') return t('wsAutomations.desc.heartbeat', { when });
  const what = firstLine(m.body);
  return what
    ? t('wsAutomations.desc.schedule', { when, target, what })
    : t('wsAutomations.desc.scheduleNoPrompt', { when, target });
}

/** A house rule's row line: "A context rule every agent reads: Plain English…". */
export function ruleLine(t: TFunction, r: HouseRule): string {
  const what = firstLine(r.text);
  return what ? t('wsAutomations.desc.rule', { what }) : t('wsAutomations.desc.ruleEmpty');
}

/** The compact / clear rule's row line, from its own numbers. */
export function maintenanceLine(t: TFunction, which: 'compact' | 'clear', rule: ContextRule): string {
  const every = intervalWords(t, intervalPhrase(rule.everyMs) ?? { unit: 'minute', count: 1 });
  return t(`wsAutomations.desc.${which}`, { every, pct: Math.round(rule.minContextPct) });
}

/** A webhook's row line: what its trust mode lets through, and to whom. */
export function webhookLine(t: TFunction, w: WebhookTrigger): string {
  return t(`wsAutomations.desc.webhook.${webhookGate(w.mode)}`);
}

/** "just now", "5 min ago", "in 3 h", "2 d ago". */
export function relTime(t: TFunction, at: number, now: number): string {
  const delta = at - now;
  const a = Math.abs(delta);
  if (a < 45_000) return t('wsAutomations.time.now');
  const mins = Math.round(a / 60_000);
  const [n, unit] = mins < 60 ? [mins, 'm'] : mins < 1440 ? [Math.round(mins / 60), 'h'] : [Math.round(mins / 1440), 'd'];
  return t(`wsAutomations.time.${delta < 0 ? 'ago' : 'in'}.${unit}`, { n });
}
