/**
 * The note itself: a side panel over the results with the full section (read
 * back from main by its ref — the search only carried a snippet), who wrote it
 * and where it lives, and what to do next: tick it for sending, open the room
 * of the agent who wrote it, or — for one of the user's own notes — edit it in
 * the sidebar's notes editor. The drawer itself stays read-only: an agent's
 * memory.md, the board and the graph are the agents' to write.
 *
 * Agent-written markdown renders through MarkdownPreview's `card` variant,
 * which has no HTML sink (see its SECURITY note). A MemPalace drawer has no
 * section to read back — it is its own record — so its verbatim text is shown.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { Button, Chip, IconButton, Spinner, WsIcon } from '../ui';
import type { MemoryNoteText, NoteHit } from '@shared/workspace/memoryTypes';
import { noteSlugFromFileName } from '@shared/workspace/sidebarNotes';
import { openSidebarNote } from '../sidebar/openNote';
import { noteByline } from './ResultRows';
import type { NameBook } from './useNames';

export interface NoteDrawerProps {
  note: NoteHit;
  names: NameBook;
  when: string | undefined;
  selected: boolean;
  onToggleSelect: () => void;
  onOpenAgent: (id: string) => void;
  onClose: () => void;
}

type Load = { phase: 'loading' } | { phase: 'done'; note: MemoryNoteText };

export function NoteDrawer({ note, names, when, selected, onToggleSelect, onOpenAgent, onClose }: NoteDrawerProps) {
  const { t } = useTranslation();
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    setCopied(false);
    if (note.ref.kind === 'palace') {
      setLoad({ phase: 'done', note: { ok: true, title: note.title, text: note.text ?? note.snippet.text, path: note.path } });
      return;
    }
    setLoad({ phase: 'loading' });
    window.cth.features.memory.readNote(note.ref)
      .then((res) => { if (live) setLoad({ phase: 'done', note: res }); })
      .catch((e: unknown) => {
        if (live) setLoad({ phase: 'done', note: { ok: false, title: '', text: '', error: e instanceof Error ? e.message : String(e) } });
      });
    return () => { live = false; };
  }, [note]);

  // Focus moves into the panel when it opens, and Escape closes it.
  useEffect(() => {
    closeRef.current?.querySelector('button')?.focus();
  }, [note.key]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented) { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const loaded = load.phase === 'done' ? load.note : null;
  const path = loaded?.path ?? note.path;
  const moved = !!loaded?.ok && loaded.title === '' && (note.ref.kind === 'memory' || note.ref.kind === 'board');
  const author = note.authorId;
  // Only a file the sidebar itself would list (`<slug>.md` in <hive>/notes)
  // opens there; a hand-made `Draft 2.txt` in the same folder stays read-only.
  const sidebarSlug = note.ref.kind === 'notes' ? noteSlugFromFileName(note.ref.file) : null;

  const copyPath = async () => {
    if (!path) return;
    try {
      const r = await window.cth.copyToClipboard(path);
      setCopied(r.ok);
    } catch { setCopied(false); }
  };

  return (
    <aside className="cth-ws-memory-drawer" role="dialog" aria-label={t('wsMemory.drawer.aria')}>
      <div className="cth-ws-memory-drawer-head">
        <Chip tone="ok">{t('wsMemory.chip.note')}</Chip>
        <h2 className="cth-ws-memory-drawer-title" dir="auto">{loaded?.ok && loaded.title ? loaded.title : note.title}</h2>
        <div ref={closeRef}>
          <IconButton label={t('wsMemory.drawer.close')} onClick={onClose} size="sm"><WsIcon name="close" /></IconButton>
        </div>
      </div>
      <div className="cth-ws-memory-drawer-meta">
        <span>{noteByline(t, note, names, when)} · {t(`wsMemory.note.source.${note.source}`)}</span>
        {path && <span className="cth-ws-memory-drawer-path" title={path}>{path}</span>}
        {loaded?.truncated && <span>{t('wsMemory.drawer.truncated')}</span>}
        {moved && <span>{t('wsMemory.drawer.moved')}</span>}
      </div>
      <div className="cth-ws-memory-drawer-body">
        {load.phase === 'loading' && (
          <div className="cth-ws-memory-status"><Spinner label={t('wsMemory.drawer.loading')} />{t('wsMemory.drawer.loading')}</div>
        )}
        {loaded && !loaded.ok && (
          <div className="cth-ws-memory-error" dir="auto">{t('wsMemory.drawer.error', { error: loaded.error ?? '' })}</div>
        )}
        {loaded?.ok && <MarkdownPreview source={loaded.text} variant="card" />}
      </div>
      <div className="cth-ws-memory-drawer-actions">
        <Button
          variant={selected ? 'secondary' : 'primary'}
          size="sm"
          icon={selected ? <WsIcon name="check" /> : undefined}
          onClick={onToggleSelect}
        >
          {selected ? t('wsMemory.drawer.selected') : t('wsMemory.drawer.select')}
        </Button>
        {sidebarSlug && (
          <Button
            variant="secondary"
            size="sm"
            title={t('wsMemory.drawer.editInSidebarTip')}
            onClick={() => { if (openSidebarNote(sidebarSlug)) onClose(); }}
          >
            {t('wsMemory.drawer.editInSidebar')}
          </Button>
        )}
        {author && (
          <Button variant="secondary" size="sm" onClick={() => onOpenAgent(author)}>
            {t('wsMemory.agent.open', { name: names.name(author) })}
          </Button>
        )}
        {path && (
          <Button variant="ghost" size="sm" onClick={() => { void copyPath(); }}>
            {copied ? t('wsMemory.drawer.copied') : t('wsMemory.drawer.copyPath')}
          </Button>
        )}
      </div>
    </aside>
  );
}
