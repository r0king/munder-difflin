/**
 * The Workspace sidebar — "the sidebar is the office". Owned by the
 * `wsSidebar` unit; Workspace.tsx renders it inside the resizable column it
 * owns (width and collapse live in useWorkspace).
 *
 * Top to bottom:
 *   - the floor: the hive folder's name, and the office number when more than
 *     one floor is open; the Stapler with its on/off switch;
 *   - Tasks, Inbox, Automations, Memory, Capabilities, each with what it is
 *     counting (doing / open questions / switched on);
 *   - Agents: the orchestrator, then everyone grouped under their projects
 *     (AgentList), then Temps running right now;
 *   - Notes you can search (NotesSection);
 *   - Add an agent, and the gear with the sidebar's own settings.
 *
 * "Agents and notes only" hides the Stapler row and the nav block. Every
 * piece truncates with an ellipsis and carries a tooltip, and sidebar.css
 * drops secondary text at the narrow end, so the column is usable at every
 * width the shell's drag allows (200–560px).
 */
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { useWorkspace, type WorkspaceRoute } from '../store';
import { useStaplerState, setStaplerEnabled } from '../useStaplerState';
import { useHiveTasks, useOpenQuestions } from '../useHiveTasks';
import { Button, IconButton, Toggle, WsIcon, type WsIconName } from '../ui';
import type { WorkspaceScreenProps } from '../types';
import { pathBasename } from '@shared/workspace/sidebarProjects';
import { countDoing, type LedgerCard } from '@shared/workspace/sidebarTickets';
import { hiveKeyFor, useSidebarPrefs } from './sidebarPrefs';
import { useAutomationsOn, useFloorInfo } from './sidebarData';
import { AgentList } from './AgentList';
import { TempsSection } from './TempsSection';
import { NotesSection } from './NotesSection';
import { SettingsMenu } from './SettingsMenu';
import type { PopoverAnchor } from './Popover';
import './sidebar.css';

export type WorkspaceSidebarProps = WorkspaceScreenProps;

type NavKind = Extract<WorkspaceRoute['kind'], 'tasks' | 'inbox' | 'automations' | 'memory' | 'capabilities'>;

const NAV: ReadonlyArray<{ kind: NavKind; icon: WsIconName }> = [
  { kind: 'tasks', icon: 'tasks' },
  { kind: 'inbox', icon: 'inbox' },
  { kind: 'automations', icon: 'automations' },
  { kind: 'memory', icon: 'memory' },
  { kind: 'capabilities', icon: 'capabilities' }
];

export function WorkspaceSidebar({ config }: WorkspaceSidebarProps) {
  const { t } = useTranslation();
  const route = useWorkspace((s) => s.route);
  const navigate = useWorkspace((s) => s.navigate);
  const toggleSidebar = useWorkspace((s) => s.toggleSidebar);
  const setAddAgentOpen = useStore((s) => s.setAddAgentOpen);
  const agentCount = useStore((s) => s.agents.filter((a) => !a.isAssistant).length);
  const stapler = useStaplerState();
  const floor = useFloorInfo();
  const agentsNotesOnly = useSidebarPrefs((s) => s.agentsNotesOnly);
  const { tasks } = useHiveTasks();
  const openQuestions = useOpenQuestions().length;
  const doing = useMemo(() => countDoing(tasks as unknown as LedgerCard[]), [tasks]);
  const automationsOn = useAutomationsOn(config);
  const [settings, setSettings] = useState<PopoverAnchor | null>(null);
  const gearRef = useRef<HTMLSpanElement>(null);

  const home = config.harnessHome;
  const hiveKey = hiveKeyFor(home);
  const floorName = home ? pathBasename(home) || home : t('wsSidebar.floor.noHive');

  const badge = (kind: NavKind): { text: string; word?: string; tip: string; alert?: boolean } | null => {
    switch (kind) {
      case 'tasks':
        return doing > 0 ? { text: String(doing), word: t('wsSidebar.nav.doingWord'), tip: t('wsSidebar.nav.doingTip', { n: doing }) } : null;
      case 'inbox':
        return openQuestions > 0
          ? { text: String(openQuestions), tip: t('wsSidebar.nav.questionsTip', { n: openQuestions }), alert: true }
          : null;
      case 'automations':
        return automationsOn > 0
          ? { text: String(automationsOn), word: t('wsSidebar.nav.onWord'), tip: t('wsSidebar.nav.onTip', { n: automationsOn }) }
          : null;
      default:
        return null;
    }
  };

  return (
    <nav className="cth-ws-sidebar-root" aria-label={t('wsSidebar.title')}>
      <div className="cth-ws-sidebar-head">
        <div className="cth-ws-sidebar-floor">
          <span
            className="cth-ws-sidebar-floor-name"
            title={home ? t('wsSidebar.floor.folderTip', { path: home }) : undefined}
          >
            <span className="cth-ws-ellipsis">{floorName}</span>
            {floor.count > 1 && (
              <span className="cth-ws-sidebar-floor-office" title={t('wsSidebar.floor.officeOf', { number: floor.number, total: floor.count })}>
                {t('wsSidebar.floor.office', { number: floor.number })}
              </span>
            )}
          </span>
          <IconButton label={t('ws.shell.collapseSidebar')} size="sm" onClick={toggleSidebar}>
            <WsIcon name="sidebar" />
          </IconButton>
        </div>
        {!agentsNotesOnly && (
          <div className="cth-ws-sidebar-stapler">
            <button
              type="button"
              className="cth-ws-navrow"
              aria-current={route.kind === 'stapler' ? 'page' : undefined}
              title={t('wsSidebar.stapler.open')}
              onClick={() => navigate({ kind: 'stapler' })}
            >
              <WsIcon name="stapler" />
              <span className="cth-ws-navrow-label">{t('ws.nav.stapler')}</span>
              {stapler.recording && (
                <span
                  className="cth-ws-sidebar-recording"
                  role="img"
                  aria-label={t('wsSidebar.stapler.recording')}
                  title={t('wsSidebar.stapler.recording')}
                />
              )}
            </button>
            <Toggle
              checked={stapler.enabled}
              onChange={(on) => { void setStaplerEnabled(on); }}
              ariaLabel={t('ws.stapler.toggleAria')}
              title={stapler.enabled ? t('ws.stapler.on') : t('ws.stapler.off')}
            />
          </div>
        )}
      </div>

      {!agentsNotesOnly && (
        <div className="cth-ws-sidebar-nav">
          {NAV.map((item) => {
            const b = badge(item.kind);
            const label = t(`ws.nav.${item.kind}`);
            return (
              <button
                key={item.kind}
                type="button"
                className="cth-ws-navrow"
                aria-current={route.kind === item.kind ? 'page' : undefined}
                aria-label={b ? `${label}, ${b.tip}` : label}
                title={b ? b.tip : label}
                onClick={() => navigate({ kind: item.kind })}
              >
                <WsIcon name={item.icon} />
                <span className="cth-ws-navrow-label">{label}</span>
                {b && (
                  <span className={`cth-ws-sidebar-badge${b.alert ? ' cth-ws-sidebar-badge--alert' : ''}`} aria-hidden="true">
                    {b.text}
                    {b.word && <span className="cth-ws-sidebar-badge-word">{b.word}</span>}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="cth-ws-sidebar-body">
        <section className="cth-ws-sidebar-section" aria-label={t('wsSidebar.agents.title')}>
          <div className="cth-ws-sidebar-section-head">
            <button
              type="button"
              className="cth-ws-sidebar-section-title"
              aria-current={route.kind === 'agents' ? 'page' : undefined}
              title={t('wsSidebar.agents.openAll')}
              onClick={() => navigate({ kind: 'agents' })}
            >
              {t('wsSidebar.agents.title')}
              {agentCount > 0 && <span className="cth-ws-sidebar-section-count">· {agentCount}</span>}
            </button>
          </div>
          <AgentList config={config} hiveKey={hiveKey} />
        </section>

        <TempsSection />

        <NotesSection harnessHome={home} />
      </div>

      <div className="cth-ws-sidebar-foot">
        <Button size="sm" variant="ghost" icon={<WsIcon name="plus" />} onClick={() => setAddAgentOpen(true)}>
          {t('ws.shell.addAgent')}
        </Button>
        <span style={{ flex: 1 }} />
        <span ref={gearRef} style={{ display: 'inline-flex' }}>
          <IconButton
            label={t('wsSidebar.settings.title')}
            size="sm"
            active={!!settings}
            onClick={() => {
              if (settings) { setSettings(null); return; }
              const rect = gearRef.current?.getBoundingClientRect();
              if (rect) setSettings({ kind: 'above', rect });
            }}
          >
            <WsIcon name="settings" />
          </IconButton>
        </span>
      </div>

      {settings && <SettingsMenu anchor={settings} hiveKey={hiveKey} onClose={() => setSettings(null)} toggleRef={gearRef} />}
    </nav>
  );
}
