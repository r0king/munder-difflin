/**
 * The room's composer: Send queues your message until the agent is free;
 * Steer lands on its next turn.
 *
 * Built on the same parts as the Classic MessageQueueComposer, not beside
 * them: the draft is the store's per-agent draft (so hold-⌥ dictation, which
 * appends to that draft, lands here, and switching rooms keeps it), the queue
 * is the store's message queue drained by useHive, attachments use the same
 * picker / drop / paste-a-screenshot IPC and the same "Attached files:" block
 * (composeDeliveryText), and delivery goes through deliverToAgent. What the
 * Workspace adds is the queue's reorder and edit (store.moveQueuedMessage /
 * editQueuedMessage) beside its send-now (releaseQueuedMessage) and remove.
 *
 * Why a queued message is not moving is said out loud — the agent's own
 * terminal holding a half-typed line or an open picker, its process gone, the
 * floor's deliveries paused — with the fix one click away, as Classic does.
 */
import { type ClipboardEvent, type DragEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type Agent, type QueuedMessage } from '@/store/store';
import { clearTerminalDraft, dismissTerminalPicker, terminalAutomationBlockFor } from '@/components/terminalPool';
import type { TerminalAutomationBlock } from '@/components/terminalAutomation';
import { freeflowRecorder, useFreeflow } from '@/freeflow/recorder';
import { isComposingKey } from '@shared/imeGuard';
import { attachmentName, composeDeliveryText } from '@shared/features/deliver';
import { Button, Chip, IconButton, KeyHint, WsIcon } from '../ui';
import { deliverToAgent } from '../deliver';
import { refreshAgentActivity } from './hooks';

const EMPTY_QUEUE: QueuedMessage[] = [];

/** Poll the pty's automation block while something waits on it (the flag is a
 *  module map in the terminal pool; there is nothing to subscribe to). */
function useTerminalBlock(ptyId: string | undefined, active: boolean): TerminalAutomationBlock {
  const [block, setBlock] = useState<TerminalAutomationBlock>(null);
  useEffect(() => {
    if (!ptyId || !active) { setBlock(null); return; }
    const read = (): void => setBlock(terminalAutomationBlockFor(ptyId));
    read();
    const iv = setInterval(read, 1000);
    return () => clearInterval(iv);
  }, [ptyId, active]);
  return block === 'settling' ? null : block;
}

export function RoomComposer({ agent, deliveryPaused, onSent }: {
  agent: Agent;
  /** The floor's auto-delivery pause (from the control snapshot). */
  deliveryPaused: boolean;
  onSent: () => void;
}) {
  const { t } = useTranslation();
  const queue = useStore((s) => s.messageQueues[agent.id]) ?? EMPTY_QUEUE;
  const text = useStore((s) => s.drafts[agent.id] ?? '');
  const setDraft = useStore((s) => s.setDraft);
  const freeflowEnabled = useStore((s) => s.freeflowEnabled);
  const hasGroqKey = useStore((s) => s.hasGroqKey);
  const ff = useFreeflow();
  const [attachments, setAttachments] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const setText = (v: string): void => setDraft(agent.id, v);
  const idle = agent.status === 'idle';
  const block = useTerminalBlock(agent.ptyId, queue.length > 0);

  const addPaths = (paths: string[]): void =>
    setAttachments((prev) => {
      const fresh = paths.filter((p) => p && !prev.includes(p));
      return fresh.length ? [...prev, ...fresh] : prev;
    });

  const pickFiles = async (): Promise<void> => {
    try {
      const res = await window.cth.attachFiles();
      if (res.ok) addPaths(res.files.map((f) => f.path));
    } catch { /* the picker was closed */ }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragOver(false);
    const paths = Array.from(e.dataTransfer?.files ?? []).map((f) => window.cth.pathForFile(f)).filter(Boolean);
    if (paths.length) addPaths(paths);
  };

  const onPaste = async (e: ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
    const items = Array.from(e.clipboardData?.items ?? []);
    if (items.some((it) => it.kind === 'file' && it.type.startsWith('image/'))) {
      e.preventDefault();
      const res = await window.cth.saveClipboardImage();
      if (res.ok) addPaths([res.file.path]);
      return;
    }
    const files = Array.from(e.clipboardData?.files ?? []).map((f) => window.cth.pathForFile(f)).filter(Boolean);
    if (files.length) { e.preventDefault(); addPaths(files); }
  };

  const canSend = (!!text.trim() || attachments.length > 0) && !busy;

  const send = async (mode: 'queue' | 'steer'): Promise<void> => {
    if (!canSend) return;
    setBusy(true);
    setError('');
    const body = composeDeliveryText(text, attachments);
    try {
      const res = await deliverToAgent({
        target: { kind: 'agent', agentId: agent.id },
        text,
        attachments,
        mode,
        source: 'agent-room'
      });
      if (!res.ok) { setError(res.error ?? t('wsAgents.composer.sendFailed')); return; }
      // A steer is counted by main at control:steer; a queued send is a
      // person's message at the composer, the same event Classic counts.
      if (mode === 'queue') void window.cth.trackMessageSent('composer').catch(() => { /* telemetry is best-effort */ });
      void window.cth.features.agents.recordSend(agent.id, { text: body, mode: mode === 'steer' ? 'steer' : 'send' })
        .catch(() => { /* the conversation only */ });
      setText('');
      setAttachments([]);
      refreshAgentActivity();
      onSent();
    } finally {
      setBusy(false);
    }
  };

  const hint = queue.length === 0
    ? null
    : block === 'draft' ? t('wsAgents.composer.heldDraft', { name: agent.name })
      : block === 'picker' ? t('wsAgents.composer.heldPicker', { name: agent.name })
        : block === 'exited' ? t('wsAgents.composer.heldExited', { name: agent.name })
          : deliveryPaused && !queue[0]?.manual ? t('wsAgents.composer.heldPaused')
            : !idle ? t('wsAgents.composer.waitingFree', { name: agent.name })
              : t('wsAgents.composer.sendingNow', { name: agent.name });

  const ffMine = ff.targetAgentId === agent.id;
  const recording = ffMine && ff.status === 'recording';
  const transcribing = ffMine && ff.status === 'transcribing';

  return (
    <div
      className="cth-ws-agents-composer"
      data-drop={dragOver ? 'true' : undefined}
      onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragOver(false);
      }}
      onDrop={onDrop}
    >
      {queue.length > 0 && (
        <>
          <div className="cth-ws-agents-queue-head">
            <span>{t('wsAgents.composer.queueTitle', { count: queue.length })}</span>
            {hint && <span className="cth-ws-ellipsis" title={hint}>· {hint}</span>}
            {(block === 'draft' || block === 'picker') && agent.ptyId && (
              <button
                type="button"
                className="cth-ws-agents-link"
                onClick={() => {
                  if (block === 'picker') { dismissTerminalPicker(agent.ptyId!); return; }
                  const leftover = clearTerminalDraft(agent.ptyId!);
                  if (leftover.trim()) setText(text ? `${text}\n${leftover}` : leftover);
                }}
              >
                {block === 'picker' ? t('wsAgents.composer.closePicker') : t('wsAgents.composer.recoverDraft')}
              </button>
            )}
          </div>
          <div className="cth-ws-agents-queue" role="list" aria-label={t('wsAgents.composer.queueAria', { name: agent.name })}>
            {queue.map((m, i) => (
              <QueueRow key={m.id} agentId={agent.id} message={m} index={i} total={queue.length} paused={deliveryPaused} />
            ))}
          </div>
        </>
      )}

      {attachments.length > 0 && (
        <div className="cth-ws-agents-attachments">
          {attachments.map((p) => (
            <Chip key={p} tone="neutral" title={p} icon={<WsIcon name="attach" />}>
              <span className="cth-ws-ellipsis" style={{ maxWidth: 180 }}>{attachmentName(p)}</span>
              <button
                type="button"
                className="cth-ws-iconbtn cth-ws-iconbtn--sm"
                aria-label={t('wsAgents.composer.removeAttachment', { name: attachmentName(p) })}
                onClick={() => setAttachments((prev) => prev.filter((x) => x !== p))}
              >
                <WsIcon name="close" />
              </button>
            </Chip>
          ))}
        </div>
      )}

      <textarea
        className="cth-ws-agents-textarea"
        dir="auto"
        value={text}
        rows={3}
        placeholder={t('wsAgents.composer.placeholder', { name: agent.name })}
        aria-label={t('wsAgents.composer.aria', { name: agent.name })}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => { void onPaste(e); }}
        onKeyDown={(e) => {
          if (isComposingKey(e)) return;
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send(e.metaKey || e.ctrlKey ? 'steer' : 'queue');
          }
        }}
      />

      <div className="cth-ws-agents-controls">
        <IconButton label={t('wsAgents.composer.attach')} onClick={() => { void pickFiles(); }}>
          <WsIcon name="attach" />
        </IconButton>
        {freeflowEnabled && (
          <IconButton
            label={!hasGroqKey ? t('wsAgents.composer.voiceNoKey') : recording ? t('wsAgents.composer.voiceStop') : t('wsAgents.composer.voice')}
            active={recording}
            disabled={!hasGroqKey || transcribing || (ff.status !== 'idle' && !ffMine)}
            onClick={() => freeflowRecorder.toggle(agent.id)}
          >
            <WsIcon name="mic" />
          </IconButton>
        )}
        <span className="cth-ws-agents-hint">
          {error
            ? <span className="cth-ws-agents-note" data-tone="error" role="alert">{error}</span>
            : recording ? t('wsAgents.composer.recording')
              : transcribing ? t('wsAgents.composer.transcribing')
                : dragOver ? t('wsAgents.composer.dropHere')
                  : freeflowEnabled ? t('wsAgents.composer.hintVoice', { name: agent.name })
                    : t('wsAgents.composer.hint', { name: agent.name })}
        </span>
        <span title={t('wsAgents.composer.steerTip', { name: agent.name })} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Button size="sm" variant="secondary" disabled={!canSend} onClick={() => { void send('steer'); }}>
            {t('wsAgents.composer.steer')}
          </Button>
          <KeyHint combo="Mod+Enter" />
        </span>
        <Button size="sm" variant="primary" icon={<WsIcon name="send" />} disabled={!canSend} title={t('wsAgents.composer.sendTip', { name: agent.name })} onClick={() => { void send('queue'); }}>
          {t('wsAgents.composer.send')}
        </Button>
      </div>
    </div>
  );
}

/** One queued message: move up/down, edit in place, send now, remove. */
function QueueRow({ agentId, message, index, total, paused }: {
  agentId: string;
  message: QueuedMessage;
  index: number;
  total: number;
  paused: boolean;
}) {
  const { t } = useTranslation();
  const move = useStore((s) => s.moveQueuedMessage);
  const edit = useStore((s) => s.editQueuedMessage);
  const release = useStore((s) => s.releaseQueuedMessage);
  const remove = useStore((s) => s.removeQueuedMessage);
  const [editing, setEditing] = useState(false);
  const [draft, setDraftText] = useState(message.text);
  // A Slack-origin message types its `instruction`, not the text shown, so
  // editing the text would change nothing the agent receives.
  const editable = !message.instruction;

  if (editing) {
    return (
      <div className="cth-ws-agents-queue-row" role="listitem">
        <span className="cth-ws-agents-queue-n">{index + 1}.</span>
        <div className="cth-ws-agents-queue-edit">
          <textarea
            className="cth-ws-agents-textarea cth-ws-agents-textarea--sm"
            dir="auto"
            value={draft}
            autoFocus
            aria-label={t('wsAgents.composer.editAria', { n: index + 1 })}
            onChange={(e) => setDraftText(e.target.value)}
            onKeyDown={(e) => {
              if (isComposingKey(e)) return;
              if (e.key === 'Escape') { e.preventDefault(); setEditing(false); setDraftText(message.text); }
              else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (draft.trim()) { edit(agentId, message.id, draft); setEditing(false); }
              }
            }}
          />
          <div className="cth-ws-agents-ticket-row">
            <Button size="sm" variant="primary" disabled={!draft.trim()} onClick={() => { edit(agentId, message.id, draft); setEditing(false); }}>
              {t('wsAgents.composer.save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setDraftText(message.text); }}>
              {t('wsAgents.composer.cancel')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="cth-ws-agents-queue-row" role="listitem">
      <span className="cth-ws-agents-queue-n">{index + 1}.</span>
      <span className="cth-ws-agents-queue-text" dir="auto" title={message.text}>{message.text}</span>
      {message.manual && <span className="cth-ws-agents-queue-state">{t('wsAgents.composer.sendsWhenFree')}</span>}
      <span className="cth-ws-agents-queue-actions">
        <IconButton size="sm" label={t('wsAgents.composer.moveUp')} disabled={index === 0} onClick={() => move(agentId, message.id, index - 1)}>
          <span aria-hidden="true">↑</span>
        </IconButton>
        <IconButton size="sm" label={t('wsAgents.composer.moveDown')} disabled={index === total - 1} onClick={() => move(agentId, message.id, index + 1)}>
          <span aria-hidden="true">↓</span>
        </IconButton>
        {editable && (
          <IconButton size="sm" label={t('wsAgents.composer.edit')} onClick={() => { setDraftText(message.text); setEditing(true); }}>
            <span aria-hidden="true">✎</span>
          </IconButton>
        )}
        {!message.manual && (index > 0 || paused) && (
          <IconButton
            size="sm"
            label={paused ? t('wsAgents.composer.sendNowPaused') : t('wsAgents.composer.sendNext')}
            onClick={() => release(agentId, message.id)}
          >
            <WsIcon name="send" />
          </IconButton>
        )}
        <IconButton size="sm" label={t('wsAgents.composer.remove')} onClick={() => remove(agentId, message.id)}>
          <WsIcon name="close" />
        </IconButton>
      </span>
    </div>
  );
}
