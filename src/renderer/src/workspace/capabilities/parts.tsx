/**
 * Small pieces the four Capabilities tabs share: the agent picker, the
 * write-only key field, a matrix mark, and the restart-to-apply button.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui';
import { providerPreset, type AgentProvider } from '@/store/config';
import { restartAgentProcess, restartErrorText, useRestartState } from '../agents/restartAgent';
import type { CellState } from '@shared/workspace/capabilities';
import type { FloorAgent } from './useCapabilities';
import './capabilities.css';

/** The engine's display name ("Claude Code", "Codex"). Product names, not UI words. */
export function engineLabel(provider: string): string {
  try { return providerPreset(provider as AgentProvider).label; } catch { return provider; }
}

export function AgentSelect({ agents, value, onChange, ariaLabel, includeEveryone }: {
  agents: FloorAgent[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  /** Offer "every agent on this machine" as the empty value. */
  includeEveryone?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <select className="cth-ws-capabilities-select" value={value} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value)}>
      {includeEveryone && <option value="">{t('wsCapabilities.common.everyone')}</option>}
      {!includeEveryone && agents.length === 0 && <option value="">{t('wsCapabilities.common.noAgents')}</option>}
      {agents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.isGod ? t('wsCapabilities.common.orchestratorName', { name: a.name }) : a.name}
        </option>
      ))}
    </select>
  );
}

/**
 * A secret that goes one way. Shows "Key saved" or "No key"; Replace opens a
 * password field whose value is sent once and dropped — nothing ever reads a
 * saved key back, so there is nothing to show.
 */
export function KeyField({ hasKey, onSave, onRemove, label }: {
  hasKey: boolean;
  onSave: (key: string) => Promise<{ ok: boolean; error?: string }>;
  onRemove?: () => Promise<unknown>;
  /** Accessible name of the input, e.g. "GitHub personal access token". */
  label: string;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setError('');
    try {
      const res = await onSave(value.trim());
      if (res.ok) { setEditing(false); setValue(''); }
      else setError(res.error || t('wsCapabilities.keys.saveFailed'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  if (!editing) {
    return (
      <span className="cth-ws-capabilities-key">
        <span className={hasKey ? undefined : 'cth-ws-muted'}>{hasKey ? t('wsCapabilities.keys.saved') : t('wsCapabilities.keys.none')}</span>
        <Button size="sm" onClick={() => { setEditing(true); setError(''); }}>
          {hasKey ? t('wsCapabilities.keys.replace') : t('wsCapabilities.keys.add')}
        </Button>
        {hasKey && onRemove && (
          <Button size="sm" variant="ghost" onClick={() => { void onRemove(); }}>{t('wsCapabilities.keys.remove')}</Button>
        )}
      </span>
    );
  }
  return (
    <span className="cth-ws-capabilities-key">
      <input
        className="cth-ws-capabilities-input cth-ws-capabilities-input--mono"
        type="password"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        aria-label={label}
        placeholder={hasKey ? t('wsCapabilities.keys.newPlaceholder') : t('wsCapabilities.keys.placeholder')}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') void save();
          if (e.key === 'Escape') { setEditing(false); setValue(''); }
        }}
      />
      <Button size="sm" variant="primary" disabled={busy || !value.trim()} onClick={() => { void save(); }}>
        {t('wsCapabilities.keys.save')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setValue(''); setError(''); }}>
        {t('wsCapabilities.common.cancel')}
      </Button>
      {error && <span className="cth-ws-capabilities-error">{error}</span>}
    </span>
  );
}

export function Mark({ state }: { state: CellState }) {
  return <span className="cth-ws-capabilities-mark" data-state={state} aria-hidden="true" />;
}

/** "Restart & Continue" for an agent running on an older setup than its grant.
 *  Reuses the agents unit's restart (the Command Center's sequence). */
export function RestartToApply({ agent }: { agent: FloorAgent }) {
  const { t } = useTranslation();
  const restarting = useRestartState((s) => !!s.restarting[agent.id]);
  const error = useRestartState((s) => s.errors[agent.id] ?? '');
  if (!agent.live) return null;
  return (
    <span className="cth-ws-capabilities-actions">
      <Button
        size="sm"
        variant="primary"
        disabled={restarting}
        title={t('wsCapabilities.restart.title', { name: agent.name })}
        onClick={() => { void restartAgentProcess(agent.id, { resume: true }); }}
      >
        {restarting ? t('wsCapabilities.restart.busy') : t('wsCapabilities.restart.action')}
      </Button>
      {error && <span className="cth-ws-capabilities-error">{restartErrorText(t, error)}</span>}
    </span>
  );
}

/** "3m ago" / "2 days ago" in the interface language. */
export function relativeTime(lng: string, ts: number, now = Date.now()): string {
  const s = Math.round((ts - now) / 1000);
  const abs = Math.abs(s);
  let rtf: Intl.RelativeTimeFormat;
  try { rtf = new Intl.RelativeTimeFormat(lng, { numeric: 'auto' }); } catch { rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' }); }
  if (abs < 60) return rtf.format(s, 'second');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}
