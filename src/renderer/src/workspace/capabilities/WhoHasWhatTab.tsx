/**
 * Who has what: one row per agent, one column per skill, MCP server and
 * connection that anyone on the floor has. A mark says how (every agent, granted
 * to this one, waiting for a restart, needs a key, not in place, not read by
 * this engine). Clicking an empty or granted cell grants or revokes it for that
 * agent — one write — and the agent's panel on the side holds the rest: its
 * role, what it was granted, and Restart & Continue when it runs on an older
 * setup than its grant.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Chip, EmptyState, IconButton, Spinner, WsIcon } from '../ui';
import type { HarnessConfig } from '@/store/config';
import { mcpCatalogEntry } from '@shared/mcpCatalog';
import { buildWhoHasWhat, type CapabilityKind, type CellState, type WhoColumn } from '@shared/workspace/capabilities';
import { ROLE_BUNDLES } from '@shared/workspace/capabilitiesBundles';
import type { CapabilitiesState } from '@shared/workspace/capabilitiesIpc';
import type { IntegrationRecordView } from '../../../../preload';
import { Mark, RestartToApply, engineLabel } from './parts';
import type { FloorAgent } from './useCapabilities';

const LEGEND: CellState[] = ['granted', 'everyone', 'pending', 'needsKey', 'missing', 'unsupported', 'none'];
const KINDS: CapabilityKind[] = ['skill', 'mcp', 'connection'];

/** Cells a click can change: a grant can be added or taken away there. */
function clickable(state: CellState): boolean {
  return state === 'none' || state === 'granted' || state === 'pending' || state === 'needsKey' || state === 'missing';
}

function AgentPanel({ agent, state, columns, cells, pending, onClose, onBundle }: {
  agent: FloorAgent;
  state: CapabilitiesState;
  columns: WhoColumn[];
  cells: Record<string, CellState>;
  pending: boolean;
  onClose: () => void;
  onBundle: (bundleId: string) => void;
}) {
  const { t } = useTranslation();
  const grant = state.grants[agent.id];
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const granted = columns.filter((c) => cells[c.key] === 'granted' || cells[c.key] === 'pending' || cells[c.key] === 'needsKey' || cells[c.key] === 'missing');
  const pendingRestart = pending;

  const clear = async () => {
    if (!confirmClear) { setConfirmClear(true); return; }
    setClearing(true);
    try { await window.cth.features.capabilities.clearGrants(agent.id); } finally { setClearing(false); setConfirmClear(false); }
  };

  return (
    <Card padding="md" className="cth-ws-capabilities-panel">
      <div className="cth-ws-capabilities-panel-body">
        <div className="cth-ws-capabilities-panel-head">
          <h2 className="cth-ws-capabilities-panel-title">{agent.name}</h2>
          <IconButton size="sm" label={t('wsCapabilities.common.close')} onClick={onClose}><WsIcon name="close" /></IconButton>
        </div>
        <div className="cth-ws-capabilities-chips">
          <Chip>{engineLabel(agent.provider)}</Chip>
          {agent.agent.description && <Chip tone="info">{agent.agent.description}</Chip>}
          {grant?.bundle && <Chip tone="accent">{t(`wsCapabilities.bundles.${grant.bundle}.name`)}</Chip>}
          {!agent.live && <Chip>{t('wsCapabilities.who.notRunning')}</Chip>}
        </div>
        {agent.provider !== 'claude' && <div className="cth-ws-muted">{t('wsCapabilities.who.engineNote', { engine: engineLabel(agent.provider) })}</div>}
        {pendingRestart && (
          <div className="cth-ws-capabilities-banner" data-tone="warn">
            <span>{t('wsCapabilities.who.pendingRestart')}</span>
            <RestartToApply agent={agent} />
          </div>
        )}
        {KINDS.map((kind) => {
          const mine = granted.filter((c) => c.kind === kind);
          return (
            <div key={kind}>
              <h3>{t(`wsCapabilities.kinds.${kind === 'skill' ? 'skills' : kind === 'mcp' ? 'mcp' : 'connections'}`)}</h3>
              {mine.length === 0
                ? <div className="cth-ws-muted">{t('wsCapabilities.who.noneGranted')}</div>
                : (
                  <div className="cth-ws-capabilities-chips">
                    {mine.map((c) => (
                      <Chip
                        key={c.key}
                        tone={cells[c.key] === 'granted' ? 'ok' : cells[c.key] === 'pending' ? 'info' : 'warn'}
                        title={t(`wsCapabilities.who.state.${cells[c.key]}`)}
                        onClick={() => { void window.cth.features.capabilities.setGrant({ agentId: agent.id, kind: c.kind, id: c.id, on: false }); }}
                      >
                        {c.label} ×
                      </Chip>
                    ))}
                  </div>
                )}
            </div>
          );
        })}
        <div>
          <h3>{t('wsCapabilities.who.giveBundle')}</h3>
          <select
            className="cth-ws-capabilities-select"
            value=""
            aria-label={t('wsCapabilities.who.giveBundle')}
            onChange={(e) => { if (e.target.value) onBundle(e.target.value); }}
          >
            <option value="">{t('wsCapabilities.who.pickBundle')}</option>
            {ROLE_BUNDLES.map((b) => <option key={b.id} value={b.id}>{t(`wsCapabilities.bundles.${b.id}.name`)}</option>)}
          </select>
        </div>
        {grant && (
          <div className="cth-ws-capabilities-actions">
            <Button size="sm" variant={confirmClear ? 'danger' : 'ghost'} disabled={clearing} onClick={() => { void clear(); }}>
              {confirmClear ? t('wsCapabilities.who.confirmClear') : t('wsCapabilities.who.clear')}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

export function WhoHasWhatTab({ agents, state, records, config, onBundle }: {
  agents: FloorAgent[];
  state: CapabilitiesState | null;
  records: IntegrationRecordView[] | null;
  config: HarnessConfig;
  /** Open the bundle review for an agent (Marketplace). */
  onBundle: (agentId: string, bundleId: string) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');

  const matrix = useMemo(() => state ? buildWhoHasWhat({
    agents,
    grants: state.grants,
    machineSkills: state.machineSkills,
    agentSkills: state.agentSkills,
    mcpDefaults: config.mcpDefaults,
    mcpKeys: state.mcpKeys,
    connections: (records ?? []).map((r) => ({ id: r.id, label: r.label, enabled: r.enabled, hasSecret: r.hasSecret, authType: r.authType })),
    appliedAt: state.appliedAt
  }) : null, [agents, state, records, config.mcpDefaults]);

  if (!state || !matrix) return <EmptyState compact title={t('wsCapabilities.common.loading')} icon={<Spinner />} />;
  if (agents.length === 0) return <EmptyState title={t('wsCapabilities.who.emptyTitle')} body={t('wsCapabilities.who.emptyBody')} />;

  const toggle = async (agentId: string, col: WhoColumn, cell: CellState) => {
    setError('');
    const on = cell === 'none';
    const res = await window.cth.features.capabilities.setGrant({ agentId, kind: col.kind, id: col.id, on });
    if (!res.ok) setError(res.error === 'noHive' ? t('wsCapabilities.common.noHive') : t('wsCapabilities.who.grantFailed', { error: res.error }));
  };

  const groups = KINDS.map((kind) => ({ kind, cols: matrix.columns.filter((c) => c.kind === kind) })).filter((g) => g.cols.length > 0);
  const selectedRow = matrix.rows.find((r) => r.agent.id === selected);
  const colTitle = (c: WhoColumn) => c.kind === 'mcp' ? (mcpCatalogEntry(c.id)?.description ?? c.label) : c.id;

  return (
    <>
      <p className="cth-ws-capabilities-intro">{t('wsCapabilities.who.intro')}</p>
      {error && <div className="cth-ws-capabilities-banner" data-tone="error"><span>{error}</span></div>}
      <div className="cth-ws-capabilities-split">
        <div className="cth-ws-capabilities-matrixwrap">
          {matrix.columns.length === 0 ? (
            <EmptyState compact title={t('wsCapabilities.who.noColumns')} />
          ) : (
            <table className="cth-ws-capabilities-matrix">
              <thead>
                <tr>
                  <th className="cth-ws-capabilities-agentcell cth-ws-capabilities-group" rowSpan={2}>{t('wsCapabilities.who.agent')}</th>
                  {groups.map((g) => (
                    <th key={g.kind} className="cth-ws-capabilities-group" colSpan={g.cols.length}>
                      {t(`wsCapabilities.kinds.${g.kind === 'skill' ? 'skills' : g.kind === 'mcp' ? 'mcp' : 'connections'}`)}
                    </th>
                  ))}
                </tr>
                <tr>
                  {groups.flatMap((g) => g.cols).map((c) => (
                    <th key={c.key} className="cth-ws-capabilities-colhead" title={colTitle(c)} scope="col"><span>{c.label}</span></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.rows.map((row) => (
                  <tr key={row.agent.id}>
                    <th className="cth-ws-capabilities-agentcell" scope="row">
                      <button
                        type="button"
                        className="cth-ws-capabilities-agentbtn"
                        aria-pressed={selected === row.agent.id}
                        onClick={() => setSelected(selected === row.agent.id ? null : row.agent.id)}
                      >
                        <span className="cth-ws-capabilities-agentname">
                          {row.agent.isGod ? t('wsCapabilities.common.orchestratorName', { name: row.agent.name }) : row.agent.name}
                        </span>
                        {row.pendingRestart && <Mark state="pending" />}
                        <span className="cth-ws-capabilities-agentsub">{row.count}</span>
                      </button>
                    </th>
                    {groups.flatMap((g) => g.cols).map((c) => {
                      const cell = row.cells[c.key];
                      const label = t('wsCapabilities.who.cellLabel', {
                        name: row.agent.name, item: c.label, state: t(`wsCapabilities.who.state.${cell}`)
                      });
                      return (
                        <td key={c.key}>
                          {clickable(cell) ? (
                            <button
                              type="button"
                              className="cth-ws-capabilities-cell"
                              title={`${label} — ${cell === 'none' ? t('wsCapabilities.who.clickGrant') : t('wsCapabilities.who.clickRevoke')}`}
                              aria-label={label}
                              onClick={() => { void toggle(row.agent.id, c, cell); }}
                            >
                              <Mark state={cell} />
                            </button>
                          ) : (
                            <span className="cth-ws-capabilities-cell" title={label} aria-label={label} role="img"><Mark state={cell} /></span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {selectedRow && (
          <AgentPanel
            agent={agents.find((a) => a.id === selectedRow.agent.id) ?? (selectedRow.agent as FloorAgent)}
            state={state}
            columns={matrix.columns}
            cells={selectedRow.cells}
            pending={selectedRow.pendingRestart}
            onClose={() => setSelected(null)}
            onBundle={(bundleId) => onBundle(selectedRow.agent.id, bundleId)}
          />
        )}
      </div>
      <div className="cth-ws-capabilities-legend" aria-label={t('wsCapabilities.who.legend')}>
        {LEGEND.map((s) => <span key={s}><Mark state={s} />{t(`wsCapabilities.who.state.${s}`)}</span>)}
      </div>
    </>
  );
}
