/**
 * Memory: ask the floor what it knows, by exact words or by meaning.
 * Owned by the `wsMemory` unit.
 *
 * Everything the agents learn — their memory.md entries, the tickets, the
 * board, the user's own notes — searched two ways side by side: the exact
 * words (main scans the files, bounded) and by meaning (MemPalace). Both
 * answer in three shapes: the tickets, the agents who worked on them, and
 * their notes, each linking to where it lives. Tick results and send them to
 * an agent with a prompt. A Graph view shows the same floor as agents and the
 * messages between them (the Classic memory graph, embedded).
 *
 * The route carries the query (`{ kind: 'memory', query }`), so a search
 * survives switching screens and can be opened from elsewhere.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { MemoryGraphPanel } from '@/components/MemoryGraphPanel';
import { Button, EmptyState, Screen, ScreenHeader, SearchInput, SegmentedControl, WsIcon } from '../ui';
import { loadWsPref, saveWsPref, useWorkspace } from '../store';
import type { WorkspaceScreenProps } from '../types';
import type { NoteHit } from '@shared/workspace/memoryTypes';
import type { SelectedResult } from '@shared/workspace/memoryContext';
import { LaneColumn, resultKey, type Selection } from '../memory/LaneColumn';
import { NoteDrawer } from '../memory/NoteDrawer';
import { SendBar } from '../memory/SendBar';
import { countText } from '../memory/ResultRows';
import { useMemorySearch } from '../memory/useMemorySearch';
import { useNameBook, useWhen } from '../memory/useNames';
import '../memory/memory.css';

export interface MemoryScreenProps extends WorkspaceScreenProps {
  /** A search to run on open (route param). */
  query?: string;
}

type View = 'results' | 'graph';
const isView = (v: unknown): v is View => v === 'results' || v === 'graph';

export function MemoryScreen({ config, query }: MemoryScreenProps) {
  const { t } = useTranslation();
  void config;
  const navigate = useWorkspace((s) => s.navigate);
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const godId = useStore((s) => s.agents.find((a) => a.isGod)?.id ?? '');

  const search = useMemorySearch();
  const [input, setInput] = useState(query ?? search.submitted);
  const [view, setView] = useState<View>(() => loadWsPref<View>('memory.view', 'results', isView));
  // Ticked results, with the search each came from: a selection can gather
  // results across several searches before it is sent.
  const [selected, setSelected] = useState<Map<string, { item: SelectedResult; query: string }>>(() => new Map());
  const [openNote, setOpenNote] = useState<NoteHit | null>(null);
  const lastRun = useRef<string | null>(null);

  const exactAnswer = search.exact.result?.answer;
  const meaningAnswer = search.meaning.result?.answer;
  const answers = useMemo(() => [exactAnswer, meaningAnswer], [exactAnswer, meaningAnswer]);
  const names = useNameBook(answers);
  const when = useWhen();

  const submit = useCallback((raw: string) => {
    const q = raw.replace(/\s+/g, ' ').trim();
    lastRun.current = q;
    setOpenNote(null);
    search.run(q);
    // Keep the query in the route: it survives a trip to another screen and
    // is what a link to "memory for X" sets.
    navigate(q ? { kind: 'memory', query: q } : { kind: 'memory' });
  }, [search, navigate]);

  // A query arriving by route (a link, or coming back to the screen) runs once.
  useEffect(() => {
    const q = (query ?? '').trim();
    if (q) {
      if (q === lastRun.current) return;
      lastRun.current = q;
      setInput(q);
      search.run(q, { reuse: true });
      return;
    }
    // The route lost its query (the sidebar links to plain Memory) while the
    // screen still holds an answer: put the query back rather than wipe it.
    if (search.submitted) navigate({ kind: 'memory', query: search.submitted });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const selection: Selection = useMemo(() => ({
    has: (key) => selected.has(key),
    toggle: (key, item) => setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key); else next.set(key, { item, query: search.submitted });
      return next;
    })
  }), [selected, search.submitted]);

  const openAgent = useCallback((id: string) => {
    navigate(names.isGod(id) ? { kind: 'orchestrator' } : { kind: 'agent', agentId: id });
  }, [navigate, names]);

  const openSettings = (section: string) =>
    window.dispatchEvent(new CustomEvent('cth:open-settings', { detail: { section } }));

  const turnOnMeaning = async () => {
    try { await window.cth.updateConfig({ semanticMemory: true }); } catch { /* the status re-check shows the truth */ }
    await search.rerunMeaning();
  };

  const stats = search.stats;
  const subtitle = stats && stats.state === 'ok' ? (
    <span title={stats.partial ? `${t('wsMemory.header.statsTip')} ${t('wsMemory.header.partial')}` : t('wsMemory.header.statsTip')}>
      {countText(t, stats.topics, 'wsMemory.header.topicsOne', 'wsMemory.header.topics')}
      {' · '}
      {t('wsMemory.header.stats', { tickets: stats.tickets, agents: stats.agentsWithMemory, notes: stats.notes })}
      {stats.documents > 0 && <> · {t('wsMemory.header.documents', { count: stats.documents })}</>}
    </span>
  ) : undefined;

  const viewSwitch = (
    <SegmentedControl<View>
      size="sm"
      ariaLabel={t('wsMemory.view.label')}
      value={view}
      onChange={(v) => { setView(v); saveWsPref('memory.view', v); }}
      options={[
        { value: 'results', label: t('wsMemory.view.results') },
        { value: 'graph', label: t('wsMemory.view.graph') }
      ]}
    />
  );

  const selectedList = useMemo(() => [...selected.values()].map((s) => s.item), [selected]);
  // Name the search in the context block only when every result came from it.
  const selectedQuery = useMemo(() => {
    const qs = new Set([...selected.values()].map((s) => s.query));
    return qs.size === 1 ? [...qs][0] : '';
  }, [selected]);
  const noteKey = openNote ? resultKey(openNote) : null;
  const searched = !!search.submitted;

  return (
    <Screen header={<ScreenHeader title={t('wsMemory.title')} subtitle={subtitle} actions={viewSwitch} />} fill>
      {view === 'graph' ? (
        <div className="cth-ws-memory-graph">
          <MemoryGraphPanel godId={godId} onJumpToMemory={openAgent} />
        </div>
      ) : (
        <div className="cth-ws-memory">
          <div className="cth-ws-memory-bar" role="search">
            <SearchInput
              value={input}
              onChange={(v) => { setInput(v); if (!v) submit(''); }}
              onSubmit={submit}
              placeholder={t('wsMemory.search.placeholder')}
              ariaLabel={t('wsMemory.search.aria')}
              autoFocus
            />
            <Button variant="primary" icon={<WsIcon name="search" />} disabled={!input.trim()} onClick={() => submit(input)}>
              {t('wsMemory.search.button')}
            </Button>
          </div>

          <div className="cth-ws-memory-scroll">
            {!searched ? (
              <EmptyState
                icon={<WsIcon name="memory" size={24} />}
                title={t('wsMemory.intro.title')}
                body={<>{t('wsMemory.intro.body')}<br /><br />{t('wsMemory.intro.hint')}</>}
              />
            ) : (
              <div className="cth-ws-memory-lanes">
                <LaneColumn
                  lane="exact"
                  view={search.exact}
                  query={search.submitted}
                  names={names}
                  selection={selection}
                  openNoteKey={noteKey}
                  onOpenTicket={openTaskDetail}
                  onOpenAgent={openAgent}
                  onOpenNote={setOpenNote}
                />
                <LaneColumn
                  lane="meaning"
                  view={search.meaning}
                  query={search.submitted}
                  names={names}
                  selection={selection}
                  openNoteKey={noteKey}
                  onOpenTicket={openTaskDetail}
                  onOpenAgent={openAgent}
                  onOpenNote={setOpenNote}
                  palace={search.palace}
                  palaceChecking={search.palaceChecking}
                  onRetry={() => { void search.rerunMeaning(); }}
                  onSetUp={() => openSettings('Prerequisites')}
                  onTurnOn={() => { void turnOnMeaning(); }}
                />
              </div>
            )}
          </div>

          <SendBar
            selected={selectedList}
            query={selectedQuery}
            names={names}
            onClear={() => setSelected(new Map())}
          />

          {openNote && (
            <NoteDrawer
              note={openNote}
              names={names}
              when={when(openNote.at)}
              selected={selection.has(resultKey(openNote))}
              onToggleSelect={() => selection.toggle(resultKey(openNote), openNote)}
              onOpenAgent={openAgent}
              onClose={() => setOpenNote(null)}
            />
          )}
        </div>
      )}
    </Screen>
  );
}
