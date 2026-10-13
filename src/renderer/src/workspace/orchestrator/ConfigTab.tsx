/**
 * Configuration — his engine, model, role, standing brief and the floor's
 * autonomy switches, all saved the Workspace way (switches at once, text when
 * you leave the field; only the engine needs an explicit Apply, because it
 * restarts his terminal).
 *
 * Every value is an existing one: `godProvider` / `godModel` (config), the
 * agent's `description` (his role, mirrored into the hive registry the way
 * useHive heals it), `goal` (the standing brief the hook server injects on
 * his prompt channel — what EditAgentModal calls the Briefing), `autoMode` and
 * `orchestratorMaySpawn` (Settings → Autonomy).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type Agent } from '@/store/store';
import {
  AGENT_PROVIDER_PRESETS,
  inferAgentProvider,
  modelsForProvider,
  providerPreset,
  type AgentProvider,
  type HarnessConfig
} from '@/store/config';
import { canReceiveInbox } from '@shared/agentProvider';
import { isDurableRole } from '@shared/agentRole';
import { Button, Section, Toggle } from '../ui';
import { CommitInput } from './CommitInput';
import { OrchestratorRestartError, restartOrchestrator } from './restart';

const sameModel = (a: string | undefined, b: string | undefined): boolean => (a ?? '') === (b ?? '');

export function ConfigTab({ god, config }: { god: Agent; config: HarnessConfig }) {
  return (
    <div className="cth-ws-orch-scroll">
      <div className="cth-ws-orch-narrow">
        <EngineSection god={god} />
        <RoleSection god={god} />
        <AutonomySection god={god} config={config} />
      </div>
    </div>
  );
}

// ─── Engine ─────────────────────────────────────────────────────────────────

function EngineSection({ god }: { god: Agent }) {
  const { t } = useTranslation();
  const running = inferAgentProvider(god.command, god.provider);
  const [provider, setProvider] = useState<AgentProvider>(running);
  const [model, setModel] = useState<string | undefined>(god.model);
  const [busy, setBusy] = useState<'apply' | 'continue' | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Follow a change made elsewhere (Classic's floor tab, a restore) while the
  // picker is untouched.
  useEffect(() => { setProvider(running); setModel(god.model); }, [running, god.model]);

  const engines = AGENT_PROVIDER_PRESETS.filter((p) => canReceiveInbox(p.id));
  const models = modelsForProvider(provider);
  const changed = provider !== running || !sameModel(model, god.model);
  const preset = providerPreset(running);
  const canResume = running === 'claude' || !!preset.resumeFlag || !!preset.resumeSubcommand;

  const explain = (e: unknown): string => {
    if (e instanceof OrchestratorRestartError) return t(`wsOrchestrator.config.err.${e.code}`);
    return e instanceof Error ? e.message : String(e);
  };

  const apply = async () => {
    if (provider !== running && !window.confirm(t('wsOrchestrator.config.confirmEngine', { godName: god.name, engine: providerPreset(provider).label }))) return;
    setBusy('apply');
    setMessage(null);
    try {
      // Persist first: god is respawned from these on every boot, so a change
      // that only reached the live terminal would revert at the next launch.
      await window.cth.updateConfig({ godProvider: provider, godModel: model });
      const { resumed } = await restartOrchestrator(god, {
        provider,
        model,
        // A model change on the same engine keeps the conversation (the point
        // of switching mid-task); an engine change cannot carry it over.
        resume: provider === running,
        resumeOptional: true
      });
      setMessage({ ok: true, text: resumed ? t('wsOrchestrator.config.appliedResumed') : t('wsOrchestrator.config.appliedFresh') });
    } catch (e) {
      setMessage({ ok: false, text: explain(e) });
    } finally {
      setBusy(null);
    }
  };

  const restartContinue = async () => {
    setBusy('continue');
    setMessage(null);
    try {
      await restartOrchestrator(god, { resume: true });
      setMessage({ ok: true, text: t('wsOrchestrator.config.continued') });
    } catch (e) {
      setMessage({ ok: false, text: explain(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title={t('wsOrchestrator.config.engineTitle')}>
      <div className="cth-ws-orch-field">
        <span className="cth-ws-orch-field-label">{t('wsOrchestrator.config.engine')}</span>
        <div className="cth-ws-orch-field-control">
          <div className="cth-ws-orch-field-line">
            <select
              className="cth-ws-orch-select"
              value={provider}
              disabled={!!busy}
              aria-label={t('wsOrchestrator.config.engine')}
              onChange={(e) => {
                const next = e.target.value as AgentProvider;
                setProvider(next);
                // The engine's recommended orchestrator model, else its first.
                const p = providerPreset(next);
                setModel(next === running ? god.model : (p.recommendedOrchestratorModel ?? modelsForProvider(next)[0]?.id));
              }}
            >
              {engines.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <select
              className="cth-ws-orch-select"
              value={model ?? ''}
              disabled={!!busy}
              aria-label={t('wsOrchestrator.config.model')}
              onChange={(e) => setModel(e.target.value || undefined)}
            >
              {!models.some((m) => sameModel(m.id, model)) && (
                <option value={model ?? ''}>{model ?? t('wsOrchestrator.config.cliDefault')}</option>
              )}
              {models.map((m) => <option key={m.id ?? 'default'} value={m.id ?? ''}>{m.label}</option>)}
            </select>
          </div>
          <span className="cth-ws-orch-field-hint">
            {provider !== running ? t('wsOrchestrator.config.engineHintFresh') : t('wsOrchestrator.config.engineHintKeep')}
          </span>
        </div>
      </div>
      <div className="cth-ws-orch-field-line">
        <Button variant="primary" size="sm" disabled={!changed || !!busy || !god.ptyId} onClick={() => { void apply(); }}>
          {busy === 'apply' ? t('wsOrchestrator.config.restarting') : t('wsOrchestrator.config.apply')}
        </Button>
        {canResume && (
          <Button size="sm" disabled={!!busy || !god.ptyId} onClick={() => { void restartContinue(); }} title={t('wsOrchestrator.config.continueTip')}>
            {busy === 'continue' ? t('wsOrchestrator.config.restarting') : t('wsOrchestrator.config.continue')}
          </Button>
        )}
        {message && <span className={message.ok ? 'cth-ws-orch-saved' : 'cth-ws-orch-error'} role="status">{message.text}</span>}
      </div>
    </Section>
  );
}

// ─── Role and standing brief ────────────────────────────────────────────────

const identity = (s: string): string => s;

function RoleSection({ god }: { god: Agent }) {
  const { t } = useTranslation();
  const updateAgent = useStore((s) => s.updateAgent);
  const [goal, setGoal] = useState(god.goal ?? '');
  const [goalState, setGoalState] = useState<'idle' | 'saved'>('idle');
  const [roleError, setRoleError] = useState(false);
  const editingGoal = useRef(false);

  useEffect(() => { if (!editingGoal.current) setGoal(god.goal ?? ''); }, [god.goal]);
  useEffect(() => {
    if (goalState !== 'saved') return;
    const id = setTimeout(() => setGoalState('idle'), 2500);
    return () => clearTimeout(id);
  }, [goalState]);

  const saveRole = async (role: string) => {
    setRoleError(false);
    const next = role.trim();
    updateAgent(god.id, { description: next });
    // The registry's `role` is what the hive hands him at spawn; keep it in
    // step (a status-like caption is never written there — isDurableRole).
    if (isDurableRole(next)) {
      const res = await window.cth.hivePatchAgentRole(god.id, next).catch(() => ({ ok: false }));
      if (!res.ok) setRoleError(true);
    }
  };

  return (
    <Section title={t('wsOrchestrator.config.roleTitle')}>
      <div className="cth-ws-orch-field">
        <span className="cth-ws-orch-field-label">{t('wsOrchestrator.config.role')}</span>
        <div className="cth-ws-orch-field-control">
          <CommitInput<string>
            value={god.description ?? ''}
            format={identity}
            parse={(s) => (s.trim() ? s.trim().slice(0, 200) : 'invalid')}
            onCommit={saveRole}
            ariaLabel={t('wsOrchestrator.config.role')}
            placeholder={t('wsOrchestrator.config.rolePlaceholder')}
            wide
          />
          <span className={roleError ? 'cth-ws-orch-error' : 'cth-ws-orch-field-hint'}>
            {roleError ? t('wsOrchestrator.config.roleFailed') : t('wsOrchestrator.config.roleHint')}
          </span>
        </div>
      </div>
      <div className="cth-ws-orch-field">
        <span className="cth-ws-orch-field-label">{t('wsOrchestrator.config.brief')}</span>
        <div className="cth-ws-orch-field-control">
          <textarea
            className="cth-ws-orch-textarea"
            dir="auto"
            value={goal}
            placeholder={t('wsOrchestrator.config.briefPlaceholder', { godName: god.name })}
            aria-label={t('wsOrchestrator.config.brief')}
            onFocus={() => { editingGoal.current = true; }}
            onChange={(e) => setGoal(e.target.value)}
            onBlur={() => {
              editingGoal.current = false;
              const next = goal.trim();
              if (next === (god.goal ?? '').trim()) return;
              updateAgent(god.id, { goal: next || undefined });
              setGoalState('saved');
            }}
          />
          <span className="cth-ws-orch-field-hint">
            {goalState === 'saved' ? t('wsOrchestrator.saved') : t('wsOrchestrator.config.briefHint')}
          </span>
        </div>
      </div>
    </Section>
  );
}

// ─── Autonomy ───────────────────────────────────────────────────────────────

function AutonomySection({ god, config }: { god: Agent; config: HarnessConfig }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const save = (patch: Partial<HarnessConfig>) => {
    setFailed(false);
    window.cth.updateConfig(patch).catch(() => setFailed(true));
  };
  const autoMode = config.autoMode !== false;
  const maySpawn = config.orchestratorMaySpawn === true;
  return (
    <Section title={t('wsOrchestrator.config.autonomyTitle')}>
      <div className="cth-ws-orch-field">
        <span className="cth-ws-orch-field-label">{t('wsOrchestrator.config.autoMode')}</span>
        <div className="cth-ws-orch-field-control">
          <Toggle
            checked={autoMode}
            onChange={(on) => save({ autoMode: on })}
            label={autoMode ? t('wsOrchestrator.config.autoModeOn') : t('wsOrchestrator.config.autoModeOff')}
          />
          <span className="cth-ws-orch-field-hint">{t('wsOrchestrator.config.autoModeHint')}</span>
        </div>
      </div>
      <div className="cth-ws-orch-field">
        <span className="cth-ws-orch-field-label">{t('wsOrchestrator.config.maySpawn')}</span>
        <div className="cth-ws-orch-field-control">
          <Toggle
            checked={maySpawn}
            onChange={(on) => save({ orchestratorMaySpawn: on })}
            label={maySpawn ? t('wsOrchestrator.config.maySpawnOn', { godName: god.name }) : t('wsOrchestrator.config.maySpawnOff')}
          />
          <span className="cth-ws-orch-field-hint">
            {maySpawn ? t('wsOrchestrator.config.maySpawnHintOn', { godName: god.name }) : t('wsOrchestrator.config.maySpawnHintOff', { godName: god.name })}
          </span>
        </div>
      </div>
      {failed && <p className="cth-ws-orch-error">{t('wsOrchestrator.saveFailed')}</p>}
    </Section>
  );
}
