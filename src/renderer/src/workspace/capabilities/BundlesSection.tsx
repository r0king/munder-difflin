/**
 * Role bundles: a job description in one click. Each card says what the job
 * needs; "Grant to <agent>" first shows exactly what would change (already has /
 * will add / needs a key / does not exist here), and only the confirm writes —
 * one atomic write of that agent's grant record in main, plus the role on the
 * hive registry (the same hivePatchAgentRole the role editor uses).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Chip, Section, Spinner } from '../ui';
import { useStore } from '@/store/store';
import { mcpCatalogEntry } from '@shared/mcpCatalog';
import { INTEGRATION_TEMPLATES } from '@shared/integrations';
import { FEATURED_BUNDLE_IDS, ROLE_BUNDLES } from '@shared/workspace/capabilitiesBundles';
import type { BundleDiff, DiffRow, RoleBundle } from '@shared/workspace/capabilities';
import type { CapabilitiesState } from '@shared/workspace/capabilitiesIpc';
import type { IntegrationRecordView } from '../../../../preload';
import { AgentSelect, RestartToApply } from './parts';
import type { FloorAgent } from './useCapabilities';

const DIFF_MARK: Record<DiffRow['state'], string> = { has: '✓', add: '+', addNeeds: '+', missing: '–' };

function rowLabel(row: DiffRow, connections: IntegrationRecordView[] | null): string {
  if (row.kind === 'mcp') return mcpCatalogEntry(row.id)?.label ?? row.id;
  if (row.kind === 'connection') {
    return connections?.find((c) => c.id === row.id)?.label
      ?? INTEGRATION_TEMPLATES.find((tp) => tp.idSuggestion === row.ref)?.label
      ?? row.ref;
  }
  return row.ref;
}

function BundleCard({ bundle, target, onGrant, busy }: {
  bundle: RoleBundle;
  target: FloorAgent | undefined;
  onGrant: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Card padding="md">
      <div className="cth-ws-capabilities-bundle">
        <h3 className="cth-ws-capabilities-bundle-name">{t(`wsCapabilities.bundles.${bundle.id}.name`)}</h3>
        <p className="cth-ws-capabilities-bundle-summary">{t(`wsCapabilities.bundles.${bundle.id}.summary`)}</p>
        <div className="cth-ws-capabilities-bundle-meta">
          <Chip>{t('wsCapabilities.bundles.counts.skills', { count: bundle.skills.length })}</Chip>
          <Chip>{t('wsCapabilities.bundles.counts.mcp', { count: bundle.mcp.length })}</Chip>
          {bundle.connections.length > 0 && <Chip>{t('wsCapabilities.bundles.counts.connections', { count: bundle.connections.length })}</Chip>}
          {bundle.gaps.length > 0 && <Chip tone="warn" title={bundle.gaps.map((g) => t(`wsCapabilities.gaps.${g}`)).join('\n')}>{t('wsCapabilities.bundles.hasGaps')}</Chip>}
        </div>
        <div className="cth-ws-capabilities-bundle-foot">
          <Button size="sm" variant="secondary" disabled={!target || busy} onClick={onGrant}>
            {target ? t('wsCapabilities.bundles.grantTo', { name: target.name }) : t('wsCapabilities.bundles.pickAgent')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ReviewPanel({ bundle, target, diff, connections, applying, onConfirm, onCancel }: {
  bundle: RoleBundle;
  target: FloorAgent;
  diff: BundleDiff;
  connections: IntegrationRecordView[] | null;
  applying: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const groups: Array<{ kind: DiffRow['kind']; title: string }> = [
    { kind: 'skill', title: t('wsCapabilities.kinds.skills') },
    { kind: 'mcp', title: t('wsCapabilities.kinds.mcp') },
    { kind: 'connection', title: t('wsCapabilities.kinds.connections') }
  ];
  const adds = diff.add.skills.length + diff.add.mcp.length + diff.add.connections.length + diff.installs.length;
  return (
    <Card padding="md" className="cth-ws-capabilities-review">
      <div className="cth-ws-capabilities-review-head">
        <h2 className="cth-ws-capabilities-review-title">
          {t('wsCapabilities.review.title', { bundle: t(`wsCapabilities.bundles.${bundle.id}.name`), name: target.name })}
        </h2>
        <span className="cth-ws-muted">
          {target.isGod ? t('wsCapabilities.review.keepsOrchestratorRole') : t('wsCapabilities.review.role', { role: diff.role })}
        </span>
      </div>
      <div className="cth-ws-capabilities-review-groups">
        {groups.map((g) => {
          const rows = diff.rows.filter((r) => r.kind === g.kind);
          return (
            <div key={g.kind} className="cth-ws-capabilities-review-group">
              <h3>{g.title}</h3>
              {rows.length === 0 && <div className="cth-ws-muted">{t('wsCapabilities.review.nothing')}</div>}
              {rows.map((r) => (
                <div key={`${r.kind}:${r.ref}`} className="cth-ws-capabilities-diff" data-state={r.state}>
                  <span className="cth-ws-capabilities-diff-mark" aria-hidden="true">{DIFF_MARK[r.state]}</span>
                  <span className="cth-ws-capabilities-diff-text">
                    <span>{rowLabel(r, connections)}</span>
                    <span className="cth-ws-capabilities-diff-note">
                      {t(`wsCapabilities.diff.state.${r.state}`)}
                      {r.note ? ` · ${t(`wsCapabilities.diff.note.${r.note}`)}` : ''}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {diff.gaps.length > 0 && (
        <div>
          <div className="cth-ws-muted" style={{ marginBottom: 'var(--cth-space-1)' }}>{t('wsCapabilities.review.gapsTitle')}</div>
          <ul className="cth-ws-capabilities-gaps">
            {diff.gaps.map((g) => <li key={g}>{t(`wsCapabilities.gaps.${g}`)}</li>)}
          </ul>
        </div>
      )}
      <div className="cth-ws-muted">{target.live ? t('wsCapabilities.review.restartNote') : t('wsCapabilities.review.nextStartNote')}</div>
      <div className="cth-ws-capabilities-actions">
        <Button variant="primary" disabled={applying || diff.noop} onClick={onConfirm}>
          {diff.noop ? t('wsCapabilities.review.alreadySet') : t('wsCapabilities.review.confirm', { count: adds, name: target.name })}
        </Button>
        <Button variant="ghost" onClick={onCancel}>{t('wsCapabilities.common.cancel')}</Button>
        {applying && <Spinner label={t('wsCapabilities.review.applying')} />}
      </div>
    </Card>
  );
}

export function BundlesSection({ agents, state, connections, target, onTarget, request }: {
  agents: FloorAgent[];
  state: CapabilitiesState | null;
  connections: IntegrationRecordView[] | null;
  target: string;
  onTarget: (id: string) => void;
  /** Open a bundle's review from elsewhere (an agent's panel on Who has what). */
  request?: { bundleId: string; seq: number } | null;
}) {
  const { t } = useTranslation();
  const updateAgent = useStore((s) => s.updateAgent);
  const [showAll, setShowAll] = useState(false);
  const [review, setReview] = useState<{ bundleId: string; diff: BundleDiff | null; error?: string } | null>(null);
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState<{ bundleId: string; agentId: string; roleError?: boolean } | null>(null);
  const targetAgent = agents.find((a) => a.id === target);

  const featured = ROLE_BUNDLES.filter((b) => FEATURED_BUNDLE_IDS.includes(b.id));
  const rest = ROLE_BUNDLES.filter((b) => !FEATURED_BUNDLE_IDS.includes(b.id));
  const shown = showAll ? ROLE_BUNDLES : featured;
  const restNames = useMemo(() => rest.map((b) => t(`wsCapabilities.bundles.${b.id}.name`)).join(t('wsCapabilities.common.listSep')), [rest, t]);

  const open = async (bundleId: string) => {
    if (!targetAgent) return;
    setDone(null);
    setReview({ bundleId, diff: null });
    try {
      const res = await window.cth.features.capabilities.previewBundle(targetAgent.id, bundleId);
      setReview(res.ok ? { bundleId, diff: res.diff } : { bundleId, diff: null, error: res.error });
    } catch (e) {
      setReview({ bundleId, diff: null, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const confirm = async () => {
    if (!review?.diff || !targetAgent) return;
    setApplying(true);
    try {
      const res = await window.cth.features.capabilities.applyBundle(targetAgent.id, review.bundleId);
      if (!res.ok) { setReview({ ...review, error: res.error }); return; }
      // The job string: the registry (what the hive and the agent read) and the
      // card. The orchestrator keeps his own role.
      let roleError = false;
      if (!targetAgent.isGod) {
        const r = await window.cth.hivePatchAgentRole(targetAgent.id, res.diff.role).catch(() => ({ ok: false }));
        roleError = !r.ok;
        updateAgent(targetAgent.id, { description: res.diff.role });
      }
      setDone({ bundleId: review.bundleId, agentId: targetAgent.id, roleError });
      setReview(null);
    } catch (e) {
      setReview({ ...review, error: e instanceof Error ? e.message : String(e) });
    } finally { setApplying(false); }
  };

  // A review asked for from another tab, once the target agent is in place.
  const handled = useRef(0);
  useEffect(() => {
    if (!request || request.seq === handled.current || !targetAgent) return;
    handled.current = request.seq;
    void open(request.bundleId);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `open` reads the current target; the request seq is the trigger
  }, [request?.seq, targetAgent?.id]);

  const reviewBundle = review ? ROLE_BUNDLES.find((b) => b.id === review.bundleId) : undefined;
  const doneAgent = done ? agents.find((a) => a.id === done.agentId) : undefined;

  return (
    <Section
      title={t('wsCapabilities.bundles.title')}
      count={ROLE_BUNDLES.length}
      actions={(
        <span className="cth-ws-capabilities-actions">
          <span className="cth-ws-capabilities-toolbar-label">{t('wsCapabilities.bundles.grantToLabel')}</span>
          <AgentSelect agents={agents} value={target} onChange={(id) => { onTarget(id); setReview(null); setDone(null); }} ariaLabel={t('wsCapabilities.bundles.grantToLabel')} />
        </span>
      )}
    >
      <p className="cth-ws-capabilities-intro">{t('wsCapabilities.bundles.intro')}</p>
      {!state?.hive && state && <div className="cth-ws-capabilities-banner" data-tone="warn"><span>{t('wsCapabilities.common.noHive')}</span></div>}
      {done && doneAgent && (
        <div className="cth-ws-capabilities-banner" data-tone="ok" role="status">
          <span>
            {t('wsCapabilities.review.granted', { bundle: t(`wsCapabilities.bundles.${done.bundleId}.name`), name: doneAgent.name })}
            {' '}{doneAgent.live ? t('wsCapabilities.review.restartNote') : t('wsCapabilities.review.nextStartNote')}
            {done.roleError ? ` ${t('wsCapabilities.review.roleFailed')}` : ''}
          </span>
          <RestartToApply agent={doneAgent} />
        </div>
      )}
      {review && reviewBundle && targetAgent && (
        review.diff
          ? <ReviewPanel
              bundle={reviewBundle}
              target={targetAgent}
              diff={review.diff}
              connections={connections}
              applying={applying}
              onConfirm={() => { void confirm(); }}
              onCancel={() => setReview(null)}
            />
          : (
            <div className="cth-ws-capabilities-banner" data-tone={review.error ? 'error' : undefined}>
              {review.error ? <span>{t('wsCapabilities.review.failed', { error: review.error })}</span> : <><Spinner /><span>{t('wsCapabilities.review.loading')}</span></>}
              {review.error && <Button size="sm" variant="ghost" onClick={() => setReview(null)}>{t('wsCapabilities.common.dismiss')}</Button>}
            </div>
          )
      )}
      <div className="cth-ws-capabilities-grid">
        {shown.map((b) => (
          <BundleCard key={b.id} bundle={b} target={targetAgent} busy={applying || (!!review && !review.diff && !review.error)} onGrant={() => { void open(b.id); }} />
        ))}
      </div>
      <div className="cth-ws-capabilities-more">
        <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
          {showAll ? t('wsCapabilities.bundles.showFewer') : t('wsCapabilities.bundles.andMore', { count: rest.length })}
        </Button>
        {!showAll && <span>{restNames}</span>}
      </div>
    </Section>
  );
}
