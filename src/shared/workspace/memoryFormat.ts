/**
 * Small display helpers for the Memory screen — pure, locale passed in.
 *
 * "from Dwight, Tuesday": a note's date reads as a day the user can place —
 * today, yesterday, a weekday within the last week, a short date beyond that.
 */

/** Parse what notes carry: 'YYYY-MM-DD' (a dated heading — a LOCAL day, not
 *  UTC midnight, or it would read as the day before west of Greenwich),
 *  'YYYY-MM-DDTHH:MM' (local) or a full ISO timestamp. */
export function parseNoteDate(value: string | undefined): Date | null {
  if (!value) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (day) {
    const d = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t);
}

export type DayLabel =
  | { kind: 'today' }
  | { kind: 'yesterday' }
  | { kind: 'weekday'; text: string }
  | { kind: 'date'; text: string };

const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Classify a date relative to `now` (local days). Future dates and anything
 *  a week or more back read as a plain date. */
export function dayLabel(date: Date, now: Date, locale: string): DayLabel {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return { kind: 'today' };
  if (days === 1) return { kind: 'yesterday' };
  const safe = (opts: Intl.DateTimeFormatOptions): string => {
    try { return new Intl.DateTimeFormat(locale, opts).format(date); } catch { return new Intl.DateTimeFormat('en', opts).format(date); }
  };
  if (days > 1 && days < 7) return { kind: 'weekday', text: safe({ weekday: 'long' }) };
  const sameYear = date.getFullYear() === now.getFullYear();
  return { kind: 'date', text: safe(sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }) };
}

/** 'YYYY-MM-DD' in local time — the date as an agent should read it. */
export function isoDay(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** Split a snippet into plain / marked runs for rendering without markup. */
export function snippetRuns(text: string, marks: ReadonlyArray<readonly [number, number]>): Array<{ text: string; mark: boolean }> {
  const out: Array<{ text: string; mark: boolean }> = [];
  let at = 0;
  for (const [a, b] of marks) {
    const s = Math.max(at, Math.min(a, text.length));
    const e = Math.max(s, Math.min(b, text.length));
    if (s > at) out.push({ text: text.slice(at, s), mark: false });
    if (e > s) out.push({ text: text.slice(s, e), mark: true });
    at = e;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out;
}
