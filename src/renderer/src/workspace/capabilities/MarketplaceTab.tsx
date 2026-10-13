/**
 * Marketplace: the role bundles, then the public skills catalog with search,
 * filters and a one-click install — for every agent on this machine (the
 * existing ~/.claude/skills install), or for one agent only (a grant: the
 * folder lands in that agent's own skills dir).
 *
 * A skill is instructions that run inside an agent holding the user's tools and
 * keys, so every row links to its source; install is one click, but it is the
 * user's click.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Chip, EmptyState, SearchInput, Section, SegmentedControl, Spinner } from '../ui';
import { catalogSkillDirName } from '@shared/workspace/capabilities';
import type { CapabilitiesState } from '@shared/workspace/capabilitiesIpc';
import type { CatalogSkill, IntegrationRecordView } from '../../../../preload';
import { BundlesSection } from './BundlesSection';
import { AgentSelect } from './parts';
import { useSkillCatalog, type FloorAgent } from './useCapabilities';

type Show = 'all' | 'available' | 'installed';
const RENDER_CAP = 200;

export function MarketplaceTab({ agents, state, connections, target, onTarget, reloadLocal, bundleRequest }: {
  agents: FloorAgent[];
  state: CapabilitiesState | null;
  connections: IntegrationRecordView[] | null;
  /** The agent the bundles grant to (shared with the skills' "for"). */
  target: string;
  onTarget: (id: string) => void;
  reloadLocal: () => void;
  bundleRequest?: { bundleId: string; seq: number } | null;
}) {
  const { t } = useTranslation();
  const catalog = useSkillCatalog(true);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [owner, setOwner] = useState('all');
  const [show, setShow] = useState<Show>('all');
  /** '' = every agent on this machine. */
  const [installFor, setInstallFor] = useState('');
  const [rowState, setRowState] = useState<Record<string, { busy?: boolean; error?: string }>>({});

  const machine = useMemo(() => new Set(state?.machineSkills ?? []), [state]);
  const builtin = useMemo(() => new Set(state?.builtinSkills ?? []), [state]);
  const forAgent = agents.find((a) => a.id === installFor);
  const agentOwn = useMemo(() => new Set(installFor ? state?.agentSkills[installFor] ?? [] : []), [state, installFor]);
  const agentGranted = useMemo(() => new Set(installFor ? state?.grants[installFor]?.skills ?? [] : []), [state, installFor]);
  const installing = useMemo(() => new Set(installFor ? state?.installing[installFor] ?? [] : []), [state, installFor]);

  const categories = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of catalog.skills ?? []) m.set(s.category, (m.get(s.category) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [catalog.skills]);
  const owners = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of catalog.skills ?? []) m.set(s.owner, (m.get(s.owner) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [catalog.skills]);

  /** Where a row stands for the chosen target. */
  const status = (s: CatalogSkill): 'builtin' | 'machine' | 'agent' | 'installing' | 'granted' | 'available' | 'manual' => {
    const dir = catalogSkillDirName(s);
    if (!dir) return 'manual';
    if (builtin.has(dir)) return 'builtin';
    if (machine.has(dir)) return 'machine';
    if (installFor && installing.has(dir)) return 'installing';
    if (installFor && agentOwn.has(dir)) return 'agent';
    if (installFor && agentGranted.has(dir)) return 'granted';
    return 'available';
  };

  const q = query.trim().toLowerCase();
  // Recomputed per render: ~1,200 rows of string checks is cheap, and a memo
  // would have to list every input `status` closes over.
  const filtered = (catalog.skills ?? []).filter((s) => {
    if (category !== 'all' && s.category !== category) return false;
    if (owner !== 'all' && s.owner !== owner) return false;
    if (q && !s.name.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q)) return false;
    if (show !== 'all') {
      const st = status(s);
      const installed = st === 'builtin' || st === 'machine' || st === 'agent';
      if (show === 'installed' ? !installed : installed) return false;
    }
    return true;
  });

  const install = async (s: CatalogSkill) => {
    const key = s.url;
    setRowState((r) => ({ ...r, [key]: { busy: true } }));
    try {
      if (!installFor) {
        const res = await window.cth.skillsInstall(s.url, s.name);
        setRowState((r) => ({ ...r, [key]: res.ok ? {} : { error: res.error } }));
        if (res.ok) reloadLocal();
      } else {
        const dir = catalogSkillDirName(s);
        if (!dir) return;
        const res = await window.cth.features.capabilities.setGrant({
          agentId: installFor, kind: 'skill', id: dir, on: true, source: { owner: s.owner, name: s.name }
        });
        setRowState((r) => ({ ...r, [key]: res.ok ? {} : { error: res.error } }));
      }
    } catch (e) {
      setRowState((r) => ({ ...r, [key]: { error: e instanceof Error ? e.message : String(e) } }));
    }
  };

  const skillError = (s: CatalogSkill): string | undefined => {
    const dir = catalogSkillDirName(s);
    return installFor && dir ? state?.skillErrors[`${installFor}/${dir}`] : undefined;
  };

  return (
    <>
      <BundlesSection agents={agents} state={state} connections={connections} target={target} onTarget={onTarget} request={bundleRequest} />

      <Section title={t('wsCapabilities.market.title')} count={catalog.skills?.length}>
        <p className="cth-ws-capabilities-intro">{t('wsCapabilities.market.intro')}</p>
        <div className="cth-ws-capabilities-toolbar">
          <SearchInput value={query} onChange={setQuery} placeholder={t('wsCapabilities.market.search')} />
          <select className="cth-ws-capabilities-select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t('wsCapabilities.market.category')}>
            <option value="all">{t('wsCapabilities.market.allCategories')}</option>
            {categories.map(([c, n]) => <option key={c} value={c}>{`${c} (${n})`}</option>)}
          </select>
          <select className="cth-ws-capabilities-select" value={owner} onChange={(e) => setOwner(e.target.value)} aria-label={t('wsCapabilities.market.publisher')}>
            <option value="all">{t('wsCapabilities.market.allPublishers')}</option>
            {owners.map(([o, n]) => <option key={o} value={o}>{`${o} (${n})`}</option>)}
          </select>
          <SegmentedControl<Show>
            size="sm"
            value={show}
            onChange={setShow}
            ariaLabel={t('wsCapabilities.market.show')}
            options={[
              { value: 'all', label: t('wsCapabilities.market.showAll') },
              { value: 'available', label: t('wsCapabilities.market.showAvailable') },
              { value: 'installed', label: t('wsCapabilities.market.showInstalled') }
            ]}
          />
          <span className="cth-ws-capabilities-spacer" />
          <span className="cth-ws-capabilities-toolbar-label">{t('wsCapabilities.market.installFor')}</span>
          <AgentSelect agents={agents} value={installFor} onChange={setInstallFor} includeEveryone ariaLabel={t('wsCapabilities.market.installFor')} />
          <Button size="sm" variant="ghost" disabled={catalog.loading} onClick={catalog.refresh}>{t('wsCapabilities.market.refresh')}</Button>
        </div>

        {catalog.stale && catalog.skills && catalog.skills.length > 0 && (
          <div className="cth-ws-capabilities-banner" data-tone="warn">
            <span>{t('wsCapabilities.market.stale', { error: catalog.error ?? '' })}</span>
          </div>
        )}

        {catalog.skills === null || (catalog.loading && catalog.skills.length === 0) ? (
          <EmptyState compact title={t('wsCapabilities.market.loading')} icon={<Spinner />} />
        ) : catalog.skills.length === 0 ? (
          <EmptyState
            compact
            title={t('wsCapabilities.market.unreachable')}
            body={catalog.error}
            action={<Button size="sm" onClick={catalog.refresh}>{t('wsCapabilities.market.retry')}</Button>}
          />
        ) : filtered.length === 0 ? (
          <EmptyState compact title={t('wsCapabilities.market.noMatch')} />
        ) : (
          <>
            <div className="cth-ws-capabilities-list">
              {filtered.slice(0, RENDER_CAP).map((s) => {
                const st = status(s);
                const rs = rowState[s.url];
                const err = rs?.error ?? skillError(s);
                return (
                  <div key={`${s.owner}/${s.name}/${s.url}`} className="cth-ws-capabilities-row">
                    <div className="cth-ws-capabilities-row-main">
                      <div className="cth-ws-capabilities-row-title">
                        <span>{s.name}</span>
                        <Chip>{s.owner}</Chip>
                        <span className="cth-ws-capabilities-row-meta">{s.category}</span>
                      </div>
                      {s.description && <div className="cth-ws-capabilities-row-desc">{s.description}</div>}
                      {err && <span className="cth-ws-capabilities-error">{err === 'notFound' ? t('wsCapabilities.market.notFound') : err}</span>}
                    </div>
                    <div className="cth-ws-capabilities-row-actions">
                      <Button size="sm" variant="ghost" onClick={() => { void window.cth.openExternal(s.url); }}>{t('wsCapabilities.market.source')}</Button>
                      {st === 'builtin' && <Chip tone="ok">{t('wsCapabilities.market.builtin')}</Chip>}
                      {st === 'machine' && <Chip tone="ok">{t('wsCapabilities.market.installedEveryone')}</Chip>}
                      {st === 'agent' && <Chip tone="ok">{t('wsCapabilities.market.installedFor', { name: forAgent?.name ?? '' })}</Chip>}
                      {(st === 'installing' || rs?.busy) && <Spinner label={t('wsCapabilities.market.installing')} />}
                      {st === 'manual' && <Chip title={t('wsCapabilities.market.manualTitle')}>{t('wsCapabilities.market.manual')}</Chip>}
                      {(st === 'available' || st === 'granted') && !rs?.busy && (
                        <Button size="sm" variant="primary" onClick={() => { void install(s); }}>
                          {st === 'granted' ? t('wsCapabilities.market.retryInstall') : installFor ? t('wsCapabilities.market.installForAgent', { name: forAgent?.name ?? '' }) : t('wsCapabilities.market.install')}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="cth-ws-capabilities-count">
              {filtered.length > RENDER_CAP
                ? t('wsCapabilities.market.showingFirst', { shown: RENDER_CAP, count: filtered.length })
                : t('wsCapabilities.market.showing', { count: filtered.length })}
            </div>
          </>
        )}
      </Section>
    </>
  );
}
