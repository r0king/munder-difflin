/**
 * Data for the Capabilities screen. Everything is read from where it already
 * lives — the floor (hive store), the skills scan and catalog, the
 * integrations registry, the MCP catalog + config, the worker list — plus the
 * per-agent grants and Temps from this unit's main module. Main pushes
 * `feat:capabilities:changed` after any write, and the hooks re-read only the
 * slice that changed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore, type Agent } from '@/store/store';
import { inferAgentProvider } from '@/store/config';
import type { CapabilitiesState, TempsState } from '@shared/workspace/capabilitiesIpc';
import type { WhoAgent } from '@shared/workspace/capabilities';
import type { CatalogSkill, IntegrationRecordView, LocalSkill } from '../../../../preload';

const capsApi = () => window.cth.features.capabilities;

export interface FloorAgent extends WhoAgent {
  agent: Agent;
}

/** The floor as Capabilities sees it: every agent with a terminal or a card,
 *  the prep assistant excluded (it is send-only and never runs a job). */
export function useFloorAgents(): FloorAgent[] {
  const agents = useStore((s) => s.agents);
  return useMemo(() => agents
    .filter((a) => !a.archived && !a.isAssistant)
    .map((a) => ({
      id: a.id,
      name: a.name,
      provider: inferAgentProvider(a.command, a.provider),
      isGod: !!a.isGod,
      live: !!a.ptyId,
      agent: a
    })), [agents]);
}

/** Subscribe to main's change pushes for one slice. */
function useChanged(what: Array<'grants' | 'temps' | 'keys'>, reload: () => void): void {
  const ref = useRef(reload);
  ref.current = reload;
  const key = what.join(',');
  useEffect(() => capsApi().onChanged((c) => {
    if (key.split(',').includes(c.what)) ref.current();
  }), [key]);
}

export function useCapabilitiesState(agentIds: string[]): {
  state: CapabilitiesState | null;
  error: boolean;
  reload: () => void;
} {
  const [state, setState] = useState<CapabilitiesState | null>(null);
  const [error, setError] = useState(false);
  const idsKey = agentIds.join('\n');
  const seq = useRef(0);
  const reload = useCallback(() => {
    const n = ++seq.current;
    capsApi().state(idsKey ? idsKey.split('\n') : [])
      .then((s) => { if (n === seq.current) { setState(s); setError(false); } })
      .catch(() => { if (n === seq.current) setError(true); });
  }, [idsKey]);
  useEffect(() => { reload(); }, [reload]);
  useChanged(['grants', 'keys'], reload);
  return { state, error, reload };
}

/** Installed skills (built-in, machine, project scopes) from the existing scan. */
export function useLocalSkills(): { skills: LocalSkill[] | null; reload: () => void } {
  const [skills, setSkills] = useState<LocalSkill[] | null>(null);
  const reload = useCallback(() => {
    window.cth.skillsLocal().then(setSkills).catch(() => setSkills([]));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  useChanged(['grants'], reload);
  return { skills, reload };
}

export interface CatalogState {
  skills: CatalogSkill[] | null;
  stale: boolean;
  error?: string;
  fetchedAt: number;
  loading: boolean;
}

/** The public skills catalog (cached a day in main). Loaded on first use. */
export function useSkillCatalog(enabled: boolean): CatalogState & { refresh: () => void } {
  const [st, setSt] = useState<CatalogState>({ skills: null, stale: false, fetchedAt: 0, loading: false });
  const load = useCallback((force: boolean) => {
    setSt((s) => ({ ...s, loading: true }));
    window.cth.skillsCatalog(force)
      .then((r) => setSt({ skills: r.skills, stale: r.stale, error: r.error, fetchedAt: r.fetchedAt, loading: false }))
      .catch((e: unknown) => setSt((s) => ({ ...s, skills: s.skills ?? [], stale: true, error: String(e), loading: false })));
  }, []);
  const started = useRef(false);
  useEffect(() => {
    if (enabled && !started.current) { started.current = true; load(false); }
  }, [enabled, load]);
  return { ...st, refresh: () => load(true) };
}

/** Registered connections, secrets redacted to `hasSecret`. */
export function useConnections(): { records: IntegrationRecordView[] | null; reload: () => void } {
  const [records, setRecords] = useState<IntegrationRecordView[] | null>(null);
  const reload = useCallback(() => {
    window.cth.integrationsList().then(setRecords).catch(() => setRecords([]));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  useChanged(['keys', 'grants'], reload);
  return { records, reload };
}

type WorkersData = Awaited<ReturnType<typeof window.cth.listWorkers>>;

/** Temps, plus (with `withWorkers`) the live worker list for running temps'
 *  token counters. */
export function useTemps(withWorkers = true): {
  temps: TempsState | null;
  workers: WorkersData | null;
  error: boolean;
  reload: () => void;
} {
  const [temps, setTemps] = useState<TempsState | null>(null);
  const [workers, setWorkers] = useState<WorkersData | null>(null);
  const [error, setError] = useState(false);
  const reload = useCallback(() => {
    capsApi().temps().then((t) => { setTemps(t); setError(false); }).catch(() => setError(true));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  useChanged(['temps'], reload);
  const live = withWorkers && (temps?.active ?? []).some((t) => t.state === 'running' || t.state === 'starting');
  useEffect(() => {
    if (!live) return;
    const poll = () => { window.cth.listWorkers().then(setWorkers).catch(() => { /* main busy */ }); };
    poll();
    // Same cadence as the Classic Workers tab.
    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, [live]);
  return { temps, workers, error, reload };
}
