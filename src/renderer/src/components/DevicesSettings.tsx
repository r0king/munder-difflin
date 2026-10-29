/**
 * Settings → Devices (spec: UI). Other Linux machines that run agents for
 * this floor. Add takes an id, a host and an optional user. Check runs the
 * setup checks over the link and shows a fix command for each failure.
 * Remove is refused while an agent, on the floor or waiting to be restored,
 * still runs there. Each device's state dot follows main's pushes
 * (store/devices).
 */
import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import { useStore } from '@/store/store';
import { deviceInUse, useDeviceStates } from '@/store/devices';
import { isValidDeviceHost, isValidDeviceId, isValidDeviceUser, type DeviceCheckItem, type DeviceConfig } from '@shared/devices';
import { PixelButton } from './PixelButton';
import { RemoteFloorSettings } from './RemoteFloorSettings';

const DOT: Record<string, string> = { online: 'var(--cth-mint)', connecting: 'var(--cth-lemon)', offline: 'var(--cth-coral)' };
const input: CSSProperties = {
  padding: '6px 8px 4px', background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontFamily: 'var(--cth-font-ui)',
  fontSize: 13, color: 'var(--cth-ink-900)', outline: 'none', minWidth: 0
};
const head: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 6
};
const mono: CSSProperties = { fontFamily: 'var(--cth-font-mono)', fontSize: 12 };

export function DevicesSettings({ config }: { config: HarnessConfig }) {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<DeviceConfig[]>(config.devices ?? []);
  const [form, setForm] = useState({ id: '', host: '', user: '' });
  const [error, setError] = useState<string>();
  const [checks, setChecks] = useState<Record<string, DeviceCheckItem[] | 'running'>>({});
  const states = useDeviceStates((s) => s.states);
  const agents = useStore((s) => s.agents);
  const restorable = useStore((s) => s.restorableAgents);

  /** True when saved; a refusal from main shows in the error line. */
  const save = async (next: DeviceConfig[]): Promise<boolean> => {
    try {
      const saved = await window.cth.updateConfig({ devices: next });
      setDevices(saved.devices ?? []);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };
  const add = async (): Promise<void> => {
    const id = form.id.trim();
    const host = form.host.trim();
    const user = form.user.trim();
    if (!isValidDeviceId(id, devices.map((d) => d.id))) { setError(t('devices.errId')); return; }
    if (!isValidDeviceHost(host)) { setError(t('devices.errHost')); return; }
    if (user && !isValidDeviceUser(user)) { setError(t('devices.errUser')); return; }
    setError(undefined);
    if (await save([...devices, { id, host, ...(user ? { user } : {}) }])) setForm({ id: '', host: '', user: '' });
  };
  const check = async (id: string): Promise<void> => {
    setChecks((c) => ({ ...c, [id]: 'running' }));
    const items = await window.cth.checkDevice(id).catch((): DeviceCheckItem[] => []);
    setChecks((c) => ({ ...c, [id]: items }));
  };

  return (
    <div>
      <div style={head}>{t('devices.title')}</div>
      <p style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)', margin: '0 0 10px' }}>{t('devices.intro')}</p>
      {devices.length === 0 && <p style={{ fontSize: 13, color: 'var(--cth-ink-700)', margin: 0 }}>{t('devices.none')}</p>}
      {devices.map((d) => {
        const status = states[d.id];
        const state = status?.state ?? 'offline';
        const inUse = deviceInUse([...agents, ...restorable], d.id);
        const result = checks[d.id];
        return (
          <div key={d.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--cth-ink-100)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span title={t(`devices.state.${state}`)} style={{ width: 8, height: 8, background: DOT[state], flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: 'var(--cth-ink-900)', fontWeight: 600 }}>{d.id}</span>
              <span style={{ ...mono, color: 'var(--cth-ink-500)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {d.user ? `${d.user}@` : ''}{d.host} · {t(`devices.state.${state}`)}
              </span>
              <PixelButton size="sm" variant="secondary" onClick={() => void check(d.id)} disabled={result === 'running'}>
                {result === 'running' ? t('devices.checking') : t('devices.check')}
              </PixelButton>
              <PixelButton
                size="sm" variant="secondary" disabled={inUse} title={inUse ? t('devices.inUse') : undefined}
                onClick={() => void save(devices.filter((x) => x.id !== d.id))}
              >
                {t('devices.remove')}
              </PixelButton>
            </div>
            {status?.error && <div style={{ fontSize: 12, color: 'var(--cth-coral)', marginTop: 4 }}>{status.error}</div>}
            {Array.isArray(result) && (
              <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0' }}>
                {result.map((it, i) => (
                  <li key={i} style={{ fontSize: 12, lineHeight: '18px', color: 'var(--cth-ink-900)' }}>
                    <span style={{ color: it.ok ? 'var(--cth-mint)' : 'var(--cth-coral)' }}>{it.ok ? '✓' : '✗'}</span>{' '}
                    {t(`devices.items.${it.id}`, { path: it.path })}
                    {!it.ok && it.fix && (
                      <div style={{ ...mono, color: 'var(--cth-ink-700)', marginInlineStart: 16, userSelect: 'text' }}>
                        {t('devices.fix')} {it.fix}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        <input style={{ ...input, width: 110 }} placeholder={t('devices.fieldId')} value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
        <input style={{ ...input, flex: 1 }} placeholder={t('devices.fieldHost')} value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
        <input style={{ ...input, width: 130 }} placeholder={t('devices.fieldUser')} value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} />
        <PixelButton size="sm" onClick={() => void add()}>{t('devices.add')}</PixelButton>
      </div>
      {error && <div style={{ fontSize: 12, color: 'var(--cth-coral)', marginTop: 4 }}>{error}</div>}
      <RemoteFloorSettings config={config} />
    </div>
  );
}
