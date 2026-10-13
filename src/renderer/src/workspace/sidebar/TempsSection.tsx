/**
 * Temps — the one-job agents running right now (hired from Capabilities →
 * Temps, or by the orchestrator for a Slack thread; both are main's ephemeral
 * workers). Read-only here: each row opens Capabilities → Temps, where a temp
 * is hired, watched and stopped. Hidden when none is running, so a floor that
 * never uses them never sees an empty heading.
 */
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { useWorkspace } from '../store';
import { agentLiveLine, deriveAgentStatus, liveLineText } from '../agentStatus';
import { StatusDot } from '../ui';
import { useLiveWorkers } from './sidebarData';
import { compactNumber, shortDuration } from './format';

export function TempsSection() {
  const { t, i18n } = useTranslation();
  const { live } = useLiveWorkers();
  const agents = useStore((s) => s.agents);
  const route = useWorkspace((s) => s.route);
  const navigate = useWorkspace((s) => s.navigate);
  if (!live.length) return null;
  const onTemps = route.kind === 'capabilities' && route.tab === 'temps';
  const open = () => navigate({ kind: 'capabilities', tab: 'temps' });

  return (
    <section className="cth-ws-sidebar-section" aria-label={t('wsSidebar.temps.title')}>
      <div className="cth-ws-sidebar-section-head">
        <button
          type="button"
          className="cth-ws-sidebar-section-title"
          aria-current={onTemps ? 'page' : undefined}
          title={t('wsSidebar.temps.open')}
          onClick={open}
        >
          {t('wsSidebar.temps.title')}
          <span className="cth-ws-sidebar-section-count">· {t('wsSidebar.temps.running', { n: live.length })}</span>
        </button>
      </div>
      {live.map((w) => {
        const agent = agents.find((a) => a.id === w.workerId);
        const status = w.releasing
          ? 'idle'
          : agent ? deriveAgentStatus({ status: agent.status, action: agent.action, ptyId: agent.ptyId, archived: agent.archived }) : 'working';
        const line = w.releasing
          ? t('wsSidebar.temps.stopping')
          : agent ? liveLineText(t, agentLiveLine({ status: agent.status, action: agent.action, ptyId: agent.ptyId, archived: agent.archived })) : '';
        const age = shortDuration(w.ageMs, i18n.language);
        const tokens = compactNumber(w.tokensUsed, i18n.language);
        return (
          <div key={w.workerId} className="cth-ws-sidebar-agent">
            <button
              type="button"
              className="cth-ws-sidebar-agent-main"
              title={t('wsSidebar.temps.rowTip', { name: w.name, age, tokens })}
              onClick={open}
            >
              <span className="cth-ws-sidebar-agent-line">
                <StatusDot status={status} />
                <span className="cth-ws-sidebar-agent-name">{w.name}</span>
                <span className="cth-ws-sidebar-agent-spacer" />
                <span className="cth-ws-sidebar-temp-meta">{age} · {t('wsSidebar.temps.tokens', { tokens })}</span>
              </span>
              {line && <span className="cth-ws-sidebar-agent-live">{line}</span>}
            </button>
          </div>
        );
      })}
    </section>
  );
}
