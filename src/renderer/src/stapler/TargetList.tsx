/**
 * The To menu: "Everything it catches goes to your orchestrator, or to the
 * agent you pick." The orchestrator first, then agents grouped by project
 * (the same grouping as the Workspace sidebar), a filter once the list is
 * long. Used by the puck (feature roster) and the meetings library (the main
 * window's roster) alike, so it only takes plain RosterEntry rows.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RosterEntry } from '@shared/features/roster';
import { sameTarget, type StaplerTarget } from '@shared/features/stapler';
import { SearchInput, StatusDot } from '@/workspace/ui';
import { StaplerIcon } from './icons';

const FILTER_FROM = 8;

export function TargetList({ roster, value, onPick, autoFocus }: {
  roster: readonly RosterEntry[];
  value: StaplerTarget;
  onPick: (target: StaplerTarget) => void;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const god = roster.find((a) => a.isGod);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const agents = roster.filter((a) => !a.isGod && (!q || a.name.toLowerCase().includes(q) || (a.project ?? '').toLowerCase().includes(q)));
    const byProject = new Map<string, RosterEntry[]>();
    for (const a of agents) {
      const key = a.project ?? '';
      byProject.set(key, [...(byProject.get(key) ?? []), a]);
    }
    return [...byProject.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  }, [roster, query]);
  const orchestrator: StaplerTarget = { kind: 'orchestrator' };
  const showGod = !query.trim() || (god?.name ?? t('stapler.to.orchestrator')).toLowerCase().includes(query.trim().toLowerCase());

  return (
    <div className="cth-stapler-targets" role="listbox" aria-label={t('stapler.to.title')}>
      {roster.length > FILTER_FROM && (
        <div style={{ padding: 'var(--cth-space-2) var(--cth-space-3)' }}>
          <SearchInput value={query} onChange={setQuery} placeholder={t('stapler.to.filter')} autoFocus={autoFocus} />
        </div>
      )}
      {showGod && (
        <button
          type="button"
          role="option"
          aria-selected={sameTarget(value, orchestrator)}
          className="cth-ws-navrow"
          aria-current={sameTarget(value, orchestrator) ? 'page' : undefined}
          onClick={() => onPick(orchestrator)}
        >
          {god ? <StatusDot status={god.status} /> : <StaplerIcon name="to" />}
          <span className="cth-ws-navrow-label">
            {god?.name ?? t('stapler.to.orchestrator')}
          </span>
          <span className="cth-ws-navrow-meta">{t('stapler.to.orchestratorRole')}</span>
          {sameTarget(value, orchestrator) && <span className="cth-stapler-target-check"><StaplerIcon name="check" /></span>}
        </button>
      )}
      {groups.map(([project, agents]) => (
        <div key={project || '-'} role="group" aria-label={project || t('stapler.to.noProject')}>
          <div className="cth-stapler-group">{project || t('stapler.to.noProject')}</div>
          {agents.map((a) => {
            const target: StaplerTarget = { kind: 'agent', agentId: a.id };
            const selected = sameTarget(value, target);
            return (
              <button
                key={a.id}
                type="button"
                role="option"
                aria-selected={selected}
                className="cth-ws-navrow"
                aria-current={selected ? 'page' : undefined}
                onClick={() => onPick(target)}
              >
                <StatusDot status={a.status} />
                <span className="cth-ws-navrow-label">{a.name}</span>
                {a.model && <span className="cth-ws-navrow-meta">{a.model}</span>}
                {selected && <span className="cth-stapler-target-check"><StaplerIcon name="check" /></span>}
              </button>
            );
          })}
        </div>
      ))}
      {roster.filter((a) => !a.isGod).length === 0 && (
        <p className="cth-stapler-help" style={{ padding: 'var(--cth-space-2) var(--cth-space-3)' }}>
          {roster.length === 0 ? t('stapler.to.noRoster') : t('stapler.to.onlyOrchestrator')}
        </p>
      )}
    </div>
  );
}
