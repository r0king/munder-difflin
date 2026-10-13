/**
 * The four figures at the top of the orchestrator's screen: spend today
 * against the daily cap, the breaker, the tasks in progress and the questions
 * waiting on the human. Each is a button that opens where it is dealt with.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import type { HarnessConfig } from '@/store/config';
import { useHiveTasks, useOpenQuestions } from '../useHiveTasks';
import { useWorkspace } from '../store';
import { useOrchestratorState } from './useOrchestratorState';
import { floorBreaker, useBreakerLevels } from './useBreakerLevels';
import { formatUsd } from './format';
import type { OrchTab } from './tabs';

export function StatStrip({ config, onOpenTab }: { config: HarnessConfig; onOpenTab: (tab: OrchTab) => void }) {
  const { t } = useTranslation();
  const navigate = useWorkspace((s) => s.navigate);
  const { state } = useOrchestratorState();
  const { tasks, loaded: tasksLoaded } = useHiveTasks();
  const questions = useOpenQuestions();
  const levels = useBreakerLevels();
  const agents = useStore((s) => s.agents);

  // The breaker never evaluates god (index.ts runBreakerBeat), and only live
  // terminals are evaluated at all — the same set here.
  const liveIds = useMemo(() => agents.filter((a) => !a.isGod && !a.isAssistant && a.ptyId).map((a) => a.id), [agents]);
  const breaker = floorBreaker(config.circuitBreaker?.enabled !== false, levels, liveIds);
  const doing = tasks.filter((x) => x.status === 'doing').length;

  const b = state?.budget;
  const level = b?.level ?? 'none';
  const pct = b && b.dailyCapUsd ? Math.min(100, Math.round(b.fraction * 100)) : 0;

  return (
    <div className="cth-ws-orch-strip" role="group" aria-label={t('wsOrchestrator.strip.aria')}>
      <button
        type="button"
        className={`cth-ws-orch-tile${level === 'over' ? ' cth-ws-orch-tile--danger' : level === 'near' ? ' cth-ws-orch-tile--warn' : ''}`}
        onClick={() => onOpenTab('budget')}
        title={t('wsOrchestrator.strip.spendTip')}
      >
        <span className="cth-ws-orch-tile-label">{t('wsOrchestrator.strip.spendToday')}</span>
        <span className="cth-ws-orch-tile-value">
          {!b ? '…' : b.noHive ? '—' : !b.ready ? '…' : formatUsd(b.spendTodayUsd)}
          <span className="cth-ws-orch-tile-sub">
            {b?.dailyCapUsd ? t('wsOrchestrator.strip.ofCap', { cap: formatUsd(b.dailyCapUsd) }) : t('wsOrchestrator.strip.noCap')}
          </span>
        </span>
        {b?.dailyCapUsd ? (
          <div className="cth-ws-orch-meter" aria-hidden="true">
            <div className={`cth-ws-orch-meter-fill cth-ws-orch-meter-fill--${level}`} style={{ width: `${pct}%` }} />
          </div>
        ) : null}
      </button>

      <button
        type="button"
        className={`cth-ws-orch-tile${breaker.state === 'tripped' ? ' cth-ws-orch-tile--danger' : ''}`}
        onClick={() => onOpenTab('budget')}
        title={t('wsOrchestrator.strip.breakerTip')}
      >
        <span className="cth-ws-orch-tile-label">{t('wsOrchestrator.strip.breaker')}</span>
        <span className="cth-ws-orch-tile-value">
          {t(`wsOrchestrator.breaker.${breaker.state}`)}
          {breaker.state === 'tripped' && (
            <span className="cth-ws-orch-tile-sub">
              {t('wsOrchestrator.strip.trippedCount', { n: breaker.tripped.length })}
            </span>
          )}
        </span>
      </button>

      <button
        type="button"
        className="cth-ws-orch-tile"
        onClick={() => onOpenTab('board')}
        title={t('wsOrchestrator.strip.tasksTip')}
      >
        <span className="cth-ws-orch-tile-label">{t('wsOrchestrator.strip.tasks')}</span>
        <span className="cth-ws-orch-tile-value">
          {tasksLoaded ? doing : '…'}
          <span className="cth-ws-orch-tile-sub">{t('wsOrchestrator.strip.doing')}</span>
        </span>
      </button>

      <button
        type="button"
        className={`cth-ws-orch-tile${questions.length > 0 ? ' cth-ws-orch-tile--warn' : ''}`}
        onClick={() => navigate({ kind: 'inbox', section: 'askme' })}
        title={t('wsOrchestrator.strip.waitingTip')}
      >
        <span className="cth-ws-orch-tile-label">{t('wsOrchestrator.strip.waiting')}</span>
        <span className="cth-ws-orch-tile-value">
          {tasksLoaded ? questions.length : '…'}
          <span className="cth-ws-orch-tile-sub">{t('wsOrchestrator.strip.toAnswer')}</span>
        </span>
      </button>
    </div>
  );
}
