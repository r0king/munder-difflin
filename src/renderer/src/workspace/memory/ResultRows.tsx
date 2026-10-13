/**
 * One row per result, in its shape: a ticket, an agent, a note. Each carries a
 * type chip, a tick box for "send these to an agent", and a link to where the
 * thing lives — the ticket's detail overlay, the agent's room, the note.
 *
 * Matches are emphasised from the marks main computed (snippets) or that the
 * shared matcher finds in the title — ranges into plain text, never markup.
 */
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Chip, StatusDot, WsIcon } from '../ui';
import { useAgentPresence } from '../agentStatus';
import { snippetRuns } from '@shared/workspace/memoryFormat';
import { findMarks, fold } from '@shared/workspace/memoryQuery';
import type { AnswerAgent, AnswerTicket, MemorySnippet, NoteHit } from '@shared/workspace/memoryTypes';
import type { NameBook } from './useNames';

export function Highlight({ text, marks }: { text: string; marks: ReadonlyArray<readonly [number, number]> }) {
  return (
    <>
      {snippetRuns(text, marks).map((r, i) =>
        r.mark ? <mark key={i} className="cth-ws-memory-mark">{r.text}</mark> : <span key={i}>{r.text}</span>
      )}
    </>
  );
}

/** Title text with the query's needles emphasised. */
function Title({ text, needles }: { text: string; needles: string[] }) {
  return <Highlight text={text} marks={needles.length ? findMarks(fold(text), needles) : []} />;
}

function Snippet({ snippet }: { snippet?: MemorySnippet }) {
  if (!snippet?.text) return null;
  return (
    <span className="cth-ws-memory-snippet" dir="auto">
      <Highlight text={snippet.text} marks={snippet.marks} />
    </span>
  );
}

export function CheckBox({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className="cth-ws-memory-check"
      onClick={onChange}
    >
      {checked && <WsIcon name="check" />}
    </button>
  );
}

/** "3 tickets" / "1 ticket" without plural keys (the three languages share
 *  one key tree, and Arabic's six plural forms would break that). */
export function countText(t: TFunction, n: number, one: string, many: string): string {
  return n === 1 ? t(one) : t(many, { count: n });
}

const KNOWN_STATUS = new Set(['todo', 'doing', 'blocked', 'done']);

function statusText(t: TFunction, status?: string): string | undefined {
  if (!status) return undefined;
  return KNOWN_STATUS.has(status) ? t(`wsMemory.ticket.status.${status}`) : status;
}

function statusTone(status?: string): 'neutral' | 'warn' | 'danger' | 'ok' | 'info' {
  switch (status) {
    case 'doing': return 'warn';
    case 'blocked': return 'danger';
    case 'done': return 'ok';
    case 'todo': return 'info';
    default: return 'neutral';
  }
}

interface RowShell {
  selected: boolean;
  onToggle: () => void;
  needles: string[];
  names: NameBook;
}

export function TicketRow({ ticket, onOpen, selected, onToggle, needles, names }: RowShell & {
  ticket: AnswerTicket;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const people = ticket.agentIds.map((id) => names.name(id));
  const status = statusText(t, ticket.status);
  return (
    <div className="cth-ws-memory-row" data-selected={selected || undefined}>
      <CheckBox checked={selected} onChange={onToggle} label={t('wsMemory.select.aria', { title: `${ticket.id} ${ticket.title}` })} />
      <button type="button" className="cth-ws-memory-row-main" onClick={onOpen} aria-label={t('wsMemory.ticket.open', { id: ticket.id })}>
        <span className="cth-ws-memory-row-top">
          <Chip tone="info">{t('wsMemory.chip.ticket')}</Chip>
          <span className="cth-ws-memory-row-id"><Title text={ticket.id} needles={needles} /></span>
          <span className="cth-ws-memory-row-title" dir="auto"><Title text={ticket.title} needles={needles} /></span>
          {status && <Chip tone={statusTone(ticket.status)}>{status}</Chip>}
        </span>
        <span className="cth-ws-memory-row-meta">
          {people.length ? people.join(', ') : t('wsMemory.ticket.nobody')}
          {ticket.mentioned && <> · {t('wsMemory.ticket.mentioned')}</>}
        </span>
        <Snippet snippet={ticket.snippet} />
      </button>
    </div>
  );
}

function LiveDot({ id, names }: { id: string; names: NameBook }) {
  const agent = names.live(id);
  const presence = useAgentPresence(agent);
  return agent ? <StatusDot status={presence.status} /> : null;
}

export function AgentRow({ agent, onOpen, selected, onToggle, needles, names }: RowShell & {
  agent: AnswerAgent;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const name = names.name(agent.id);
  const role = names.role(agent.id);
  const parts: string[] = [];
  if (names.isGod(agent.id)) parts.push(t('wsMemory.agent.orchestrator'));
  if (agent.tickets) parts.push(countText(t, agent.tickets, 'wsMemory.agent.ticketsOne', 'wsMemory.agent.tickets'));
  if (agent.notes) parts.push(countText(t, agent.notes, 'wsMemory.agent.notesOne', 'wsMemory.agent.notes'));
  if (!agent.tickets && !agent.notes && agent.direct) parts.push(t('wsMemory.agent.byName'));
  if (!names.live(agent.id)) parts.push(t('wsMemory.agent.left'));
  return (
    <div className="cth-ws-memory-row" data-selected={selected || undefined}>
      <CheckBox checked={selected} onChange={onToggle} label={t('wsMemory.select.aria', { title: name })} />
      <button type="button" className="cth-ws-memory-row-main" onClick={onOpen} aria-label={t('wsMemory.agent.open', { name })}>
        <span className="cth-ws-memory-row-top">
          <Chip tone="accent">{t('wsMemory.chip.agent')}</Chip>
          <LiveDot id={agent.id} names={names} />
          <span className="cth-ws-memory-row-title" dir="auto"><Title text={name} needles={needles} /></span>
        </span>
        {agent.snippet?.text
          ? <Snippet snippet={agent.snippet} />
          : role && <span className="cth-ws-memory-snippet" dir="auto">{role}</span>}
        {parts.length > 0 && <span className="cth-ws-memory-row-meta">{parts.join(' · ')}</span>}
      </button>
    </div>
  );
}

/** "from Dwight, Tuesday" / "from you" / "document" — who wrote a note, when. */
export function noteByline(t: TFunction, note: NoteHit, names: NameBook, when: string | undefined): string {
  if (note.source === 'notes') return when ? t('wsMemory.note.fromYouWhen', { when }) : t('wsMemory.note.fromYou');
  if (note.source === 'knowledge') return when ? t('wsMemory.note.documentWhen', { when }) : t('wsMemory.note.document');
  const name = note.authorId ? names.name(note.authorId) : t('wsMemory.note.unknown');
  return when ? t('wsMemory.note.fromWhen', { name, when }) : t('wsMemory.note.from', { name });
}

export function NoteRow({ note, onOpen, selected, onToggle, needles, names, when, active }: RowShell & {
  note: NoteHit;
  onOpen: () => void;
  when: string | undefined;
  /** Open in the drawer right now. */
  active: boolean;
}) {
  const { t } = useTranslation();
  const title = note.title || note.snippet.text;
  return (
    <div className="cth-ws-memory-row" data-selected={selected || active || undefined}>
      <CheckBox checked={selected} onChange={onToggle} label={t('wsMemory.select.aria', { title })} />
      <button
        type="button"
        className="cth-ws-memory-row-main"
        onClick={onOpen}
        aria-label={t('wsMemory.note.open', { title })}
        aria-expanded={active}
      >
        <span className="cth-ws-memory-row-top">
          <Chip tone="ok">{t('wsMemory.chip.note')}</Chip>
          <span className="cth-ws-memory-row-title" dir="auto"><Title text={title} needles={needles} /></span>
        </span>
        <Snippet snippet={note.snippet} />
        <span className="cth-ws-memory-row-meta">
          {noteByline(t, note, names, when)} · {t(`wsMemory.note.source.${note.source}`)}
        </span>
      </button>
    </div>
  );
}
