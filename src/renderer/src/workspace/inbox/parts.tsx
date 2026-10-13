/**
 * Small pieces every Inbox surface shares: the reply box with its quick
 * replies, a message body (markdown, clamped when long), the "from → to" line,
 * and a localized relative time.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { useRtl } from '@/i18n/useDirection';
import { isComposingKey } from '@shared/imeGuard';
import type { InboxMessage, NameOf } from '@shared/workspace/inboxMessages';
import { Button, Chip, KeyHint, WsIcon } from '../ui';
import { actLabel, fullTime, relativeTime } from './model';
import './inbox.css';

// ─── Time ───────────────────────────────────────────────────────────────────

export function TimeText({ ms, className }: { ms: number; className?: string }) {
  const { i18n } = useTranslation();
  if (!Number.isFinite(ms)) return null;
  return (
    <time className={className} dateTime={new Date(ms).toISOString()} title={fullTime(ms, i18n.language)}>
      {relativeTime(ms, i18n.language)}
    </time>
  );
}

// ─── Who ────────────────────────────────────────────────────────────────────

/** "Dwight → Michael". */
export function Route({ from, to, nameOf }: { from: string; to: string; nameOf: NameOf }) {
  return (
    <>
      <span className="cth-ws-inbox-meta-who" title={from}>{nameOf(from)}</span>
      <span className="cth-ws-inbox-arrow" aria-hidden="true">→</span>
      <span className="cth-ws-ellipsis" title={to}>{nameOf(to)}</span>
    </>
  );
}

const ACT_TONE: Record<string, 'neutral' | 'info' | 'warn' | 'danger' | 'ok' | 'accent'> = {
  request: 'warn', query: 'info', propose: 'accent', inform: 'neutral', agree: 'ok', done: 'ok', refuse: 'danger'
};

export function ActChip({ act }: { act: string }) {
  const { t } = useTranslation();
  return <Chip tone={ACT_TONE[act] ?? 'neutral'}>{actLabel(t, act)}</Chip>;
}

// ─── Body ───────────────────────────────────────────────────────────────────

const CLAMP_CHARS = 700;
const CLAMP_LINES = 12;

/**
 * A message body, rendered with the app's safe markdown renderer (no raw HTML,
 * links through the main-process opener). A long body rests clamped with a
 * "Show all"; one main cut at the wire cap says so.
 */
export function MessageBody({ message, clampable = true }: { message: Pick<InboxMessage, 'body' | 'clipped'>; clampable?: boolean }) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const [open, setOpen] = useState(false);
  const long = useMemo(
    () => message.body.length > CLAMP_CHARS || message.body.split('\n').length > CLAMP_LINES,
    [message.body]
  );
  if (!message.body.trim()) return <div className="cth-ws-inbox-body cth-ws-muted">{t('wsInbox.message.empty')}</div>;
  const clamped = clampable && long && !open;
  return (
    <>
      <div className={clamped ? 'cth-ws-inbox-body cth-ws-inbox-body--clamped' : 'cth-ws-inbox-body'} dir={rtl ? 'auto' : undefined}>
        <MarkdownPreview source={message.body} variant="card" />
      </div>
      {clampable && long && (
        <button type="button" className="cth-ws-inbox-more" onClick={() => setOpen((v) => !v)}>
          {open ? t('wsInbox.message.showLess') : t('wsInbox.message.showAll')}
        </button>
      )}
      {message.clipped && (open || !clampable || !long) && (
        <div className="cth-ws-inbox-note">{t('wsInbox.message.clipped')}</div>
      )}
    </>
  );
}

// ─── Reply box ──────────────────────────────────────────────────────────────

export interface ReplyBoxProps {
  value: string;
  onChange: (value: string) => void;
  /** Send `text` (the box's value, or a quick reply). Resolve true on success. */
  onSend: (text: string) => Promise<boolean>;
  /** Quick replies — one click answers with the label. */
  options?: string[];
  placeholder: string;
  sendLabel: string;
  /** Extra controls after Send (Dismiss, Open the card). */
  extra?: ReactNode;
  error?: string | null;
  autoFocus?: boolean;
  /** Visible label for the textarea (screen readers). */
  ariaLabel: string;
}

export function ReplyBox({ value, onChange, onSend, options, placeholder, sendLabel, extra, error, autoFocus, ariaLabel }: ReplyBoxProps) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const [busy, setBusy] = useState(false);

  const send = async (text: string): Promise<void> => {
    if (busy || !text.trim()) return;
    setBusy(true);
    try { await onSend(text.trim()); } finally { setBusy(false); }
  };

  return (
    <div className="cth-ws-inbox-reply">
      {!!options?.length && (
        <div className="cth-ws-inbox-options" role="group" aria-label={t('wsInbox.reply.quickReplies')}>
          {options.map((o) => (
            <Button
              key={o}
              size="sm"
              disabled={busy}
              title={t('wsInbox.reply.quickReplyTitle', { option: o })}
              onClick={() => { void send(o); }}
            >
              {o}
            </Button>
          ))}
        </div>
      )}
      <textarea
        className="cth-ws-inbox-textarea"
        dir={rtl ? 'auto' : undefined}
        value={value}
        rows={3}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (isComposingKey(e)) return;
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(value); }
        }}
      />
      {error && <div className="cth-ws-inbox-banner cth-ws-inbox-banner--danger cth-ws-inbox-reply-error" role="alert">{error}</div>}
      <div className="cth-ws-inbox-reply-bar">
        <Button variant="primary" size="sm" icon={<WsIcon name="send" />} disabled={busy || !value.trim()} onClick={() => { void send(value); }}>
          {busy ? t('wsInbox.reply.sending') : sendLabel}
        </Button>
        {extra}
        <span className="cth-ws-inbox-reply-spacer" />
        <span className="cth-ws-inbox-reply-hint"><KeyHint combo="Mod+Enter" />{t('wsInbox.reply.toSend')}</span>
      </div>
    </div>
  );
}
