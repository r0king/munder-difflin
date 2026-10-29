/**
 * Settings → Devices → Control page (devices phase 2, item 8): turn the
 * phone-first control page on or off, and see where to open it. The page
 * binds only to this laptop's Tailscale address and lets in only this node's
 * Tailscale login (src/main/remoteFloor.ts). With Tailscale down it retries
 * every 30 s, so the address is polled while the toggle is on.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';

export function RemoteFloorSettings({ config }: { config: HarnessConfig }) {
  const { t } = useTranslation();
  const [on, setOn] = useState(config.remoteFloorEnabled === true);
  const [addr, setAddr] = useState<{ ip: string; port: number } | null>(null);

  useEffect(() => {
    if (!on) { setAddr(null); return; }
    let live = true;
    const poll = (): void => {
      void window.cth.remoteFloorAddress().then((a) => { if (live) setAddr(a); }).catch(() => { /* app closing */ });
    };
    poll();
    const timer = setInterval(poll, 5_000);
    return () => { live = false; clearInterval(timer); };
  }, [on]);

  const toggle = async (next: boolean): Promise<void> => {
    setOn(next);
    await window.cth.updateConfig({ remoteFloorEnabled: next });
  };
  const url = addr ? `http://${addr.ip}:${addr.port}` : null;

  return (
    <div style={{ marginTop: 16 }}>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--cth-ink-900)', cursor: 'pointer' }}>
        <input type="checkbox" checked={on} onChange={(e) => void toggle(e.target.checked)} />
        {t('remoteFloor.toggle')}
      </label>
      <p style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)', margin: '4px 0 0', marginInlineStart: 24 }}>
        {t('remoteFloor.hint')}
      </p>
      {on && (
        <div style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 12, marginTop: 4, marginInlineStart: 24, color: 'var(--cth-ink-700)', userSelect: 'text' }}>
          {url ? t('remoteFloor.address', { url }) : t('remoteFloor.waiting')}
        </div>
      )}
    </div>
  );
}
