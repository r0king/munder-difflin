/**
 * Installed: everything an agent here can already reach — skills (built in,
 * machine-wide, per project, given to one agent), the MCP servers (on for every
 * Claude Code agent, or granted to some) and the registered connections.
 *
 * Keys stay sealed: a server's or connection's key shows only as saved / not
 * saved. Replace sends a new one one way (the encrypted secret store); nothing
 * on this screen can read one back.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Chip, EmptyState, Section, Spinner, Toggle } from '../ui';
import type { HarnessConfig } from '@/store/config';
import { MCP_CATALOG, type McpTier } from '@shared/mcpCatalog';
import { authTypeNeedsSecret } from '@shared/integrations';
import type { CapabilitiesState } from '@shared/workspace/capabilitiesIpc';
import type { IntegrationRecordView, LocalSkill } from '../../../../preload';
import { KeyField, engineLabel } from './parts';
import type { FloorAgent } from './useCapabilities';

const TIER_ORDER: McpTier[] = ['safe-readonly', 'write', 'secret'];
const TIER_KEY: Record<McpTier, string> = { 'safe-readonly': 'safe', write: 'write', secret: 'secret' };

function grantedNames(agents: FloorAgent[], state: CapabilitiesState | null, pick: (g: NonNullable<CapabilitiesState['grants'][string]>) => string[], id: string): string[] {
  if (!state) return [];
  return agents.filter((a) => pick(state.grants[a.id] ?? { skills: [], mcp: [], connections: [], updatedAt: 0 }).includes(id)).map((a) => a.name);
}

function SkillsBlock({ agents, state, local, reloadLocal }: {
  agents: FloorAgent[];
  state: CapabilitiesState | null;
  local: LocalSkill[] | null;
  reloadLocal: () => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<Record<string, string>>({});

  const byScope = (scope: LocalSkill['scope'], claudeOnly = true) =>
    (local ?? []).filter((s) => s.scope === scope && (!claudeOnly || s.provider === 'claude'));
  const plugins = (local ?? []).filter((s) => s.provider !== 'claude');
  const builtin = byScope('bundled');
  const machine = byScope('user');
  const project = byScope('project');

  const uninstall = async (s: LocalSkill) => {
    if (confirming !== s.path) { setConfirming(s.path); return; }
    setConfirming(null);
    const res = await window.cth.skillsUninstall(s.path).catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (!res.ok) setRowErr((r) => ({ ...r, [s.path]: res.error ?? t('wsCapabilities.installed.uninstallFailed') }));
    reloadLocal();
  };

  const revoke = async (agentId: string, name: string) => {
    const res = await window.cth.features.capabilities.setGrant({ agentId, kind: 'skill', id: name, on: false });
    if (!res.ok) setRowErr((r) => ({ ...r, [`${agentId}/${name}`]: res.error }));
  };
  const retry = (agentId: string, name: string) => {
    void window.cth.features.capabilities.setGrant({ agentId, kind: 'skill', id: name, on: true });
  };

  // Per-agent skills: in the folder, or granted and not (yet) there.
  const perAgent = useMemo(() => {
    const rows: Array<{ agent: FloorAgent; name: string; present: boolean; installing: boolean; error?: string }> = [];
    if (!state) return rows;
    const everyone = new Set([...state.builtinSkills, ...state.machineSkills]);
    for (const a of agents) {
      const own = new Set(state.agentSkills[a.id] ?? []);
      const granted = state.grants[a.id]?.skills ?? [];
      const names = [...new Set([...own, ...granted.filter((g) => !everyone.has(g))])].sort();
      for (const name of names) {
        rows.push({
          agent: a, name, present: own.has(name),
          installing: (state.installing[a.id] ?? []).includes(name),
          error: state.skillErrors[`${a.id}/${name}`]
        });
      }
    }
    return rows;
  }, [agents, state]);

  const skillRow = (s: LocalSkill, removable: boolean) => (
    <div key={s.path} className="cth-ws-capabilities-row">
      <div className="cth-ws-capabilities-row-main">
        <div className="cth-ws-capabilities-row-title"><span>{s.name}</span>{s.provider !== 'claude' && <Chip>{engineLabel(s.provider)}</Chip>}</div>
        {s.description && <div className="cth-ws-capabilities-row-desc">{s.description}</div>}
        {s.scope === 'project' && <div className="cth-ws-capabilities-row-meta cth-ws-mono">{s.path}</div>}
        {rowErr[s.path] && <span className="cth-ws-capabilities-error">{rowErr[s.path]}</span>}
      </div>
      {removable && (
        <div className="cth-ws-capabilities-row-actions">
          <Button size="sm" variant={confirming === s.path ? 'danger' : 'ghost'} onClick={() => { void uninstall(s); }}>
            {confirming === s.path ? t('wsCapabilities.installed.confirmUninstall') : t('wsCapabilities.installed.uninstall')}
          </Button>
        </div>
      )}
    </div>
  );

  if (local === null) return <EmptyState compact title={t('wsCapabilities.common.loading')} icon={<Spinner />} />;

  return (
    <>
      <Section title={t('wsCapabilities.installed.perAgent')} count={perAgent.length}>
        {perAgent.length === 0
          ? <div className="cth-ws-muted">{t('wsCapabilities.installed.perAgentEmpty')}</div>
          : (
            <div className="cth-ws-capabilities-list">
              {perAgent.map((r) => (
                <div key={`${r.agent.id}/${r.name}`} className="cth-ws-capabilities-row">
                  <div className="cth-ws-capabilities-row-main">
                    <div className="cth-ws-capabilities-row-title"><span>{r.name}</span><Chip tone="accent">{r.agent.name}</Chip></div>
                    {!r.present && !r.installing && !r.error && <span className="cth-ws-capabilities-row-meta">{t('wsCapabilities.installed.notInPlace')}</span>}
                    {r.error && <span className="cth-ws-capabilities-error">{r.error === 'notFound' ? t('wsCapabilities.market.notFound') : r.error}</span>}
                    {(rowErr[`${r.agent.id}/${r.name}`]) && <span className="cth-ws-capabilities-error">{rowErr[`${r.agent.id}/${r.name}`]}</span>}
                  </div>
                  <div className="cth-ws-capabilities-row-actions">
                    {r.installing && <Spinner label={t('wsCapabilities.market.installing')} />}
                    {!r.present && !r.installing && <Button size="sm" onClick={() => retry(r.agent.id, r.name)}>{t('wsCapabilities.market.retryInstall')}</Button>}
                    <Button size="sm" variant="ghost" onClick={() => { void revoke(r.agent.id, r.name); }}>{t('wsCapabilities.installed.revoke')}</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
      </Section>
      <Section title={t('wsCapabilities.installed.machine')} count={machine.length}>
        <p className="cth-ws-capabilities-intro">{t('wsCapabilities.installed.machineIntro')}</p>
        {machine.length === 0
          ? <div className="cth-ws-muted">{t('wsCapabilities.installed.machineEmpty')}</div>
          : <div className="cth-ws-capabilities-list">{machine.map((s) => skillRow(s, true))}</div>}
      </Section>
      {project.length > 0 && (
        <Section title={t('wsCapabilities.installed.project')} count={project.length}>
          <div className="cth-ws-capabilities-list">{project.map((s) => skillRow(s, true))}</div>
        </Section>
      )}
      <Section title={t('wsCapabilities.installed.builtin')} count={builtin.length} collapsible defaultCollapsed>
        <p className="cth-ws-capabilities-intro">{t('wsCapabilities.installed.builtinIntro')}</p>
        <div className="cth-ws-capabilities-list">{builtin.map((s) => skillRow(s, false))}</div>
      </Section>
      {plugins.length > 0 && (
        <Section title={t('wsCapabilities.installed.plugins')} count={plugins.length} collapsible defaultCollapsed>
          <div className="cth-ws-capabilities-list">{plugins.map((s) => skillRow(s, true))}</div>
        </Section>
      )}
    </>
  );
}

function McpBlock({ agents, state, config }: { agents: FloorAgent[]; state: CapabilitiesState | null; config: HarnessConfig }) {
  const { t } = useTranslation();
  const [error, setError] = useState('');
  const enabledFor = (id: string): boolean =>
    config.mcpDefaults?.[id]?.enabled ?? MCP_CATALOG.find((e) => e.id === id)?.defaultEnabled ?? false;

  const toggle = async (id: string, next: boolean) => {
    setError('');
    try {
      await window.cth.updateConfig({ mcpDefaults: { ...(config.mcpDefaults ?? {}), [id]: { enabled: next } } });
    } catch {
      setError(t('wsCapabilities.installed.couldNotSave'));
    }
  };

  return (
    <Section title={t('wsCapabilities.kinds.mcp')} count={MCP_CATALOG.length}>
      <p className="cth-ws-capabilities-intro">{t('wsCapabilities.installed.mcpIntro')}</p>
      {error && <div className="cth-ws-capabilities-banner" data-tone="error"><span>{error}</span></div>}
      {TIER_ORDER.map((tier) => (
        <div key={tier} style={{ marginBottom: 'var(--cth-space-3)' }}>
          <div className="cth-ws-capabilities-row-meta">{t(`wsCapabilities.installed.tier.${TIER_KEY[tier]}`)}</div>
          <div className="cth-ws-capabilities-list">
            {MCP_CATALOG.filter((e) => e.tier === tier).map((e) => {
              const granted = grantedNames(agents, state, (g) => g.mcp, e.id);
              return (
                <div key={e.id} className="cth-ws-capabilities-row">
                  <div className="cth-ws-capabilities-row-main">
                    <div className="cth-ws-capabilities-row-title">
                      <span>{e.label}</span>
                      <span className="cth-ws-mono cth-ws-muted">{e.id}</span>
                    </div>
                    <div className="cth-ws-capabilities-row-desc">{e.description}</div>
                    {granted.length > 0 && (
                      <div className="cth-ws-capabilities-row-meta">{t('wsCapabilities.installed.grantedTo', { names: granted.join(t('wsCapabilities.common.listSep')) })}</div>
                    )}
                    {e.tier === 'secret' && (
                      <KeyField
                        label={t('wsCapabilities.keys.mcpLabel', { name: e.label })}
                        hasKey={!!state?.mcpKeys[e.id]}
                        onSave={(key) => window.cth.features.capabilities.setMcpKey(e.id, key)}
                        onRemove={() => window.cth.features.capabilities.clearMcpKey(e.id)}
                      />
                    )}
                  </div>
                  <div className="cth-ws-capabilities-row-actions">
                    <Toggle
                      checked={enabledFor(e.id)}
                      onChange={(next) => { void toggle(e.id, next); }}
                      label={t('wsCapabilities.installed.everyAgent')}
                      title={tier === 'safe-readonly' ? undefined : t('wsCapabilities.installed.consentTitle')}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </Section>
  );
}

function ConnectionsBlock({ agents, state, records, reload }: {
  agents: FloorAgent[];
  state: CapabilitiesState | null;
  records: IntegrationRecordView[] | null;
  reload: () => void;
}) {
  const { t } = useTranslation();
  const openSettings = () => window.dispatchEvent(new CustomEvent('cth:open-settings', { detail: { section: 'Connections' } }));
  return (
    <Section
      title={t('wsCapabilities.kinds.connections')}
      count={records?.length}
      actions={<Button size="sm" variant="ghost" onClick={openSettings}>{t('wsCapabilities.installed.manageConnections')}</Button>}
    >
      <p className="cth-ws-capabilities-intro">{t('wsCapabilities.installed.connectionsIntro')}</p>
      {records === null ? <Spinner /> : records.length === 0 ? (
        <EmptyState
          compact
          title={t('wsCapabilities.installed.connectionsEmpty')}
          action={<Button size="sm" onClick={openSettings}>{t('wsCapabilities.installed.addConnection')}</Button>}
        />
      ) : (
        <div className="cth-ws-capabilities-list">
          {records.map((r) => {
            const granted = grantedNames(agents, state, (g) => g.connections, r.id);
            return (
              <div key={r.id} className="cth-ws-capabilities-row">
                <div className="cth-ws-capabilities-row-main">
                  <div className="cth-ws-capabilities-row-title">
                    <span>{r.label}</span>
                    <span className="cth-ws-mono cth-ws-muted">{r.id}</span>
                    <Chip tone={r.enabled ? 'ok' : 'neutral'}>{r.enabled ? t('wsCapabilities.installed.on') : t('wsCapabilities.installed.off')}</Chip>
                  </div>
                  <div className="cth-ws-capabilities-row-meta cth-ws-mono">{r.baseUrl}</div>
                  <div className="cth-ws-capabilities-row-meta">
                    {granted.length > 0
                      ? t('wsCapabilities.installed.grantedTo', { names: granted.join(t('wsCapabilities.common.listSep')) })
                      : t('wsCapabilities.installed.workersOnly')}
                  </div>
                  {authTypeNeedsSecret(r.authType)
                    ? (
                      <KeyField
                        label={t('wsCapabilities.keys.connectionLabel', { name: r.label })}
                        hasKey={r.hasSecret}
                        onSave={async (secret) => {
                          const res = await window.cth.integrationsSetSecret({ id: r.id, secret });
                          reload();
                          return res;
                        }}
                      />
                    )
                    : <span className="cth-ws-muted">{t('wsCapabilities.keys.notNeeded')}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

export function InstalledTab({ agents, state, local, reloadLocal, records, reloadRecords, config }: {
  agents: FloorAgent[];
  state: CapabilitiesState | null;
  local: LocalSkill[] | null;
  reloadLocal: () => void;
  records: IntegrationRecordView[] | null;
  reloadRecords: () => void;
  config: HarnessConfig;
}) {
  return (
    <>
      <SkillsBlock agents={agents} state={state} local={local} reloadLocal={reloadLocal} />
      <McpBlock agents={agents} state={state} config={config} />
      <ConnectionsBlock agents={agents} state={state} records={records} reload={reloadRecords} />
    </>
  );
}
