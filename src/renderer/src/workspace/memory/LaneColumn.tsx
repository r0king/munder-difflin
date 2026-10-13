/**
 * One search lane — "Exact matches" or "By meaning" — with its own label,
 * state and the answer in three shapes. Both lanes render through this so they
 * read as one product; only the meaning lane has a prerequisite to explain.
 */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Chip, Section, Spinner } from '../ui';
import { needlesOf, parseQuery } from '@shared/workspace/memoryQuery';
import type { AnswerAgent, AnswerTicket, MemoryLane, NoteHit } from '@shared/workspace/memoryTypes';
import type { SelectedResult } from '@shared/workspace/memoryContext';
import { AgentRow, NoteRow, TicketRow, countText } from './ResultRows';
import { palaceUsable, type LaneView, type PalaceStatus } from './useMemorySearch';
import { useWhen, type NameBook } from './useNames';

/** Rows shown per shape before "Show all". */
const FIRST_ROWS = 5;

export interface Selection {
  has(key: string): boolean;
  toggle(key: string, item: SelectedResult): void;
}

export const resultKey = (r: SelectedResult): string =>
  r.kind === 'note' ? `note:${r.key}` : `${r.kind}:${r.id}`;

export interface LaneColumnProps {
  lane: MemoryLane;
  view: LaneView;
  query: string;
  names: NameBook;
  selection: Selection;
  openNoteKey: string | null;
  onOpenTicket: (id: string) => void;
  onOpenAgent: (id: string) => void;
  onOpenNote: (note: NoteHit) => void;
  /** Meaning lane only. */
  palace?: PalaceStatus | null;
  palaceChecking?: boolean;
  onRetry?: () => void;
  onSetUp?: () => void;
  onTurnOn?: () => void;
}

function Shape<T>({ title, items, total, render }: {
  title: string;
  items: readonly T[];
  total: number;
  render: (item: T) => ReactNode;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, FIRST_ROWS);
  return (
    <Section title={title} count={total}>
      <div className="cth-ws-memory-rows">{shown.map(render)}</div>
      {items.length > FIRST_ROWS && (
        <Button variant="ghost" size="sm" className="cth-ws-memory-more" onClick={() => setAll((v) => !v)}>
          {all ? t('wsMemory.shapes.showFewer') : t('wsMemory.shapes.showAll', { count: items.length })}
        </Button>
      )}
    </Section>
  );
}

export function LaneColumn(props: LaneColumnProps) {
  const { t } = useTranslation();
  const { lane, view, query, names, selection } = props;
  const when = useWhen();
  const needles = (() => { const q = parseQuery(query); return q ? needlesOf(q) : []; })();
  const result = view.result;
  const answer = result?.ok ? result.answer : null;
  const total = answer ? answer.totals.tickets + answer.totals.agents + answer.totals.notes : 0;

  const title = lane === 'exact' ? t('wsMemory.lane.exact') : t('wsMemory.lane.meaning');
  const hint = lane === 'exact' ? t('wsMemory.lane.exactHint') : t('wsMemory.lane.meaningHint');

  let body: ReactNode;
  const status = (node: ReactNode) => <div className="cth-ws-memory-status">{node}</div>;

  if (lane === 'meaning' && props.palaceChecking && !props.palace && view.phase !== 'done') {
    body = status(<><Spinner label={t('wsMemory.meaning.checking')} />{t('wsMemory.meaning.checking')}</>);
  } else if (lane === 'meaning' && (!palaceUsable(props.palace ?? null) || result?.state === 'not-installed' || result?.state === 'disabled')) {
    const off = (!!props.palace?.available && !props.palace.enabled) || result?.state === 'disabled';
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cth-space-2)' }}>
        <div className="cth-ws-memory-status" style={{ fontWeight: 600 }}>
          {off ? t('wsMemory.meaning.disabledTitle') : t('wsMemory.meaning.notInstalledTitle')}
        </div>
        <div className="cth-ws-memory-sub">{off ? t('wsMemory.meaning.disabledBody') : t('wsMemory.meaning.notInstalledBody')}</div>
        <div className="cth-ws-memory-send-row">
          {off
            ? <Button variant="primary" size="sm" onClick={props.onTurnOn}>{t('wsMemory.meaning.turnOn')}</Button>
            : <Button variant="primary" size="sm" onClick={props.onSetUp}>{t('wsMemory.meaning.setUp')}</Button>}
          <Button variant="ghost" size="sm" onClick={props.onRetry}>{t('wsMemory.meaning.checkAgain')}</Button>
        </div>
      </div>
    );
  } else if (view.phase === 'idle') {
    body = null;
  } else if (view.phase === 'loading') {
    body = lane === 'exact'
      ? status(<><Spinner label={t('wsMemory.exact.searching')} />{t('wsMemory.exact.searching')}</>)
      : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cth-space-1)' }}>
          {status(<><Spinner label={t('wsMemory.meaning.searching')} />{t('wsMemory.meaning.searching')}</>)}
          <div className="cth-ws-memory-sub">{t('wsMemory.meaning.slow')}</div>
        </div>
      );
  } else if (result && !result.ok) {
    if (result.state === 'no-hive') {
      body = status(t('wsMemory.exact.noHive'));
    } else if (result.state === 'not-ready') {
      body = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cth-space-1)' }}>
          <div className="cth-ws-memory-status" style={{ fontWeight: 600 }}>{t('wsMemory.meaning.notReadyTitle')}</div>
          <div className="cth-ws-memory-sub">{t('wsMemory.meaning.notReadyBody')}</div>
          <div><Button variant="ghost" size="sm" onClick={props.onRetry}>{t('wsMemory.meaning.retry')}</Button></div>
        </div>
      );
    } else {
      const error = result.error || '';
      body = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cth-space-2)' }}>
          <div className="cth-ws-memory-error" dir="auto">
            {lane === 'exact' ? t('wsMemory.exact.error', { error }) : t('wsMemory.meaning.error', { error })}
          </div>
          {lane === 'meaning' && <div><Button variant="secondary" size="sm" onClick={props.onRetry}>{t('wsMemory.meaning.retry')}</Button></div>}
        </div>
      );
    }
  } else if (answer) {
    const key = (r: AnswerTicket | AnswerAgent | NoteHit) => resultKey(r);
    body = (
      <>
        {result?.partial && <Chip tone="warn">{t('wsMemory.exact.partial')}</Chip>}
        {result?.notice && <div className="cth-ws-memory-sub" dir="auto">{result.notice}</div>}
        {result?.raw && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cth-space-1)' }}>
            <div className="cth-ws-memory-sub">{t('wsMemory.meaning.unparsed')}</div>
            <pre className="cth-ws-memory-raw" dir="auto">{result.raw}</pre>
          </div>
        )}
        {total === 0 && !result?.raw && (
          lane === 'exact'
            ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cth-space-1)' }}>
                <div className="cth-ws-memory-status">{t('wsMemory.exact.none', { query })}</div>
                <div className="cth-ws-memory-sub">{t('wsMemory.exact.noneHint')}</div>
              </div>
            )
            : status(t('wsMemory.meaning.none', { query }))
        )}
        <Shape
          key={`${query}:tickets`}
          title={t('wsMemory.shapes.tickets')}
          items={answer.tickets}
          total={answer.totals.tickets}
          render={(tk) => (
            <TicketRow
              key={key(tk)}
              ticket={tk}
              names={names}
              needles={needles}
              selected={selection.has(key(tk))}
              onToggle={() => selection.toggle(key(tk), tk)}
              onOpen={() => props.onOpenTicket(tk.id)}
            />
          )}
        />
        <Shape
          key={`${query}:agents`}
          title={t('wsMemory.shapes.agents')}
          items={answer.agents}
          total={answer.totals.agents}
          render={(ag) => (
            <AgentRow
              key={key(ag)}
              agent={ag}
              names={names}
              needles={needles}
              selected={selection.has(key(ag))}
              onToggle={() => selection.toggle(key(ag), ag)}
              onOpen={() => props.onOpenAgent(ag.id)}
            />
          )}
        />
        <Shape
          key={`${query}:notes`}
          title={t('wsMemory.shapes.notes')}
          items={answer.notes}
          total={answer.totals.notes}
          render={(n) => (
            <NoteRow
              key={key(n)}
              note={n}
              names={names}
              needles={needles}
              when={when(n.at)}
              active={props.openNoteKey === key(n)}
              selected={selection.has(key(n))}
              onToggle={() => selection.toggle(key(n), n)}
              onOpen={() => props.onOpenNote(n)}
            />
          )}
        />
      </>
    );
  }

  return (
    <section className="cth-ws-memory-lane" aria-label={title} aria-busy={view.phase === 'loading'}>
      <header className="cth-ws-memory-lane-head">
        <h2 className="cth-ws-memory-lane-title">
          {title}
          {answer && view.phase === 'done' && (
            <span className="cth-ws-memory-lane-count">
              {countText(t, total, 'wsMemory.lane.countOne', 'wsMemory.lane.count')}
            </span>
          )}
        </h2>
        <span className="cth-ws-memory-lane-hint">{hint}</span>
      </header>
      {body && <div className="cth-ws-memory-lane-body">{body}</div>}
    </section>
  );
}
