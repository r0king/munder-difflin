/**
 * The Stapler's screen in the Workspace: the meetings library ("one folder
 * per meeting, searchable and editable") and the Stapler's settings. Owned by
 * the `stapler` unit (route `{ kind: 'stapler' }`).
 *
 * The list is main's (feat:stapler:meetingList, searched across titles,
 * descriptions and transcripts) and reloads whenever a meeting changes on
 * disk — a recording that just finished in the puck appears here by itself.
 * The puck's "Open in library" lands on its meeting through
 * takeMeetingFocus / onFocusMeeting.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDuration, type MeetingSummary } from '@shared/features/stapler';
import { Chip, EmptyState, KeyHint, Screen, ScreenHeader, SearchInput, Spinner, Tabs, Toggle, Button } from '../ui';
import type { WorkspaceScreenProps } from '../types';
import { loadWsPref, saveWsPref } from '../store';
import { setStaplerEnabled, useStaplerState } from '../useStaplerState';
import { MeetingDetail, formatMeetingDate, statusChip } from '../stapler/MeetingDetail';
import { StaplerSettings, acceleratorCombo } from '@/stapler/StaplerSettings';
import { StaplerIcon } from '@/stapler/icons';
import { stapler } from '@/stapler/bridge';
import '@/stapler/stapler.css';

type Tab = 'meetings' | 'settings';
const isTab = (v: unknown): v is Tab => v === 'meetings' || v === 'settings';

export function StaplerScreen({ config }: WorkspaceScreenProps) {
  void config;
  const { t, i18n } = useTranslation();
  const state = useStaplerState();
  const [tab, setTabState] = useState<Tab>(() => loadWsPref<Tab>('stapler.tab', 'meetings', isTab));
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MeetingSummary[] | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;

  const setTab = (next: Tab) => { setTabState(next); saveWsPref('stapler.tab', next); };

  const reload = useCallback(async () => {
    try {
      const list = await stapler().meetingList(queryRef.current);
      setItems(list);
      setError(false);
    } catch {
      setError(true);
      setItems((prev) => prev ?? []);
    }
  }, []);

  // Search as you type, lightly debounced.
  useEffect(() => {
    const timer = setTimeout(() => { void reload(); }, query ? 180 : 0);
    return () => clearTimeout(timer);
  }, [query, reload]);

  useEffect(() => stapler().onMeetings(() => { void reload(); }), [reload]);

  // "Open in library" from the puck.
  // A meeting the puck asked for stays selected even before the list has
  // caught up with it (it may have been written a moment ago).
  const pinned = useRef<string | null>(null);
  useEffect(() => {
    const focus = (id: string) => { pinned.current = id; setTab('meetings'); setQuery(''); setSelected(id); void reload(); };
    void stapler().takeMeetingFocus().then((id) => { if (id) focus(id); }, () => {});
    return stapler().onFocusMeeting((id) => {
      focus(id);
      void stapler().takeMeetingFocus();
    });
  }, []);

  // Keep a selection while there is anything to select.
  useEffect(() => {
    if (!items) return;
    if (selected && (items.some((m) => m.id === selected) || query || pinned.current === selected)) return;
    setSelected(items[0]?.id ?? null);
  }, [items, selected, query]);

  const shortcut = state.meetingShortcut?.accelerator ?? (window.cth.platform === 'darwin' ? 'Shift+Command+Space' : 'Ctrl+Shift+Space');

  const header = (
    <ScreenHeader
      title={t('stapler.title')}
      subtitle={t('stapler.library.subtitle')}
      actions={
        <Toggle
          checked={state.enabled}
          onChange={(on) => { void setStaplerEnabled(on); }}
          label={state.enabled ? t('stapler.library.on') : t('stapler.library.off')}
        />
      }
    >
      <Tabs<Tab>
        tabs={[
          { id: 'meetings', label: t('stapler.library.meetings'), badge: items?.length || undefined },
          { id: 'settings', label: t('stapler.library.settings') }
        ]}
        value={tab}
        onChange={setTab}
        ariaLabel={t('stapler.title')}
      />
    </ScreenHeader>
  );

  if (tab === 'settings') {
    return (
      <Screen header={header}>
        <div style={{ maxWidth: 640 }}>
          <StaplerSettings where="library" />
        </div>
      </Screen>
    );
  }

  const noneAtAll = items !== null && items.length === 0 && !query;
  return (
    <Screen header={header} fill>
      {noneAtAll ? (
        <EmptyState
          fill
          icon={<StaplerIcon name="meeting" size={24} />}
          title={t('stapler.library.emptyTitle')}
          body={t('stapler.library.emptyBody')}
          action={
            <>
              {!state.enabled && (
                <Button variant="primary" onClick={() => { void setStaplerEnabled(true); }}>{t('stapler.library.turnOn')}</Button>
              )}
              <Button onClick={() => { void stapler().openPanel('meeting'); }}>{t('stapler.library.startMeeting')}</Button>
              <KeyHint combo={acceleratorCombo(shortcut)} />
            </>
          }
        />
      ) : (
        <div className="cth-stapler-lib">
          <aside className="cth-stapler-lib-list" aria-label={t('stapler.library.meetings')}>
            <div className="cth-stapler-lib-search">
              <SearchInput value={query} onChange={setQuery} placeholder={t('stapler.library.search')} />
            </div>
            <div className="cth-stapler-lib-items">
              {items === null && <div style={{ padding: 'var(--cth-space-4)' }}><Spinner label={t('stapler.library.loading')} /></div>}
              {error && <p className="cth-stapler-help" style={{ padding: 'var(--cth-space-3)' }}>{t('stapler.library.loadFailed')}</p>}
              {items !== null && items.length === 0 && query && (
                <EmptyState compact title={t('stapler.library.noResults')} body={t('stapler.library.noResultsBody', { query })} />
              )}
              {items?.map((m) => {
                const tone = statusChip(m.status);
                return (
                  <button
                    key={m.id}
                    type="button"
                    className="cth-stapler-lib-item"
                    aria-current={m.id === selected ? 'true' : undefined}
                    onClick={() => { pinned.current = null; setSelected(m.id); }}
                  >
                    <span className="cth-stapler-lib-item-title cth-ws-ellipsis">{m.title}</span>
                    <span className="cth-stapler-row">
                      <span className="cth-stapler-lib-item-meta">
                        {formatMeetingDate(m.startedAt, i18n.language)} · {formatDuration(m.durationMs)}
                      </span>
                      {tone && <Chip tone={tone}>{t(`stapler.library.status.${m.status}`)}</Chip>}
                    </span>
                    {m.snippet && <span className="cth-stapler-lib-item-snippet">{m.snippet}</span>}
                  </button>
                );
              })}
            </div>
          </aside>
          {selected ? (
            <MeetingDetail key={selected} id={selected} onDeleted={() => { pinned.current = null; setSelected(null); void reload(); }} />
          ) : (
            <div className="cth-stapler-lib-detail">
              <EmptyState fill title={t('stapler.library.pick')} />
            </div>
          )}
        </div>
      )}
    </Screen>
  );
}
