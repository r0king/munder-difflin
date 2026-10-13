/**
 * Routing — the routing log: who sent what to whom, and when, newest first.
 *
 * Read from the tail of the hive's log.jsonl by main (subjects redacted
 * there), filtered here by participant, kind and free text
 * (shared/workspace/orchestratorRouting.ts). Refreshes on routed traffic and on
 * a slow timer while the tab is open.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  filterRouting,
  routingDayKey,
  routingParticipants,
  type RoutingEntry,
  type RoutingKind
} from '@shared/workspace/orchestratorRouting';
import { Button, Chip, EmptyState, SearchInput, SegmentedControl, Spinner } from '../ui';
import { loadWsPref, saveWsPref } from '../store';
import { formatDay, formatTime, useParticipantLabel } from './format';

const POLL_MS = 10_000;
/** Rows rendered per page of the (already filtered) list. */
const PAGE = 300;

type KindFilter = 'all' | 'messages' | 'handoffs' | 'problems';
const KIND_FILTERS: Record<KindFilter, RoutingKind[]> = {
  all: [],
  messages: ['message'],
  handoffs: ['handoff'],
  problems: ['drop', 'archived']
};
const isKindFilter = (v: unknown): v is KindFilter => typeof v === 'string' && v in KIND_FILTERS;

export function RoutingTab() {
  const { t, i18n } = useTranslation();
  const { label, names, godId } = useParticipantLabel();
  const [entries, setEntries] = useState<RoutingEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [who, setWho] = useState<string>('');
  const [kind, setKind] = useState<KindFilter>(() => loadWsPref('orchestrator.routingKind', 'all', isKindFilter));
  const [shownCount, setShownCount] = useState(PAGE);

  const load = useCallback(async () => {
    const res = await window.cth.features.orchestrator.routingLog().catch((e: unknown) => ({
      ok: false, entries: [] as RoutingEntry[], truncated: false, error: e instanceof Error ? e.message : String(e)
    }));
    if (res.ok) {
      setEntries(res.entries);
      setTruncated(res.truncated);
      setError(null);
    } else {
      setError(res.error ?? 'error');
      setEntries((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const off = window.cth.onHiveMessage(() => {
      if (debounce) return;
      debounce = setTimeout(() => { debounce = null; void load(); }, 1000);
    });
    const iv = setInterval(() => { void load(); }, POLL_MS);
    return () => { off(); clearInterval(iv); if (debounce) clearTimeout(debounce); };
  }, [load]);

  const participants = useMemo(() => (entries ? routingParticipants(entries, godId) : []), [entries, godId]);
  const filtered = useMemo(() => {
    if (!entries) return [];
    return filterRouting(entries, { agentId: who || null, query, kinds: KIND_FILTERS[kind], godId, names }).reverse();
  }, [entries, who, query, kind, godId, names]);
  useEffect(() => { setShownCount(PAGE); }, [who, query, kind]);

  const visible = filtered.slice(0, shownCount);

  return (
    <>
      <div className="cth-ws-orch-toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder={t('wsOrchestrator.routing.search')} />
        <select
          className="cth-ws-orch-select"
          value={who}
          onChange={(e) => setWho(e.target.value)}
          aria-label={t('wsOrchestrator.routing.whoAria')}
        >
          <option value="">{t('wsOrchestrator.routing.everyone')}</option>
          {participants.map((id) => <option key={id} value={id}>{label(id)}</option>)}
        </select>
        <SegmentedControl<KindFilter>
          size="sm"
          value={kind}
          onChange={(k) => { setKind(k); saveWsPref('orchestrator.routingKind', k); }}
          ariaLabel={t('wsOrchestrator.routing.kindAria')}
          options={[
            { value: 'all', label: t('wsOrchestrator.routing.kindAll') },
            { value: 'messages', label: t('wsOrchestrator.routing.kindMessages') },
            { value: 'handoffs', label: t('wsOrchestrator.routing.kindHandoffs') },
            { value: 'problems', label: t('wsOrchestrator.routing.kindProblems') }
          ]}
        />
      </div>
      <div className="cth-ws-orch-routes">
        {entries === null ? (
          <EmptyState fill icon={<Spinner label={t('wsOrchestrator.loading')} />} title={t('wsOrchestrator.loading')} />
        ) : error && entries.length === 0 ? (
          error === 'no-hive'
            ? <EmptyState title={t('wsOrchestrator.routing.noHive')} />
            : <EmptyState title={t('wsOrchestrator.routing.error')} body={error} action={<Button onClick={() => { void load(); }}>{t('wsOrchestrator.retry')}</Button>} />
        ) : entries.length === 0 ? (
          <EmptyState title={t('wsOrchestrator.routing.empty')} body={t('wsOrchestrator.routing.emptyBody')} />
        ) : filtered.length === 0 ? (
          <EmptyState compact title={t('wsOrchestrator.routing.noMatch')} />
        ) : (
          <>
            <div role="list">
              {visible.map((e, i) => {
                const prev = visible[i - 1];
                const newDay = !prev || routingDayKey(prev.ts) !== routingDayKey(e.ts);
                return (
                  <div key={e.key} role="listitem" style={{ display: 'contents' }}>
                    {newDay && <div className="cth-ws-orch-day">{formatDay(e.ts, i18n.language, t)}</div>}
                    <RouteRow entry={e} label={label} lang={i18n.language} />
                  </div>
                );
              })}
            </div>
            <div className="cth-ws-orch-foot">
              <span className="cth-ws-orch-muted">
                {t('wsOrchestrator.routing.count', { shown: visible.length, total: filtered.length })}
                {truncated ? ` ${t('wsOrchestrator.routing.truncated')}` : ''}
              </span>
              {visible.length < filtered.length && (
                <Button size="sm" onClick={() => setShownCount((n) => n + PAGE)}>{t('wsOrchestrator.routing.showMore')}</Button>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function RouteRow({ entry, label, lang }: { entry: RoutingEntry; label: (id: string) => string; lang: string }) {
  const { t } = useTranslation();
  const broadcast = entry.to === 'broadcast';
  const toLabel = broadcast
    ? t('wsOrchestrator.routing.toEveryone', { n: entry.delivered.length })
    : label(entry.to);
  const reason = entry.reason ? t(`wsOrchestrator.routing.reason.${reasonKey(entry.reason)}`) : null;
  return (
    <div className="cth-ws-orch-route">
      <span className="cth-ws-orch-route-time">{formatTime(entry.ts, lang)}</span>
      <span className="cth-ws-orch-route-who" title={`${entry.from} → ${entry.to}${entry.delivered.length ? ` (${entry.delivered.join(', ')})` : ''}`}>
        <span>{label(entry.from)}</span>
        <span className="cth-ws-orch-route-arrow" aria-hidden="true">→</span>
        <span>{toLabel}</span>
      </span>
      <span className="cth-ws-orch-route-subject" dir="auto" title={entry.subject}>{entry.subject || '—'}</span>
      <span className="cth-ws-orch-route-tags">
        {entry.act && <Chip tone="neutral">{actLabel(t, entry.act)}</Chip>}
        {entry.kind === 'handoff' && (
          <Chip tone={entry.delivered.length ? 'info' : 'danger'}>
            {entry.delivered.length ? t('wsOrchestrator.routing.handoff') : t('wsOrchestrator.routing.handoffFailed')}
          </Chip>
        )}
        {entry.kind === 'archived' && <Chip tone="warn">{t('wsOrchestrator.routing.archived')}</Chip>}
        {entry.kind === 'drop' && <Chip tone="danger" title={entry.reason ?? undefined}>{reason ?? t('wsOrchestrator.routing.dropped')}</Chip>}
        {/* A message to 'human' is answered by god himself (he is the human's
            proxy) and routes nowhere else, so an empty list is not a failure. */}
        {entry.kind === 'message' && entry.delivered.length === 0 && entry.to !== 'human' && entry.to !== 'broadcast' && (
          <Chip tone="danger">{t('wsOrchestrator.routing.undelivered')}</Chip>
        )}
      </span>
    </div>
  );
}

const ACTS = new Set(['request', 'inform', 'propose', 'query', 'agree', 'refuse', 'done']);
function actLabel(t: (k: string) => string, act: string): string {
  return ACTS.has(act) ? t(`wsOrchestrator.act.${act}`) : act;
}

function reasonKey(reason: string): string {
  switch (reason) {
    case 'hop-cap': return 'hopCap';
    case 'no-inbox': return 'noInbox';
    case 'malformed-json': return 'malformed';
    default: return 'other';
  }
}
