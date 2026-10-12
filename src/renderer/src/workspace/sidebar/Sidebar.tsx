/**
 * The Workspace sidebar: the Stapler toggle at the top, then Tasks, Inbox,
 * Automations, Memory, Capabilities, then every agent with a live dot.
 * Owned by the `wsSidebar` unit.
 *
 * FOUNDATION STUB — deliberately already usable (every route is reachable and
 * every agent is listed) so the shell works before the real sidebar lands:
 * grouping by project, live lines, "Asked you", reordering and search are the
 * unit's. Keep the export name and props; Workspace.tsx renders it inside a
 * resizable column and owns collapse/width (useWorkspace).
 */
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { useWorkspace, type WorkspaceRoute } from '../store';
import { deriveAgentStatus } from '../agentStatus';
import { useStaplerState, setStaplerEnabled } from '../useStaplerState';
import { Button, IconButton, Section, StatusDot, Toggle, WsIcon, type WsIconName } from '../ui';
import type { WorkspaceScreenProps } from '../types';

export type WorkspaceSidebarProps = WorkspaceScreenProps;

const NAV: ReadonlyArray<{ kind: WorkspaceRoute['kind']; icon: WsIconName }> = [
  { kind: 'orchestrator', icon: 'orchestrator' },
  { kind: 'agents', icon: 'agents' },
  { kind: 'tasks', icon: 'tasks' },
  { kind: 'inbox', icon: 'inbox' },
  { kind: 'automations', icon: 'automations' },
  { kind: 'memory', icon: 'memory' },
  { kind: 'capabilities', icon: 'capabilities' }
];

export function WorkspaceSidebar({ config }: WorkspaceSidebarProps) {
  const { t } = useTranslation();
  void config;
  const route = useWorkspace((s) => s.route);
  const navigate = useWorkspace((s) => s.navigate);
  const toggleSidebar = useWorkspace((s) => s.toggleSidebar);
  const agents = useStore((s) => s.agents);
  const setAddAgentOpen = useStore((s) => s.setAddAgentOpen);
  const stapler = useStaplerState();

  const roster = agents.filter((a) => !a.isAssistant);

  return (
    <nav aria-label={t('wsSidebar.title')} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 8px 4px 12px' }}>
        <button
          type="button"
          className="cth-ws-navrow"
          aria-current={route.kind === 'stapler' ? 'page' : undefined}
          onClick={() => navigate({ kind: 'stapler' })}
          style={{ padding: 0, flex: 1 }}
        >
          <WsIcon name="stapler" />
          <span className="cth-ws-navrow-label">{t('ws.nav.stapler')}</span>
        </button>
        <Toggle
          checked={stapler.enabled}
          onChange={(on) => { void setStaplerEnabled(on); }}
          ariaLabel={t('ws.stapler.toggleAria')}
          title={stapler.enabled ? t('ws.stapler.on') : t('ws.stapler.off')}
        />
        <IconButton label={t('ws.shell.collapseSidebar')} size="sm" onClick={toggleSidebar}>
          <WsIcon name="sidebar" />
        </IconButton>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', padding: '4px 0' }}>
        {NAV.map((item) => (
          <button
            key={item.kind}
            type="button"
            className="cth-ws-navrow"
            aria-current={route.kind === item.kind ? 'page' : undefined}
            onClick={() => navigate({ kind: item.kind } as WorkspaceRoute)}
          >
            <WsIcon name={item.icon} />
            <span className="cth-ws-navrow-label">{t(`ws.nav.${item.kind}`)}</span>
          </button>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 0' }}>
        <Section
          title={<span style={{ paddingInlineStart: 12 }}>{t('ws.nav.agents')}</span>}
          count={roster.length}
        >
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {roster.map((a) => {
              const current = a.isGod ? route.kind === 'orchestrator' : route.kind === 'agent' && route.agentId === a.id;
              const status = deriveAgentStatus(a);
              return (
                <button
                  key={a.id}
                  type="button"
                  className="cth-ws-navrow"
                  aria-current={current ? 'page' : undefined}
                  onClick={() => navigate({ kind: 'agent', agentId: a.id })}
                >
                  <StatusDot status={status} />
                  <span className="cth-ws-navrow-label">{a.name}</span>
                  {a.isGod && <span className="cth-ws-navrow-meta">{t('ws.nav.orchestrator')}</span>}
                </button>
              );
            })}
          </div>
        </Section>
      </div>

      <div style={{ padding: 12, borderTop: '1px solid var(--cth-ink-100)' }}>
        <Button size="sm" variant="ghost" icon={<WsIcon name="plus" />} onClick={() => setAddAgentOpen(true)}>
          {t('ws.shell.addAgent')}
        </Button>
      </div>
    </nav>
  );
}
