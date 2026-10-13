/**
 * Inbox — one inbox for what needs you. Owned by the `wsInbox` unit.
 *
 * Left, the list: FOR YOU (Ask me — every question an agent is blocked on and
 * every request addressed to you — then a row per agent), EVERYONE (every
 * routed message, searchable), OUTSIDE (webhooks, Slack threads, other
 * offices; Approve / Reject on anything held). Right, the open section. The
 * section is the route's `section` (see shared/workspace/inboxSection.ts), so
 * main, the sidebar or a bell can deep-link to any of them.
 *
 * Sources, all existing: the task ledger (useHiveTasks), the floor's mail
 * (feat:inbox:messages, inbox/mailStore.ts), the trigger history
 * (inbox/outsideStore.ts) and the orchestrator's queue for Slack.
 */
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Screen, ScreenHeader } from '../ui';
import type { WorkspaceScreenProps } from '../types';
import { useWorkspace } from '../store';
import { useHiveTasks } from '../useHiveTasks';
import { useStore, type QueuedMessage } from '@/store/store';
import { heldCounts, slackThreads } from '@shared/workspace/inboxOutside';
import { isToHuman, newestAt, agentOf } from '@shared/workspace/inboxMessages';
import {
  agentSectionKey,
  formatInboxSection,
  parseInboxSection,
  type InboxSection
} from '@shared/workspace/inboxSection';
import { InboxList } from '../inbox/InboxList';
import { AgentSection, AskMeSection, EveryoneSection } from '../inbox/sections';
import { OutsideSection } from '../inbox/outside';
import { markInboxRead, useInboxMail } from '../inbox/mailStore';
import { useOutside } from '../inbox/outsideStore';
import { useAgentRows, useGodId, useNameOf, useWaitingOnYou } from '../inbox/model';
import '../inbox/inbox.css';

export interface InboxScreenProps extends WorkspaceScreenProps {
  /** Which section is open (route param). */
  section?: string;
}

const EMPTY_QUEUE: QueuedMessage[] = [];

export function InboxScreen({ config, section }: InboxScreenProps) {
  const { t } = useTranslation();
  const navigate = useWorkspace((s) => s.navigate);
  const current = useMemo(() => parseInboxSection(section), [section]);
  const go = useCallback((s: InboxSection) => navigate({ kind: 'inbox', section: formatInboxSection(s) }), [navigate]);

  const mail = useInboxMail();
  const outside = useOutside();
  const { tasks } = useHiveTasks();
  const waiting = useWaitingOnYou();
  const rows = useAgentRows(waiting.items);
  const nameOf = useNameOf();
  const godId = useGodId();
  const godQueue = useStore((s) => s.messageQueues[godId ?? 'god'] ?? EMPTY_QUEUE);

  const held = useMemo(() => heldCounts(outside.entries), [outside.entries]);
  const showOrg = useMemo(() => outside.entries.some((e) => e.source === 'org'), [outside.entries]);
  const slackOpen = useMemo(() => slackThreads({ tasks }, godQueue).filter((th) => th.open).length, [tasks, godQueue]);
  const unread = rows.reduce((n, r) => n + (r.summary?.unread ?? 0), 0);

  const markAllRead = useCallback(() => {
    const entries = rows
      .filter((r) => (r.summary?.unread ?? 0) > 0)
      .map((r) => ({
        key: agentSectionKey(r.agentId),
        at: newestAt(mail.messages.filter((m) => isToHuman(m) && agentOf(m, godId) === r.agentId)) ?? new Date().toISOString()
      }));
    if (entries.length) markInboxRead(entries);
  }, [rows, mail.messages, godId]);

  const subtitle = [
    waiting.items.length ? t('wsInbox.header.waiting', { count: waiting.items.length }) : t('wsInbox.header.nothingWaiting'),
    unread ? t('wsInbox.header.unread', { count: unread }) : '',
    held.webhook + held.org ? t('wsInbox.header.held', { count: held.webhook + held.org }) : ''
  ].filter(Boolean).join(' · ');

  return (
    <Screen fill header={<ScreenHeader title={t('wsInbox.title')} subtitle={subtitle} />}>
      <div className="cth-ws-inbox">
        <InboxList
          section={current}
          onSelect={go}
          waiting={waiting.items}
          rows={rows}
          nameOf={nameOf}
          everyoneCount={mail.total}
          held={held}
          slackOpen={slackOpen}
          showOrg={showOrg || (current.kind === 'outside' && current.tab === 'org')}
          onMarkAllRead={unread ? markAllRead : undefined}
        />
        <div className="cth-ws-inbox-pane">
          <div className="cth-ws-inbox-pane-inner" key={formatInboxSection(current)}>
            {current.kind === 'askme' && (
              <AskMeSection waiting={waiting.items} tasks={waiting.tasks} loaded={waiting.loaded} nameOf={nameOf} marks={mail.marks} />
            )}
            {current.kind === 'agent' && (
              <AgentSection
                agentId={current.agentId}
                mail={mail}
                waiting={waiting.items}
                tasks={waiting.tasks}
                nameOf={nameOf}
                godId={godId}
              />
            )}
            {current.kind === 'everyone' && <EveryoneSection mail={mail} nameOf={nameOf} />}
            {current.kind === 'outside' && <OutsideSection tab={current.tab} config={config} />}
          </div>
        </div>
      </div>
    </Screen>
  );
}
