/**
 * Every record the Automations screen shows, and every write it makes — over
 * the SAME storage the Classic UI uses, so the two can never disagree:
 *
 *   schedules     config.missions          read from the live `config` prop,
 *                                          written with window.cth.saveMissions
 *   compact/clear config.contextTrigger    window.cth.setContextTrigger
 *   house rules   this unit's main module  window.cth.features.automations
 *   webhooks      the store mirror Settings → Connections and the Triggers
 *                 tab share (useStore.webhookTriggers), written through
 *                 window.cth.saveWebhooks / deleteWebhook
 *   deliveries    the trigger-history ledger, live via onTriggerHistoryUpdated
 *
 * OPTIMISTIC, THEN CANONICAL. A write paints at once (a switch must answer the
 * click), then adopts what main actually stored — main sanitises (it clamps a
 * context cadence, refuses to enable a secretless webhook, switches off an
 * empty house rule), so its answer can differ from what was sent. A failed
 * write rolls back to the last known truth and resolves `{ ok: false }` for the
 * row to say so inline.
 *
 * While one of OUR mission/context writes is in flight, config broadcasts are
 * not adopted: an unrelated setting saved in between would carry the
 * pre-write list and flick the row back for a frame.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import type { HarnessConfig } from '@/store/config';
import {
  DEFAULT_CONTEXT_TRIGGER,
  type ContextRule,
  type ContextTriggerConfig,
  type TriggerHistoryEntry,
  type WebhookTrigger
} from '@shared/triggers';
import {
  patchMission as patchMissionList,
  removeMission,
  type MissionRecord
} from '@shared/workspace/automations';
import type { HouseRule } from '@shared/workspace/automationsRules';

export type WriteOutcome = { ok: true } | { ok: false; error: string };

export type WebhooksStatus = { running: boolean; url?: string; endpoints: { id: string; url: string }[] };

const STATUS_POLL_MS = 5000;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e ?? 'unknown error'));

function fillRule(partial: Partial<ContextRule> | undefined, fallback: ContextRule): ContextRule {
  return {
    enabled: typeof partial?.enabled === 'boolean' ? partial.enabled : fallback.enabled,
    everyMs: typeof partial?.everyMs === 'number' ? partial.everyMs : fallback.everyMs,
    minContextPct: typeof partial?.minContextPct === 'number' ? partial.minContextPct : fallback.minContextPct,
    minContextPctLargeWindow: typeof partial?.minContextPctLargeWindow === 'number'
      ? partial.minContextPctLargeWindow : fallback.minContextPctLargeWindow,
    message: typeof partial?.message === 'string' ? partial.message : fallback.message
  };
}

function fillContext(cfg: Partial<ContextTriggerConfig> | undefined): ContextTriggerConfig {
  return {
    compact: fillRule(cfg?.compact, DEFAULT_CONTEXT_TRIGGER.compact),
    clear: fillRule(cfg?.clear, DEFAULT_CONTEXT_TRIGGER.clear)
  };
}

function missionsOf(config: HarnessConfig): MissionRecord[] {
  return Array.isArray(config.missions) ? (config.missions as MissionRecord[]) : [];
}

export interface AutomationsData {
  /** False until house rules and the ledger have answered once. */
  ready: boolean;
  /** A read that failed (house rules, history). The list still renders. */
  loadError: string | null;
  missions: MissionRecord[];
  contextTrigger: ContextTriggerConfig;
  houseRules: HouseRule[];
  webhooks: WebhookTrigger[];
  history: TriggerHistoryEntry[];
  status: WebhooksStatus;

  saveMissions: (next: MissionRecord[]) => Promise<WriteOutcome>;
  /** Patch against the LATEST list (not a render's snapshot), so two quick
   *  edits never drop each other. */
  patchMission: (id: string, fields: Partial<MissionRecord>) => Promise<WriteOutcome>;
  /** missions:save keeps only what it is sent, so deleting is "save without it". */
  deleteMission: (id: string) => Promise<WriteOutcome>;
  patchContext: (which: 'compact' | 'clear', fields: Partial<ContextRule>) => Promise<WriteOutcome>;
  saveRule: (rule: HouseRule) => Promise<WriteOutcome & { stored?: HouseRule }>;
  /** Merge into the LATEST copy of a rule, like patchMission. */
  patchRule: (id: string, fields: Partial<HouseRule>) => Promise<WriteOutcome & { stored?: HouseRule }>;
  deleteRule: (id: string) => Promise<WriteOutcome>;
  saveWebhooks: (next: WebhookTrigger[]) => Promise<WriteOutcome & { stored?: WebhookTrigger[] }>;
  patchWebhook: (id: string, fields: Partial<WebhookTrigger>) => Promise<WriteOutcome & { stored?: WebhookTrigger }>;
  deleteWebhook: (id: string) => Promise<WriteOutcome>;
  decide: (entryId: string, decision: 'approved' | 'rejected') => Promise<WriteOutcome>;
}

export function useAutomationsData(config: HarnessConfig): AutomationsData {
  /* ── schedules ── */
  const cfgMissions = missionsOf(config);
  const cfgMissionsKey = JSON.stringify(cfgMissions);
  const [missions, setMissions] = useState<MissionRecord[]>(cfgMissions);
  const missionsRef = useRef(missions);
  missionsRef.current = missions;
  const missionWrites = useRef(0);

  useEffect(() => {
    if (missionWrites.current > 0) return;
    setMissions(JSON.parse(cfgMissionsKey) as MissionRecord[]);
  }, [cfgMissionsKey]);

  const saveMissions = useCallback(async (next: MissionRecord[]): Promise<WriteOutcome> => {
    const before = missionsRef.current;
    missionsRef.current = next;
    setMissions(next);
    missionWrites.current += 1;
    try {
      await window.cth.saveMissions(next);
      return { ok: true };
    } catch (e) {
      missionsRef.current = before;
      setMissions(before);
      return { ok: false, error: errText(e) };
    } finally {
      missionWrites.current -= 1;
      // Adopt main's merge (it keeps the scheduler's newer lastFiredAt stamps).
      if (missionWrites.current === 0) {
        void window.cth.listMissions().then((list) => {
          if (missionWrites.current === 0 && Array.isArray(list)) {
            missionsRef.current = list as MissionRecord[];
            setMissions(list as MissionRecord[]);
          }
        }).catch(() => { /* keep what is on screen */ });
      }
    }
  }, []);

  const patchMission = useCallback((id: string, fields: Partial<MissionRecord>) =>
    saveMissions(patchMissionList(missionsRef.current, id, fields)), [saveMissions]);

  const deleteMission = useCallback((id: string) =>
    saveMissions(removeMission(missionsRef.current, id)), [saveMissions]);

  /* ── compact / clear ── */
  const cfgContextKey = JSON.stringify(fillContext(config.contextTrigger));
  const [contextTrigger, setContextTrigger] = useState<ContextTriggerConfig>(() => JSON.parse(cfgContextKey));
  const contextRef = useRef(contextTrigger);
  contextRef.current = contextTrigger;
  const contextWrites = useRef(0);

  useEffect(() => {
    if (contextWrites.current > 0) return;
    setContextTrigger(JSON.parse(cfgContextKey) as ContextTriggerConfig);
  }, [cfgContextKey]);

  const patchContext = useCallback(async (which: 'compact' | 'clear', fields: Partial<ContextRule>): Promise<WriteOutcome> => {
    const before = contextRef.current;
    const next: ContextTriggerConfig = { ...before, [which]: { ...before[which], ...fields } };
    contextRef.current = next;
    setContextTrigger(next);
    contextWrites.current += 1;
    try {
      // Main clamps the cadence and the percentages; its echo is the truth.
      const stored = await window.cth.setContextTrigger(next);
      const canonical = fillContext(stored);
      contextRef.current = canonical;
      setContextTrigger(canonical);
      return { ok: true };
    } catch (e) {
      contextRef.current = before;
      setContextTrigger(before);
      return { ok: false, error: errText(e) };
    } finally {
      contextWrites.current -= 1;
    }
  }, []);

  /* ── house rules ── */
  const [houseRules, setHouseRules] = useState<HouseRule[]>([]);
  const rulesRef = useRef(houseRules);
  rulesRef.current = houseRules;
  const [rulesReady, setRulesReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const api = window.cth.features?.automations;
    if (!api) { setRulesReady(true); return; }
    api.listRules()
      .then((list) => { if (alive) setHouseRules(Array.isArray(list) ? list : []); })
      .catch((e) => { if (alive) setLoadError(errText(e)); })
      .finally(() => { if (alive) setRulesReady(true); });
    const off = api.onRules((list) => { if (alive && Array.isArray(list)) setHouseRules(list); });
    return () => { alive = false; off(); };
  }, []);

  const saveRule = useCallback(async (rule: HouseRule): Promise<WriteOutcome & { stored?: HouseRule }> => {
    const before = rulesRef.current;
    const exists = before.some((r) => r.id === rule.id);
    const optimistic = exists ? before.map((r) => (r.id === rule.id ? rule : r)) : [...before, rule];
    rulesRef.current = optimistic;
    setHouseRules(optimistic);
    try {
      const res = await window.cth.features.automations.saveRule(rule);
      rulesRef.current = res.rules;
      setHouseRules(res.rules);
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, stored: res.rules.find((r) => r.id === rule.id) };
    } catch (e) {
      rulesRef.current = before;
      setHouseRules(before);
      return { ok: false, error: errText(e) };
    }
  }, []);

  const patchRule = useCallback((id: string, fields: Partial<HouseRule>) => {
    const latest = rulesRef.current.find((r) => r.id === id);
    if (!latest) return Promise.resolve<WriteOutcome>({ ok: false, error: 'notFound' });
    return saveRule({ ...latest, ...fields });
  }, [saveRule]);

  const deleteRule = useCallback(async (id: string): Promise<WriteOutcome> => {
    const before = rulesRef.current;
    const optimistic = before.filter((r) => r.id !== id);
    rulesRef.current = optimistic;
    setHouseRules(optimistic);
    try {
      const res = await window.cth.features.automations.deleteRule(id);
      rulesRef.current = res.rules;
      setHouseRules(res.rules);
      return res.ok || res.error === 'notFound' ? { ok: true } : { ok: false, error: res.error };
    } catch (e) {
      rulesRef.current = before;
      setHouseRules(before);
      return { ok: false, error: errText(e) };
    }
  }, []);

  /* ── webhooks (the shared store mirror) ── */
  const webhooks = useStore((s) => s.webhookTriggers);
  const setWebhooks = useStore((s) => s.setWebhookTriggers);

  useEffect(() => {
    // App seeds the mirror at boot; only an unseeded one is read here, so an
    // edit in flight in Settings is never clobbered by this screen mounting.
    if (useStore.getState().webhookTriggers.length > 0) return;
    let alive = true;
    window.cth.listWebhooks()
      .then((list) => {
        if (alive && Array.isArray(list) && useStore.getState().webhookTriggers.length === 0) setWebhooks(list);
      })
      .catch(() => { /* the mirror stands */ });
    return () => { alive = false; };
  }, [setWebhooks]);

  const saveWebhooks = useCallback(async (next: WebhookTrigger[]): Promise<WriteOutcome & { stored?: WebhookTrigger[] }> => {
    const before = useStore.getState().webhookTriggers;
    setWebhooks(next);
    try {
      const canonical = await window.cth.saveWebhooks(next);
      if (!Array.isArray(canonical)) throw new Error('no answer from main');
      setWebhooks(canonical);
      return { ok: true, stored: canonical };
    } catch (e) {
      setWebhooks(before);
      return { ok: false, error: errText(e) };
    }
  }, [setWebhooks]);

  const patchWebhook = useCallback(async (id: string, fields: Partial<WebhookTrigger>) => {
    const latest = useStore.getState().webhookTriggers;
    const res = await saveWebhooks(latest.map((w) => (w.id === id ? { ...w, ...fields } : w)));
    return res.ok ? { ...res, stored: res.stored?.find((w) => w.id === id) } : res;
  }, [saveWebhooks]);

  const deleteWebhook = useCallback(async (id: string): Promise<WriteOutcome> => {
    const before = useStore.getState().webhookTriggers;
    setWebhooks(before.filter((w) => w.id !== id));
    try {
      const canonical = await window.cth.deleteWebhook(id);
      if (Array.isArray(canonical)) setWebhooks(canonical);
      return { ok: true };
    } catch (e) {
      setWebhooks(before);
      return { ok: false, error: errText(e) };
    }
  }, [setWebhooks]);

  /* ── deliveries ── */
  const [history, setHistory] = useState<TriggerHistoryEntry[]>([]);
  const [historyReady, setHistoryReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      window.cth.listTriggerHistory()
        .then((rows) => { if (alive) setHistory(Array.isArray(rows) ? rows : []); })
        .catch((e) => { if (alive) setLoadError(errText(e)); })
        .finally(() => { if (alive) setHistoryReady(true); });
    };
    load();
    const off = window.cth.onTriggerHistoryUpdated(load);
    return () => { alive = false; off(); };
  }, []);

  const decide = useCallback(async (entryId: string, decision: 'approved' | 'rejected'): Promise<WriteOutcome> => {
    try {
      const row = await window.cth.decideTriggerHistory({ id: entryId, decision });
      if (!row) return { ok: false, error: 'gone' };
      // Main leaves an approval `pending` when the hive could not take the card
      // (no hive open yet). That is a failure the operator must see.
      if (decision === 'approved' && row.decision === 'pending') return { ok: false, error: 'notDispatched' };
      setHistory((rows) => rows.map((r) => (r.id === row.id ? row : r)));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  }, []);

  /* ── webhook server status (the per-endpoint public URL) ── */
  const [status, setStatus] = useState<WebhooksStatus>({ running: false, endpoints: [] });
  useEffect(() => {
    let alive = true;
    const poll = () => {
      window.cth.webhooksStatus()
        .then((s) => { if (alive && s) setStatus(s); })
        .catch(() => { /* keep the last answer */ });
    };
    poll();
    const timer = setInterval(poll, STATUS_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  return useMemo(() => ({
    ready: rulesReady && historyReady,
    loadError,
    missions,
    contextTrigger,
    houseRules,
    webhooks,
    history,
    status,
    saveMissions,
    patchMission,
    deleteMission,
    patchContext,
    saveRule,
    patchRule,
    deleteRule,
    saveWebhooks,
    patchWebhook,
    deleteWebhook,
    decide
  }), [
    rulesReady, historyReady, loadError, missions, contextTrigger, houseRules, webhooks, history, status,
    saveMissions, patchMission, deleteMission, patchContext, saveRule, patchRule, deleteRule, saveWebhooks, patchWebhook, deleteWebhook, decide
  ]);
}
