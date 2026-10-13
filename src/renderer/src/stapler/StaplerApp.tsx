/**
 * Router for the Stapler's windows, keyed on `location.hash` — main loads
 * `stapler.html#<view>` via ctx.loadRendererEntry:
 *   #puck    the floating puck, its ring and panels (this unit);
 *   #overlay the screenshot region picker (this unit);
 *   #dictate the dictate unit's hidden recorder window (DictationHostPage).
 * Dictation runs in its own window, so the puck route hosts nothing of it.
 */
import { useEffect, useState } from 'react';
import { useDirectionSync } from '@/i18n/useDirection';
import { Puck } from './Puck';
import { ScreenshotOverlay } from './ScreenshotOverlay';
import { DictationHostPage } from './dictate/DictationHostPage';

export type StaplerView = 'puck' | 'overlay' | 'dictate' | 'unknown';

export function viewForHash(hash: string): StaplerView {
  const h = hash.replace(/^#/, '').split(/[?&/]/)[0];
  return h === 'puck' || h === 'overlay' || h === 'dictate' ? h : 'unknown';
}

export function StaplerApp() {
  useDirectionSync();
  const [view, setView] = useState<StaplerView>(() => viewForHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setView(viewForHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (view === 'puck') return <Puck />;
  if (view === 'overlay') return <ScreenshotOverlay />;
  if (view === 'dictate') return <DictationHostPage />;
  return null;
}
