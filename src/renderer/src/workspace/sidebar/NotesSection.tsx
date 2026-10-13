/**
 * Notes you can search — the user's own quick markdown notes, kept as files
 * in the hive (`<harnessHome>/hive/notes/<slug>.md`) so every agent can read
 * them. Create, rename, edit in a small editor pane right here, delete, search
 * titles and text, and "Send to…" any agent through deliverToAgent.
 *
 * The files are main's (src/main/features/sidebar.ts). This side never builds
 * a path: it names notes by slug, and every write carries the version it was
 * loaded at, so a note an agent changed in the meantime comes back as a
 * conflict to resolve instead of being overwritten. The folder is watched, so
 * an agent's edit (or another floor's) shows up here on its own.
 *
 * Saving follows the Workspace rule — no Save button: the body saves a moment
 * after you stop typing and when you leave it; a title saves on Enter or blur.
 *
 * Other screens open a note here with `openSidebarNote(slug)` (./openNote.ts).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { isComposingKey } from '@shared/imeGuard';
import {
  NOTE_TITLE_MAX,
  noteDeliveryText,
  type NoteDoc,
  type NoteErrorCode,
  type NoteMeta,
  type NoteSearchHit
} from '@shared/workspace/sidebarNotes';
import type { DeliverTarget } from '@shared/features/deliver';
import { deliverToAgent } from '../deliver';
import { Button, IconButton, SearchInput, Spinner, WsIcon } from '../ui';
import { MenuList, Popover, type MenuEntry, type PopoverAnchor } from './Popover';
import { relativeTime } from './format';
import { useSidebarNoteRequest } from './openNote';

const SAVE_DEBOUNCE_MS = 800;
const SEARCH_DEBOUNCE_MS = 180;

function api() {
  return window.cth?.features?.sidebar;
}

/** Stable for a language (it sits in useCallback deps below). */
function useErrorText(): (code: NoteErrorCode | string, message?: string) => string {
  const { t } = useTranslation();
  return useCallback((code: NoteErrorCode | string, message?: string) => {
    switch (code) {
      case 'no-hive': return t('wsSidebar.notes.errors.noHive');
      case 'not-found': return t('wsSidebar.notes.errors.notFound');
      case 'conflict': return t('wsSidebar.notes.errors.conflict');
      case 'invalid': return t('wsSidebar.notes.errors.invalid');
      default: return t('wsSidebar.notes.errors.io', { message: message ?? code });
    }
  }, [t]);
}

/** The snippet with its match marked. */
function Snippet({ hit }: { hit: NoteSearchHit }): ReactNode {
  if (!hit.snippet) return null;
  const { snippet, matchStart: a, matchLength: n } = hit;
  if (n <= 0 || a < 0 || a + n > snippet.length) return snippet;
  return <>{snippet.slice(0, a)}<mark>{snippet.slice(a, a + n)}</mark>{snippet.slice(a + n)}</>;
}

// ─── Send to… ───────────────────────────────────────────────────────────────

/** Deliver a note (fresh from disk) to an agent's queue. */
async function sendNote(slug: string, target: DeliverTarget): Promise<{ ok: boolean; error?: string }> {
  const read = await api()?.notesRead(slug);
  if (!read) return { ok: false, error: 'io' };
  if (!read.ok) return { ok: false, error: read.error };
  const { text, attachments } = noteDeliveryText(read.note);
  return deliverToAgent({ target, text, attachments, mode: 'queue', source: 'sidebar-note' });
}

function SendMenu({ slug, anchor, onClose, onSent }: {
  slug: string;
  anchor: PopoverAnchor;
  onClose: () => void;
  onSent: (msg: { text: string; error?: boolean }) => void;
}) {
  const { t } = useTranslation();
  const agents = useStore((s) => s.agents);
  const god = agents.find((a) => a.isGod);
  const others = agents.filter((a) => !a.isGod && !a.isAssistant && a.ptyId);
  const go = (target: DeliverTarget, name: string) => {
    void sendNote(slug, target).then((res) => {
      onSent(res.ok
        ? { text: t('wsSidebar.notes.sent', { name }) }
        : { text: t('wsSidebar.notes.sendFailed', { name, error: res.error ?? '' }), error: true });
    });
  };
  const entries: MenuEntry[] = [{ key: 'head', header: t('wsSidebar.notes.sendTo') }];
  entries.push({
    key: 'god',
    label: god?.name ?? t('wsSidebar.agents.orchestrator'),
    hint: t('wsSidebar.agents.orchestrator'),
    onSelect: () => go({ kind: 'orchestrator' }, god?.name ?? t('wsSidebar.agents.orchestrator'))
  });
  for (const a of others) {
    entries.push({ key: a.id, label: a.name, onSelect: () => go({ kind: 'agent', agentId: a.id }, a.name) });
  }
  if (!others.length) entries.push({ key: 'none', note: t('wsSidebar.notes.sendOnlyOrchestrator') });
  return (
    <Popover anchor={anchor} onClose={onClose} role="menu" ariaLabel={t('wsSidebar.notes.sendTo')} autoFocus>
      <MenuList entries={entries} onClose={onClose} />
    </Popover>
  );
}

// ─── Editor ─────────────────────────────────────────────────────────────────

type SaveState = 'loading' | 'saved' | 'dirty' | 'saving' | 'conflict' | 'error' | 'gone';

function NoteEditor({ slug, focus, onClose, onSlugChange, onFlash }: {
  slug: string;
  focus: 'title' | 'body';
  onClose: () => void;
  onSlugChange: (slug: string) => void;
  onFlash: (msg: { text: string; error?: boolean }) => void;
}) {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const openFileInIde = useStore((s) => s.openFileInIde);
  const [doc, setDoc] = useState<NoteDoc | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [state, setState] = useState<SaveState>('loading');
  const [error, setError] = useState('');
  const [theirs, setTheirs] = useState<NoteDoc | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [send, setSend] = useState<PopoverAnchor | null>(null);
  // Refs for the async paths, which must see the latest values.
  const docRef = useRef<NoteDoc | null>(null);
  const bodyRef = useRef('');
  const dirtyRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyElRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<HTMLSpanElement>(null);

  const adopt = useCallback((next: NoteDoc) => {
    docRef.current = next;
    setDoc(next);
    setTitle(next.title);
    if (!dirtyRef.current) { bodyRef.current = next.body; setBody(next.body); }
  }, []);

  // Load (and reload when the folder changes under a clean editor).
  const load = useCallback(async (initial: boolean) => {
    const res = await api()?.notesRead(slug);
    if (!res) return;
    if (!res.ok) {
      if (res.error === 'not-found') setState('gone');
      else { setState('error'); setError(errorText(res.error, res.message)); }
      return;
    }
    if (!initial && dirtyRef.current) return;
    if (!initial && docRef.current && Math.abs(docRef.current.updatedAt - res.note.updatedAt) <= 1) return;
    adopt(res.note);
    setState('saved');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, adopt]);

  useEffect(() => {
    dirtyRef.current = false;
    setState('loading');
    void load(true).then(() => {
      requestAnimationFrame(() => {
        if (focus === 'title') { titleRef.current?.focus(); titleRef.current?.select(); }
        else bodyElRef.current?.focus();
      });
    });
    const off = api()?.onNotesChanged(() => { void load(false); });
    return () => { off?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  /** Write the body now. `force` overwrites whatever is on disk (Keep mine). */
  const save = useCallback(async (force = false): Promise<void> => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (!docRef.current || (!dirtyRef.current && !force)) return;
    // One write at a time; the next one is versioned against what the last
    // one produced, so it is read only after waiting.
    if (saving.current) { await saving.current; if (!dirtyRef.current && !force) return; }
    const current = docRef.current;
    if (!current) return;
    const text = bodyRef.current;
    setState('saving');
    const run = (async () => {
      const res = await api()?.notesWrite({
        slug: current.slug,
        title: current.title,
        body: text,
        expectedUpdatedAt: force ? undefined : current.updatedAt
      });
      if (!res) return;
      if (res.ok) {
        docRef.current = res.note;
        setDoc(res.note);
        setTheirs(null);
        // Typed more while the save was in flight: still dirty.
        dirtyRef.current = bodyRef.current !== text;
        setState(dirtyRef.current ? 'dirty' : 'saved');
      } else if (res.error === 'conflict') {
        setTheirs(res.current ?? null);
        setState('conflict');
      } else if (res.error === 'not-found') {
        setState('gone');
      } else {
        setState('error');
        setError(errorText(res.error, res.message));
      }
    })();
    saving.current = run;
    try { await run; } finally { if (saving.current === run) saving.current = null; }
  }, [errorText]);

  // Flush on close/unmount (switching notes, collapsing the sidebar) — once,
  // through a ref, so a re-render never counts as an unmount.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => () => { if (dirtyRef.current) void saveRef.current(); }, []);

  const onBody = (v: string) => {
    bodyRef.current = v;
    setBody(v);
    dirtyRef.current = true;
    if (state !== 'conflict') setState('dirty');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (state !== 'conflict') saveTimer.current = setTimeout(() => { void save(); }, SAVE_DEBOUNCE_MS);
  };

  const commitTitle = async () => {
    const current = docRef.current;
    const next = title.replace(/\s+/g, ' ').trim();
    if (!current) return;
    if (!next || next === current.title) { setTitle(current.title); return; }
    // The rename re-reads the body from disk, so land the body first.
    if (dirtyRef.current) await save();
    const res = await api()?.notesRename({ slug: current.slug, title: next });
    if (!res) return;
    if (res.ok) {
      adopt(res.note);
      if (res.note.slug !== slug) onSlugChange(res.note.slug);
    } else {
      setTitle(current.title);
      onFlash({ text: errorText(res.error, res.message), error: true });
    }
  };

  const remove = async () => {
    const current = docRef.current;
    if (!current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    dirtyRef.current = false;
    const res = await api()?.notesDelete(current.slug);
    if (res?.ok || res?.error === 'not-found') {
      onFlash({ text: t('wsSidebar.notes.deleted', { title: current.title }) });
      onClose();
    } else if (res) {
      onFlash({ text: errorText(res.error, res.message), error: true });
    }
  };

  const stateLine = (() => {
    switch (state) {
      case 'loading': return t('wsSidebar.notes.loading');
      case 'saving': return t('wsSidebar.notes.saving');
      case 'dirty': return t('wsSidebar.notes.unsaved');
      case 'saved': return doc ? t('wsSidebar.notes.savedAt', { when: relativeTime(doc.updatedAt, Date.now(), i18n.language) }) : '';
      default: return '';
    }
  })();

  if (state === 'gone') {
    return (
      <div className="cth-ws-sidebar-editor">
        <div className="cth-ws-sidebar-banner cth-ws-sidebar-banner--error">
          {t('wsSidebar.notes.errors.notFound')}
          <div className="cth-ws-sidebar-banner-actions">
            <Button size="sm" onClick={onClose}>{t('wsSidebar.notes.close')}</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="cth-ws-sidebar-editor" role="region" aria-label={t('wsSidebar.notes.editorLabel', { title: doc?.title ?? '' })}>
      <div className="cth-ws-sidebar-editor-top">
        <input
          ref={titleRef}
          className="cth-ws-sidebar-editor-title"
          value={title}
          maxLength={NOTE_TITLE_MAX}
          disabled={!doc}
          aria-label={t('wsSidebar.notes.titleLabel')}
          placeholder={t('wsSidebar.notes.untitled')}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => { void commitTitle(); }}
          onKeyDown={(e) => {
            if (isComposingKey(e.nativeEvent)) return;
            if (e.key === 'Enter') { e.preventDefault(); bodyElRef.current?.focus(); }
            else if (e.key === 'Escape') { e.preventDefault(); setTitle(docRef.current?.title ?? ''); bodyElRef.current?.focus(); }
          }}
        />
        <IconButton label={t('wsSidebar.notes.close')} size="sm" onClick={() => { void save().finally(onClose); }}>
          <WsIcon name="close" />
        </IconButton>
      </div>

      {state === 'conflict' && (
        <div className="cth-ws-sidebar-banner" role="alert">
          {t('wsSidebar.notes.conflict')}
          <div className="cth-ws-sidebar-banner-actions">
            <Button size="sm" onClick={() => {
              if (!theirs) { void load(true); return; }
              dirtyRef.current = false;
              adopt(theirs);
              setTheirs(null);
              setState('saved');
            }}>{t('wsSidebar.notes.loadTheirs')}</Button>
            <Button size="sm" variant="ghost" onClick={() => { dirtyRef.current = true; void save(true); }}>
              {t('wsSidebar.notes.keepMine')}
            </Button>
          </div>
        </div>
      )}
      {state === 'error' && (
        <div className="cth-ws-sidebar-banner cth-ws-sidebar-banner--error" role="alert">
          {error}
          <div className="cth-ws-sidebar-banner-actions">
            <Button size="sm" onClick={() => { dirtyRef.current = true; void save(); }}>{t('wsSidebar.notes.retry')}</Button>
          </div>
        </div>
      )}

      {state === 'loading' && !doc ? (
        <Spinner label={t('wsSidebar.notes.loading')} />
      ) : (
        <textarea
          ref={bodyElRef}
          className="cth-ws-sidebar-editor-body"
          value={body}
          spellCheck
          aria-label={t('wsSidebar.notes.bodyLabel')}
          placeholder={t('wsSidebar.notes.bodyPlaceholder')}
          rows={10}
          onChange={(e) => onBody(e.target.value)}
          onBlur={() => { if (state !== 'conflict') void save(); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !isComposingKey(e.nativeEvent)) { e.preventDefault(); void save().finally(onClose); }
          }}
        />
      )}

      <div className="cth-ws-sidebar-editor-foot">
        <span className="cth-ws-sidebar-editor-state" aria-live="polite">{stateLine}</span>
        <span ref={sendRef} style={{ display: 'inline-flex' }}>
          <IconButton
            label={t('wsSidebar.notes.sendTo')}
            size="sm"
            disabled={!doc}
            onClick={() => {
              // Land the latest text first: the agent gets what is on disk.
              void save().then(() => {
                const rect = sendRef.current?.getBoundingClientRect();
                if (rect) setSend({ kind: 'above', rect });
              });
            }}
          >
            <WsIcon name="send" />
          </IconButton>
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={!doc}
          title={t('wsSidebar.notes.openInIde')}
          onClick={() => { if (docRef.current) void save().then(() => openFileInIde(docRef.current!.path)); }}
        >
          {t('wsSidebar.notes.ide')}
        </Button>
        <Button
          size="sm"
          variant={confirmDelete ? 'danger' : 'ghost'}
          disabled={!doc}
          onClick={() => { if (confirmDelete) void remove(); else setConfirmDelete(true); }}
        >
          {confirmDelete ? t('wsSidebar.notes.deleteConfirm') : t('wsSidebar.notes.delete')}
        </Button>
      </div>

      {send && doc && (
        <SendMenu slug={doc.slug} anchor={send} onClose={() => setSend(null)} onSent={onFlash} />
      )}
    </div>
  );
}

// ─── Section ────────────────────────────────────────────────────────────────

export function NotesSection({ harnessHome }: { harnessHome: string | null }) {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const [notes, setNotes] = useState<NoteMeta[] | null>(null);
  const [listError, setListError] = useState<{ code: NoteErrorCode; message?: string } | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<NoteSearchHit[] | null>(null);
  const [open, setOpen] = useState<{ slug: string; focus: 'title' | 'body' } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [menu, setMenu] = useState<{ slug: string; title: string; anchor: PopoverAnchor; send?: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ text: string; error?: boolean } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sectionRef = useRef<HTMLElement>(null);

  // A note another screen asked for (Memory's "Edit in sidebar"): open it,
  // and bring the editor into view — Notes sits below the agents, often out
  // of sight. An open editor on another note flushes its own save on unmount.
  const request = useSidebarNoteRequest((s) => s.pending);
  const reveal = useRef(false);
  useEffect(() => {
    if (!request) return;
    useSidebarNoteRequest.getState().take(request.seq);
    setCreating(false);
    setMenu(null);
    reveal.current = true;
    setOpen({ slug: request.slug, focus: 'body' });
  }, [request]);
  // After the commit that put the editor in the DOM.
  useEffect(() => {
    if (!open || !reveal.current) return;
    reveal.current = false;
    sectionRef.current?.querySelector('.cth-ws-sidebar-editor')?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  const showFlash = useCallback((msg: { text: string; error?: boolean }) => {
    setFlash(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), msg.error ? 6000 : 3000);
  }, []);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  const refresh = useCallback(async () => {
    const a = api();
    if (!a) { setListError({ code: 'io', message: 'no bridge' }); return; }
    try {
      const res = await a.notesList();
      if (res.ok) { setNotes(res.notes); setTruncated(res.truncated); setListError(null); }
      else { setListError({ code: res.error, message: res.message }); setNotes([]); }
    } catch (e) {
      setListError({ code: 'io', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    setNotes(null);
    void refresh();
    const off = api()?.onNotesChanged(() => { void refresh(); });
    return () => { off?.(); };
  }, [refresh, harnessHome]);

  // Search runs in main over the files; debounced per keystroke.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setHits(null); return; }
    let alive = true;
    const timer = setTimeout(() => {
      void api()?.notesSearch(q).then((res) => {
        if (!alive) return;
        setHits(res.ok ? res.hits : []);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, notes]);

  const create = async () => {
    const title = newTitle.replace(/\s+/g, ' ').trim() || t('wsSidebar.notes.untitled');
    const res = await api()?.notesWrite({ title, body: '' });
    setCreating(false);
    setNewTitle('');
    if (!res) return;
    if (res.ok) {
      setQuery('');
      setOpen({ slug: res.note.slug, focus: 'body' });
      void refresh();
    } else {
      showFlash({ text: errorText(res.error, res.message), error: true });
    }
  };

  const removeFromList = async (slug: string, title: string) => {
    const res = await api()?.notesDelete(slug);
    if (res?.ok) { showFlash({ text: t('wsSidebar.notes.deleted', { title }) }); void refresh(); }
    else if (res) showFlash({ text: errorText(res.error, res.message), error: true });
    if (open?.slug === slug) setOpen(null);
  };

  const rows: Array<{ slug: string; title: string; sub: ReactNode; updatedAt: number }> = hits
    ? hits.map((h) => ({
        slug: h.slug,
        title: h.title,
        sub: h.snippet ? <Snippet hit={h} /> : relativeTime(h.updatedAt, Date.now(), i18n.language),
        updatedAt: h.updatedAt
      }))
    : (notes ?? []).map((n) => ({
        slug: n.slug,
        title: n.title,
        sub: n.excerpt || relativeTime(n.updatedAt, Date.now(), i18n.language),
        updatedAt: n.updatedAt
      }));

  const noHive = listError?.code === 'no-hive';
  const count = notes?.length ?? 0;

  const rowMenu: MenuEntry[] = menu && !menu.send ? [
    { key: 'head', header: menu.title },
    { key: 'open', label: t('wsSidebar.notes.open'), onSelect: () => setOpen({ slug: menu.slug, focus: 'body' }) },
    { key: 'rename', label: t('wsSidebar.notes.rename'), onSelect: () => setOpen({ slug: menu.slug, focus: 'title' }) },
    {
      key: 'send',
      label: t('wsSidebar.notes.sendTo'),
      keepOpen: true,
      onSelect: () => setMenu({ ...menu, send: true })
    },
    {
      key: 'ide',
      label: t('wsSidebar.notes.openInIde'),
      onSelect: () => {
        void api()?.notesRead(menu.slug).then((r) => { if (r.ok) useStore.getState().openFileInIde(r.note.path); });
      }
    },
    { key: 'sep', separator: true },
    {
      key: 'delete',
      label: confirmDelete === menu.slug ? t('wsSidebar.notes.deleteConfirm') : t('wsSidebar.notes.delete'),
      danger: true,
      keepOpen: confirmDelete !== menu.slug,
      onSelect: () => {
        if (confirmDelete !== menu.slug) { setConfirmDelete(menu.slug); return; }
        setConfirmDelete(null);
        void removeFromList(menu.slug, menu.title);
      }
    }
  ] : [];

  return (
    <section ref={sectionRef} className="cth-ws-sidebar-section" aria-label={t('wsSidebar.notes.title')}>
      <div className="cth-ws-sidebar-section-head">
        <h2 className="cth-ws-sidebar-section-title">
          {t('wsSidebar.notes.title')}
          {count > 0 && <span className="cth-ws-sidebar-section-count">· {count}</span>}
        </h2>
        {!noHive && (
          <IconButton label={t('wsSidebar.notes.new')} size="sm" onClick={() => { setCreating(true); setOpen(null); }}>
            <WsIcon name="plus" />
          </IconButton>
        )}
      </div>

      {(creating || count > 0 || query) && !noHive && (
        <div className="cth-ws-sidebar-notes-tools">
          {creating && (
            <input
              className="cth-ws-sidebar-input"
              autoFocus
              value={newTitle}
              maxLength={NOTE_TITLE_MAX}
              placeholder={t('wsSidebar.notes.newPlaceholder')}
              aria-label={t('wsSidebar.notes.newPlaceholder')}
              onChange={(e) => setNewTitle(e.target.value)}
              onBlur={() => { if (!newTitle.trim()) setCreating(false); }}
              onKeyDown={(e) => {
                if (isComposingKey(e.nativeEvent)) return;
                if (e.key === 'Enter') { e.preventDefault(); void create(); }
                else if (e.key === 'Escape') { e.preventDefault(); setCreating(false); setNewTitle(''); }
              }}
            />
          )}
          {(count > 0 || query) && (
            <SearchInput value={query} onChange={setQuery} placeholder={t('wsSidebar.notes.search')} />
          )}
        </div>
      )}

      {open && (
        <NoteEditor
          key={open.slug}
          slug={open.slug}
          focus={open.focus}
          onClose={() => { setOpen(null); void refresh(); }}
          onSlugChange={(slug) => setOpen({ slug, focus: 'body' })}
          onFlash={showFlash}
        />
      )}

      {notes === null && !listError ? (
        <div className="cth-ws-sidebar-quiet"><Spinner label={t('wsSidebar.notes.loading')} /></div>
      ) : noHive ? (
        <div className="cth-ws-sidebar-quiet">{t('wsSidebar.notes.errors.noHive')}</div>
      ) : listError ? (
        <div className="cth-ws-sidebar-quiet">
          {errorText(listError.code, listError.message)}{' '}
          <Button size="sm" variant="ghost" onClick={() => { void refresh(); }}>{t('wsSidebar.notes.retry')}</Button>
        </div>
      ) : count === 0 && !creating ? (
        <div className="cth-ws-sidebar-quiet">{t('wsSidebar.notes.empty')}</div>
      ) : hits && hits.length === 0 ? (
        <div className="cth-ws-sidebar-quiet">{t('wsSidebar.notes.noMatch', { query: query.trim() })}</div>
      ) : (
        <div>
          {rows.filter((r) => r.slug !== open?.slug).map((r) => (
            <button
              key={r.slug}
              type="button"
              className="cth-ws-navrow cth-ws-sidebar-note"
              title={`${r.title} — ${new Date(r.updatedAt).toLocaleString(i18n.language)}`}
              onClick={() => setOpen({ slug: r.slug, focus: 'body' })}
              onContextMenu={(e) => {
                e.preventDefault();
                setConfirmDelete(null);
                setMenu({ slug: r.slug, title: r.title, anchor: { kind: 'point', x: e.clientX, y: e.clientY } });
              }}
              onKeyDown={(e) => {
                if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
                  e.preventDefault();
                  setConfirmDelete(null);
                  setMenu({ slug: r.slug, title: r.title, anchor: { kind: 'below', rect: e.currentTarget.getBoundingClientRect() } });
                }
              }}
            >
              <span className="cth-ws-sidebar-note-title">{r.title}</span>
              <span className="cth-ws-sidebar-note-sub">{r.sub}</span>
            </button>
          ))}
          {truncated && !hits && <div className="cth-ws-sidebar-quiet">{t('wsSidebar.notes.truncated')}</div>}
        </div>
      )}

      {flash && (
        <div className={flash.error ? 'cth-ws-sidebar-quiet cth-ws-sidebar-menu-error' : 'cth-ws-sidebar-quiet'} role="status">
          {flash.text}
        </div>
      )}

      {menu && !menu.send && (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} role="menu" ariaLabel={t('wsSidebar.notes.menuLabel', { title: menu.title })} autoFocus>
          <MenuList entries={rowMenu} onClose={() => setMenu(null)} />
        </Popover>
      )}
      {menu?.send && (
        <SendMenu slug={menu.slug} anchor={menu.anchor} onClose={() => setMenu(null)} onSent={showFlash} />
      )}
    </section>
  );
}
