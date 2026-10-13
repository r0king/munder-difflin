/**
 * The two things that wait on you, as cards: an open question on a task card
 * (Ask me), and a request an agent addressed to you ("→ You · needs a reply").
 * Both answer inline, both are drawn by the Inbox screen and the bell.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { useRtl } from '@/i18n/useDirection';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { extractOptions } from '@shared/workspace/inboxOptions';
import { countBlockedBehind } from '@shared/workspace/inboxAsk';
import { isUnread, type InboxMessage, type NameOf } from '@shared/workspace/inboxMessages';
import { Button, Card, Chip, EmptyState, Spinner } from '../ui';
import { answerAsk, dismissAsk, replyTo } from './actions';
import { useReplyDrafts, type WaitingItem } from './model';
import { ActChip, MessageBody, ReplyBox, Route, TimeText } from './parts';
import type { HiveTask } from '../useHiveTasks';

// ─── An open question on a card ─────────────────────────────────────────────

export function AskItemCard({ item, tasks, nameOf, compact }: {
  item: Extract<WaitingItem, { kind: 'ask' }>;
  tasks: HiveTask[];
  nameOf: NameOf;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const draft = useStore((s) => s.answerDrafts[item.task.id] ?? '');
  const setDraft = useStore((s) => s.setAnswerDraft);
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const [error, setError] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const { task, question } = item;
  const options = extractOptions(question.q);
  const blocked = countBlockedBehind(task.id, tasks);

  const send = async (text: string): Promise<boolean> => {
    setError(null);
    const res = await answerAsk(task, question.q, text);
    if (res.ok) { setDraft(task.id, ''); return true; }
    setError(res.reason === 'changed' ? t('wsInbox.ask.changed') : t('wsInbox.ask.failed'));
    return false;
  };

  const dismiss = async (): Promise<void> => {
    setError(null);
    setDismissing(true);
    const res = await dismissAsk(task, question.q);
    setDismissing(false);
    if (!res.ok) setError(res.reason === 'changed' ? t('wsInbox.ask.changed') : t('wsInbox.ask.failed'));
  };

  return (
    <Card className="cth-ws-inbox-item cth-ws-inbox-item--needs">
      <div className="cth-ws-inbox-meta">
        <Chip tone="warn">{t('wsInbox.ask.chip')}</Chip>
        <span className="cth-ws-inbox-meta-who">{nameOf(item.agentId)}</span>
        <TimeText ms={item.at} className="cth-ws-inbox-meta-time" />
      </div>
      <h3 className="cth-ws-inbox-subject">
        <button
          type="button"
          className="cth-ws-inbox-linkbtn"
          title={t('wsInbox.ask.openCard')}
          onClick={() => openTaskDetail(task.id)}
        >
          {task.title}
        </button>
      </h3>
      <div className="cth-ws-inbox-body" dir={rtl ? 'auto' : undefined}>
        <MarkdownPreview source={question.q} variant="card" />
      </div>
      {blocked > 0 && !compact && (
        <div className="cth-ws-inbox-cascade">{t('wsInbox.ask.blocking', { count: blocked })}</div>
      )}
      <ReplyBox
        value={draft}
        onChange={(v) => setDraft(task.id, v)}
        onSend={send}
        options={options}
        placeholder={t('wsInbox.ask.placeholder')}
        ariaLabel={t('wsInbox.ask.answerAria', { title: task.title })}
        sendLabel={t('wsInbox.ask.answer')}
        error={error}
        extra={
          <Button variant="ghost" size="sm" disabled={dismissing} title={t('wsInbox.ask.dismissTitle')} onClick={() => { void dismiss(); }}>
            {t('wsInbox.ask.dismiss')}
          </Button>
        }
      />
    </Card>
  );
}

// ─── A message ──────────────────────────────────────────────────────────────

/**
 * One message. `needsReply` draws the "→ You · needs a reply" state and its
 * reply box; otherwise a Reply link opens one on demand (`canReply`).
 */
export function MessageItemCard({ message, nameOf, needsReply, unread, canReply = true }: {
  message: InboxMessage;
  nameOf: NameOf;
  needsReply: boolean;
  unread?: boolean;
  canReply?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Card className={needsReply ? 'cth-ws-inbox-item cth-ws-inbox-item--needs' : 'cth-ws-inbox-item'}>
      <div className="cth-ws-inbox-meta">
        {unread && <span className="cth-ws-inbox-unread" role="img" aria-label={t('wsInbox.message.unread')} />}
        <Route from={message.from} to={message.to} nameOf={nameOf} />
        <ActChip act={message.act} />
        {needsReply && <Chip tone="warn">{t('wsInbox.message.needsReply')}</Chip>}
        <TimeText ms={Date.parse(message.createdAt)} className="cth-ws-inbox-meta-time" />
      </div>
      {message.subject.trim() && <h3 className="cth-ws-inbox-subject">{message.subject}</h3>}
      <MessageBody message={message} />
      {needsReply || open ? (
        <MessageReply message={message} nameOf={nameOf} autoFocus={open} onDone={() => setOpen(false)} />
      ) : canReply ? (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
            {t('wsInbox.message.replyTo', { name: nameOf(message.from) })}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/** The reply box for one message: quick replies from its body, the existing
 *  thread-reply path (`hiveSend` as the human, same conversation). */
export function MessageReply({ message, nameOf, autoFocus, onDone }: {
  message: InboxMessage;
  nameOf: NameOf;
  autoFocus?: boolean;
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const draft = useReplyDrafts((s) => s.drafts[message.id] ?? '');
  const setDraft = useReplyDrafts((s) => s.set);
  const [error, setError] = useState<string | null>(null);
  const options = extractOptions(`${message.subject}\n${message.body}`);
  const name = nameOf(message.from);

  const send = async (text: string): Promise<boolean> => {
    setError(null);
    const ok = await replyTo(message, text);
    if (!ok) { setError(t('wsInbox.message.replyFailed')); return false; }
    setDraft(message.id, '');
    onDone?.();
    return true;
  };

  return (
    <ReplyBox
      value={draft}
      onChange={(v) => setDraft(message.id, v)}
      onSend={send}
      options={options}
      autoFocus={autoFocus}
      placeholder={t('wsInbox.message.replyPlaceholder', { name })}
      ariaLabel={t('wsInbox.message.replyTo', { name })}
      sendLabel={t('wsInbox.message.reply')}
      error={error}
    />
  );
}

// ─── The waiting list ───────────────────────────────────────────────────────

/** Every item waiting on you, newest first — the Ask me section's body and
 *  the bell's. */
export function WaitingList({ items, tasks, nameOf, loaded, compact, marks }: {
  items: WaitingItem[];
  tasks: HiveTask[];
  nameOf: NameOf;
  loaded: boolean;
  compact?: boolean;
  /** Read watermark per agent row, to dot unread requests. */
  marks?: (agentId: string) => number;
}) {
  const { t } = useTranslation();
  if (!items.length) {
    if (!loaded) {
      return <EmptyState compact icon={<Spinner label={t('wsInbox.loading')} />} title={t('wsInbox.loading')} />;
    }
    return <EmptyState compact title={t('wsInbox.ask.emptyTitle')} body={t('wsInbox.ask.emptyBody')} />;
  }
  return (
    <>
      {items.map((item) =>
        item.kind === 'ask' ? (
          <AskItemCard key={item.key} item={item} tasks={tasks} nameOf={nameOf} compact={compact} />
        ) : (
          <MessageItemCard
            key={item.key}
            message={item.message}
            nameOf={nameOf}
            needsReply
            unread={marks ? isUnread(item.message, marks(item.agentId)) : false}
          />
        )
      )}
    </>
  );
}
