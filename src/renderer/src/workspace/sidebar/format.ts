/**
 * Locale-aware formatting for the sidebar. Built on Intl rather than i18n
 * keys: Intl already knows how Chinese and Arabic say "3 minutes ago" and how
 * Arabic writes its digits, and a hand-rolled plural table would get Arabic's
 * six plural forms wrong.
 */

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600_000],
  ['month', 30 * 24 * 3600_000],
  ['week', 7 * 24 * 3600_000],
  ['day', 24 * 3600_000],
  ['hour', 3600_000],
  ['minute', 60_000],
  ['second', 1000]
];

/** "3 min ago", "yesterday", "in 2 hours" — in the UI language. */
export function relativeTime(at: number, now: number, lang: string): string {
  const diff = at - now;
  const abs = Math.abs(diff);
  let fmt: Intl.RelativeTimeFormat;
  try {
    fmt = new Intl.RelativeTimeFormat(lang || 'en', { numeric: 'auto', style: 'short' });
  } catch {
    fmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' });
  }
  if (abs < 45_000) return fmt.format(0, 'second');
  for (const [unit, size] of UNITS) {
    if (abs >= size || unit === 'second') return fmt.format(Math.round(diff / size), unit);
  }
  return fmt.format(0, 'second');
}

/** "4m", "1h 12m" — a running duration, compact, with Intl's narrow unit
 *  names so it reads "4分钟" and "٤ د" too. */
export function shortDuration(ms: number, lang: string): string {
  const unit = (v: number, u: 'second' | 'minute' | 'hour') => {
    try {
      return new Intl.NumberFormat(lang || 'en', { style: 'unit', unit: u, unitDisplay: 'narrow' }).format(v);
    } catch {
      return `${v}${u[0]}`;
    }
  };
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return unit(s, 'second');
  const m = Math.floor(s / 60);
  if (m < 60) return unit(m, 'minute');
  const h = Math.floor(m / 60);
  return m % 60 ? `${unit(h, 'hour')} ${unit(m % 60, 'minute')}` : unit(h, 'hour');
}

/** 38k, 1.2M — token counts. */
export function compactNumber(v: number, lang: string): string {
  try {
    return new Intl.NumberFormat(lang || 'en', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
  } catch {
    return String(v);
  }
}
