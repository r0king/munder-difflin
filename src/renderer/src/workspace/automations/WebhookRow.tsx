/**
 * A webhook: an inbound HTTP endpoint that brings outside events to the floor.
 *
 * Same record as Settings → Connections and Classic's Webhooks (the
 * webhookTriggers store mirror, persisted with webhooks:save), with what the
 * Classic row shows — the public address, the secret, the trust mode, the body
 * schema — plus the endpoint's deliveries: the held ones first, each waiting on
 * Approve or Reject, then the recent ones. Approving releases the message into
 * the hive exactly as an auto-allowed one would have gone (a card plus a
 * request to the orchestrator); rejecting only records the verdict.
 */
import { forwardRef, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TRIGGER_MODES, type TriggerHistoryEntry, type TriggerMode, type WebhookTrigger } from '@shared/triggers';
import { firstLine, webhookDeliveries } from '@shared/workspace/automations';
import { Button, Chip, SegmentedControl } from '../ui';
import { navigateWorkspace } from '../store';
import { RowShell } from './RowShell';
import { BlurText, Field, useSaveState } from './fields';
import { relTime, webhookLine } from './describe';
import type { AutomationsData, WebhooksStatus } from './useAutomationsData';

const NAME_MAX = 80;
const RECENT_LIMIT = 5;
const COPIED_FOR_MS = 1400;

export const WebhookRow = forwardRef<HTMLDivElement, {
  hook: WebhookTrigger;
  data: AutomationsData;
  status: WebhooksStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  autoFocus?: boolean;
  now: number;
  describeError: (code: string) => string;
  onDelete: () => void;
}>(function WebhookRow({ hook, data, status, open, onOpenChange, autoFocus, now, describeError, onDelete }, ref) {
  const { t } = useTranslation();
  const { state, track, fail, clear } = useSaveState(describeError);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<'url' | 'secret' | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A closed row never keeps a secret on screen.
  useEffect(() => { if (!open) setRevealed(false); }, [open]);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  const url = status.endpoints.find((e) => e.id === hook.id)?.url ?? '';
  const deliveries = webhookDeliveries(data.history, hook.id, RECENT_LIMIT);
  const held = deliveries.held.length;

  const patch = async (fields: Partial<WebhookTrigger>) => {
    const res = await track(data.patchWebhook(hook.id, fields));
    // Main refuses to enable an endpoint with no secret — it would be an open
    // door. Say so instead of letting the switch quietly snap back.
    if (res.ok && fields.enabled === true && res.stored && !res.stored.enabled) {
      fail(t('wsAutomations.webhook.noSecret'));
    }
    return res;
  };

  const copy = (what: 'url' | 'secret', text: string) => {
    window.cth.copyToClipboard(text)
      .then(() => {
        setCopied(what);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(null), COPIED_FOR_MS);
      })
      .catch(() => fail(t('wsAutomations.webhook.copyFailed')));
  };

  const reach = !hook.enabled
    ? null
    : url ? t('wsAutomations.webhook.live')
      : status.running ? t('wsAutomations.webhook.noAddressYet') : t('wsAutomations.webhook.offline');

  return (
    <RowShell
      ref={ref}
      kind="webhook"
      name={hook.name}
      description={webhookLine(t, hook)}
      meta={<>
        {held > 0 && <Chip tone="warn">{t('wsAutomations.webhook.heldChip', { n: held })}</Chip>}
        {reach}
      </>}
      enabled={hook.enabled}
      onToggle={(on) => { clear(); void patch({ enabled: on }); }}
      open={open}
      onOpenChange={onOpenChange}
      save={state}
      bodyId={`automation-${hook.id}`}
      onDelete={onDelete}
    >
      <div className="cth-ws-automations-grid">
        <BlurText
          label={t('wsAutomations.field.name')}
          value={hook.name}
          rule={{ required: true, singleLine: true, maxLength: NAME_MAX }}
          onCommit={(name) => patch({ name })}
          placeholder={t('wsAutomations.webhook.namePlaceholder')}
          autoFocus={autoFocus}
        />
        <Field label={t('wsAutomations.webhook.trust')} hint={TRIGGER_MODE_HINT(t, hook.mode)}>
          <SegmentedControl<TriggerMode>
            size="sm"
            ariaLabel={t('wsAutomations.webhook.trust')}
            value={hook.mode}
            options={TRIGGER_MODES.map((m) => ({ value: m.value, label: t(`wsAutomations.webhook.mode.${m.value}`) }))}
            onChange={(mode) => { void patch({ mode }); }}
          />
        </Field>

        <Field
          label={t('wsAutomations.webhook.address')}
          wide
          hint={url
            ? t('wsAutomations.webhook.howToCall')
            : hook.enabled
              ? (status.running ? t('wsAutomations.webhook.tunnelPending') : t('wsAutomations.webhook.serverDown'))
              : t('wsAutomations.webhook.addressWhenOn')}
        >
          <div className="cth-ws-automations-inline">
            <span className="cth-ws-automations-urlbox" dir="ltr">{url || '—'}</span>
            <Button size="sm" variant="secondary" disabled={!url} onClick={() => copy('url', url)}>
              {copied === 'url' ? t('wsAutomations.webhook.copied') : t('wsAutomations.webhook.copy')}
            </Button>
          </div>
        </Field>

        <Field label={t('wsAutomations.webhook.secret')} wide hint={t('wsAutomations.webhook.secretHint')}>
          <div className="cth-ws-automations-inline">
            {/* Masked by default, and never in a title/tooltip — those end up in
                screenshots and accessibility trees. */}
            <input
              className="cth-ws-automations-input cth-ws-automations-mono"
              style={{ flex: 1 }}
              type={revealed ? 'text' : 'password'}
              value={hook.secret}
              readOnly
              dir="ltr"
              aria-label={t('wsAutomations.webhook.secret')}
            />
            <Button size="sm" variant="ghost" onClick={() => setRevealed((r) => !r)}>
              {revealed ? t('wsAutomations.webhook.hide') : t('wsAutomations.webhook.show')}
            </Button>
            <Button size="sm" variant="secondary" disabled={!hook.secret} onClick={() => copy('secret', hook.secret)}>
              {copied === 'secret' ? t('wsAutomations.webhook.copied') : t('wsAutomations.webhook.copy')}
            </Button>
          </div>
        </Field>

        <BlurText
          label={t('wsAutomations.webhook.schema')}
          hint={t('wsAutomations.webhook.schemaHint')}
          value={hook.schema}
          multiline
          rows={6}
          wide
          mono
          rule={{ required: true }}
          // Never store a schema that does not parse: it would lock the caller
          // out of its own endpoint with nothing on screen to say why.
          validate={(v) => {
            try { JSON.parse(v); return null; } catch (e) {
              return t('wsAutomations.webhook.badSchema', { error: e instanceof Error ? e.message : String(e) });
            }
          }}
          onCommit={(schema) => patch({ schema })}
        />
      </div>

      <Deliveries
        held={deliveries.held}
        recent={deliveries.recent}
        total={deliveries.total}
        now={now}
        onDecide={(id, decision) => track(data.decide(id, decision))}
      />
    </RowShell>
  );
});

function TRIGGER_MODE_HINT(t: (k: string) => string, mode: TriggerMode): string {
  return t(`wsAutomations.webhook.modeHint.${mode}`);
}

/* ─────────────────────────────── deliveries ─────────────────────────────── */

function Deliveries({ held, recent, total, now, onDecide }: {
  held: TriggerHistoryEntry[];
  recent: TriggerHistoryEntry[];
  total: number;
  now: number;
  onDecide: (id: string, decision: 'approved' | 'rejected') => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const shown = held.length + recent.length;

  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    setBusy(id);
    try { await onDecide(id, decision); } finally { setBusy(null); }
  };

  return (
    <Field
      label={t('wsAutomations.webhook.deliveries')}
      wide
      hint={total > shown
        ? <button type="button" className="cth-ws-btn cth-ws-btn--ghost cth-ws-btn--sm" onClick={() => navigateWorkspace({ kind: 'inbox', section: 'webhooks' })}>
            {t('wsAutomations.webhook.allInInbox', { n: total })}
          </button>
        : undefined}
    >
      {shown === 0
        ? <p className="cth-ws-automations-hint">{t('wsAutomations.webhook.noDeliveries')}</p>
        : (
          <div className="cth-ws-automations-deliveries">
            {held.map((e) => (
              <div key={e.id} className="cth-ws-automations-delivery" data-held="true">
                <div className="cth-ws-automations-deliveryhead">
                  <Chip tone="warn">{t('wsAutomations.webhook.decision.pending')}</Chip>
                  <span className="cth-ws-automations-deliverytitle" dir="auto">{e.title || firstLine(e.body, 120)}</span>
                  <span>{e.peer ? t('wsAutomations.webhook.from', { peer: e.peer }) : null}</span>
                  <span>{relTime(t, e.at, now)}</span>
                </div>
                <p className="cth-ws-automations-deliverybody" dir="auto">{e.body}</p>
                <div className="cth-ws-automations-inline">
                  <Button size="sm" variant="primary" disabled={busy === e.id} onClick={() => { void decide(e.id, 'approved'); }}>
                    {t('wsAutomations.webhook.approve')}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy === e.id} onClick={() => { void decide(e.id, 'rejected'); }}>
                    {t('wsAutomations.webhook.reject')}
                  </Button>
                  <span className="cth-ws-automations-hint">
                    {e.kind === 'directive' ? t('wsAutomations.webhook.kindDirective') : t('wsAutomations.webhook.kindCommunication')}
                  </span>
                </div>
              </div>
            ))}
            {recent.map((e) => (
              <div key={e.id} className="cth-ws-automations-delivery">
                <div className="cth-ws-automations-deliveryhead">
                  <Chip tone={e.decision === 'rejected' ? 'danger' : 'ok'}>
                    {t(`wsAutomations.webhook.decision.${e.decision === 'rejected' ? 'rejected' : e.decision === 'approved' ? 'approved' : 'delivered'}`)}
                  </Chip>
                  <span className="cth-ws-automations-deliverytitle" dir="auto">{e.title || firstLine(e.body, 120)}</span>
                  <span>{e.peer ? t('wsAutomations.webhook.from', { peer: e.peer }) : null}</span>
                  <span>{relTime(t, e.at, now)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
    </Field>
  );
}
