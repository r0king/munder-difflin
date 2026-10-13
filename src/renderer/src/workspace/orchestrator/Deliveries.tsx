/**
 * "Deliveries paused" — the floor-wide hold on every agent's queue, as a
 * header switch and a banner. Both read the one state main keeps
 * (features/orchestrator.ts), so they agree with each other, with every
 * composer ("held") and with a reload.
 *
 * `DeliveriesPausedBanner` renders nothing while deliveries flow, so it can be
 * mounted anywhere a screen-wide notice belongs.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui';
import { setDeliveriesPaused, useOrchestratorState } from './useOrchestratorState';
import { formatTime, formatUsd } from './format';
import './orchestrator.css';

function useToggle(): { busy: boolean; failed: boolean; set: (paused: boolean) => void } {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const set = (paused: boolean) => {
    setBusy(true);
    setFailed(false);
    setDeliveriesPaused(paused)
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };
  return { busy, failed, set };
}

/** The header switch: "Pause deliveries" / "Resume deliveries". */
export function DeliveriesToggle() {
  const { t } = useTranslation();
  const { state } = useOrchestratorState();
  const { busy, failed, set } = useToggle();
  const paused = !!state?.delivery.paused;
  return (
    <Button
      variant={paused ? 'primary' : 'secondary'}
      size="sm"
      disabled={!state || busy}
      onClick={() => set(!paused)}
      title={failed ? t('wsOrchestrator.deliveries.failed') : paused ? t('wsOrchestrator.deliveries.resumeTip') : t('wsOrchestrator.deliveries.pauseTip')}
      icon={<span className="cth-ws-orch-pausemark" aria-hidden="true" />}
    >
      {paused ? t('wsOrchestrator.deliveries.resume') : t('wsOrchestrator.deliveries.pause')}
    </Button>
  );
}

/** The banner while the hold is on. `onRaiseCap` adds a shortcut to the cap
 *  when the budget is what tripped it. */
export function DeliveriesPausedBanner({ onRaiseCap }: { onRaiseCap?: () => void }) {
  const { t, i18n } = useTranslation();
  const { state } = useOrchestratorState();
  const { busy, failed, set } = useToggle();
  if (!state?.delivery.paused) return null;
  const byBudget = state.delivery.reason === 'budget';
  const since = state.delivery.since ? formatTime(state.delivery.since, i18n.language) : null;
  return (
    <div className={`cth-ws-orch-banner${byBudget ? ' cth-ws-orch-banner--budget' : ''}`} role="status" aria-live="polite">
      <span className="cth-ws-orch-pausemark" aria-hidden="true" />
      <div className="cth-ws-orch-banner-text">
        <span className="cth-ws-orch-banner-title">
          {byBudget ? t('wsOrchestrator.deliveries.bannerBudgetTitle') : t('wsOrchestrator.deliveries.bannerTitle')}
        </span>
        <span>
          {byBudget
            ? t('wsOrchestrator.deliveries.bannerBudgetBody', {
              spend: formatUsd(state.budget.spendTodayUsd),
              cap: formatUsd(state.budget.lastTrip?.capUsd ?? state.budget.dailyCapUsd ?? 0)
            })
            : t('wsOrchestrator.deliveries.bannerBody')}
          {since ? ` ${t('wsOrchestrator.deliveries.since', { time: since })}` : ''}
        </span>
        {failed && <span className="cth-ws-orch-error">{t('wsOrchestrator.deliveries.failed')}</span>}
      </div>
      <div className="cth-ws-orch-banner-actions">
        {byBudget && onRaiseCap && (
          <Button size="sm" variant="secondary" onClick={onRaiseCap}>{t('wsOrchestrator.deliveries.changeCap')}</Button>
        )}
        <Button size="sm" variant="primary" disabled={busy} onClick={() => set(false)}>
          {t('wsOrchestrator.deliveries.resume')}
        </Button>
      </div>
    </div>
  );
}
