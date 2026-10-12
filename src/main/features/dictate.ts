/**
 * Dictate into any app — main-process side (owned by the `dictate` unit).
 *
 * Hold the key, speak, release, and the text is typed where the cursor is:
 * the global hold-to-talk shortcut (Option on the Mac, Control+Alt+Space on
 * Windows and Linux X11; Wayland says why it cannot), the OS text-injection
 * helper, and the permission prompts (Microphone, Accessibility).
 *
 * Audio is captured in the puck window (renderer, stapler/dictate/
 * useDictationHost.ts) and transcribed via ./transcribe.ts (transcribeFile).
 * Return true from micLive() while recording so the mic gate opens.
 *
 * Channels: feat:dictate:<action>. FOUNDATION STUB: registers nothing yet.
 */
import type { FeatureModule } from './types';

export const dictateFeature: FeatureModule = {
  name: 'dictate',
  register(ctx) {
    void ctx;
    // TODO(dictate): register feat:dictate:* ipcMain handlers here.
  }
};
