/**
 * "When does this run": a repeating gap, or days of the week and a time.
 *
 * Writes go straight to the record — the day toggles, the unit and the mode at
 * once, the typed numbers (count, time) on blur. The one thing that is held
 * back is a week with no days in it: main would silently fall back to the
 * interval, so an empty week stays a local draft with a note until a day is
 * picked again.
 */
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMinute, normalizeWeekly } from '@shared/weeklySchedule';
import { intervalPhrase, type IntervalUnit } from '@shared/workspace/automations';
import { Button, SegmentedControl } from '../ui';
import { longDayName } from './describe';
import { Field } from './fields';

const UNIT_MS: Record<IntervalUnit, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000
};
const UNITS: IntervalUnit[] = ['minute', 'hour', 'day', 'week'];
const MAX_COUNT = 9999;

const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
export const DEFAULT_WEEKLY = { days: WEEKDAYS, minute: 9 * 60 };

/* ──────────────────────────────── interval ──────────────────────────────── */

export function IntervalInput({ valueMs, onCommit, minMs = UNIT_MS.minute, maxMs = Number.POSITIVE_INFINITY, ariaLabel }: {
  valueMs: number;
  onCommit: (ms: number) => void;
  minMs?: number;
  maxMs?: number;
  ariaLabel: string;
}) {
  const { t } = useTranslation();
  const phrase = intervalPhrase(valueMs) ?? { unit: 'hour' as IntervalUnit, count: 1 };
  const [draft, setDraft] = useState(String(phrase.count));
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const units = UNITS.filter((u) => UNIT_MS[u] <= maxMs);

  useEffect(() => {
    if (!focused) setDraft(String(phrase.count));
  }, [phrase.count, focused]);

  const clamp = (ms: number) => Math.min(maxMs, Math.max(minMs, ms));

  const commitCount = () => {
    setFocused(false);
    const n = Number(draft.trim());
    if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) {
      setDraft(String(phrase.count));
      setError(t('wsAutomations.when.badCount', { max: MAX_COUNT }));
      return;
    }
    setError(null);
    const ms = clamp(n * UNIT_MS[phrase.unit]);
    if (ms !== valueMs) onCommit(ms);
    else setDraft(String(phrase.count));
  };

  return (
    <div className="cth-ws-automations-field">
      <div className="cth-ws-automations-inline">
        <span className="cth-ws-automations-hint">{t('wsAutomations.when.everyLabel')}</span>
        <input
          type="text"
          inputMode="numeric"
          className="cth-ws-automations-input cth-ws-automations-input--num"
          aria-label={ariaLabel}
          aria-invalid={error ? true : undefined}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setError(null); }}
          onFocus={() => setFocused(true)}
          onBlur={commitCount}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
            if (e.key === 'Escape') { e.preventDefault(); setDraft(String(phrase.count)); setError(null); }
          }}
        />
        <select
          className="cth-ws-automations-select"
          style={{ width: 'auto' }}
          aria-label={t('wsAutomations.when.unitLabel')}
          value={units.includes(phrase.unit) ? phrase.unit : units[units.length - 1]}
          onChange={(e) => {
            const unit = e.target.value as IntervalUnit;
            const ms = clamp(phrase.count * UNIT_MS[unit]);
            if (ms !== valueMs) onCommit(ms);
          }}
        >
          {units.map((u) => <option key={u} value={u}>{t(`wsAutomations.when.unit.${u}`)}</option>)}
        </select>
      </div>
      {error && <p className="cth-ws-automations-fielderr" role="alert">{error}</p>}
    </div>
  );
}

/* ───────────────────────────────── weekly ───────────────────────────────── */

type Weekly = { days: number[]; minute: number };

function WeeklyInput({ value, onCommit }: { value: Weekly; onCommit: (w: Weekly) => void }) {
  const { t, i18n } = useTranslation();
  const [days, setDays] = useState<number[]>(value.days);
  const [time, setTime] = useState(formatMinute(value.minute));
  const [timeFocused, setTimeFocused] = useState(false);
  const storedDays = value.days.join(',');

  // Follow the stored schedule unless a local (empty) draft is being held.
  useEffect(() => {
    setDays((d) => (d.length === 0 ? d : value.days));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedDays]);
  useEffect(() => {
    if (!timeFocused) setTime(formatMinute(value.minute));
  }, [value.minute, timeFocused]);

  const commitDays = (next: number[]) => {
    const sorted = [...new Set(next)].sort((a, b) => a - b);
    setDays(sorted);
    const valid = normalizeWeekly({ days: sorted, minute: value.minute });
    if (valid) onCommit(valid);
  };
  const toggle = (d: number) => commitDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d]);
  const same = (set: number[]) => days.length === set.length && set.every((d) => days.includes(d));

  const commitTime = () => {
    setTimeFocused(false);
    const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
    const minute = m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
    if (!Number.isInteger(minute) || minute < 0 || minute > 1439) { setTime(formatMinute(value.minute)); return; }
    if (minute === value.minute) return;
    const valid = normalizeWeekly({ days: days.length ? days : value.days, minute });
    if (valid) onCommit(valid);
  };

  return (
    <div className="cth-ws-automations-field">
      <div className="cth-ws-automations-inline">
        <div className="cth-ws-automations-days" role="group" aria-label={t('wsAutomations.when.daysLabel')}>
          {/* Sunday-first, matching Date.getDay(), so what is clicked is what is
              stored. Each button's name is the full day for screen readers. */}
          {EVERY_DAY.map((d) => {
            const name = longDayName(i18n.language, d);
            return (
              <button
                key={d}
                type="button"
                className="cth-ws-automations-day"
                aria-pressed={days.includes(d)}
                aria-label={name}
                title={name}
                onClick={() => toggle(d)}
              >{t(`wsAutomations.when.initial.${d}`)}</button>
            );
          })}
        </div>
        <span className="cth-ws-automations-hint">{t('wsAutomations.when.at')}</span>
        <input
          type="time"
          className="cth-ws-automations-input cth-ws-automations-input--time"
          aria-label={t('wsAutomations.when.timeLabel')}
          value={time}
          onChange={(e) => setTime(e.target.value)}
          onFocus={() => setTimeFocused(true)}
          onBlur={commitTime}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
        />
      </div>
      <div className="cth-ws-automations-inline">
        <Button size="sm" variant={same(WEEKDAYS) ? 'secondary' : 'ghost'} onClick={() => commitDays(WEEKDAYS)}>
          {t('wsAutomations.when.weekdaysButton')}
        </Button>
        <Button size="sm" variant={same(EVERY_DAY) ? 'secondary' : 'ghost'} onClick={() => commitDays(EVERY_DAY)}>
          {t('wsAutomations.when.everyDayButton')}
        </Button>
        <Button size="sm" variant={same([0, 6]) ? 'secondary' : 'ghost'} onClick={() => commitDays([0, 6])}>
          {t('wsAutomations.when.weekendsButton')}
        </Button>
      </div>
      {days.length === 0
        ? <p className="cth-ws-automations-fielderr" role="alert">{t('wsAutomations.when.pickADay')}</p>
        : <p className="cth-ws-automations-hint">{t('wsAutomations.when.localTime')}</p>}
    </div>
  );
}

/* ─────────────────────────────────── both ───────────────────────────────── */

/**
 * @param heartbeat the heartbeat has no calendar — its cadence adapts to how
 *   busy the floor is — so it offers the interval alone, as Classic does.
 */
export function WhenPicker({ intervalMs, weekly, heartbeat, onInterval, onWeekly }: {
  intervalMs: number;
  weekly: Weekly | undefined;
  heartbeat?: boolean;
  onInterval: (ms: number) => void;
  /** `undefined` switches back to the interval. */
  onWeekly: (w: Weekly | undefined) => void;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  const valid = normalizeWeekly(weekly);
  const mode: 'interval' | 'weekly' = !heartbeat && weekly !== undefined ? 'weekly' : 'interval';

  return (
    <Field label={<span id={labelId}>{t('wsAutomations.field.when')}</span>} wide>
      {!heartbeat && (
        <SegmentedControl<'interval' | 'weekly'>
          size="sm"
          ariaLabel={t('wsAutomations.field.when')}
          value={mode}
          options={[
            { value: 'weekly', label: t('wsAutomations.when.modeWeekly') },
            { value: 'interval', label: t('wsAutomations.when.modeInterval') }
          ]}
          onChange={(m) => onWeekly(m === 'weekly' ? (valid ?? DEFAULT_WEEKLY) : undefined)}
        />
      )}
      {mode === 'weekly'
        ? <WeeklyInput value={valid ?? DEFAULT_WEEKLY} onCommit={onWeekly} />
        : <IntervalInput valueMs={intervalMs} onCommit={onInterval} ariaLabel={t('wsAutomations.when.countLabel')} />}
    </Field>
  );
}
