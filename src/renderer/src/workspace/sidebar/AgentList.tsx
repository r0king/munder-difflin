/**
 * The sidebar's agent list: the orchestrator first, then every agent grouped
 * under its project (sidebarProjects.ts), each row with its live dot, name,
 * model, what it is doing in words, an "Asked you" chip and its ticket.
 *
 * ORDER. With "Keep my agent order" off, groups and rows sort themselves:
 * needs-you first, then working, then idle (sidebarOrder.ts), with a hold on
 * demotions so a row does not hop between two tool calls. With it on, the
 * order is the user's — drag a row within its project, drag a project header,
 * or Alt+ArrowUp/Down on a focused row or header — saved per hive.
 *
 * KEYBOARD. Rows and headers are buttons in one roving list: ArrowUp/Down move
 * focus, Enter opens, the context-menu key (or Shift+F10) opens the menu, and
 * Alt+ArrowUp/Down moves the focused item when the order is kept.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type Agent } from '@/store/store';
import type { HarnessConfig } from '@/store/config';
import { useWorkspace } from '../store';
import { agentLiveLine, deriveAgentStatus, liveLineText, type WsAgentStatus } from '../agentStatus';
import { useAskedYou, useHiveTasks } from '../useHiveTasks';
import { StatusDot, WsIcon } from '../ui';
import {
  groupAgentsByProject,
  projectIdentity,
  type ProjectGroup
} from '@shared/workspace/sidebarProjects';
import {
  applyGroupOrder,
  autoGroupOrder,
  autoOrder,
  nudgeItem,
  placeRelative,
  reconcileOrder,
  statusRank
} from '@shared/workspace/sidebarOrder';
import { currentTicketsByAgent, ticketAssignee, type LedgerCard } from '@shared/workspace/sidebarTickets';
import { useHiveSidebarState, useSidebarPrefs } from './sidebarPrefs';
import { modelLabel, useLiveWorkers, useRepoRoots, useSettledRanks } from './sidebarData';
import { AgentMenu } from './AgentMenu';
import { TicketCard, useHoverCard } from './TicketCard';
import type { PopoverAnchor } from './Popover';

type DragState = { kind: 'agent'; id: string; group: string } | { kind: 'project'; id: string };
type DropState = { id: string; where: 'before' | 'after' };

/** Focus the roving item with this id after React has moved it (a moved DOM
 *  node loses focus in Chromium). */
function refocus(id: string): void {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`[data-sb-nav="${CSS.escape(id)}"]`)?.focus();
  });
}

/** Plain ArrowUp/Down: the previous/next item in the list. */
function moveFocus(from: HTMLElement, delta: 1 | -1): void {
  const list = from.closest('[data-sb-list]');
  if (!list) return;
  const items = [...list.querySelectorAll<HTMLElement>('[data-sb-nav]')];
  const i = items.indexOf(from);
  const next = items[i + delta];
  next?.focus();
}

function whereInRow(e: DragEvent<HTMLElement>): 'before' | 'after' {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? 'before' : 'after';
}

export function AgentList({ config, hiveKey }: { config: HarnessConfig; hiveKey: string }) {
  const { t } = useTranslation();
  const agents = useStore((s) => s.agents);
  const route = useWorkspace((s) => s.route);
  const navigate = useWorkspace((s) => s.navigate);
  const askedYou = useAskedYou();
  const { tasks } = useHiveTasks();
  const { live: workers } = useLiveWorkers();
  const rootOf = useRepoRoots(agents);
  const keepOrder = useSidebarPrefs((s) => s.keepOrder);
  const saveAgentOrder = useSidebarPrefs((s) => s.saveAgentOrder);
  const saveProjectOrder = useSidebarPrefs((s) => s.saveProjectOrder);
  const toggleCollapsed = useSidebarPrefs((s) => s.toggleCollapsed);
  const hiveState = useHiveSidebarState(hiveKey);

  const [drag, setDrag] = useState<DragState | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  const [menu, setMenu] = useState<{ agentId: string; anchor: PopoverAnchor } | null>(null);
  const [announce, setAnnounce] = useState('');

  const tickets = useMemo(() => currentTicketsByAgent(tasks as unknown as LedgerCard[]), [tasks]);
  const workerIds = useMemo(() => new Set(workers.map((w) => w.workerId)), [workers]);
  const god = agents.find((a) => a.isGod && !a.isAssistant);
  // Temps (one-job workers) are listed in their own section, not as projects.
  const roster = useMemo(
    () => agents.filter((a) => !a.isGod && !a.isAssistant && !workerIds.has(a.id)),
    [agents, workerIds]
  );

  const statusOf = (a: Agent): WsAgentStatus =>
    deriveAgentStatus({ status: a.status, action: a.action, ptyId: a.ptyId, archived: a.archived, hasOpenQuestion: askedYou.has(a.id) });

  const rawRanks: Record<string, number> = {};
  for (const a of roster) rawRanks[a.id] = statusRank(statusOf(a), askedYou.has(a.id));
  const ranks = useSettledRanks(rawRanks);
  const rankOf = (id: string): number => ranks[id] ?? rawRanks[id] ?? 4;

  const naturalGroups = groupAgentsByProject(roster, (a) =>
    projectIdentity(a, { repoRoot: rootOf(a.cwd), harnessHome: config.harnessHome }));
  const naturalIds = roster.map((a) => a.id);

  // The order on screen, both ways. Recomputed every render on purpose: the
  // members are live agent objects (their action changes on every chunk of
  // terminal output), so a memo keyed on ids would show a stale live line.
  const autoView: ProjectGroup<Agent>[] = autoGroupOrder(naturalGroups, (g) => Math.min(...g.members.map((m) => rankOf(m.id))))
    .map((g) => {
      const byId = new Map(g.members.map((m) => [m.id, m]));
      return { ...g, members: autoOrder(g.members.map((m) => m.id), rankOf).map((id) => byId.get(id)!) };
    });
  const flatManual = reconcileOrder(hiveState.agents, naturalIds);
  const manualGroups: ProjectGroup<Agent>[] = (() => {
    const pos = new Map(flatManual.map((id, i) => [id, i]));
    const keys = reconcileOrder(hiveState.projects, naturalGroups.map((g) => g.key));
    const byKey = new Map(naturalGroups.map((g) => [g.key, g]));
    return keys.map((k) => {
      const g = byKey.get(k)!;
      return { ...g, members: [...g.members].sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0)) };
    });
  })();
  const groups = keepOrder ? manualGroups : autoView;

  // Turning "Keep my agent order" on keeps the order you were looking at,
  // rather than snapping back to roster order on the first frame.
  const lastAuto = useRef(autoView);
  lastAuto.current = autoView;
  useEffect(() => {
    if (!keepOrder) return;
    const state = useSidebarPrefs.getState().hive(hiveKey);
    if (state.agents.length || state.projects.length) return;
    const view = lastAuto.current;
    saveProjectOrder(hiveKey, view.map((g) => g.key));
    saveAgentOrder(hiveKey, view.flatMap((g) => g.members.map((m) => m.id)));
  }, [keepOrder, hiveKey, saveAgentOrder, saveProjectOrder]);

  // ─── Moves ─────────────────────────────────────────────────────────────────

  const moveAgent = (group: ProjectGroup<Agent>, nextGroupOrder: string[], movedId: string) => {
    saveAgentOrder(hiveKey, applyGroupOrder(flatManual, nextGroupOrder));
    const name = roster.find((a) => a.id === movedId)?.name ?? '';
    const pos = nextGroupOrder.indexOf(movedId) + 1;
    setAnnounce(t('wsSidebar.agents.moved', { name, position: pos, total: group.members.length }));
  };
  const moveProject = (nextKeys: string[], movedKey: string) => {
    saveProjectOrder(hiveKey, nextKeys);
    const g = groups.find((x) => x.key === movedKey);
    setAnnounce(t('wsSidebar.agents.movedProject', {
      name: g?.name || t('wsSidebar.agents.noProject'),
      position: nextKeys.indexOf(movedKey) + 1,
      total: nextKeys.length
    }));
  };

  const onRowKey = (e: KeyboardEvent<HTMLElement>, a: Agent, group: ProjectGroup<Agent> | null) => {
    if (e.nativeEvent.isComposing) return;
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey && !e.ctrlKey && !e.metaKey) {
      if (!keepOrder || !group) return;
      e.preventDefault();
      const ids = group.members.map((m) => m.id);
      const next = nudgeItem(ids, a.id, e.key === 'ArrowUp' ? -1 : 1);
      if (next.join() !== ids.join()) { moveAgent(group, next, a.id); refocus(a.id); }
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      moveFocus(e.currentTarget, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      setMenu({ agentId: a.id, anchor: { kind: 'below', rect: r } });
    }
  };

  const onHeaderKey = (e: KeyboardEvent<HTMLElement>, key: string) => {
    if (e.nativeEvent.isComposing) return;
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey && !e.ctrlKey && !e.metaKey) {
      if (!keepOrder) return;
      e.preventDefault();
      const keys = groups.map((g) => g.key);
      const next = nudgeItem(keys, key, e.key === 'ArrowUp' ? -1 : 1);
      if (next.join() !== keys.join()) { moveProject(next, key); refocus(`project:${key}`); }
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      moveFocus(e.currentTarget, e.key === 'ArrowUp' ? -1 : 1);
    }
  };

  const openMenuAt = (e: MouseEvent, agentId: string) => {
    e.preventDefault();
    setMenu({ agentId, anchor: { kind: 'point', x: e.clientX, y: e.clientY } });
  };

  const endDrag = () => { setDrag(null); setDrop(null); };

  const nameOf = (id: string | null): string | null =>
    id ? (agents.find((a) => a.id === id)?.name ?? useStore.getState().restorableAgents.find((a) => a.id === id)?.name ?? id) : null;

  const menuAgent = menu ? agents.find((a) => a.id === menu.agentId) : undefined;
  const multipleGroups = groups.length > 1 || (groups.length === 1 && !!groups[0].name);

  return (
    <div data-sb-list="" role="list" aria-label={t('wsSidebar.agents.title')}>
      {god && (
        <AgentRow
          agent={god}
          status={statusOf(god)}
          asked={askedYou.has(god.id)}
          ticket={tickets.get(god.id) ?? null}
          current={route.kind === 'orchestrator'}
          reorderable={false}
          dragging={false}
          drop={null}
          nameOf={nameOf}
          onOpen={() => navigate({ kind: 'orchestrator' })}
          onContextMenu={(e) => openMenuAt(e, god.id)}
          onKeyDown={(e) => onRowKey(e, god, null)}
        />
      )}

      {groups.map((group) => {
        const collapsed = hiveState.collapsed.includes(group.key);
        const needsYou = group.members.some((m) => rankOf(m.id) === 0);
        const groupName = group.name || t('wsSidebar.agents.noProject');
        const headerDrop = drop && drop.id === `project:${group.key}` ? drop.where : null;
        return (
          <div key={group.key} className="cth-ws-sidebar-group" role="group" aria-label={groupName}>
            {multipleGroups && (
              <button
                type="button"
                className="cth-ws-sidebar-group-head"
                data-sb-nav={`project:${group.key}`}
                data-reorderable={keepOrder ? 'true' : undefined}
                data-dragging={drag?.kind === 'project' && drag.id === group.key ? 'true' : undefined}
                data-drop={headerDrop ?? undefined}
                aria-expanded={!collapsed}
                title={group.path ?? groupName}
                draggable={keepOrder}
                onClick={() => toggleCollapsed(hiveKey, group.key)}
                onKeyDown={(e) => onHeaderKey(e, group.key)}
                onDragStart={(e) => {
                  if (!keepOrder) return;
                  setDrag({ kind: 'project', id: group.key });
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', groupName);
                }}
                onDragOver={(e) => {
                  if (drag?.kind !== 'project' || drag.id === group.key) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  const where = whereInRow(e);
                  if (drop?.id !== `project:${group.key}` || drop.where !== where) setDrop({ id: `project:${group.key}`, where });
                }}
                onDragLeave={() => { if (drop?.id === `project:${group.key}`) setDrop(null); }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drag?.kind === 'project' && drag.id !== group.key) {
                    const keys = groups.map((g) => g.key);
                    moveProject(placeRelative(keys, drag.id, group.key, whereInRow(e)), drag.id);
                  }
                  endDrag();
                }}
                onDragEnd={endDrag}
              >
                {keepOrder && <span className="cth-ws-sidebar-grip" aria-hidden="true" />}
                <WsIcon name={collapsed ? 'chevron-right' : 'chevron-down'} />
                <span className="cth-ws-sidebar-group-name">{groupName}</span>
                {group.detail && <span className="cth-ws-sidebar-group-detail">· {group.detail}</span>}
                <span className="cth-ws-sidebar-group-spacer" />
                {collapsed && needsYou && (
                  <span className="cth-ws-sidebar-group-needs" role="img" aria-label={t('wsSidebar.agents.groupNeedsYou')} title={t('wsSidebar.agents.groupNeedsYou')} />
                )}
                <span className="cth-ws-sidebar-group-count">{group.members.length}</span>
              </button>
            )}
            {!(multipleGroups && collapsed) && group.members.map((a) => (
              <AgentRow
                key={a.id}
                agent={a}
                status={statusOf(a)}
                asked={askedYou.has(a.id)}
                ticket={tickets.get(a.id) ?? null}
                current={route.kind === 'agent' && route.agentId === a.id}
                reorderable={keepOrder}
                dragging={drag?.kind === 'agent' && drag.id === a.id}
                drop={drop && drop.id === a.id ? drop.where : null}
                nameOf={nameOf}
                onOpen={() => navigate({ kind: 'agent', agentId: a.id })}
                onContextMenu={(e) => openMenuAt(e, a.id)}
                onKeyDown={(e) => onRowKey(e, a, group)}
                onDragStart={(e) => {
                  setDrag({ kind: 'agent', id: a.id, group: group.key });
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', a.name);
                }}
                onDragOver={(e) => {
                  // Rows only move within their own project: the group comes
                  // from the agent's folder, so a cross-group drop would snap
                  // straight back under its own header.
                  if (drag?.kind !== 'agent' || drag.group !== group.key || drag.id === a.id) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  const where = whereInRow(e);
                  if (drop?.id !== a.id || drop.where !== where) setDrop({ id: a.id, where });
                }}
                onDragLeave={() => { if (drop?.id === a.id) setDrop(null); }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drag?.kind === 'agent' && drag.group === group.key && drag.id !== a.id) {
                    const ids = group.members.map((m) => m.id);
                    moveAgent(group, placeRelative(ids, drag.id, a.id, whereInRow(e)), drag.id);
                  }
                  endDrag();
                }}
                onDragEnd={endDrag}
              />
            ))}
          </div>
        );
      })}

      {!god && roster.length === 0 && (
        <div className="cth-ws-sidebar-quiet">{t('wsSidebar.agents.empty')}</div>
      )}

      <span className="cth-ws-sidebar-sr" aria-live="polite">{announce}</span>

      {menu && menuAgent && (
        <AgentMenu agent={menuAgent} anchor={menu.anchor} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

// ─── Row ────────────────────────────────────────────────────────────────────

interface AgentRowProps {
  agent: Agent;
  status: WsAgentStatus;
  asked: boolean;
  ticket: LedgerCard | null;
  current: boolean;
  reorderable: boolean;
  dragging: boolean;
  drop: 'before' | 'after' | null;
  nameOf: (id: string | null) => string | null;
  onOpen: () => void;
  onContextMenu: (e: MouseEvent) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  onDragStart?: (e: DragEvent<HTMLElement>) => void;
  onDragOver?: (e: DragEvent<HTMLElement>) => void;
  onDragLeave?: () => void;
  onDrop?: (e: DragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
}

function AgentRow({
  agent, status, asked, ticket, current, reorderable, dragging, drop, nameOf,
  onOpen, onContextMenu, onKeyDown, onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd
}: AgentRowProps) {
  const { t } = useTranslation();
  const navigate = useWorkspace((s) => s.navigate);
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const hover = useHoverCard();
  const line = agentLiveLine({
    status: agent.status, action: agent.action, ptyId: agent.ptyId, archived: agent.archived,
    isGod: agent.isGod, hasOpenQuestion: asked
  });
  const live = liveLineText(t, line);
  const model = modelLabel(agent);
  const role = agent.isGod ? t('wsSidebar.agents.orchestrator') : null;

  return (
    <div
      className="cth-ws-sidebar-agent"
      role="listitem"
      data-status={status}
      data-current={current ? 'true' : undefined}
      data-reorderable={reorderable ? 'true' : undefined}
      data-dragging={dragging ? 'true' : undefined}
      data-drop={drop ?? undefined}
      draggable={reorderable}
      onContextMenu={onContextMenu}
      onDragStart={reorderable ? onDragStart : undefined}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      {reorderable && <span className="cth-ws-sidebar-grip" aria-hidden="true" />}
      <button
        type="button"
        className="cth-ws-sidebar-agent-main"
        data-sb-nav={agent.id}
        aria-current={current ? 'page' : undefined}
        title={reorderable ? `${agent.name} — ${live}\n${t('wsSidebar.agents.reorderHint')}` : `${agent.name} — ${live}`}
        onClick={onOpen}
        onKeyDown={onKeyDown}
      >
        <span className="cth-ws-sidebar-agent-line">
          <StatusDot status={status} />
          <span className="cth-ws-sidebar-agent-name">{agent.name}</span>
          {role && <span className="cth-ws-sidebar-orch-tag">{role}</span>}
          <span className="cth-ws-sidebar-agent-model">{model}</span>
        </span>
        <span className="cth-ws-sidebar-agent-live">{live}</span>
      </button>
      {(asked || ticket) && (
        <span className="cth-ws-sidebar-agent-chips">
          {asked && (
            <button
              type="button"
              className="cth-ws-sidebar-chip cth-ws-sidebar-chip--asked"
              title={t('wsSidebar.agents.askedYouTip', { name: agent.name })}
              aria-label={t('wsSidebar.agents.askedYouTip', { name: agent.name })}
              onClick={() => navigate({ kind: 'inbox', section: 'askme' })}
            >
              <span className="cth-ws-sidebar-chip-long">{t('wsSidebar.agents.askedYou')}</span>
              <span className="cth-ws-sidebar-chip-short" aria-hidden="true">?</span>
            </button>
          )}
          {ticket && (
            <button
              type="button"
              className="cth-ws-sidebar-chip cth-ws-sidebar-chip--ticket"
              aria-label={t('wsSidebar.ticket.open', { key: ticket.id })}
              onPointerEnter={(e) => hover.show(e.currentTarget)}
              onPointerLeave={() => hover.hide()}
              onFocus={(e) => hover.show(e.currentTarget, true)}
              onBlur={() => hover.hide(true)}
              onClick={() => { hover.hide(true); openTaskDetail(ticket.id); }}
            >
              {ticket.id}
            </button>
          )}
        </span>
      )}
      {ticket && hover.anchor && (
        <TicketCard
          card={ticket}
          assigneeName={nameOf(ticketAssignee(ticket))}
          anchor={hover.anchor}
          onClose={() => hover.hide()}
          onKeep={hover.keep}
        />
      )}
    </div>
  );
}
