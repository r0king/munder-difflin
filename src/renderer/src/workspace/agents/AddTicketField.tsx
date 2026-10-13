/**
 * "Add a ticket" from an idle card: one line in, and in one move the ticket is
 * written to the task ledger assigned to this agent AND the agent is told.
 *
 *   1. hiveAddTask — the ledger's own add path (main merges by id and refuses
 *      a duplicate). The id follows the floor's convention (`bmt-13`) via the
 *      Tasks unit's nextTaskId, so a ticket made here looks like one made on
 *      the board.
 *   2. deliverToAgent (queue) — the agent gets the briefing the moment it is
 *      free, through the same drain as the composer.
 *
 * If the ledger write fails nothing is sent; if the send fails after the card
 * was written, the field says so (the card exists — the agent was not told).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Agent } from '@/store/store';
import { isComposingKey } from '@shared/imeGuard';
import { buildTicket, ticketBriefing } from '@shared/workspace/agentsSummary';
import { deriveTaskKey, nextTaskId } from '@shared/workspace/tasks';
import { Button } from '../ui';
import { deliverToAgent } from '../deliver';
import { refreshHiveTasks, useHiveTasks } from '../useHiveTasks';
import { homeFolderName } from './format';
import { refreshAgentActivity } from './hooks';

export function AddTicketField({ agent, harnessHome, onDone }: {
  agent: Agent;
  harnessHome?: string | null;
  onDone: (message: string) => void;
}) {
  const { t } = useTranslation();
  const { tasks } = useHiveTasks();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => { input.current?.focus(); }, []);

  const submit = async (): Promise<void> => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setError('');
    try {
      // Re-read the ledger first: the 5 s snapshot may predate a card the
      // orchestrator just added, and an id collision is refused by main.
      let ids = tasks.map((x) => x.id);
      try {
        const raw = await window.cth.hiveTasks() as { tasks?: Array<{ id?: unknown }> } | null;
        if (raw && Array.isArray(raw.tasks)) ids = raw.tasks.map((x) => (typeof x?.id === 'string' ? x.id : '')).filter(Boolean);
      } catch { /* fall back to the snapshot */ }
      const id = nextTaskId(ids, deriveTaskKey(homeFolderName(harnessHome)));
      const ticket = buildTicket(text, agent.id, id, new Date());
      if (!ticket) return;
      const added = await window.cth.hiveAddTask(ticket);
      if (!added.ok) {
        setError(added.error ? t('wsAgents.ticket.writeFailedDetail', { error: added.error }) : t('wsAgents.ticket.writeFailed'));
        return;
      }
      void refreshHiveTasks();
      const briefing = ticketBriefing(ticket);
      const sent = await deliverToAgent({
        target: { kind: 'agent', agentId: agent.id },
        text: briefing,
        mode: 'queue',
        source: 'agent-card'
      });
      if (!sent.ok) {
        setError(t('wsAgents.ticket.tellFailed', { id: ticket.id, name: agent.name, error: sent.error ?? '' }));
        return;
      }
      void window.cth.features.agents.recordSend(agent.id, { text: briefing, mode: 'send' }).catch(() => { /* conversation only */ });
      refreshAgentActivity();
      setText('');
      onDone(t('wsAgents.ticket.added', { id: ticket.id, name: agent.name }));
    } catch (e) {
      setError(t('wsAgents.ticket.writeFailedDetail', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cth-ws-agents-ticket-form" onClick={(e) => e.stopPropagation()}>
      <div className="cth-ws-agents-ticket-row">
        <input
          ref={input}
          className="cth-ws-agents-input"
          value={text}
          maxLength={2000}
          disabled={busy}
          placeholder={t('wsAgents.ticket.placeholder', { name: agent.name })}
          aria-label={t('wsAgents.ticket.aria', { name: agent.name })}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (isComposingKey(e)) return;
            if (e.key === 'Enter') { e.preventDefault(); void submit(); }
            else if (e.key === 'Escape') { e.preventDefault(); onDone(''); }
          }}
        />
        <Button size="sm" variant="primary" disabled={busy || !text.trim()} onClick={() => { void submit(); }}>
          {t('wsAgents.ticket.add')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDone('')}>
          {t('wsAgents.ticket.cancel')}
        </Button>
      </div>
      <span className="cth-ws-agents-note" data-tone={error ? 'error' : undefined}>
        {error || t('wsAgents.ticket.hint', { name: agent.name })}
      </span>
    </div>
  );
}
