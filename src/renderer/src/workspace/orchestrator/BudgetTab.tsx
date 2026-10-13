/**
 * Budget and breaker — "Set a cap in dollars, a default token cap per agent,
 * or a cap for one agent. The breaker stops a runaway loop."
 *
 *   - Spend today vs the daily dollar cap (features/orchestrator.ts folds the
 *     cost ledger and enforces it: at the cap, deliveries pause).
 *   - Token caps: the default every agent gets (features/orchestrator.ts →
 *     breaker config) and each agent's own (the existing agentTokenCaps,
 *     written through setAgentTokenCap so concurrent writers merge in main).
 *   - The breaker: armed / off, steer-only vs allowed to stop a terminal (the
 *     existing circuitBreaker config), and where every agent stands.
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import type { HarnessConfig } from '@/store/config';
import { useFleetTelemetry } from '@/hooks/useTelemetry';
import { MAX_AGENT_TOKEN_CAP } from '@shared/tokenCaps';
import { parseCapInput, parseTokenInput } from '@shared/workspace/orchestratorBudget';
import { Button, Chip, EmptyState, Section, Spinner, Toggle, type ChipTone } from '../ui';
import { CommitInput } from './CommitInput';
import { adoptOrchestratorState, useOrchestratorState } from './useOrchestratorState';
import { useBreakerLevels, type BreakerLevel } from './useBreakerLevels';
import { formatDayKeyShort, formatTokens, formatUsd, useParticipantLabel } from './format';

/** The breaker's own defaults (src/main/breaker.ts DEFAULTS), shown when unset. */
const BREAKER_DEFAULTS = { repeatedToolLimit: 8, errorStormLimit: 5, tokenVelocityPerMin: 60_000 };

const LEVEL_TONE: Record<BreakerLevel, ChipTone> = {
  healthy: 'ok', steering: 'warn', constrained: 'danger', stopped: 'danger'
};

const fmtCap = (v: number | null): string => (v === null ? '' : v.toFixed(2));
const fmtTokCap = (v: number | null): string => (v === null ? '' : formatTokens(v));
const parseTokCap = (s: string): number | null | 'invalid' => parseTokenInput(s, MAX_AGENT_TOKEN_CAP);

export function BudgetTab({ config }: { config: HarnessConfig }) {
  return (
    <div className="cth-ws-orch-scroll">
      <div className="cth-ws-orch-narrow">
        <SpendSection />
        <TokenCapsSection config={config} />
        <BreakerSection config={config} />
      </div>
    </div>
  );
}

// ─── Spend today ────────────────────────────────────────────────────────────

function SpendSection() {
  const { t, i18n } = useTranslation();
  const { label } = useParticipantLabel();
  const { state, error } = useOrchestratorState();
  const [draft, setDraft] = useState<number | null | 'invalid' | null>(null);

  const saveCap = useCallback(async (cap: number | null) => {
    adoptOrchestratorState(await window.cth.features.orchestrator.setDailyCap(cap));
  }, []);

  if (!state) {
    return (
      <Section title={t('wsOrchestrator.budget.spendTitle')}>
        {error
          ? <p className="cth-ws-orch-error">{error}</p>
          : <EmptyState compact icon={<Spinner label={t('wsOrchestrator.loading')} />} title={t('wsOrchestrator.loading')} />}
      </Section>
    );
  }
  const b = state.budget;
  const pct = b.dailyCapUsd ? Math.min(100, Math.round(b.fraction * 100)) : 0;
  const maxBar = Math.max(b.dailyCapUsd ?? 0, ...b.history.map((h) => h.usd), 0.01);
  const overNow = typeof draft === 'number' && b.ready && b.spendTodayUsd >= draft;

  return (
    <Section title={t('wsOrchestrator.budget.spendTitle')}>
      {b.noHive ? (
        <p className="cth-ws-orch-muted">{t('wsOrchestrator.budget.noHive')}</p>
      ) : (
        <div className="cth-ws-orch-spend">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cth-space-2)', minWidth: 0 }}>
            <div>
              <div className="cth-ws-orch-figure">{b.ready ? formatUsd(b.spendTodayUsd) : '…'}</div>
              <div className="cth-ws-orch-figure-sub">
                {!b.ready
                  ? t('wsOrchestrator.budget.reading')
                  : b.dailyCapUsd
                    ? t('wsOrchestrator.budget.ofCapLeft', { cap: formatUsd(b.dailyCapUsd), left: formatUsd(b.remainingUsd ?? 0) })
                    : t('wsOrchestrator.budget.noCapSet')}
              </div>
            </div>
            {b.dailyCapUsd ? (
              <div
                className="cth-ws-orch-meter cth-ws-orch-meter--lg"
                role="meter"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                aria-label={t('wsOrchestrator.budget.meterAria')}
              >
                <div className={`cth-ws-orch-meter-fill cth-ws-orch-meter-fill--${b.level}`} style={{ width: `${pct}%` }} />
              </div>
            ) : null}
            <div className="cth-ws-orch-field-line">
              <span className="cth-ws-orch-field-label">{t('wsOrchestrator.budget.capLabel')}</span>
              <span className="cth-ws-orch-mono" aria-hidden="true">$</span>
              <CommitInput<number | null>
                value={b.dailyCapUsd}
                format={fmtCap}
                parse={parseCapInput}
                onCommit={saveCap}
                onDraft={setDraft}
                placeholder={t('wsOrchestrator.budget.capPlaceholder')}
                ariaLabel={t('wsOrchestrator.budget.capLabel')}
                inputMode="decimal"
              />
            </div>
            <p className={overNow ? 'cth-ws-orch-error' : 'cth-ws-orch-field-hint'} style={{ margin: 0 }}>
              {draft === 'invalid'
                ? t('wsOrchestrator.budget.capInvalid')
                : overNow
                  ? t('wsOrchestrator.budget.capBelowSpend')
                  : t('wsOrchestrator.budget.capHint')}
            </p>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cth-space-2)', minWidth: 0 }}>
            <span className="cth-ws-orch-field-hint">{t('wsOrchestrator.budget.lastSeven')}</span>
            <div className="cth-ws-orch-bars" role="img" aria-label={t('wsOrchestrator.budget.barsAria')}>
              {b.history.map((h) => {
                const today = h.day === b.today;
                const over = !!b.dailyCapUsd && h.usd >= b.dailyCapUsd;
                return (
                  <div key={h.day} className="cth-ws-orch-bar" title={`${h.day}: ${formatUsd(h.usd)}`}>
                    <div
                      className={`cth-ws-orch-bar-fill${over ? ' cth-ws-orch-bar-fill--over' : today ? ' cth-ws-orch-bar-fill--today' : ''}`}
                      style={{ height: `${Math.max(1, Math.round((h.usd / maxBar) * 80))}px` }}
                    />
                    <span className="cth-ws-orch-bar-label">{formatDayKeyShort(h.day, i18n.language)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {b.ready && b.byAgent.length > 0 && (
        <div className="cth-ws-orch-rows" style={{ marginTop: 'var(--cth-space-3)' }}>
          <span className="cth-ws-orch-field-hint">{t('wsOrchestrator.budget.byAgent')}</span>
          {b.byAgent.slice(0, 10).map((a) => (
            <div key={a.agentId} className="cth-ws-orch-row">
              <span className="cth-ws-orch-row-name"><span>{label(a.agentId)}</span></span>
              <span className="cth-ws-orch-row-value">{formatUsd(a.usd)}</span>
            </div>
          ))}
        </div>
      )}
      <p className="cth-ws-orch-field-hint" style={{ margin: 'var(--cth-space-2) 0 0' }}>{t('wsOrchestrator.budget.source')}</p>
    </Section>
  );
}

// ─── Token caps ─────────────────────────────────────────────────────────────

function TokenCapsSection({ config }: { config: HarnessConfig }) {
  const { t } = useTranslation();
  const { state } = useOrchestratorState();
  const agents = useStore((s) => s.agents);
  const { samples } = useFleetTelemetry();
  const workers = agents.filter((a) => !a.isGod && !a.isAssistant);
  const caps = config.agentTokenCaps ?? {};
  const def = state?.budget.defaultAgentTokenCap ?? null;
  const [rowError, setRowError] = useState<string | null>(null);

  const saveDefault = useCallback(async (v: number | null) => {
    adoptOrchestratorState(await window.cth.features.orchestrator.setDefaultTokenCap(v));
  }, []);

  return (
    <Section title={t('wsOrchestrator.budget.tokensTitle')}>
      <div className="cth-ws-orch-field">
        <span className="cth-ws-orch-field-label">{t('wsOrchestrator.budget.defaultCap')}</span>
        <div className="cth-ws-orch-field-control">
          <div className="cth-ws-orch-field-line">
            <CommitInput<number | null>
              value={def}
              format={fmtTokCap}
              parse={parseTokCap}
              onCommit={saveDefault}
              placeholder={t('wsOrchestrator.budget.noTokenCap')}
              ariaLabel={t('wsOrchestrator.budget.defaultCap')}
              disabled={!state}
            />
            <span className="cth-ws-orch-field-hint">{t('wsOrchestrator.budget.tokenFormat')}</span>
          </div>
          <span className="cth-ws-orch-field-hint">{t('wsOrchestrator.budget.defaultCapHint')}</span>
        </div>
      </div>

      {workers.length === 0 ? (
        <p className="cth-ws-orch-muted">{t('wsOrchestrator.budget.noWorkers')}</p>
      ) : (
        <div className="cth-ws-orch-rows">
          {workers.map((a) => {
            const s = samples[a.id];
            const work = s ? s.input + s.output + s.cacheCreation : 0;
            const own = typeof caps[a.id] === 'number' ? caps[a.id] : null;
            const effective = own ?? def;
            const over = effective !== null && work > effective;
            return (
              <div key={a.id} className="cth-ws-orch-row">
                <span className="cth-ws-orch-row-name"><span>{a.name}</span></span>
                <span className="cth-ws-orch-row-value" title={t('wsOrchestrator.budget.workTokensTip')}>
                  {s ? formatTokens(work) : '—'}
                  {effective !== null && ` / ${formatTokens(effective)}`}
                </span>
                {over && <Chip tone="danger">{t('wsOrchestrator.budget.overCap')}</Chip>}
                <CommitInput<number | null>
                  value={own}
                  format={fmtTokCap}
                  parse={parseTokCap}
                  onCommit={async (v) => {
                    setRowError(null);
                    try { await window.cth.setAgentTokenCap(a.id, v ?? undefined); }
                    catch (e) { setRowError(e instanceof Error ? e.message : String(e)); throw e; }
                  }}
                  placeholder={def !== null ? t('wsOrchestrator.budget.usesDefault', { cap: formatTokens(def) }) : t('wsOrchestrator.budget.noTokenCap')}
                  ariaLabel={t('wsOrchestrator.budget.agentCapAria', { name: a.name })}
                />
              </div>
            );
          })}
        </div>
      )}
      {rowError && <p className="cth-ws-orch-error">{rowError}</p>}
    </Section>
  );
}

// ─── Breaker ────────────────────────────────────────────────────────────────

function BreakerSection({ config }: { config: HarnessConfig }) {
  const { t } = useTranslation();
  const agents = useStore((s) => s.agents);
  const levels = useBreakerLevels();
  const cb = config.circuitBreaker ?? {};
  const enabled = cb.enabled !== false;
  const hardStop = cb.hardStop === true;
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const live = useMemo(() => agents.filter((a) => !a.isGod && !a.isAssistant && a.ptyId), [agents]);

  const patch = async (next: Partial<NonNullable<HarnessConfig['circuitBreaker']>>) => {
    setSaving(true);
    setFailed(false);
    try {
      // Merge with the latest config on disk, not this render's snapshot, so a
      // threshold saved from Settings a moment ago is not overwritten.
      const fresh = await window.cth.getConfig();
      await window.cth.updateConfig({ circuitBreaker: { ...(fresh.circuitBreaker ?? {}), ...next } });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title={t('wsOrchestrator.budget.breakerTitle')}
      actions={
        <Button size="sm" variant="ghost" onClick={() => window.dispatchEvent(new CustomEvent('cth:open-settings', { detail: { section: 'Autonomy & Budgets' } }))}>
          {t('wsOrchestrator.budget.thresholds')}
        </Button>
      }
    >
      <p className="cth-ws-orch-field-hint" style={{ margin: 0 }}>{t('wsOrchestrator.budget.breakerIntro')}</p>
      <div className="cth-ws-orch-field">
        <span className="cth-ws-orch-field-label">{t('wsOrchestrator.budget.armed')}</span>
        <div className="cth-ws-orch-field-control">
          <Toggle
            checked={enabled}
            disabled={saving}
            onChange={(on) => { void patch({ enabled: on }); }}
            label={enabled ? t('wsOrchestrator.breaker.armed') : t('wsOrchestrator.breaker.off')}
          />
          <span className="cth-ws-orch-field-hint">
            {t('wsOrchestrator.budget.limits', {
              repeat: cb.repeatedToolLimit ?? BREAKER_DEFAULTS.repeatedToolLimit,
              errors: cb.errorStormLimit ?? BREAKER_DEFAULTS.errorStormLimit,
              velocity: formatTokens(cb.tokenVelocityPerMin ?? BREAKER_DEFAULTS.tokenVelocityPerMin)
            })}
          </span>
        </div>
      </div>
      <div className="cth-ws-orch-field">
        <span className="cth-ws-orch-field-label">{t('wsOrchestrator.budget.hardStop')}</span>
        <div className="cth-ws-orch-field-control">
          <Toggle
            checked={hardStop}
            disabled={saving || !enabled}
            onChange={(on) => { void patch({ hardStop: on }); }}
            label={hardStop ? t('wsOrchestrator.budget.hardStopOn') : t('wsOrchestrator.budget.hardStopOff')}
          />
          <span className="cth-ws-orch-field-hint">{t('wsOrchestrator.budget.hardStopHint')}</span>
        </div>
      </div>
      {failed && <p className="cth-ws-orch-error">{t('wsOrchestrator.saveFailed')}</p>}

      {live.length === 0 ? (
        <p className="cth-ws-orch-muted">{t('wsOrchestrator.budget.noLive')}</p>
      ) : (
        <div className="cth-ws-orch-rows">
          {live.map((a) => {
            const entry = levels[a.id];
            const level: BreakerLevel = enabled ? (entry?.level ?? 'healthy') : 'healthy';
            return (
              <div key={a.id} className="cth-ws-orch-row" style={{ alignItems: 'flex-start' }}>
                <span className="cth-ws-orch-row-name" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                  <span>{a.name}</span>
                  {entry?.reason && level !== 'healthy' && <span className="cth-ws-orch-row-reason">{entry.reason}</span>}
                </span>
                <Chip tone={enabled ? LEVEL_TONE[level] : 'neutral'}>
                  {enabled ? t(`wsOrchestrator.level.${level}`) : t('wsOrchestrator.breaker.off')}
                </Chip>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
