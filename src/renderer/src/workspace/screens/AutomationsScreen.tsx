/**
 * Automations: schedules, context rules and webhooks in one list.
 * Owned by the `wsAutomations` unit.
 *
 * "The floor keeps working while you are away from the keyboard." Every row is
 * a view over storage Classic already uses (see automations/useAutomationsData),
 * so a schedule switched on here is the same mission the Command Center shows,
 * armed by the same scheduler in main.
 *
 * There is no Save button: text saves when you leave the field, switches save
 * at once, and each row says "Saved" (or what went wrong) where it happened.
 * New automations are created OFF and opened for editing — each one starts the
 * moment you switch it on.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  assembleAutomations,
  countByKind,
  countOn,
  filterAutomations,
  newMission,
  type AutomationFilter,
  type AutomationItem,
  type AutomationKind
} from '@shared/workspace/automations';
import { newHouseRule } from '@shared/workspace/automationsRules';
import { generateWebhookSecret, newWebhook } from '@/components/triggers/api';
import { Button, EmptyState, Screen, ScreenHeader, SegmentedControl, Spinner } from '../ui';
import { loadWsPref, saveWsPref } from '../store';
import type { WorkspaceScreenProps } from '../types';
import { useAutomationsData } from '../automations/useAutomationsData';
import { NewAutomationButtons, NewAutomationMenu } from '../automations/NewAutomationMenu';
import { ScheduleRow } from '../automations/ScheduleRow';
import { HouseRuleRow, MaintenanceRow } from '../automations/ContextRows';
import { WebhookRow } from '../automations/WebhookRow';
import { DEFAULT_WEEKLY } from '../automations/WhenPicker';
import '../automations/automations.css';

const FILTERS: AutomationFilter[] = ['all', 'schedule', 'context', 'webhook'];
const isFilter = (v: unknown): v is AutomationFilter => FILTERS.includes(v as AutomationFilter);

/** Relative times ("next in 3 h") are re-read this often. */
const CLOCK_MS = 30_000;

export function AutomationsScreen({ config }: WorkspaceScreenProps) {
  const { t } = useTranslation();
  const data = useAutomationsData(config);
  const [filter, setFilterState] = useState<AutomationFilter>(() => loadWsPref('automations.filter', 'all', isFilter));
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const scrollTo = useRef<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  const setFilter = (f: AutomationFilter) => { setFilterState(f); saveWsPref('automations.filter', f); };

  const describeError = useCallback((code: string): string => {
    switch (code) {
      case 'invalid': return t('wsAutomations.error.invalid');
      case 'full': return t('wsAutomations.error.full');
      case 'notFound': case 'gone': return t('wsAutomations.error.gone');
      case 'writeFailed': return t('wsAutomations.error.writeFailed');
      case 'notDispatched': return t('wsAutomations.error.notDispatched');
      default: return t('wsAutomations.error.generic', { error: code });
    }
  }, [t]);

  const items = useMemo(() => assembleAutomations({
    missions: data.missions,
    contextTrigger: data.contextTrigger,
    houseRules: data.houseRules,
    webhooks: data.webhooks,
    history: data.history
  }, now), [data.missions, data.contextTrigger, data.houseRules, data.webhooks, data.history, now]);

  const visible = filterAutomations(items, filter);
  const on = countOn(items);
  const counts = countByKind(items);
  const heldTotal = items.reduce((n, i) => n + i.held, 0);
  const firstHeld = items.find((i) => i.held > 0);

  // Bring a just-created (or just-revealed) row into view once it has rendered.
  useEffect(() => {
    const key = scrollTo.current;
    if (!key) return;
    const el = rowRefs.current.get(key);
    if (!el) return;
    scrollTo.current = null;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  const reveal = (key: string, kind: AutomationKind, focus: boolean) => {
    if (filter !== 'all' && filter !== kind) setFilter('all');
    setOpenKey(key);
    setFocusKey(focus ? key : null);
    scrollTo.current = key;
  };

  const create = async (kind: AutomationKind) => {
    setCreating(true);
    setScreenError(null);
    try {
      const stamp = Date.now();
      if (kind === 'schedule') {
        const m = newMission(
          { label: t('wsAutomations.new.scheduleName'), to: 'god', weekly: DEFAULT_WEEKLY },
          data.missions,
          stamp
        );
        const res = await data.saveMissions([...data.missions, m]);
        if (!res.ok) throw new Error(describeError(res.error));
        reveal(`schedule:${m.id}`, kind, true);
      } else if (kind === 'context') {
        const rule = newHouseRule(t('wsAutomations.new.ruleName'), stamp);
        const res = await data.saveRule(rule);
        if (!res.ok) throw new Error(describeError(res.error));
        reveal(`rule:${rule.id}`, kind, true);
      } else {
        // Same shape and the same DISABLED start as Settings → Connections:
        // the operator copies the address and the secret, then opts in.
        const secret = await generateWebhookSecret();
        const hook = { ...newWebhook(secret, data.webhooks.length), name: t('wsAutomations.new.webhookName') };
        const res = await data.saveWebhooks([...data.webhooks, hook]);
        if (!res.ok) throw new Error(describeError(res.error));
        reveal(`webhook:${hook.id}`, kind, true);
      }
    } catch (e) {
      setScreenError(t('wsAutomations.error.createFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setCreating(false);
    }
  };

  /** Deletes run here, not in the row: if one fails the row comes back, and
   *  the failure still needs somewhere to be said. */
  const remove = async (item: AutomationItem) => {
    setScreenError(null);
    if (openKey === item.key) setOpenKey(null);
    const ref = item.ref;
    const res = ref.type === 'mission' ? await data.deleteMission(ref.id)
      : ref.type === 'houseRule' ? await data.deleteRule(ref.id)
        : ref.type === 'webhook' ? await data.deleteWebhook(ref.id)
          : { ok: true as const };
    if (!res.ok) setScreenError(t('wsAutomations.error.deleteFailed', { name: item.name, error: describeError(res.error) }));
  };

  const setRef = (key: string) => (el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(key, el); else rowRefs.current.delete(key);
  };

  const renderRow = (item: AutomationItem) => {
    const common = {
      ref: setRef(item.key),
      data,
      open: openKey === item.key,
      onOpenChange: (open: boolean) => { setOpenKey(open ? item.key : null); if (!open) setFocusKey(null); },
      describeError
    };
    const ref = item.ref;
    switch (ref.type) {
      case 'mission': {
        const m = data.missions.find((x) => x.id === ref.id);
        return m ? <ScheduleRow key={item.key} {...common} mission={m} now={now} autoFocus={focusKey === item.key} onDelete={() => { void remove(item); }} /> : null;
      }
      case 'maintenance':
        return <MaintenanceRow key={item.key} {...common} which={ref.which} rule={data.contextTrigger[ref.which]} />;
      case 'houseRule': {
        const r = data.houseRules.find((x) => x.id === ref.id);
        return r ? <HouseRuleRow key={item.key} {...common} rule={r} autoFocus={focusKey === item.key} onDelete={() => { void remove(item); }} /> : null;
      }
      case 'webhook': {
        const w = data.webhooks.find((x) => x.id === ref.id);
        return w ? (
          <WebhookRow
            key={item.key}
            {...common}
            hook={w}
            status={data.status}
            now={now}
            autoFocus={focusKey === item.key}
            onDelete={() => { void remove(item); }}
          />
        ) : null;
      }
    }
  };

  return (
    <Screen
      header={(
        <ScreenHeader
          title={t('wsAutomations.title')}
          subtitle={t('wsAutomations.onCount', { n: on })}
          actions={<NewAutomationMenu onPick={(k) => { void create(k); }} busy={creating} />}
        />
      )}
    >
      <p className="cth-ws-automations-intro">{t('wsAutomations.intro')}</p>

      {heldTotal > 0 && firstHeld && (
        <div className="cth-ws-automations-banner" role="status">
          <span>{t('wsAutomations.heldBanner', { n: heldTotal })}</span>
          <Button size="sm" variant="secondary" onClick={() => reveal(firstHeld.key, firstHeld.kind, false)}>
            {t('wsAutomations.heldReview')}
          </Button>
        </div>
      )}

      {screenError && (
        <div className="cth-ws-automations-banner" data-tone="error" role="alert">
          <span>{screenError}</span>
          <Button size="sm" variant="ghost" onClick={() => setScreenError(null)}>{t('wsAutomations.dismiss')}</Button>
        </div>
      )}
      {data.loadError && (
        <p className="cth-ws-automations-callout" data-tone="warn" role="alert">
          {t('wsAutomations.error.loadFailed', { error: data.loadError })}
        </p>
      )}

      <div className="cth-ws-automations-toolbar">
        <SegmentedControl<AutomationFilter>
          size="sm"
          ariaLabel={t('wsAutomations.filter.label')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('wsAutomations.filter.all', { n: items.length }) },
            { value: 'schedule', label: t('wsAutomations.filter.schedule', { n: counts.schedule }) },
            { value: 'context', label: t('wsAutomations.filter.context', { n: counts.context }) },
            { value: 'webhook', label: t('wsAutomations.filter.webhook', { n: counts.webhook }) }
          ]}
        />
        {!data.ready && <Spinner label={t('wsAutomations.loading')} />}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          compact
          title={t(`wsAutomations.empty.${filter}.title`)}
          body={t(`wsAutomations.empty.${filter}.body`)}
          action={filter === 'all'
            ? <NewAutomationButtons onPick={(k) => { void create(k); }} busy={creating} />
            : <Button variant="secondary" disabled={creating} onClick={() => { void create(filter); }}>{t(`wsAutomations.new.${filter}Action`)}</Button>}
        />
      ) : (
        <div className="cth-ws-automations-list">
          {visible.map(renderRow)}
        </div>
      )}
    </Screen>
  );
}
