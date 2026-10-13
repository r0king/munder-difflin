/**
 * A schedule: a mission dispatched on a calendar ("Weekdays at 09:00") or an
 * interval ("every 2 hours") to the orchestrator, one agent, or everyone.
 *
 * The record is config.missions — the same list Classic's Schedules edits — so
 * a save here is what the scheduler in main re-arms from (missions:save calls
 * syncMissions). Switching one on arms it at once: a never-run interval
 * schedule runs right away, a weekly one at its next slot.
 */
import { forwardRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { missionBlocker, nextRunAt, type MissionRecord } from '@shared/workspace/automations';
import { RowShell } from './RowShell';
import { BlurText, Field, useSaveState } from './fields';
import { WhenPicker } from './WhenPicker';
import { relTime, scheduleLine, targetName } from './describe';
import type { AutomationsData } from './useAutomationsData';

const LABEL_MAX = 120;
const PROMPT_MAX = 20_000;

export const ScheduleRow = forwardRef<HTMLDivElement, {
  mission: MissionRecord;
  data: AutomationsData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  autoFocus?: boolean;
  now: number;
  describeError: (code: string) => string;
  /** The screen deletes, so a failure can still be reported once the row is gone. */
  onDelete: () => void;
}>(function ScheduleRow({ mission: m, data, open, onOpenChange, autoFocus, now, describeError, onDelete }, ref) {
  const { t, i18n } = useTranslation();
  const agents = useStore((s) => s.agents);
  const archived = useStore((s) => s.archivedAgents);
  const { state, track, fail, clear } = useSaveState(describeError);
  const heartbeat = m.kind === 'heartbeat';

  const target = targetName(t, m.to, agents, archived);
  const line = scheduleLine(t, i18n.language, m, target);

  const next = nextRunAt(m, now);
  const meta = m.enabled && next !== null
    ? t('wsAutomations.meta.next', { when: relTime(t, next, now) })
    : m.lastFiredAt
      ? t('wsAutomations.meta.last', { when: relTime(t, m.lastFiredAt, now) })
      : null;

  const patch = (fields: Partial<MissionRecord>) => track(data.patchMission(m.id, fields));

  const toggle = (on: boolean) => {
    if (on) {
      const blocker = missionBlocker(m);
      if (blocker) {
        onOpenChange(true);
        fail(t(`wsAutomations.blocked.${blocker}`));
        return;
      }
    }
    clear();
    void patch({ enabled: on });
  };

  // Everyone, the orchestrator, then each worker on the floor. A schedule aimed
  // at an agent who has since left keeps its target listed, so opening the row
  // does not silently retarget it.
  const options = useMemo(() => {
    const list: { value: string; label: string }[] = [
      { value: 'god', label: agents.find((a) => a.isGod)?.name ?? t('wsAutomations.target.orchestrator') },
      ...agents.filter((a) => !a.isGod).map((a) => ({ value: a.id, label: a.name })),
      { value: 'broadcast', label: t('wsAutomations.target.everyone') }
    ];
    if (m.to && !list.some((o) => o.value === m.to)) list.push({ value: m.to, label: target });
    return list;
  }, [agents, m.to, target, t]);

  return (
    <RowShell
      ref={ref}
      kind="schedule"
      name={m.label}
      description={line}
      meta={meta}
      enabled={m.enabled}
      onToggle={toggle}
      toggleTitle={!m.enabled && missionBlocker(m) ? t(`wsAutomations.blocked.${missionBlocker(m)}`) : undefined}
      open={open}
      onOpenChange={onOpenChange}
      save={state}
      bodyId={`automation-${m.id}`}
      onDelete={onDelete}
    >
      <div className="cth-ws-automations-grid">
        <BlurText
          label={t('wsAutomations.field.name')}
          value={m.label}
          rule={{ required: true, singleLine: true, maxLength: LABEL_MAX }}
          onCommit={(label) => patch({ label })}
          placeholder={t('wsAutomations.schedule.namePlaceholder')}
          autoFocus={autoFocus}
        />
        {!heartbeat && (
          <Field label={t('wsAutomations.field.goesTo')}>
            <select
              className="cth-ws-automations-select"
              value={m.to}
              onChange={(e) => { void patch({ to: e.target.value }); }}
            >
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
        )}
        <WhenPicker
          intervalMs={m.intervalMs}
          weekly={m.weekly}
          heartbeat={heartbeat}
          onInterval={(intervalMs) => { void patch({ intervalMs }); }}
          // `weekly: undefined` must be SENT, not omitted: main merges by id and
          // spreads, so a missing key would leave the old calendar in place.
          onWeekly={(weekly) => { void patch({ weekly }); }}
        />
        <BlurText
          label={t('wsAutomations.field.prompt')}
          value={m.body}
          multiline
          rows={5}
          wide
          rule={{ maxLength: PROMPT_MAX }}
          onCommit={(body) => patch({ body })}
          placeholder={t('wsAutomations.schedule.promptPlaceholder')}
          hint={heartbeat
            ? t('wsAutomations.schedule.heartbeatHint')
            : t('wsAutomations.schedule.promptHint', { target })}
        />
      </div>
    </RowShell>
  );
});
