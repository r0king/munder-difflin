/**
 * One agent card on the Agents screen: its status in words, engine + model,
 * the ticket it is on, its latest update in its own words, the tool call it is
 * making and what that call printed, the question it is waiting on, a context
 * gauge and its spend — and a crash strip when its process died.
 *
 * The whole card opens the agent's room on click; the name is the real button
 * (keyboard + screen reader), so the card's inner controls are never nested
 * inside another button.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type Agent } from '@/store/store';
import { useHasTerminalDraft } from '@/components/terminalPool';
import {
  contextPercent,
  contextTone,
  formatToolLine,
  formatUsd,
  pickLatestUpdate,
  plainPreview,
  toolLineFromAction,
  type AgentActivity,
  type CardTicket,
  type OpenAsk
} from '@shared/workspace/agentsSummary';
import { toolDisplayName } from '@shared/workspace/agentsTranscript';
import { agentLiveLine, deriveAgentStatus, liveLineText, statusLabel, type WsAgentStatus } from '../agentStatus';
import { Button, Chip, StatusBadge } from '../ui';
import { useWorkspace } from '../store';
import { CrashStrip } from './CrashStrip';
import { AddTicketField } from './AddTicketField';
import { engineModelLabel } from './format';

const EMPTY_QUEUE: unknown[] = [];

export interface AgentCardViewProps {
  agent: Agent;
  activity?: AgentActivity;
  ticket: CardTicket | null;
  ask: OpenAsk | null;
  hasOpenQuestion: boolean;
  dead: boolean;
  usd?: number;
  harnessHome?: string | null;
}

/** Statuses during which the current tool line is news, not history. */
const SHOWS_TOOL: ReadonlySet<WsAgentStatus> = new Set(['working', 'thinking', 'looping', 'waiting', 'compacting']);

export function AgentCardView({ agent, activity, ticket, ask, hasOpenQuestion, dead, usd, harnessHome }: AgentCardViewProps) {
  const { t, i18n } = useTranslation();
  const navigate = useWorkspace((s) => s.navigate);
  const queued = useStore((s) => (s.messageQueues[agent.id] ?? EMPTY_QUEUE).length);
  const typing = useHasTerminalDraft(agent.ptyId);
  const [adding, setAdding] = useState(false);
  const [flash, setFlash] = useState('');

  const input = {
    status: agent.status, action: agent.action, ptyId: agent.ptyId, archived: agent.archived,
    isGod: agent.isGod, hasOpenQuestion
  };
  const status: WsAgentStatus = dead ? 'offline' : deriveAgentStatus(input);
  const liveText = dead ? t('wsAgents.card.processEnded') : liveLineText(t, agentLiveLine(input));
  const update = pickLatestUpdate(activity, liveText);
  const { engine, model } = engineModelLabel(t, agent);

  // The tool line: the transcript's when there is one (Claude writes the
  // tool_use record as the call starts, with its argument, and the result as
  // it returns); otherwise the store's own action (the pty parser's
  // `<tool> <arg>` or a hook's `using <Tool>`), for engines with no transcript.
  const fromTranscript = activity?.lastTool;
  const fromAction = toolLineFromAction(agent.action);
  const tool = fromTranscript
    ? { line: formatToolLine(toolDisplayName(fromTranscript.tool), fromTranscript.text), result: activity?.lastResult }
    : fromAction
      ? { line: formatToolLine(fromAction.tool, fromAction.text), result: undefined }
      : null;
  const showTool = !!tool && SHOWS_TOOL.has(status) && status !== 'needs-you';

  const pct = contextPercent(agent.contextTokens, agent.contextLimit);
  const tone = contextTone(pct);
  const spend = formatUsd(usd, i18n.language);
  const idle = status === 'idle' && !dead;
  const open = (): void => navigate({ kind: 'agent', agentId: agent.id });

  return (
    <article
      className="cth-ws-card cth-ws-agents-card"
      data-needs={status === 'needs-you' ? 'true' : undefined}
      data-dead={dead ? 'true' : undefined}
      onClick={open}
    >
      <div className="cth-ws-agents-card-head">
        <button
          type="button"
          className="cth-ws-agents-name"
          onClick={(e) => { e.stopPropagation(); open(); }}
          aria-label={agent.isGod ? t('wsAgents.card.openOrchestrator', { name: agent.name }) : t('wsAgents.card.openRoom', { name: agent.name })}
        >
          {agent.name}
        </button>
        <span className="cth-ws-agents-model" title={`${engine} · ${model}`}>
          {agent.isGod ? `${t('wsAgents.card.orchestrator')} · ${model}` : `${engine} · ${model}`}
        </span>
        {typing && !dead && (
          <Chip tone="warn" title={t('wsAgents.card.typingTip')}>{t('wsAgents.card.typing')}</Chip>
        )}
        <StatusBadge status={status} label={statusLabel(t, status)} />
      </div>

      <p
        className="cth-ws-agents-update"
        data-source={update.source}
        title={update.source === 'live' ? undefined : t(update.source === 'reply' ? 'wsAgents.card.fromReply' : 'wsAgents.card.fromMail')}
        dir="auto"
      >
        {update.text}
      </p>

      {ticket && (
        <div className="cth-ws-agents-ticket" title={`${ticket.id} · ${ticket.title}`}>
          <span className="cth-ws-agents-ticket-key">{ticket.id}</span>
          <span className="cth-ws-ellipsis">{ticket.title}</span>
        </div>
      )}

      {status === 'needs-you' && (ask || agent.isGod) && (
        <div className="cth-ws-agents-ask">
          <span className="cth-ws-ellipsis" dir="auto">
            ? {ask ? plainPreview(ask.q, 140) : t('wsAgents.card.atPrompt')}
          </span>
          <span className="cth-ws-agents-ask-meta">
            {ask ? t('wsAgents.card.waitingForAnswer') : t('wsAgents.card.answerInTerminal')}
          </span>
        </div>
      )}

      {showTool && tool && (
        <div className="cth-ws-agents-tool">
          <span className="cth-ws-agents-tool-line cth-ws-ellipsis" dir="ltr" title={tool.line}>✱ {tool.line}</span>
          {tool.result && (
            <span
              className="cth-ws-agents-tool-result cth-ws-ellipsis"
              data-error={tool.result.isError ? 'true' : undefined}
              dir="ltr"
              title={tool.result.text}
            >
              {tool.result.text}
            </span>
          )}
        </div>
      )}

      {dead && <CrashStrip agent={agent} compact />}

      {adding ? (
        <AddTicketField
          agent={agent}
          harnessHome={harnessHome}
          onDone={(msg) => { setAdding(false); setFlash(msg); if (msg) setTimeout(() => setFlash(''), 4000); }}
        />
      ) : (
        <div className="cth-ws-agents-foot">
          <span className="cth-ws-agents-gauge" title={pct === null
            ? t('wsAgents.card.contextUnknown')
            : t('wsAgents.card.contextTip', {
                used: (agent.contextTokens ?? 0).toLocaleString(i18n.language),
                limit: (agent.contextLimit ?? 0).toLocaleString(i18n.language)
              })}
          >
            {t('wsAgents.card.context')}
            <span className="cth-ws-agents-gauge-track" aria-hidden="true">
              <span className="cth-ws-agents-gauge-fill" data-tone={tone} style={{ display: 'block', width: `${pct ?? 0}%` }} />
            </span>
            <span className="cth-ws-agents-num">{pct === null ? '—' : `${pct}%`}</span>
          </span>
          <span title={t('wsAgents.card.spendTip')}>
            <span className="cth-ws-agents-num">{spend ?? '—'}</span>
          </span>
          {queued > 0 && <span>{t('wsAgents.card.queued', { count: queued })}</span>}
          {hasOpenQuestion && status !== 'needs-you' && <Chip tone="danger">{t('wsAgents.card.askedYou')}</Chip>}
          <span className="cth-ws-agents-foot-spacer" />
          {flash && <span className="cth-ws-agents-note" data-tone="ok">{flash}</span>}
          {idle && !agent.isGod && (
            <span onClick={(e) => e.stopPropagation()}>
              <Button size="sm" variant="ghost" onClick={() => { setFlash(''); setAdding(true); }}>
                + {t('wsAgents.card.addTicket')}
              </Button>
            </span>
          )}
        </div>
      )}
    </article>
  );
}
