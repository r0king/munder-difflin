/**
 * The Inbox's left list: FOR YOU (Ask me, then a row per agent), EVERYONE
 * (all routed messages), OUTSIDE (webhooks, Slack, other offices).
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { useAgentPresence } from '../agentStatus';
import { useAskedYou } from '../useHiveTasks';
import { Button, StatusDot, WsIcon, type WsIconName } from '../ui';
import type { AgentRow, NameOf } from '@shared/workspace/inboxMessages';
import { sameSection, type InboxSection } from '@shared/workspace/inboxSection';
import type { WaitingItem } from './model';

function Row({ current, onSelect, icon, title, sub, subWarn, strong, count, countTone, ariaLabel }: {
  current: boolean;
  onSelect: () => void;
  icon: ReactNode;
  title: string;
  sub?: string;
  subWarn?: boolean;
  strong?: boolean;
  count?: number;
  countTone?: 'warn' | 'unread' | 'quiet';
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      className="cth-ws-inbox-row"
      aria-current={current ? 'page' : undefined}
      aria-label={ariaLabel}
      onClick={onSelect}
    >
      <span className="cth-ws-inbox-row-icon">{icon}</span>
      <span className="cth-ws-inbox-row-text">
        <span className={strong ? 'cth-ws-inbox-row-title cth-ws-inbox-row-title--strong' : 'cth-ws-inbox-row-title'}>{title}</span>
        {sub && <span className={subWarn ? 'cth-ws-inbox-row-sub cth-ws-inbox-row-sub--warn' : 'cth-ws-inbox-row-sub'}>{sub}</span>}
      </span>
      {!!count && (
        <span className="cth-ws-inbox-row-meta">
          <span className={
            countTone === 'warn' ? 'cth-ws-inbox-count cth-ws-inbox-count--warn'
              : countTone === 'unread' ? 'cth-ws-inbox-count cth-ws-inbox-count--unread'
                : 'cth-ws-inbox-count'
          }>{count}</span>
        </span>
      )}
    </button>
  );
}

function Icon({ name }: { name: WsIconName }) {
  return <WsIcon name={name} />;
}

/** One agent's row: live status dot, name, and what is new or waiting. */
function AgentListRow({ row, current, onSelect, nameOf, waiting, askedYou }: {
  row: AgentRow;
  current: boolean;
  onSelect: () => void;
  nameOf: NameOf;
  waiting: WaitingItem[];
  askedYou: boolean;
}) {
  const { t } = useTranslation();
  const agent = useStore((s) => s.agents.find((a) => a.id === row.agentId));
  const presence = useAgentPresence(agent, askedYou);
  const name = nameOf(row.agentId);
  const unread = row.summary?.unread ?? 0;
  const replies = row.summary?.needsReply ?? 0;
  const firstAsk = waiting.find((w) => w.kind === 'ask' && w.agentId === row.agentId);

  let sub: string;
  if (firstAsk && firstAsk.kind === 'ask') sub = t('wsInbox.list.asksYou', { title: firstAsk.task.title });
  else if (replies > 0) sub = t('wsInbox.list.needsReply', { count: replies });
  else if (row.summary?.latest) {
    const latest = row.summary.latest;
    const text = latest.subject.trim() || latest.body.trim().split('\n')[0] || '';
    sub = latest.from === 'human' ? t('wsInbox.list.youWrote', { text }) : text;
  } else sub = t('wsInbox.list.nothingYet');

  const needs = row.asks + replies;
  return (
    <Row
      current={current}
      onSelect={onSelect}
      icon={<StatusDot status={presence.status} />}
      title={name}
      strong={unread > 0 || needs > 0}
      sub={sub}
      subWarn={needs > 0}
      count={needs || unread}
      countTone={needs ? 'warn' : 'unread'}
      ariaLabel={[
        name,
        presence.label,
        needs ? t('wsInbox.list.waitingAria', { count: needs }) : '',
        unread ? t('wsInbox.list.unreadAria', { count: unread }) : ''
      ].filter(Boolean).join(', ')}
    />
  );
}

export function InboxList({ section, onSelect, waiting, rows, nameOf, everyoneCount, held, slackOpen, showOrg, onMarkAllRead }: {
  section: InboxSection;
  onSelect: (s: InboxSection) => void;
  waiting: WaitingItem[];
  rows: AgentRow[];
  nameOf: NameOf;
  everyoneCount: number;
  held: { webhook: number; org: number };
  slackOpen: number;
  showOrg: boolean;
  /** Present when any row has unread mail. */
  onMarkAllRead?: () => void;
}) {
  const { t } = useTranslation();
  const askedYou = useAskedYou();
  const is = (s: InboxSection) => sameSection(section, s);
  return (
    <nav className="cth-ws-inbox-list" aria-label={t('wsInbox.list.aria')}>
      <div className="cth-ws-inbox-group">
        <span className="cth-ws-inbox-group-label">{t('wsInbox.list.forYou')}</span>
        {onMarkAllRead && (
          <Button variant="ghost" size="sm" onClick={onMarkAllRead} title={t('wsInbox.list.markAllReadTitle')}>
            {t('wsInbox.list.markAllRead')}
          </Button>
        )}
      </div>
      <Row
        current={is({ kind: 'askme' })}
        onSelect={() => onSelect({ kind: 'askme' })}
        icon={<Icon name="bell" />}
        title={t('wsInbox.askme.title')}
        sub={t('wsInbox.askme.sub')}
        strong={waiting.length > 0}
        count={waiting.length}
        countTone="warn"
      />
      {rows.map((row) => (
        <AgentListRow
          key={row.agentId}
          row={row}
          current={is({ kind: 'agent', agentId: row.agentId })}
          onSelect={() => onSelect({ kind: 'agent', agentId: row.agentId })}
          nameOf={nameOf}
          waiting={waiting}
          askedYou={askedYou.has(row.agentId)}
        />
      ))}

      <div className="cth-ws-inbox-group"><span className="cth-ws-inbox-group-label">{t('wsInbox.list.everyone')}</span></div>
      <Row
        current={is({ kind: 'everyone' })}
        onSelect={() => onSelect({ kind: 'everyone' })}
        icon={<Icon name="agents" />}
        title={t('wsInbox.everyone.title')}
        sub={t('wsInbox.everyone.sub')}
        count={everyoneCount}
        countTone="quiet"
      />

      <div className="cth-ws-inbox-group"><span className="cth-ws-inbox-group-label">{t('wsInbox.list.outside')}</span></div>
      <Row
        current={is({ kind: 'outside', tab: 'webhook' })}
        onSelect={() => onSelect({ kind: 'outside', tab: 'webhook' })}
        icon={<Icon name="automations" />}
        title={t('wsInbox.outside.webhooks')}
        sub={held.webhook ? t('wsInbox.outside.heldSub', { count: held.webhook }) : t('wsInbox.outside.webhooksSub')}
        subWarn={held.webhook > 0}
        strong={held.webhook > 0}
        count={held.webhook}
        countTone="warn"
      />
      <Row
        current={is({ kind: 'outside', tab: 'slack' })}
        onSelect={() => onSelect({ kind: 'outside', tab: 'slack' })}
        icon={<Icon name="inbox" />}
        title={t('wsInbox.outside.slack')}
        sub={slackOpen ? t('wsInbox.outside.slackOpenSub', { count: slackOpen }) : t('wsInbox.outside.slackSub')}
        count={slackOpen}
        countTone="quiet"
      />
      {showOrg && (
        <Row
          current={is({ kind: 'outside', tab: 'org' })}
          onSelect={() => onSelect({ kind: 'outside', tab: 'org' })}
          icon={<Icon name="orchestrator" />}
          title={t('wsInbox.outside.org')}
          sub={held.org ? t('wsInbox.outside.heldSub', { count: held.org }) : t('wsInbox.outside.orgSub')}
          subWarn={held.org > 0}
          strong={held.org > 0}
          count={held.org}
          countTone="warn"
        />
      )}
    </nav>
  );
}
