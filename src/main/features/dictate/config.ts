/**
 * Dictation settings: read back from disk, and patched from the renderer —
 * pure, unit-tested (test/dictate-config.test.cjs).
 *
 * Both inputs are untrusted: settings.json can be hand-edited or written by an
 * older build, and a patch crosses IPC. A bad stored value falls back to its
 * default (so a typo cannot lock the user out of the shortcut); a bad patch is
 * refused whole, with the field that failed, and nothing is saved.
 */
import {
  MAX_MAX_SECONDS,
  MIN_MAX_SECONDS,
  defaultDictateConfig,
  validateAccelerator,
  type AcceleratorError,
  type DictateConfig,
  type DictatePlatform
} from '../../../shared/features/dictate';

export function clampMaxSeconds(n: number): number {
  return Math.min(MAX_MAX_SECONDS, Math.max(MIN_MAX_SECONDS, Math.round(n)));
}

/** A stored settings object → a valid config, field by field. */
export function sanitizeDictateConfig(raw: unknown, platform: DictatePlatform): DictateConfig {
  const d = defaultDictateConfig(platform);
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const toggle = typeof r.accelerator === 'string' ? validateAccelerator(r.accelerator, platform, 'toggle') : null;
  const accelerator = toggle && toggle.ok ? toggle.accelerator : d.accelerator;
  const cancel = typeof r.cancelAccelerator === 'string'
    ? validateAccelerator(r.cancelAccelerator, platform, 'cancel', accelerator)
    : null;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    accelerator,
    cancelAccelerator: cancel && cancel.ok ? cancel.accelerator : d.cancelAccelerator,
    pasteMode: r.pasteMode === 'paste' || r.pasteMode === 'clipboard' ? r.pasteMode : d.pasteMode,
    restoreClipboard: typeof r.restoreClipboard === 'boolean' ? r.restoreClipboard : d.restoreClipboard,
    maxSeconds: typeof r.maxSeconds === 'number' && Number.isFinite(r.maxSeconds)
      ? clampMaxSeconds(r.maxSeconds)
      : d.maxSeconds
  };
}

export type PatchResult =
  | { ok: true; config: DictateConfig }
  | {
      ok: false;
      field: keyof DictateConfig;
      error: AcceleratorError | 'invalid';
    };

/**
 * Apply a renderer patch to the current config. Unknown keys are ignored;
 * a wrongly-typed known key is an error. The two accelerators are checked
 * against each other AFTER both are applied, so swapping them in one patch
 * works.
 */
export function applyDictatePatch(current: DictateConfig, patch: unknown, platform: DictatePlatform): PatchResult {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: true, config: current };
  const p = patch as Record<string, unknown>;
  const next: DictateConfig = { ...current };
  if (p.enabled !== undefined) {
    if (typeof p.enabled !== 'boolean') return { ok: false, field: 'enabled', error: 'invalid' };
    next.enabled = p.enabled;
  }
  if (p.restoreClipboard !== undefined) {
    if (typeof p.restoreClipboard !== 'boolean') return { ok: false, field: 'restoreClipboard', error: 'invalid' };
    next.restoreClipboard = p.restoreClipboard;
  }
  if (p.pasteMode !== undefined) {
    if (p.pasteMode !== 'paste' && p.pasteMode !== 'clipboard') return { ok: false, field: 'pasteMode', error: 'invalid' };
    next.pasteMode = p.pasteMode;
  }
  if (p.maxSeconds !== undefined) {
    if (typeof p.maxSeconds !== 'number' || !Number.isFinite(p.maxSeconds)) {
      return { ok: false, field: 'maxSeconds', error: 'invalid' };
    }
    next.maxSeconds = clampMaxSeconds(p.maxSeconds);
  }
  if (p.accelerator !== undefined) {
    if (typeof p.accelerator !== 'string' || p.accelerator.length > 100) return { ok: false, field: 'accelerator', error: 'syntax' };
    next.accelerator = p.accelerator;
  }
  if (p.cancelAccelerator !== undefined) {
    if (typeof p.cancelAccelerator !== 'string' || p.cancelAccelerator.length > 100) {
      return { ok: false, field: 'cancelAccelerator', error: 'syntax' };
    }
    next.cancelAccelerator = p.cancelAccelerator;
  }
  const toggle = validateAccelerator(next.accelerator, platform, 'toggle', next.cancelAccelerator);
  if (!toggle.ok) {
    // A conflict is reported on the field the user just edited.
    const field = toggle.error === 'conflict' && p.accelerator === undefined ? 'cancelAccelerator' : 'accelerator';
    return { ok: false, field, error: toggle.error };
  }
  const cancel = validateAccelerator(next.cancelAccelerator, platform, 'cancel', toggle.accelerator);
  if (!cancel.ok) return { ok: false, field: 'cancelAccelerator', error: cancel.error };
  next.accelerator = toggle.accelerator;
  next.cancelAccelerator = cancel.accelerator;
  return { ok: true, config: next };
}
