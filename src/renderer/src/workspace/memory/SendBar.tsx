/**
 * "Send the results to an agent with a prompt, so the next job starts from what
 * the floor already knows."
 *
 * Appears once something is ticked. Pick the orchestrator or an agent on the
 * floor, write what they should do, and Send: the prompt plus a compact block
 * of the ticked results (shared/workspace/memoryContext.ts) goes through
 * deliverToAgent in 'queue' mode — the composer's own Send, so it waits until
 * the agent is free and never types over a draft.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { deliverToAgent, type DeliverTarget } from '../deliver';
import { navigateWorkspace } from '../store';
import { Button, KeyHint, WsIcon } from '../ui';
import { buildContextBlock, toContextItems, CONTEXT_PROMPT_MAX, type SelectedResult } from '@shared/workspace/memoryContext';
import { countText } from './ResultRows';
import type { NameBook } from './useNames';

const ORCHESTRATOR = '__orchestrator__';

export interface SendBarProps {
  selected: readonly SelectedResult[];
  query: string;
  names: NameBook;
  onClear: () => void;
}

type Outcome = { ok: true; target: DeliverTarget; name: string } | { ok: false; error: string } | null;

export function SendBar({ selected, query, names, onClear }: SendBarProps) {
  const { t } = useTranslation();
  const agents = useStore((s) => s.agents);
  const [target, setTarget] = useState<string>(ORCHESTRATOR);
  const [prompt, setPrompt] = useState('');
  const [preview, setPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  // Agents on the floor that take messages. The orchestrator is offered by
  // role (first), and Michael's prep assistant only forwards to him.
  const recipients = useMemo(
    () => agents.filter((a) => !a.archived && !a.isGod && !a.isAssistant).sort((a, b) => a.name.localeCompare(b.name)),
    [agents]
  );
  const targetId = target === ORCHESTRATOR || recipients.some((a) => a.id === target) ? target : ORCHESTRATOR;

  const text = useMemo(
    () => buildContextBlock({ prompt, query, items: toContextItems(selected, names) }),
    [prompt, query, selected, names]
  );

  if (!selected.length && !outcome) return null;

  const send = async () => {
    if (sending || !text.trim()) return;
    const dest: DeliverTarget = targetId === ORCHESTRATOR ? { kind: 'orchestrator' } : { kind: 'agent', agentId: targetId };
    const name = dest.kind === 'orchestrator'
      ? (agents.find((a) => a.isGod)?.name ?? t('wsMemory.send.orchestrator'))
      : names.name(dest.agentId);
    setSending(true);
    try {
      const res = await deliverToAgent({ target: dest, text, mode: 'queue', source: 'memory' });
      if (res.ok) {
        setOutcome({ ok: true, target: dest, name });
        setPrompt('');
        setPreview(false);
        onClear();
      } else {
        setOutcome({ ok: false, error: res.error ?? '' });
      }
    } catch (e) {
      setOutcome({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setSending(false);
    }
  };

  const openTarget = (dest: DeliverTarget) =>
    navigateWorkspace(dest.kind === 'orchestrator' ? { kind: 'orchestrator' } : { kind: 'agent', agentId: dest.agentId });

  if (!selected.length && outcome) {
    return (
      <div className="cth-ws-memory-send" role="status">
        <div className="cth-ws-memory-send-row">
          <span className="cth-ws-memory-send-result">
            {outcome.ok ? t('wsMemory.send.sent', { name: outcome.name }) : t('wsMemory.send.failed', { error: outcome.error })}
          </span>
          <span className="cth-ws-memory-spacer" />
          {outcome.ok && <Button size="sm" variant="secondary" onClick={() => openTarget(outcome.target)}>{t('wsMemory.send.open')}</Button>}
          <Button size="sm" variant="ghost" onClick={() => setOutcome(null)}>{t('wsMemory.drawer.close')}</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="cth-ws-memory-send">
      <div className="cth-ws-memory-send-row">
        <span className="cth-ws-memory-send-count">
          {countText(t, selected.length, 'wsMemory.send.selectedOne', 'wsMemory.send.selected')}
        </span>
        <Button size="sm" variant="ghost" onClick={() => { onClear(); setOutcome(null); }}>{t('wsMemory.send.clear')}</Button>
        <span className="cth-ws-memory-spacer" />
        <label className="cth-ws-memory-send-label" htmlFor="cth-ws-memory-target">{t('wsMemory.send.to')}</label>
        <select
          id="cth-ws-memory-target"
          className="cth-ws-memory-select"
          value={targetId}
          onChange={(e) => setTarget(e.target.value)}
          title={t('wsMemory.send.archivedNote')}
        >
          <option value={ORCHESTRATOR}>{t('wsMemory.send.orchestrator')}</option>
          {recipients.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <textarea
        className="cth-ws-memory-prompt"
        value={prompt}
        maxLength={CONTEXT_PROMPT_MAX}
        placeholder={t('wsMemory.send.prompt')}
        aria-label={t('wsMemory.send.promptAria')}
        dir="auto"
        onChange={(e) => { setPrompt(e.target.value); if (outcome && !outcome.ok) setOutcome(null); }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
        }}
      />
      {preview && <pre className="cth-ws-memory-preview">{text}</pre>}
      <div className="cth-ws-memory-send-row">
        <Button size="sm" variant="ghost" onClick={() => setPreview((v) => !v)}>
          {preview ? t('wsMemory.send.hidePreview') : t('wsMemory.send.preview')}
        </Button>
        {outcome && !outcome.ok && (
          <span className="cth-ws-memory-send-result" role="alert">{t('wsMemory.send.failed', { error: outcome.error })}</span>
        )}
        <span className="cth-ws-memory-spacer" />
        <KeyHint combo="Mod+Enter" />
        <span className="cth-ws-memory-send-label">{t('wsMemory.send.sendHint')}</span>
        <Button variant="primary" size="sm" icon={<WsIcon name="send" />} disabled={sending} onClick={() => { void send(); }}>
          {sending ? t('wsMemory.send.sending') : t('wsMemory.send.send')}
        </Button>
      </div>
    </div>
  );
}
