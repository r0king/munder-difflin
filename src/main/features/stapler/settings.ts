/**
 * The Stapler's persisted switches: `<userData>/features/stapler/settings.json`
 * through ctx.read/writeFeatureSettings. That helper merges shallowly over the
 * defaults, so every nested value is re-validated here — the file is
 * hand-editable and must never be able to put the puck off screen or crash
 * register(). Pure; tested in test/stapler-settings.test.cjs.
 */
import {
  ORCHESTRATOR_TARGET,
  cleanTarget,
  fitRegion,
  isStaplerTarget,
  type Region,
  type StaplerTarget
} from '../../../shared/features/stapler';
import { sanitizePlacement, type SavedPlacement } from './geometry';

export interface StaplerSettings {
  /** The puck is shown (restored at launch). */
  enabled: boolean;
  /** "Make invisible": excluded from screen shares and recordings. */
  invisible: boolean;
  /** Where the puck sits, per display. */
  placement: SavedPlacement;
  /** The To menu "remembers who you picked". */
  lastTarget: StaplerTarget;
  /** "The region is remembered" — per display id, in CSS px. */
  regions: Record<string, Region>;
}

export const DEFAULT_SETTINGS: StaplerSettings = {
  enabled: false,
  invisible: false,
  placement: { positions: {} },
  lastTarget: ORCHESTRATOR_TARGET,
  regions: {}
};

/** A remembered region only has to be a plausible rectangle here; it is fitted
 *  to the display's real size when the overlay opens. */
const BIG_VIEW = { width: 100_000, height: 100_000 };

export function sanitizeSettings(raw: unknown): StaplerSettings {
  const v = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const regions: Record<string, Region> = {};
  if (v.regions && typeof v.regions === 'object' && !Array.isArray(v.regions)) {
    for (const [k, r] of Object.entries(v.regions as Record<string, unknown>).slice(0, 32)) {
      const fitted = k.length <= 64 ? fitRegion(r, BIG_VIEW) : null;
      if (fitted) regions[k] = fitted;
    }
  }
  return {
    enabled: v.enabled === true,
    invisible: v.invisible === true,
    placement: sanitizePlacement(v.placement),
    lastTarget: isStaplerTarget(v.lastTarget) ? cleanTarget(v.lastTarget) : ORCHESTRATOR_TARGET,
    regions
  };
}
