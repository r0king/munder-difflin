/**
 * Router for the Stapler's windows, keyed on `location.hash` (main loads
 * `stapler.html#puck` or `#overlay` via ctx.loadRendererEntry). Owned by the
 * `stapler` unit; the puck route also hosts dictation (the `dictate` unit's
 * hook), because the puck is the one Stapler window that is always alive.
 */
import { useEffect, useState } from 'react';
import { useDirectionSync } from '@/i18n/useDirection';
import { Puck } from './Puck';
import { ScreenshotOverlay } from './ScreenshotOverlay';
import { useDictationHost } from './dictate/useDictationHost';

export type StaplerView = 'puck' | 'overlay' | 'unknown';

export function viewForHash(hash: string): StaplerView {
  const h = hash.replace(/^#/, '').split(/[?&/]/)[0];
  return h === 'puck' || h === 'overlay' ? h : 'unknown';
}

function PuckRoute() {
  useDictationHost();
  return <Puck />;
}

export function StaplerApp() {
  useDirectionSync();
  const [view, setView] = useState<StaplerView>(() => viewForHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setView(viewForHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (view === 'puck') return <PuckRoute />;
  if (view === 'overlay') return <ScreenshotOverlay />;
  return null;
}
