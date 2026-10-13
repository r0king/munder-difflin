/**
 * Messages — his conversation with you and with the floor, and the composer.
 *
 * The thread merges his mailbox (hive:messages, redacted in main, newest 40 —
 * the read layer's own cap) with the prompts you typed into his terminal
 * (history:list). See shared/workspace/orchestratorConversation.ts.
 *
 * The composer is the existing MessageQueueComposer — Send queues the message
 * until he is free, with the queue's reorder / edit / send-now controls. Steer
 * is added beside it through deliverToAgent's 'steer' mode: it takes the same
 * draft (the store keeps drafts per agent) and lands it on his next turn.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type Agent } from '@/store/store';
import { MessageQueueComposer } from '@/components/MessageQueueComposer';
import { deliverToAgent } from '../deliver';
import { Button, Chip, EmptyState, SegmentedControl, Spinner } from '../ui';
import {
  buildConversation,
  filterConversation,
  type ConversationItem,
  type ConversationScope
} from '@shared/workspace/orchestratorConversation';
import { formatDay, formatTime, useParticipantLabel } from './format';

/** The read layer returns at most this many messages per mailbox. */
const MAIL_LIMIT = 40;
const PROMPT_LIMIT = 60;
/** Reading a mailbox parses every message file in it, so the thread refreshes
 *  on routed traffic that involves him, with only a slow backstop poll. */
const BACKSTOP_MS = 60_000;

const ACTS = new Set(['request', 'inform', 'propose', 'query', 'agree', 'refuse', 'done']);

export function MessagesTab({ god }: { god: Agent }) {
  const { t, i18n } = useTranslation();
  const { label } = useParticipantLabel();
  const [items, setItems] = useState<ConversationItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<ConversationScope>('all');

  const load = useCallback(async () => {
    try {
      const [mail, prompts] = await Promise.all([
        window.cth.hiveMessages({ agentId: god.id, limit: MAIL_LIMIT, includeArchived: true }),
        window.cth.historyList(god.id, PROMPT_LIMIT).catch(() => [])
      ]);
      setItems(buildConversation(mail, prompts, god.id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems((prev) => prev ?? []);
    }
  }, [god.id]);

  useEffect(() => {
    void load();
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const off = window.cth.onHiveMessage((e) => {
      const involved = e.from === god.id || e.from === 'god' || e.to === 'god' || e.to === 'human'
        || e.to === god.id || (e.targets ?? []).includes(god.id);
      if (!involved || debounce) return;
      debounce = setTimeout(() => { debounce = null; void load(); }, 800);
    });
    const iv = setInterval(() => { void load(); }, BACKSTOP_MS);
    return () => { off(); clearInterval(iv); if (debounce) clearTimeout(debounce); };
  }, [god.id, load]);

  const shown = useMemo(() => (items ? filterConversation(items, scope) : []), [items, scope]);

  // Stick to the bottom while the reader is there; leave them alone when they
  // have scrolled up to read something older.
  const scroller = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  return (
    <>
      <div className="cth-ws-orch-toolbar">
        <SegmentedControl<ConversationScope>
          size="sm"
          value={scope}
          onChange={setScope}
          ariaLabel={t('wsOrchestrator.messages.scopeAria')}
          options={[
            { value: 'all', label: t('wsOrchestrator.messages.scopeAll') },
            { value: 'you', label: t('wsOrchestrator.messages.scopeYou') },
            { value: 'floor', label: t('wsOrchestrator.messages.scopeFloor') }
          ]}
        />
        <span className="cth-ws-orch-spacer" />
        <span className="cth-ws-orch-muted">{t('wsOrchestrator.messages.windowNote', { n: MAIL_LIMIT })}</span>
      </div>
      <div
        ref={scroller}
        className="cth-ws-orch-thread"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        aria-live="polite"
      >
        {items === null ? (
          <EmptyState fill icon={<Spinner label={t('wsOrchestrator.loading')} />} title={t('wsOrchestrator.loading')} />
        ) : error && items.length === 0 ? (
          <EmptyState fill title={t('wsOrchestrator.messages.error')} body={error} action={<Button onClick={() => { void load(); }}>{t('wsOrchestrator.retry')}</Button>} />
        ) : shown.length === 0 ? (
          <EmptyState
            fill
            title={t('wsOrchestrator.messages.empty')}
            body={t('wsOrchestrator.messages.emptyBody', { godName: god.name })}
          />
        ) : (
          shown.map((item, i) => {
            const prev = shown[i - 1];
            const newDay = !prev || new Date(prev.ts).toDateString() !== new Date(item.ts).toDateString();
            return (
              <div key={item.key} style={{ display: 'contents' }}>
                {newDay && item.ts > 0 && <div className="cth-ws-orch-day">{formatDay(item.ts, i18n.language, t)}</div>}
                <MessageItem item={item} label={label} lang={i18n.language} />
              </div>
            );
          })
        )}
      </div>
      <SteerBar god={god} />
      <MessageQueueComposer agent={god} />
    </>
  );
}

function MessageItem({ item, label, lang }: { item: ConversationItem; label: (id: string) => string; lang: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const fromYou = item.kind === 'prompt' || item.from === 'human';
  const cls = [
    'cth-ws-orch-msg',
    fromYou ? 'cth-ws-orch-msg--you' : item.outgoing ? 'cth-ws-orch-msg--out' : '',
    item.unread ? 'cth-ws-orch-msg--unread' : ''
  ].filter(Boolean).join(' ');
  const long = item.body.length > 480 || item.body.split('\n').length > 6;
  return (
    <article className={cls}>
      <div className="cth-ws-orch-msg-head">
        <span className="cth-ws-orch-msg-who">{label(item.from)}</span>
        {item.kind === 'mail' && (
          <>
            <span aria-hidden="true">→</span>
            <span>{label(item.to)}</span>
          </>
        )}
        {item.kind === 'prompt' && <span>{t('wsOrchestrator.messages.typed')}</span>}
        {item.act && ACTS.has(item.act) && <Chip tone="neutral">{t(`wsOrchestrator.act.${item.act}`)}</Chip>}
        {item.unread && <Chip tone="info">{t('wsOrchestrator.messages.unread')}</Chip>}
        {item.needsReply && <Chip tone="warn">{t('wsOrchestrator.messages.needsReply')}</Chip>}
        {item.ts > 0 && <time dateTime={new Date(item.ts).toISOString()}>{formatTime(item.ts, lang)}</time>}
      </div>
      {item.subject && <div className="cth-ws-orch-msg-subject" dir="auto">{item.subject}</div>}
      {item.body && (
        <pre className={`cth-ws-orch-msg-body${long && !open ? ' cth-ws-orch-msg-body--clamped' : ''}`} dir="auto">{item.body}</pre>
      )}
      {long && (
        <button type="button" className="cth-ws-orch-linkbtn" onClick={() => setOpen((v) => !v)}>
          {open ? t('wsOrchestrator.messages.less') : t('wsOrchestrator.messages.more')}
        </button>
      )}
    </article>
  );
}

/** Steer: the composer's draft, landed on his next turn instead of queued. */
function SteerBar({ god }: { god: Agent }) {
  const { t } = useTranslation();
  const draft = useStore((s) => s.drafts[god.id] ?? '');
  const setDraft = useStore((s) => s.setDraft);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(id);
  }, [note]);
  const steer = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    try {
      const res = await deliverToAgent({ target: { kind: 'orchestrator' }, text, mode: 'steer', source: 'orchestrator-screen' });
      if (res.ok) {
        setDraft(god.id, '');
        setNote({ ok: true, text: t('wsOrchestrator.messages.steered', { godName: god.name }) });
      } else {
        setNote({ ok: false, text: t('wsOrchestrator.messages.steerFailed', { error: res.error ?? '' }) });
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cth-ws-orch-steer">
      <span className={note && !note.ok ? 'cth-ws-orch-error' : 'cth-ws-orch-steer-hint'}>
        {note ? note.text : t('wsOrchestrator.messages.steerHint', { godName: god.name })}
      </span>
      <Button size="sm" variant="secondary" disabled={busy || !draft.trim()} onClick={() => { void steer(); }}
        title={t('wsOrchestrator.messages.steerTip')}>
        {t('wsOrchestrator.messages.steer')}
      </Button>
    </div>
  );
}
