/**
 * Props every Workspace screen receives from the shell (Workspace.tsx).
 *
 * `config` is App's live copy (it re-renders on every `config:changed`), so a
 * screen never needs its own getConfig()/onConfigChanged pair. Persist a change
 * with `window.cth.updateConfig(patch)`; the new config comes back down.
 */
import type { HarnessConfig } from '@/store/config';

export interface WorkspaceScreenProps {
  config: HarnessConfig;
}
