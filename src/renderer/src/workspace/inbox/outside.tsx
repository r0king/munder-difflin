/**
 * OUTSIDE — what came in from beyond the floor: webhooks and peer offices
 * (the trigger-history ledger, with Approve / Reject on anything held), and
 * Slack threads (read off the task ledger and the orchestrator's queue; Slack
 * has no hold — see shared/workspace/inboxOutside.ts).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type QueuedMessage } from '@/store/store';
import type { HarnessConfig } from '@/store/config';
import { useRtl } from '@/i18n/useDirection';
import type { TriggerHistoryEntry } from '@shared/triggers';
import {
  buildExchanges,
  filterExchanges,
  slackThreads,
  type Exchange,
  type ExchangeFilter,
  type SlackItemState,
  type SlackThread
} from '@shared/workspace/inboxOutside';
import type { OutsideTab } from '@shared/workspace/inboxSection';
import { useWorkspace } from '../store';
import { useHiveTasks } from '../useHiveTasks';
import { Button, Card, Chip, EmptyState, SegmentedControl, Spinner, type ChipTone } from '../ui';
import { decideHeld, useOutside } from './outsideStore';
import { TimeText } from './parts';
import { Head } from './sections';

const EMPTY_QUEUE: QueuedMessage[] = [];

// ─── Plain bodies ───────────────────────────────────────────────────────────

const CLAMP = 600;

/** An outside body is someone else's text (often JSON): shown as plain text,
 *  never as markdown, clamped at rest. */
function PlainBody({ text }: { text: string }) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const [open, setOpen] = useState(false);
  const body = text ?? '';
  if (!body.trim()) return <div className="cth-ws-inbox-plain cth-ws-muted">{t('wsInbox.message.empty')}</div>;
  const long = body.length > CLAMP || body.split('\n').length > 10;
  const shown = long && !open ? `${body.slice(0, CLAMP).split('\n').slice(0, 10).join('\n').trimEnd()}…` : body;
  return (
    <>
      <div className="cth-ws-inbox-plain" dir={rtl ? 'auto' : undefined}>{shown}</div>
      {long && (
        <button type="button" className="cth-ws-inbox-more" onClick={() => setOpen((v) => !v)}>
          {open ? t('wsInbox.message.showLess') : t('wsInbox.message.showAll')}
        </button>
      )}
    </>
  );
}

// ─── Webhooks / other offices ───────────────────────────────────────────────

function DecisionChip({ decision }: { decision: TriggerHistoryEntry['decision'] }) {
  const { t } = useTranslation();
  switch (decision) {
    case 'pending': return <Chip tone="warn">{t('wsInbox.outside.decision.pending')}</Chip>;
    case 'approved': return <Chip tone="ok">{t('wsInbox.outside.decision.approved')}</Chip>;
    case 'rejected': return <Chip tone="danger">{t('wsInbox.outside.decision.rejected')}</Chip>;
    case 'auto-allowed': return <Chip tone="neutral">{t('wsInbox.outside.decision.allowed')}</Chip>;
    default: return null;
  }
}

function ExchangeCard({ ex, busy, onDecide }: {
  ex: Exchange;
  busy: boolean;
  onDecide: (id: string, decision: 'approved' | 'rejected') => void;
}) {
  const { t } = useTranslation();
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const head = ex.head as TriggerHistoryEntry;
  const hasInbound = ex.msgs.some((m) => m.direction === 'inbound');
  const taskId = ex.msgs.find((m) => m.taskId)?.taskId;
  const pending = ex.pending;
  return (
    <Card className={pending ? 'cth-ws-inbox-item cth-ws-inbox-item--needs' : 'cth-ws-inbox-item'}>
      <div className="cth-ws-inbox-meta">
        <span className="cth-ws-inbox-meta-who" title={head.sourceName}>{head.sourceName || t('wsInbox.outside.unnamed')}</span>
        <span className="cth-ws-ellipsis" title={head.peer}>
          {hasInbound ? t('wsInbox.outside.from', { peer: head.peer || t('wsInbox.outside.unknown') }) : t('wsInbox.outside.to', { peer: head.peer || t('wsInbox.outside.unknown') })}
        </span>
        <Chip tone={head.kind === 'directive' ? 'warn' : 'info'}>
          {head.kind === 'directive' ? t('wsInbox.outside.kindDirective') : t('wsInbox.outside.kindMessage')}
        </Chip>
        {head.direction === 'inbound' && <DecisionChip decision={head.decision} />}
        <TimeText ms={ex.latestAt} className="cth-ws-inbox-meta-time" />
      </div>
      {head.title && <h3 className="cth-ws-inbox-subject">{head.title}</h3>}
      {ex.msgs.map((m) => (
        <div key={m.id} className="cth-ws-inbox-item">
          <span className="cth-ws-inbox-exchange-label">
            {m.direction === 'inbound' ? t('wsInbox.outside.theySent') : hasInbound ? t('wsInbox.outside.weReplied') : t('wsInbox.outside.weSent')}
          </span>
          <PlainBody text={m.body} />
        </div>
      ))}
      {pending ? (
        <>
          <div className="cth-ws-inbox-cascade">
            {pending.kind === 'directive' ? t('wsInbox.outside.heldDirective') : t('wsInbox.outside.heldMessage')}
          </div>
          <div className="cth-ws-inbox-actions">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => onDecide(pending.id, 'approved')} title={t('wsInbox.outside.approveTitle')}>
              {busy ? t('wsInbox.reply.sending') : t('wsInbox.outside.approve')}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => onDecide(pending.id, 'rejected')} title={t('wsInbox.outside.rejectTitle')}>
              {t('wsInbox.outside.reject')}
            </Button>
          </div>
        </>
      ) : !ex.answered && head.direction === 'inbound' ? (
        <div className="cth-ws-inbox-cascade cth-ws-muted">
          {head.decision === 'rejected' ? t('wsInbox.outside.tailRejected') : t('wsInbox.outside.tailNoReply')}
        </div>
      ) : null}
      {taskId && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => openTaskDetail(taskId)}>{t('wsInbox.outside.openCard', { id: taskId })}</Button>
        </div>
      )}
    </Card>
  );
}

function LedgerPane({ source }: { source: 'webhook' | 'org' }) {
  const { t } = useTranslation();
  const navigate = useWorkspace((s) => s.navigate);
  const { loaded, entries, error } = useOutside();
  const [filter, setFilter] = useState<ExchangeFilter>('all');
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [decideError, setDecideError] = useState<string | null>(null);
  const all = useMemo(() => buildExchanges(entries.filter((e) => e.source === source)), [entries, source]);
  const list = useMemo(() => filterExchanges(all, filter), [all, filter]);
  const held = all.filter((e) => e.pending).length;

  const decide = (id: string, decision: 'approved' | 'rejected') => {
    setBusy((b) => ({ ...b, [id]: true }));
    setDecideError(null);
    void decideHeld(id, decision).then((outcome) => {
      if (outcome === 'gone') setDecideError(t('wsInbox.outside.decideGone'));
      else if (outcome === 'not-released') setDecideError(t('wsInbox.outside.decideNotReleased'));
      else if (outcome === 'failed') setDecideError(t('wsInbox.outside.decideFailed'));
    }).finally(() => setBusy((b) => { const n = { ...b }; delete n[id]; return n; }));
  };

  return (
    <>
      {all.length > 0 && (
        <SegmentedControl<ExchangeFilter>
          size="sm"
          ariaLabel={t('wsInbox.outside.filterAria')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('wsInbox.outside.filter.all') },
            { value: 'held', label: held ? t('wsInbox.outside.filter.heldCount', { count: held }) : t('wsInbox.outside.filter.held') },
            { value: 'allowed', label: t('wsInbox.outside.filter.allowed') },
            { value: 'rejected', label: t('wsInbox.outside.filter.rejected') }
          ]}
        />
      )}
      {held > 0 && <div className="cth-ws-inbox-banner cth-ws-inbox-banner--warn">{t('wsInbox.outside.heldBanner', { count: held })}</div>}
      {error && <div className="cth-ws-inbox-banner cth-ws-inbox-banner--danger">{t('wsInbox.outside.readFailed')}</div>}
      {decideError && <div className="cth-ws-inbox-banner cth-ws-inbox-banner--danger" role="alert">{decideError}</div>}
      {!loaded ? (
        <EmptyState compact icon={<Spinner label={t('wsInbox.loading')} />} title={t('wsInbox.loading')} />
      ) : !all.length ? (
        source === 'webhook' ? (
          <EmptyState
            compact
            title={t('wsInbox.outside.emptyWebhookTitle')}
            body={t('wsInbox.outside.emptyWebhookBody')}
            action={<Button onClick={() => navigate({ kind: 'automations' })}>{t('wsInbox.outside.openAutomations')}</Button>}
          />
        ) : (
          <EmptyState compact title={t('wsInbox.outside.emptyOrgTitle')} body={t('wsInbox.outside.emptyOrgBody')} />
        )
      ) : !list.length ? (
        <EmptyState compact title={t('wsInbox.outside.emptyFilter')} />
      ) : (
        list.map((ex) => <ExchangeCard key={ex.key} ex={ex} busy={!!(ex.pending && busy[ex.pending.id])} onDecide={decide} />)
      )}
    </>
  );
}

// ─── Slack ──────────────────────────────────────────────────────────────────

const STATE_TONE: Record<SlackItemState, ChipTone> = {
  queued: 'neutral', todo: 'info', doing: 'warn', blocked: 'danger', done: 'ok'
};

function SlackThreadCard({ thread }: { thread: SlackThread }) {
  const { t } = useTranslation();
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  return (
    <Card className="cth-ws-inbox-item">
      <div className="cth-ws-inbox-meta">
        <span className="cth-ws-inbox-meta-who">{t('wsInbox.outside.slackThread', { channel: thread.channel })}</span>
        <Chip tone={thread.open ? 'warn' : 'ok'}>{thread.open ? t('wsInbox.outside.slackOpen') : t('wsInbox.outside.slackDone')}</Chip>
        <TimeText ms={thread.latestAt} className="cth-ws-inbox-meta-time" />
      </div>
      {thread.items.map((item) => (
        <div key={item.id} className="cth-ws-inbox-item">
          <div className="cth-ws-inbox-meta">
            <Chip tone={STATE_TONE[item.state]}>{t(`wsInbox.outside.slackState.${item.state}`)}</Chip>
            <TimeText ms={item.at} />
            {item.isTask && (
              <Button variant="ghost" size="sm" onClick={() => openTaskDetail(item.id)}>{t('wsInbox.outside.openCardShort')}</Button>
            )}
          </div>
          <PlainBody text={item.text} />
          {item.result && (
            <>
              <span className="cth-ws-inbox-exchange-label">{t('wsInbox.outside.postedBack')}</span>
              <PlainBody text={item.result} />
            </>
          )}
        </div>
      ))}
    </Card>
  );
}

function SlackPane({ config }: { config: HarnessConfig }) {
  const { t } = useTranslation();
  const { tasks, loaded } = useHiveTasks();
  const godId = useStore((s) => s.agents.find((a) => a.isGod)?.id ?? 'god');
  const queue = useStore((s) => s.messageQueues[godId] ?? EMPTY_QUEUE);
  const [running, setRunning] = useState<boolean | null>(null);
  const threads = useMemo(() => slackThreads({ tasks }, queue), [tasks, queue]);

  useEffect(() => {
    let alive = true;
    window.cth.slackStatus()
      .then((s) => { if (alive) setRunning(!!s?.running); })
      .catch(() => { if (alive) setRunning(false); });
    return () => { alive = false; };
  }, [config.slackEnabled]);

  const openSettings = () => window.dispatchEvent(new CustomEvent('cth:open-settings', { detail: { section: 'Connections' } }));

  return (
    <>
      {config.slackEnabled && running === false && (
        <div className="cth-ws-inbox-banner cth-ws-inbox-banner--warn">{t('wsInbox.outside.slackStopped')}</div>
      )}
      {!loaded ? (
        <EmptyState compact icon={<Spinner label={t('wsInbox.loading')} />} title={t('wsInbox.loading')} />
      ) : !threads.length ? (
        config.slackEnabled ? (
          <EmptyState compact title={t('wsInbox.outside.slackEmptyTitle')} body={t('wsInbox.outside.slackEmptyBody')} />
        ) : (
          <EmptyState
            compact
            title={t('wsInbox.outside.slackOffTitle')}
            body={t('wsInbox.outside.slackOffBody')}
            action={<Button onClick={openSettings}>{t('wsInbox.outside.slackSetUp')}</Button>}
          />
        )
      ) : (
        threads.map((th) => <SlackThreadCard key={th.key} thread={th} />)
      )}
    </>
  );
}

// ─── The section ────────────────────────────────────────────────────────────

export function OutsideSection({ tab, config }: { tab: OutsideTab; config: HarnessConfig }) {
  const { t } = useTranslation();
  const title = tab === 'webhook' ? t('wsInbox.outside.webhooks') : tab === 'slack' ? t('wsInbox.outside.slack') : t('wsInbox.outside.org');
  const sub = tab === 'webhook' ? t('wsInbox.outside.webhooksSub') : tab === 'slack' ? t('wsInbox.outside.slackSub') : t('wsInbox.outside.orgSub');
  return (
    <>
      <Head title={title} sub={sub} />
      {tab === 'slack' ? <SlackPane config={config} /> : <LedgerPane key={tab} source={tab} />}
    </>
  );
}
