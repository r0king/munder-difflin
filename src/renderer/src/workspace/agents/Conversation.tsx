/**
 * The room's conversation pane: your sends and steers, what was typed into its
 * terminal, its replies, its mail to and from the floor, and the ASK ME
 * questions on its cards with your answers — in time order (see
 * useConversation / agentsConversation.ts for where each comes from).
 *
 * Agent-written text renders through the app's safe markdown renderer
 * (MarkdownPreview: no raw HTML, links open outside the app). Long messages
 * fold; a turn's working notes fold under its final reply. The pane sticks to
 * the bottom while you are at the bottom, and stays put when you scrolled up.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type Agent, type QueuedMessage } from '@/store/store';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { comparableText, lastItemKey, type ConversationItem } from '@shared/workspace/agentsConversation';
import { Button, Chip, EmptyState, Spinner } from '../ui';
import { useWorkspace } from '../store';
import type { ConversationState } from './useConversation';
import { formatWhen, nameForId } from './format';

const EMPTY_QUEUE: QueuedMessage[] = [];
/** Messages longer than this fold behind "Show more". */
const FOLD_AT = 1400;

export function Conversation({ agent, state, godName }: { agent: Agent; state: ConversationState; godName: string }) {
  const { t, i18n } = useTranslation();
  const agents = useStore((s) => s.agents);
  const archived = useStore((s) => s.archivedAgents);
  const queue = useStore((s) => s.messageQueues[agent.id]) ?? EMPTY_QUEUE;
  const everyone = useMemo(() => [...agents, ...archived], [agents, archived]);
  const queuedTexts = useMemo(() => new Set(queue.map((m) => comparableText(m.text))), [queue]);
  const thread = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const lastKey = lastItemKey(state.items);

  useLayoutEffect(() => {
    const el = thread.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lastKey, state.loaded]);

  const name = (id: string | undefined): string => (id ? nameForId(t, id, everyone, godName) : '');

  if (!state.loaded) {
    return (
      <div className="cth-ws-agents-thread">
        <EmptyState compact icon={<Spinner label={t('wsAgents.room.loading')} />} title={t('wsAgents.room.loading')} />
      </div>
    );
  }

  return (
    <div
      ref={thread}
      className="cth-ws-agents-thread"
      role="log"
      aria-live="polite"
      aria-label={t('wsAgents.room.conversationAria', { name: agent.name })}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {state.error && <div className="cth-ws-agents-notice" role="status">{t('wsAgents.room.readFailed')}</div>}
      {state.transcriptMissing === 'engine' && (
        <div className="cth-ws-agents-notice">{t('wsAgents.room.noTranscriptEngine', { name: agent.name })}</div>
      )}
      {state.transcriptMissing === 'none' && agent.ptyId && (
        <div className="cth-ws-agents-notice">{t('wsAgents.room.noTranscriptYet', { name: agent.name })}</div>
      )}
      {state.items.length === 0 ? (
        <EmptyState compact title={t('wsAgents.room.emptyTitle')} body={t('wsAgents.room.emptyBody', { name: agent.name })} />
      ) : (
        state.items.map((item) => (
          <ConversationRow
            key={item.id}
            item={item}
            agent={agent}
            name={name}
            when={formatWhen(item.ts, i18n.language)}
            queued={(item.kind === 'send' || item.kind === 'steer') && !item.delivered && queuedTexts.has(comparableText(item.text))}
          />
        ))
      )}
    </div>
  );
}

function ConversationRow({ item, agent, name, when, queued }: {
  item: ConversationItem;
  agent: Agent;
  name: (id: string | undefined) => string;
  when: string;
  queued: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useWorkspace((s) => s.navigate);
  const [unfolded, setUnfolded] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  if (item.kind === 'event') {
    const label = item.event === 'compact' ? t('wsAgents.room.eventCompact')
      : item.event === 'interrupt' ? t('wsAgents.room.eventInterrupt')
        : t('wsAgents.room.eventCommand', { command: item.text });
    return <div className="cth-ws-agents-event">{label}{when ? ` · ${when}` : ''}</div>;
  }

  const long = item.text.length > FOLD_AT;
  const clamped = long && !unfolded;

  let who: string;
  const chips: Array<{ tone: 'neutral' | 'info' | 'warn' | 'danger' | 'ok' | 'accent'; label: string; title?: string }> = [];
  switch (item.kind) {
    case 'send':
      who = t('wsAgents.room.you');
      chips.push(item.delivered
        ? { tone: 'ok', label: t('wsAgents.room.delivered') }
        : queued
          ? { tone: 'warn', label: t('wsAgents.room.queued'), title: t('wsAgents.room.queuedTip', { name: agent.name }) }
          : { tone: 'neutral', label: t('wsAgents.room.sent') });
      break;
    case 'steer':
      who = t('wsAgents.room.you');
      chips.push({ tone: 'accent', label: t('wsAgents.room.steer'), title: t('wsAgents.room.steerTip') });
      if (item.delivered) chips.push({ tone: 'ok', label: t('wsAgents.room.delivered') });
      else if (queued) chips.push({ tone: 'warn', label: t('wsAgents.room.queued') });
      break;
    case 'prompt':
      who = item.byYou ? t('wsAgents.room.you') : t('wsAgents.room.floor');
      chips.push({ tone: 'neutral', label: t('wsAgents.room.inTerminal'), title: item.byYou ? t('wsAgents.room.typedTip') : t('wsAgents.room.floorTip') });
      break;
    case 'reply':
      who = agent.name;
      break;
    case 'mail': {
      who = name(item.from);
      chips.push({ tone: 'info', label: t('wsAgents.room.mailTo', { name: name(item.to) }) });
      if (item.act) chips.push({ tone: 'neutral', label: item.act });
      if (item.requiresReply) chips.push({ tone: 'warn', label: t('wsAgents.room.needsReply') });
      break;
    }
    case 'ask':
      who = agent.name;
      chips.push(item.open
        ? { tone: 'danger', label: t('wsAgents.room.askOpen') }
        : { tone: 'neutral', label: t('wsAgents.room.askClosed') });
      break;
    case 'answer':
      who = t('wsAgents.room.you');
      chips.push({ tone: 'ok', label: t('wsAgents.room.answer') });
      break;
    default:
      who = '';
  }

  // Your own words are shown as you typed them; everything an agent (or the
  // floor) wrote is markdown and goes through the safe renderer.
  const plain = item.author === 'you' && (item.kind === 'send' || item.kind === 'steer' || item.kind === 'prompt');

  return (
    <div
      className="cth-ws-agents-msg"
      data-author={item.author}
      data-kind={item.kind}
      data-open={item.kind === 'ask' && item.open ? 'true' : undefined}
    >
      <div className="cth-ws-agents-msg-head">
        <span className="cth-ws-agents-msg-who">{who}</span>
        {chips.map((c, i) => <Chip key={i} tone={c.tone} title={c.title}>{c.label}</Chip>)}
        {(item.kind === 'ask' || item.kind === 'answer') && item.taskId && (
          <span className="cth-ws-ellipsis" title={item.taskTitle}>{item.taskId} · {item.taskTitle}</span>
        )}
        <span className="cth-ws-agents-msg-time">{when}</span>
      </div>
      {item.kind === 'mail' && item.subject && (
        <div className="cth-ws-agents-msg-subject" dir="auto">{item.subject}</div>
      )}
      {item.notes && item.notes.length > 0 && (
        <>
          <button type="button" className="cth-ws-agents-link" onClick={() => setNotesOpen((o) => !o)} aria-expanded={notesOpen}>
            {notesOpen ? t('wsAgents.room.hideNotes') : t('wsAgents.room.showNotes', { count: item.notes.length })}
          </button>
          {notesOpen && (
            <div className="cth-ws-agents-notes">
              {item.notes.map((n, i) => <MarkdownPreview key={i} source={n} variant="card" />)}
            </div>
          )}
        </>
      )}
      <div className="cth-ws-agents-msg-body" data-clamped={clamped ? 'true' : undefined}>
        {plain
          ? <pre className="cth-ws-agents-plain" dir="auto">{item.text}</pre>
          : <MarkdownPreview source={item.text} variant="card" />}
      </div>
      {long && (
        <button type="button" className="cth-ws-agents-link" onClick={() => setUnfolded((u) => !u)} aria-expanded={unfolded}>
          {unfolded ? t('wsAgents.room.showLess') : t('wsAgents.room.showMore')}
        </button>
      )}
      {item.kind === 'ask' && item.open && (
        <div>
          <Button size="sm" variant="primary" onClick={() => navigate({ kind: 'inbox', section: 'askme' })}>
            {t('wsAgents.room.answerInInbox')}
          </Button>
        </div>
      )}
    </div>
  );
}
