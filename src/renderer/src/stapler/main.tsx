/**
 * Entry for the Stapler's windows (src/renderer/stapler.html), built as a
 * second renderer input beside index.html. The window's hash picks the view —
 * see StaplerApp.
 *
 * Foundation-owned (the `stapler` unit owns everything else in this folder).
 *
 * THIS WINDOW HAS NO HIVE STORE. Never import '@/store/store' here: the store
 * loads and re-writes the roster (localStorage + <harnessHome>/roster.json) at
 * module load and on unload, and a second writer with a stale copy would
 * clobber the main window's roster. Agents come from
 * `window.cth.features.getRoster()` / `onRoster`, and text goes out through
 * `window.cth.features.deliver(...)`.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/design/global.css';
import i18n from '@/i18n';
import { setAppTheme } from '@/design/theme';
import { StaplerApp } from './StaplerApp';

// The theme and language are chosen in the main window and persisted to
// localStorage, which this window shares (same origin). A `storage` event fires
// here when the main window writes, so follow it live instead of only on open.
window.addEventListener('storage', (e) => {
  if (e.key === 'cth.theme' && (e.newValue === 'light' || e.newValue === 'dark')) setAppTheme(e.newValue);
  if (e.key === 'cth.language' && e.newValue && e.newValue !== i18n.language) void i18n.changeLanguage(e.newValue);
});

const root = document.getElementById('root');
if (!root) throw new Error('No root element');

createRoot(root).render(
  <StrictMode>
    <StaplerApp />
  </StrictMode>
);
