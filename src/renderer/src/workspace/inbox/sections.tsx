/**
 * The Inbox's right pane for FOR YOU and EVERYONE: Ask me, one agent's
 * messages to and about you, and every routed message on the floor.
 */
import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { useWorkspace } from '../store';
import { useAgentPresence } from '../agentStatus';
import { useAskedYou, type HiveTask } from '../useHiveTasks';
import {
  HUMAN,
  SYSTEM,
  agentOf,
  groupThreads,
  isFromHuman,
  isToHuman,
  isUnread,
  newestAt,
  pendingReplyIds,
  searchMessages,
  watermark,
  type InboxMessage,
  type InboxThread,
  type NameOf,
  type ReadMarks
} from '@shared/workspace/inboxMessages';
import { agentSectionKey } from '@shared/workspace/inboxSection';
import { Button, Card, Chip, EmptyState, SearchInput, Spinner, StatusDot } from '../ui';
import { markInboxRead, type MailSnapshot } from './mailStore';
import { AskItemCard, MessageReply, WaitingList } from './items';
import { ActChip, MessageBody, Route, TimeText } from './parts';
import type { WaitingItem } from './model';

export function Head({ title, sub, actions, leading }: { title: string; sub?: string; actions?: ReactNode; leading?: ReactNode }) {
  return (
    <div className="cth-ws-inbox-head">
      <div className="cth-ws-inbox-head-text">
        <h2 className="cth-ws-inbox-head-title">{leading}{title}</h2>
        {sub && <span className="cth-ws-inbox-head-sub">{sub}</span>}
      </div>
      {actions && <div className="cth-ws-inbox-head-actions">{actions}</div>}
    </div>
  );
}

export function MailState({ mail }: { mail: MailSnapshot }) {
  const { t } = useTranslation();
  if (!mail.hive) return <div className="cth-ws-inbox-banner">{t('wsInbox.noHive')}</div>;
  if (mail.error) return <div className="cth-ws-inbox-banner cth-ws-inbox-banner--danger">{t('wsInbox.readFailed')}</div>;
  return null;
}

// ─── Ask me ─────────────────────────────────────────────────────────────────

export function AskMeSection({ waiting, tasks, loaded, nameOf, marks }: {
  waiting: WaitingItem[];
  tasks: HiveTask[];
  loaded: boolean;
  nameOf: NameOf;
  marks: ReadMarks;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Head
        title={t('wsInbox.askme.title')}
        sub={waiting.length ? t('wsInbox.askme.count', { count: waiting.length }) : t('wsInbox.askme.sub')}
      />
      <WaitingList
        items={waiting}
        tasks={tasks}
        nameOf={nameOf}
        loaded={loaded}
        marks={(agentId) => watermark(marks, agentSectionKey(agentId))}
      />
    </>
  );
}

// ─── One agent ──────────────────────────────────────────────────────────────

/** How long a section must be on screen before its mail counts as read — a
 *  click through the list on the way somewhere else does not. */
const READ_DWELL_MS = 800;

function ThreadCard({ thread, nameOf, pending, mark }: {
  thread: InboxThread;
  nameOf: NameOf;
  pending: Set<string>;
  mark: number;
}) {
  const { t } = useTranslation();
  const [replyOpen, setReplyOpen] = useState(false);
  const waitingOn = [...thread.messages].reverse().find((m) => pending.has(m.id)) ?? null;
  // A reply answers the request still waiting on you, else the agent's latest
  // message in the thread. A thread of only your own messages has no one to
  // reply to (its addressee answers in it).
  const replyTarget = waitingOn
    ?? [...thread.messages].reverse().find((m) => !isFromHuman(m) && m.from !== SYSTEM)
    ?? null;
  return (
    <Card className={waitingOn ? 'cth-ws-inbox-item cth-ws-inbox-item--needs' : 'cth-ws-inbox-item'}>
      {thread.subject.trim() && <h3 className="cth-ws-inbox-subject">{thread.subject}</h3>}
      <div className="cth-ws-inbox-thread">
        {thread.messages.map((m) => (
          <div key={m.id} className={isFromHuman(m) ? 'cth-ws-inbox-thread-msg cth-ws-inbox-thread-msg--you' : 'cth-ws-inbox-thread-msg'}>
            <div className="cth-ws-inbox-meta">
              {isUnread(m, mark) && <span className="cth-ws-inbox-unread" role="img" aria-label={t('wsInbox.message.unread')} />}
              <Route from={m.from} to={m.to} nameOf={nameOf} />
              <ActChip act={m.act} />
              {pending.has(m.id) && <Chip tone="warn">{t('wsInbox.message.needsReply')}</Chip>}
              {!pending.has(m.id) && m.needsHuman && m.to !== HUMAN && <Chip tone="accent">{t('wsInbox.message.aboutYou')}</Chip>}
              <TimeText ms={Date.parse(m.createdAt)} className="cth-ws-inbox-meta-time" />
            </div>
            {m.subject.trim() && m.subject !== thread.subject && <div className="cth-ws-inbox-subject">{m.subject}</div>}
            <MessageBody message={m} />
          </div>
        ))}
      </div>
      {replyTarget && (waitingOn || replyOpen) ? (
        <MessageReply message={replyTarget} nameOf={nameOf} autoFocus={replyOpen} onDone={() => setReplyOpen(false)} />
      ) : replyTarget ? (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setReplyOpen(true)}>
            {t('wsInbox.message.replyTo', { name: nameOf(replyTarget.from) })}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

export function AgentSection({ agentId, mail, waiting, tasks, nameOf, godId }: {
  agentId: string;
  mail: MailSnapshot;
  waiting: WaitingItem[];
  tasks: HiveTask[];
  nameOf: NameOf;
  godId: string | null;
}) {
  const { t } = useTranslation();
  const navigate = useWorkspace((s) => s.navigate);
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const askedYou = useAskedYou();
  const presence = useAgentPresence(agent, askedYou.has(agentId));
  const name = nameOf(agentId);
  const key = agentSectionKey(agentId);

  const mine = useMemo(
    () => mail.messages.filter((m) => agentOf(m, godId) === agentId),
    [mail.messages, godId, agentId]
  );
  const threads = useMemo(() => groupThreads(mine), [mine]);
  const pending = useMemo(() => pendingReplyIds(mail.messages), [mail.messages]);
  const asks = waiting.filter((w): w is Extract<WaitingItem, { kind: 'ask' }> => w.kind === 'ask' && w.agentId === agentId);
  // The mark as it was when the section opened (or when the mail first
  // landed), so what was new stays dotted while you read it rather than
  // vanishing under the cursor. Until it is known nothing reads as unread.
  const [mark, setMark] = useState<number | null>(() => (mail.loaded ? watermark(mail.marks, key) : null));
  useEffect(() => {
    if (mark === null && mail.loaded) setMark(watermark(mail.marks, key));
  }, [mark, mail.loaded, mail.marks, key]);
  const newestToYou = useMemo(() => newestAt(mine.filter(isToHuman)), [mine]);

  useEffect(() => {
    if (!newestToYou) return;
    const timer = setTimeout(() => markInboxRead([{ key, at: newestToYou }]), READ_DWELL_MS);
    return () => clearTimeout(timer);
  }, [key, newestToYou]);

  const openRoom = () => navigate(agent?.isGod ? { kind: 'orchestrator' } : { kind: 'agent', agentId });

  return (
    <>
      <Head
        leading={<StatusDot status={presence.status} />}
        title={name}
        sub={agent ? presence.text : t('wsInbox.agent.notOnFloor')}
        actions={agent && <Button size="sm" onClick={openRoom}>{agent.isGod ? t('wsInbox.agent.openOrchestrator') : t('wsInbox.agent.openRoom')}</Button>}
      />
      <MailState mail={mail} />
      {asks.map((item) => <AskItemCard key={item.key} item={item} tasks={tasks} nameOf={nameOf} />)}
      {!mail.loaded && !threads.length ? (
        <EmptyState compact icon={<Spinner label={t('wsInbox.loading')} />} title={t('wsInbox.loading')} />
      ) : threads.length ? (
        threads.map((th) => (
          <ThreadCard key={th.conversation} thread={th} nameOf={nameOf} pending={pending} mark={mark ?? Number.POSITIVE_INFINITY} />
        ))
      ) : !asks.length ? (
        <EmptyState
          compact
          title={t('wsInbox.agent.emptyTitle', { name })}
          body={t('wsInbox.agent.emptyBody', { name })}
          action={agent && <Button onClick={openRoom}>{agent.isGod ? t('wsInbox.agent.openOrchestrator') : t('wsInbox.agent.openRoom')}</Button>}
        />
      ) : null}
    </>
  );
}

// ─── Everyone ───────────────────────────────────────────────────────────────

const PAGE = 100;
/** The query survives leaving the section and coming back (not a reload). */
let lastQuery = '';

function FeedRow({ m, nameOf }: { m: InboxMessage; nameOf: NameOf }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [replying, setReplying] = useState(false);
  const preview = m.subject.trim() || m.body.trim().split('\n')[0] || t('wsInbox.message.empty');
  const canReply = !isFromHuman(m) && m.from !== SYSTEM;
  return (
    <>
      <button type="button" className="cth-ws-inbox-feed-row" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="cth-ws-inbox-feed-route">
          <Route from={m.from} to={m.to} nameOf={nameOf} />
          <ActChip act={m.act} />
        </span>
        <TimeText ms={Date.parse(m.createdAt)} className="cth-ws-inbox-feed-time" />
        <span className="cth-ws-inbox-feed-subject">{preview}</span>
      </button>
      {open && (
        <div className="cth-ws-inbox-feed-open">
          {m.subject.trim() && <div className="cth-ws-inbox-subject">{m.subject}</div>}
          <MessageBody message={m} />
          {canReply && (replying ? (
            <MessageReply message={m} nameOf={nameOf} autoFocus onDone={() => setReplying(false)} />
          ) : (
            <div>
              <Button variant="ghost" size="sm" onClick={() => setReplying(true)}>
                {t('wsInbox.message.replyTo', { name: nameOf(m.from) })}
              </Button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function EveryoneSection({ mail, nameOf }: { mail: MailSnapshot; nameOf: NameOf }) {
  const { t } = useTranslation();
  const [query, setQueryState] = useState(lastQuery);
  const setQuery = (q: string) => { lastQuery = q; setQueryState(q); };
  const deferred = useDeferredValue(query);
  const [shown, setShown] = useState(PAGE);
  const results = useMemo(() => searchMessages(mail.messages, deferred, nameOf), [mail.messages, deferred, nameOf]);
  const searching = deferred.trim().length > 0;

  useEffect(() => { setShown(PAGE); }, [deferred]);

  return (
    <>
      <Head
        title={t('wsInbox.everyone.title')}
        sub={searching
          ? t('wsInbox.everyone.matches', { count: results.length })
          : t('wsInbox.everyone.count', { count: mail.total })}
      />
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder={t('wsInbox.everyone.searchPlaceholder')}
        ariaLabel={t('wsInbox.everyone.searchAria')}
      />
      <MailState mail={mail} />
      {mail.truncated && !searching && (
        <div className="cth-ws-inbox-banner">{t('wsInbox.everyone.truncated', { shown: mail.messages.length, total: mail.total })}</div>
      )}
      {!mail.loaded ? (
        <EmptyState compact icon={<Spinner label={t('wsInbox.loading')} />} title={t('wsInbox.loading')} />
      ) : !results.length ? (
        searching
          ? <EmptyState compact title={t('wsInbox.everyone.noMatchTitle')} body={t('wsInbox.everyone.noMatchBody')} />
          : <EmptyState compact title={t('wsInbox.everyone.emptyTitle')} body={t('wsInbox.everyone.emptyBody')} />
      ) : (
        <Card padding="none">
          <div className="cth-ws-inbox-feed" role="list">
            {results.slice(0, shown).map((m) => (
              <div role="listitem" key={m.id}><FeedRow m={m} nameOf={nameOf} /></div>
            ))}
          </div>
        </Card>
      )}
      {results.length > shown && (
        <div>
          <Button onClick={() => setShown((n) => n + PAGE)}>
            {t('wsInbox.everyone.showMore', { count: Math.min(PAGE, results.length - shown) })}
          </Button>
        </div>
      )}
    </>
  );
}
