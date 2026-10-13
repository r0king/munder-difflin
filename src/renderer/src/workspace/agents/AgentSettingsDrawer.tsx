/**
 * "Agent settings" in the room: change its engine, model, role or token cap
 * without leaving.
 *
 * Every write rides an existing path:
 *   - engine + model → restartAgentProcess (the Command Center's restart): the
 *     same engine CONTINUES the conversation on the new model; a different
 *     engine starts a fresh session. Saved on the agent (command/provider/model)
 *     so a later restore relaunches what you picked.
 *   - role → the roster description (updateAgent) and the hive registry role
 *     (hivePatchAgentRole), the two places EditAgentModal / the hire flow keep.
 *   - token cap → setAgentTokenCap, main's atomic per-agent write (the breaker
 *     reads it; WORK tokens: input + output + cache writes).
 *
 * Text saves when you leave the field; there is no Save button. A restart is
 * the one explicit action, because it interrupts the agent.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type Agent } from '@/store/store';
import {
  inferAgentProvider,
  modelProvidersForAgent,
  modelsForProvider,
  providerPreset,
  type AgentProvider,
  type HarnessConfig
} from '@/store/config';
import { MAX_AGENT_TOKEN_CAP } from '@shared/tokenCaps';
import { isComposingKey } from '@shared/imeGuard';
import { Button, IconButton, WsIcon } from '../ui';
import { canResume, restartAgentProcess, restartErrorText, useRestartState } from './restartAgent';

export function AgentSettingsDrawer({ agent, config, onClose }: { agent: Agent; config: HarnessConfig; onClose: () => void }) {
  const { t } = useTranslation();
  const updateAgent = useStore((s) => s.updateAgent);
  const restarting = useRestartState((s) => !!s.restarting[agent.id]);
  const restartError = useRestartState((s) => s.errors[agent.id] || '');
  const currentProvider = inferAgentProvider(agent.command, agent.provider);

  const [provider, setProvider] = useState<AgentProvider>(currentProvider);
  const [model, setModel] = useState<string | undefined>(agent.model);
  const [confirming, setConfirming] = useState(false);
  const [role, setRole] = useState(agent.description ?? '');
  const [roleNote, setRoleNote] = useState<{ text: string; error?: boolean } | null>(null);
  const savedCap = config.agentTokenCaps?.[agent.id];
  const [cap, setCap] = useState(savedCap ? String(savedCap) : '');
  const [capNote, setCapNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [result, setResult] = useState('');

  useEffect(() => { setCap(savedCap ? String(savedCap) : ''); }, [savedCap]);
  useEffect(() => { setRole(agent.description ?? ''); }, [agent.description]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const providers = useMemo(() => {
    const list = modelProvidersForAgent(!!agent.isGod);
    return list.some((p) => p.id === currentProvider) ? list : [providerPreset(currentProvider), ...list];
  }, [agent.isGod, currentProvider]);
  const preset = providerPreset(provider);
  const models = useMemo(() => {
    const known = modelsForProvider(provider);
    return model && !known.some((m) => m.id === model) ? [...known, { id: model, label: model }] : known;
  }, [provider, model]);

  const engineChanged = provider !== currentProvider || (model ?? '') !== (agent.model ?? '');
  const sameEngine = provider === currentProvider;
  const busyAgent = agent.status !== 'idle';

  const pickProvider = (p: AgentProvider): void => {
    setProvider(p);
    setConfirming(false);
    setResult('');
    if (p === currentProvider) { setModel(agent.model); return; }
    setModel(p === 'claude' ? config.defaultModel : config.providerDefaultModels?.[p]);
  };

  const apply = async (): Promise<void> => {
    if (busyAgent && !confirming) { setConfirming(true); return; }
    setConfirming(false);
    setResult('');
    const r = await restartAgentProcess(agent.id, {
      provider,
      model,
      resume: sameEngine && canResume(agent),
      resumeOptional: true
    });
    if (r.ok) setResult(r.resumed ? t('wsAgents.settings.appliedContinued', { name: agent.name }) : t('wsAgents.settings.appliedFresh', { name: agent.name }));
  };

  const saveRole = async (): Promise<void> => {
    const next = role.trim();
    if (next === (agent.description ?? '').trim()) return;
    if (!next) { setRole(agent.description ?? ''); return; }
    updateAgent(agent.id, { description: next });
    try {
      const r = await window.cth.hivePatchAgentRole(agent.id, next);
      setRoleNote(r.ok ? { text: t('wsAgents.settings.roleSaved') } : { text: r.error ?? t('wsAgents.settings.roleFailed'), error: true });
    } catch (e) {
      setRoleNote({ text: e instanceof Error ? e.message : String(e), error: true });
    }
  };

  const saveCap = async (): Promise<void> => {
    const raw = cap.trim().replace(/[\s,_]/g, '');
    const value = raw === '' ? undefined : Number(raw);
    if (value !== undefined && (!Number.isInteger(value) || value <= 0 || value > MAX_AGENT_TOKEN_CAP)) {
      setCapNote({ text: t('wsAgents.settings.capInvalid'), error: true });
      return;
    }
    if (value === savedCap) return;
    try {
      const updated = await window.cth.setAgentTokenCap(agent.id, value);
      const stored = updated.agentTokenCaps?.[agent.id];
      setCap(stored ? String(stored) : '');
      setCapNote({ text: stored ? t('wsAgents.settings.capSaved', { cap: stored.toLocaleString() }) : t('wsAgents.settings.capCleared') });
    } catch (e) {
      setCapNote({ text: e instanceof Error ? e.message : String(e), error: true });
    }
  };

  return (
    <aside className="cth-ws-agents-drawer" role="dialog" aria-label={t('wsAgents.settings.title', { name: agent.name })}>
      <div className="cth-ws-agents-drawer-head">
        <span className="cth-ws-ellipsis" style={{ flex: 1 }}>{t('wsAgents.settings.title', { name: agent.name })}</span>
        <IconButton label={t('wsAgents.settings.close')} onClick={onClose}><WsIcon name="close" /></IconButton>
      </div>
      <div className="cth-ws-agents-drawer-body">
        <div className="cth-ws-agents-field">
          <label className="cth-ws-agents-label" htmlFor={`ws-eng-${agent.id}`}>{t('wsAgents.settings.engine')}</label>
          <select
            id={`ws-eng-${agent.id}`}
            className="cth-ws-agents-select"
            value={provider}
            disabled={restarting}
            onChange={(e) => pickProvider(e.target.value as AgentProvider)}
          >
            {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
        {preset.supportsModel && (
          <div className="cth-ws-agents-field">
            <label className="cth-ws-agents-label" htmlFor={`ws-model-${agent.id}`}>{t('wsAgents.settings.model')}</label>
            <select
              id={`ws-model-${agent.id}`}
              className="cth-ws-agents-select"
              value={model ?? ''}
              disabled={restarting}
              onChange={(e) => { setModel(e.target.value || undefined); setConfirming(false); setResult(''); }}
            >
              {models.map((m) => <option key={m.id ?? 'default'} value={m.id ?? ''}>{m.label}</option>)}
            </select>
          </div>
        )}
        <div className="cth-ws-agents-field">
          <span className="cth-ws-agents-note">
            {sameEngine ? t('wsAgents.settings.sameEngineNote', { name: agent.name }) : t('wsAgents.settings.newEngineNote', { name: agent.name })}
          </span>
          <div className="cth-ws-agents-ticket-row">
            <Button
              size="sm"
              variant={confirming ? 'danger' : 'primary'}
              disabled={!engineChanged || restarting || !agent.ptyId}
              onClick={() => { void apply(); }}
            >
              {restarting ? t('wsAgents.settings.restarting')
                : confirming ? t('wsAgents.settings.confirmRestart', { name: agent.name })
                  : t('wsAgents.settings.apply')}
            </Button>
            {confirming && (
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>{t('wsAgents.settings.cancel')}</Button>
            )}
          </div>
          {confirming && <span className="cth-ws-agents-note">{t('wsAgents.settings.busyWarning', { name: agent.name })}</span>}
          {restartError && <span className="cth-ws-agents-note" data-tone="error">{restartErrorText(t, restartError)}</span>}
          {result && !restartError && <span className="cth-ws-agents-note" data-tone="ok">{result}</span>}
        </div>

        <div className="cth-ws-agents-field">
          <label className="cth-ws-agents-label" htmlFor={`ws-role-${agent.id}`}>{t('wsAgents.settings.role')}</label>
          <input
            id={`ws-role-${agent.id}`}
            className="cth-ws-agents-input"
            value={role}
            maxLength={300}
            dir="auto"
            placeholder={t('wsAgents.settings.rolePlaceholder')}
            onChange={(e) => { setRole(e.target.value); setRoleNote(null); }}
            onBlur={() => { void saveRole(); }}
            onKeyDown={(e) => { if (!isComposingKey(e) && e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
          <span className="cth-ws-agents-note" data-tone={roleNote?.error ? 'error' : roleNote ? 'ok' : undefined}>
            {roleNote?.text ?? t('wsAgents.settings.roleHint')}
          </span>
        </div>

        <div className="cth-ws-agents-field">
          <label className="cth-ws-agents-label" htmlFor={`ws-cap-${agent.id}`}>{t('wsAgents.settings.tokenCap')}</label>
          <input
            id={`ws-cap-${agent.id}`}
            className="cth-ws-agents-input"
            value={cap}
            inputMode="numeric"
            placeholder={t('wsAgents.settings.capPlaceholder')}
            onChange={(e) => { setCap(e.target.value); setCapNote(null); }}
            onBlur={() => { void saveCap(); }}
            onKeyDown={(e) => { if (!isComposingKey(e) && e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
          <span className="cth-ws-agents-note" data-tone={capNote?.error ? 'error' : capNote ? 'ok' : undefined}>
            {capNote?.text ?? t('wsAgents.settings.capHint')}
          </span>
        </div>
      </div>
    </aside>
  );
}
