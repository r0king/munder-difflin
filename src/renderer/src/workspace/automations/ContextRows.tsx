/**
 * Context rules — two kinds under one heading:
 *
 *   HouseRuleRow    text every agent reads before it starts ("House style").
 *                   Stored by this unit's main module and folded into each
 *                   agent's hook-channel briefing (see automationsRules.ts).
 *   MaintenanceRow  the built-in auto-compact and auto-clear rules: what an
 *                   agent's context gets told when it fills up. These are
 *                   config.contextTrigger, the same record Classic's Context
 *                   section edits; main owns their timers and re-arms them on
 *                   every save.
 */
import { forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContextRule } from '@shared/triggers';
import { HOUSE_RULE_NAME_MAX, HOUSE_RULE_TEXT_MAX, type HouseRule } from '@shared/workspace/automationsRules';
import { RowShell } from './RowShell';
import { BlurText, Field, useSaveState } from './fields';
import { IntervalInput } from './WhenPicker';
import { maintenanceLine, ruleLine } from './describe';
import type { AutomationsData } from './useAutomationsData';

/* ──────────────────────────────── house rule ────────────────────────────── */

export const HouseRuleRow = forwardRef<HTMLDivElement, {
  rule: HouseRule;
  data: AutomationsData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  autoFocus?: boolean;
  describeError: (code: string) => string;
  onDelete: () => void;
}>(function HouseRuleRow({ rule, data, open, onOpenChange, autoFocus, describeError, onDelete }, ref) {
  const { t } = useTranslation();
  const { state, track, fail, clear } = useSaveState(describeError);
  const empty = !rule.text.trim();

  // patchRule merges into the freshest copy: a blur on the name and a click on
  // the switch can land back to back, and each must carry the other's change.
  const save = (fields: Partial<HouseRule>) => track(data.patchRule(rule.id, fields));

  const toggle = (on: boolean) => {
    if (on && empty) {
      onOpenChange(true);
      fail(t('wsAutomations.blocked.noRuleText'));
      return;
    }
    clear();
    void save({ enabled: on });
  };

  return (
    <RowShell
      ref={ref}
      kind="context"
      name={rule.name}
      description={ruleLine(t, rule)}
      enabled={rule.enabled}
      onToggle={toggle}
      toggleTitle={!rule.enabled && empty ? t('wsAutomations.blocked.noRuleText') : undefined}
      open={open}
      onOpenChange={onOpenChange}
      save={state}
      bodyId={`automation-${rule.id}`}
      onDelete={onDelete}
    >
      <div className="cth-ws-automations-grid">
        <BlurText
          label={t('wsAutomations.field.name')}
          value={rule.name}
          rule={{ required: true, singleLine: true, maxLength: HOUSE_RULE_NAME_MAX }}
          onCommit={(name) => save({ name })}
          placeholder={t('wsAutomations.rule.namePlaceholder')}
          autoFocus={autoFocus}
        />
        <span />
        <BlurText
          label={t('wsAutomations.field.ruleText')}
          value={rule.text}
          multiline
          rows={6}
          wide
          rule={{ maxLength: HOUSE_RULE_TEXT_MAX }}
          // Clearing the text of a live rule switches it off — main stores an
          // empty rule as off, and the switch should say so rather than lie.
          onCommit={(text) => save(text.trim() ? { text } : { text, enabled: false })}
          placeholder={t('wsAutomations.rule.textPlaceholder')}
          hint={t('wsAutomations.rule.hint')}
        />
      </div>
    </RowShell>
  );
});

/* ─────────────────────────────── compact / clear ────────────────────────── */

/** Main clamps a context cadence to 1 minute … 24 hours; the picker offers
 *  exactly that range so it never shows a value main will not store. */
const MIN_EVERY = 60_000;
const MAX_EVERY = 86_400_000;

function PctInput({ label, hint, value, onCommit }: {
  label: string; hint: string; value: number; onCommit: (pct: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <BlurText
      label={label}
      hint={hint}
      value={String(Math.round(value))}
      rule={{ required: true, singleLine: true }}
      validate={(v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 && n <= 100 ? null : t('wsAutomations.maintenance.badPct');
      }}
      onCommit={(v) => onCommit(Math.round(Number(v)))}
      mono
    />
  );
}

export const MaintenanceRow = forwardRef<HTMLDivElement, {
  which: 'compact' | 'clear';
  rule: ContextRule;
  data: AutomationsData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  describeError: (code: string) => string;
}>(function MaintenanceRow({ which, rule, data, open, onOpenChange, describeError }, ref) {
  const { t } = useTranslation();
  const { state, track, clear } = useSaveState(describeError);
  const patch = (fields: Partial<ContextRule>) => track(data.patchContext(which, fields));

  return (
    <RowShell
      ref={ref}
      kind="context"
      name={t(`wsAutomations.maintenance.${which}.name`)}
      description={maintenanceLine(t, which, rule)}
      meta={t('wsAutomations.meta.builtIn')}
      enabled={rule.enabled}
      onToggle={(on) => { clear(); void patch({ enabled: on }); }}
      open={open}
      onOpenChange={onOpenChange}
      save={state}
      bodyId={`automation-context-${which}`}
    >
      <p className="cth-ws-automations-hint">{t(`wsAutomations.maintenance.${which}.blurb`)}</p>
      {which === 'clear' && (
        <p className="cth-ws-automations-callout" data-tone={rule.enabled ? 'warn' : undefined}>
          {t('wsAutomations.maintenance.clear.caution')}
        </p>
      )}
      <div className="cth-ws-automations-grid">
        <Field label={t('wsAutomations.maintenance.noSoonerThan')} wide>
          <IntervalInput
            valueMs={rule.everyMs}
            minMs={MIN_EVERY}
            maxMs={MAX_EVERY}
            ariaLabel={t('wsAutomations.maintenance.noSoonerThan')}
            onCommit={(everyMs) => { void patch({ everyMs }); }}
          />
        </Field>
        <PctInput
          label={t('wsAutomations.maintenance.bar')}
          hint={t('wsAutomations.maintenance.barHint')}
          value={rule.minContextPct}
          onCommit={(minContextPct) => { void patch({ minContextPct }); }}
        />
        <PctInput
          label={t('wsAutomations.maintenance.bigBar')}
          hint={t('wsAutomations.maintenance.bigBarHint')}
          value={rule.minContextPctLargeWindow}
          onCommit={(minContextPctLargeWindow) => { void patch({ minContextPctLargeWindow }); }}
        />
        <BlurText
          label={t(`wsAutomations.maintenance.${which}.messageLabel`)}
          hint={t(`wsAutomations.maintenance.${which}.messageHint`)}
          value={rule.message}
          multiline
          rows={3}
          wide
          mono={which === 'clear'}
          placeholder={which === 'clear' ? '/clear' : undefined}
          onCommit={(message) => patch({ message })}
        />
      </div>
    </RowShell>
  );
});
