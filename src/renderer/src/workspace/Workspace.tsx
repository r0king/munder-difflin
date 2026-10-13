/**
 * The Workspace — the professional interface, shown in place of the pixel
 * office (floor + right-hand panel + agent strip) when `config.uiMode` is
 * 'workspace'. App.tsx keeps everything else exactly as it is in Classic: the
 * titlebar, toasts, modals, focus mode, the IDE, the task overlay, the quit
 * flow, and every hook (useHive and friends). This is a presentation swap.
 *
 * The shell owns only the frame: a resizable sidebar column (collapsible to a
 * rail), the main area, which screen a route shows, an error boundary per
 * screen, and the states that exist before there is anything to show (god
 * booting, an empty floor, an agent that has left). Every screen is its own
 * unit's file (docs/WORKSPACE_UNITS.md).
 */
import { Component, type ErrorInfo, type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import type { HarnessConfig } from '@/store/config';
import { useRestoreTeam } from '@/hooks/useRestoreTeam';
import { useResolvedGodName } from '@/hooks/useResolvedGodName';
import { useRtl } from '@/i18n/useDirection';
import { useWorkspace, WS_SIDEBAR_DEFAULT, WS_SIDEBAR_MIN, type WorkspaceRoute } from './store';
import { Button, EmptyState, IconButton, ScreenHeaderExtrasContext, Spinner, WsIcon } from './ui';
import { WorkspaceSidebar } from './sidebar/Sidebar';
import { AgentsScreen } from './screens/AgentsScreen';
import { AgentRoom } from './screens/AgentRoom';
import { OrchestratorScreen } from './screens/OrchestratorScreen';
import { TasksScreen } from './screens/TasksScreen';
import { InboxScreen } from './screens/InboxScreen';
import { AutomationsScreen } from './screens/AutomationsScreen';
import { MemoryScreen } from './screens/MemoryScreen';
import { CapabilitiesScreen } from './screens/CapabilitiesScreen';
import { StaplerScreen } from './screens/StaplerScreen';

/** The main area never gets narrower than this while dragging the sidebar. */
const MIN_MAIN_WIDTH = 480;

export function Workspace({ config }: { config: HarnessConfig }) {
  // The boot-time "restore last session's team" lives in this hook, and in
  // Classic it is mounted by AgentStrip — which the Workspace does not render.
  // Mounting it here keeps the automatic restore identical in both modes (its
  // module-level latch makes a second mount point harmless).
  useRestoreTeam(config);

  const route = useWorkspace((s) => s.route);
  const collapsed = useWorkspace((s) => s.sidebarCollapsed);
  const width = useWorkspace((s) => s.sidebarWidth);
  const toggleSidebar = useWorkspace((s) => s.toggleSidebar);
  const { t } = useTranslation();

  // Controls every screen header carries, after the screen's own actions
  // (ui.tsx ScreenHeaderExtrasContext). The wsInbox unit mounts its Ask me
  // bell here.
  const headerExtras = null;

  return (
    <div className="cth-ws-root">
      {collapsed ? (
        <div className="cth-ws-rail">
          <IconButton label={t('ws.shell.expandSidebar')} onClick={toggleSidebar}>
            <WsIcon name="sidebar" />
          </IconButton>
        </div>
      ) : (
        <>
          <aside className="cth-ws-sidebar" style={{ width }}>
            <WorkspaceSidebar config={config} />
          </aside>
          <SidebarResizeHandle />
        </>
      )}
      <main className="cth-ws-main">
        <ScreenHeaderExtrasContext.Provider value={headerExtras}>
          <ScreenBoundary resetKey={JSON.stringify(route)}>
            <RouteScreen route={route} config={config} />
          </ScreenBoundary>
        </ScreenHeaderExtrasContext.Provider>
      </main>
    </div>
  );
}

// ─── Routing ────────────────────────────────────────────────────────────────

function RouteScreen({ route, config }: { route: WorkspaceRoute; config: HarnessConfig }) {
  const { t } = useTranslation();
  const godName = useResolvedGodName();
  const agentCount = useStore((s) => s.agents.length);
  const godStatus = useStore((s) => s.godStatus);
  const hasGod = useStore((s) => s.agents.some((a) => a.isGod));
  const routeAgent = useStore((s) => (route.kind === 'agent' ? s.agents.find((a) => a.id === route.agentId) : undefined));
  const navigate = useWorkspace((s) => s.navigate);
  const setAddAgentOpen = useStore((s) => s.setAddAgentOpen);

  // An agent route that names god is his screen. navigate() canonicalises
  // this already; a route restored from an older session may not have been.
  useEffect(() => {
    if (route.kind === 'agent' && routeAgent?.isGod) navigate({ kind: 'orchestrator' });
  }, [route, routeAgent, navigate]);

  // The floor-level states first: they apply to the screens that are ABOUT
  // agents. Tasks, Memory, Automations and Capabilities work without anyone
  // on the floor, so they are never gated.
  const agentScreen = route.kind === 'agents' || route.kind === 'agent' || route.kind === 'orchestrator';
  if (agentScreen && agentCount === 0 && godStatus === 'booting') {
    return (
      <EmptyState
        fill
        icon={<Spinner label={t('ws.shell.booting')} />}
        title={t('ws.shell.booting')}
        body={t('ws.shell.bootingBody', { godName })}
      />
    );
  }
  if (route.kind === 'orchestrator' && !hasGod && godStatus === 'failed') {
    return (
      <EmptyState
        fill
        title={t('ws.shell.failed', { godName })}
        body={t('ws.shell.failedBody')}
        action={
          <Button onClick={() => window.dispatchEvent(new CustomEvent('cth:open-settings', { detail: {} }))}>
            {t('ws.keys.settings')}
          </Button>
        }
      />
    );
  }
  if (agentScreen && agentCount === 0) {
    return (
      <EmptyState
        fill
        title={t('ws.shell.empty')}
        body={t('ws.shell.emptyBody')}
        action={
          <Button variant="primary" icon={<WsIcon name="plus" />} onClick={() => setAddAgentOpen(true)}>
            {t('ws.shell.addAgent')}
          </Button>
        }
      />
    );
  }

  switch (route.kind) {
    case 'agents': return <AgentsScreen config={config} />;
    case 'agent':
      if (!routeAgent) {
        return (
          <EmptyState
            fill
            title={t('ws.shell.agentGone')}
            body={t('ws.shell.agentGoneBody')}
            action={<Button onClick={() => navigate({ kind: 'agents' })}>{t('ws.shell.backToAgents')}</Button>}
          />
        );
      }
      if (routeAgent.isGod) return <OrchestratorScreen config={config} />;
      return <AgentRoom key={route.agentId} agentId={route.agentId} config={config} />;
    case 'orchestrator': return <OrchestratorScreen config={config} tab={route.tab} />;
    case 'tasks': return <TasksScreen config={config} />;
    case 'inbox': return <InboxScreen config={config} section={route.section} />;
    case 'automations': return <AutomationsScreen config={config} />;
    case 'memory': return <MemoryScreen config={config} query={route.query} />;
    case 'capabilities': return <CapabilitiesScreen config={config} tab={route.tab} />;
    case 'stapler': return <StaplerScreen config={config} />;
    default: return <AgentsScreen config={config} />;
  }
}

// ─── Error boundary ─────────────────────────────────────────────────────────

interface BoundaryProps { resetKey: string; children: ReactNode }
interface BoundaryState { error: Error | null; key: string }

/**
 * One screen's crash stays that screen's problem. Eleven units land screens in
 * parallel; without this, a throw in any one of them blanks the whole window
 * (React unmounts the root), titlebar and quit flow included. Navigating away
 * (a new resetKey) clears it.
 */
class ScreenBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[workspace] screen crashed:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return <CrashedScreen message={this.state.error.message} onRetry={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}

function CrashedScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <EmptyState
      fill
      title={t('ws.shell.screenCrashed')}
      body={<>{t('ws.shell.screenCrashedBody')}<br /><span className="cth-ws-mono">{message}</span></>}
      action={<Button onClick={onRetry}>{t('ws.shell.retry')}</Button>}
    />
  );
}

// ─── Sidebar resize ─────────────────────────────────────────────────────────

/**
 * The drag handle on the sidebar's inline-end edge. Learned from
 * components/SidebarSplitter (drag, double-click resets), but on pointer
 * capture rather than window listeners, keyboard-operable (it is a separator
 * with a value), and mirrored for Arabic, where the sidebar sits on the right
 * and dragging LEFT widens it.
 */
function SidebarResizeHandle() {
  const { t } = useTranslation();
  const rtl = useRtl();
  const width = useWorkspace((s) => s.sidebarWidth);
  const setWidth = useWorkspace((s) => s.setSidebarWidth);
  const start = useRef<{ x: number; width: number } | null>(null);
  const [active, setActive] = useState(false);

  const clampToViewport = (px: number): number =>
    Math.min(px, Math.max(WS_SIDEBAR_MIN, window.innerWidth - MIN_MAIN_WIDTH));

  return (
    <div
      className="cth-ws-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('ws.shell.resizeSidebar')}
      aria-valuenow={width}
      tabIndex={0}
      title={t('ws.shell.resizeSidebar')}
      data-active={active ? 'true' : undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width };
        setActive(true);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const delta = (e.clientX - start.current.x) * (rtl ? -1 : 1);
        setWidth(clampToViewport(start.current.width + delta));
      }}
      onPointerUp={(e) => {
        start.current = null;
        setActive(false);
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      }}
      onPointerCancel={() => { start.current = null; setActive(false); }}
      onDoubleClick={() => setWidth(WS_SIDEBAR_DEFAULT)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        const grow = rtl ? 'ArrowLeft' : 'ArrowRight';
        const shrink = rtl ? 'ArrowRight' : 'ArrowLeft';
        if (e.key === grow) { e.preventDefault(); setWidth(clampToViewport(width + step)); }
        else if (e.key === shrink) { e.preventDefault(); setWidth(width - step); }
        else if (e.key === 'Home') { e.preventDefault(); setWidth(WS_SIDEBAR_DEFAULT); }
      }}
    />
  );
}
