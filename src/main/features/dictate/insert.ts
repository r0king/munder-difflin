/**
 * Typing dictated words into the app in front — main process only.
 *
 * The words go onto the clipboard and the platform's paste key is pressed
 * (strategy.ts picks how, platform.ts finds the helper). Afterwards the
 * clipboard the user had is put back — but only after the target app has had
 * time to read it, and only if nobody copied something new in between.
 *
 * Restoring is best-effort by nature: the clipboard can hold formats Electron
 * cannot read back (file references from Finder or Explorer, app-private
 * types). Text, HTML, RTF and images come back; anything else does not, and
 * the settings say so next to the switch.
 */
import { clipboard, type NativeImage } from 'electron';
import type { DictatePasteMode, DictatePlatform, InsertNotice, InsertStrategy } from '../../../shared/features/dictate';
import { chooseInsertStrategy, classifyPasteFailure, pasteCommand, shouldRestoreClipboard } from './strategy';
import { accessibilityTrusted, runTool, sessionEnv, toolPaths, toolsFrom } from './platform';

/** How long the target app gets to read the clipboard before it is restored.
 *  Electron and browser apps read it on the next event-loop turn or two; a
 *  busy app can lag by hundreds of ms. */
export const RESTORE_DELAY_MS = 900;
/** One paste helper run. osascript and PowerShell cold-start in ~0.2–0.8 s. */
const PASTE_TIMEOUT_MS = 6000;

interface ClipboardSnapshot {
  text: string;
  html: string;
  rtf: string;
  image: NativeImage | null;
}

function snapshotClipboard(): ClipboardSnapshot | null {
  try {
    const formats = clipboard.availableFormats();
    const image = formats.some((f) => f.startsWith('image/')) ? clipboard.readImage() : null;
    return {
      text: clipboard.readText(),
      html: formats.includes('text/html') ? clipboard.readHTML() : '',
      rtf: formats.includes('text/rtf') ? clipboard.readRTF() : '',
      image: image && !image.isEmpty() ? image : null
    };
  } catch {
    return null;
  }
}

function restoreSnapshot(snap: ClipboardSnapshot): void {
  try {
    if (!snap.text && !snap.html && !snap.rtf && !snap.image) { clipboard.clear(); return; }
    clipboard.write({
      text: snap.text || undefined,
      html: snap.html || undefined,
      rtf: snap.rtf || undefined,
      image: snap.image ?? undefined
    });
  } catch { /* the clipboard is busy — leave our text there */ }
}

/** A restore waiting for its delay. A second dictation inside the delay keeps
 *  the ORIGINAL snapshot: snapshotting again would capture our own words. */
let pending: { timer: ReturnType<typeof setTimeout>; snap: ClipboardSnapshot; written: string } | null = null;

function takeSnapshot(): ClipboardSnapshot | null {
  if (pending) {
    clearTimeout(pending.timer);
    const snap = pending.snap;
    pending = null;
    return snap;
  }
  return snapshotClipboard();
}

function scheduleRestore(snap: ClipboardSnapshot, written: string): void {
  const timer = setTimeout(() => {
    const p = pending;
    pending = null;
    if (!p) return;
    let current = '';
    try { current = clipboard.readText(); } catch { return; }
    if (shouldRestoreClipboard(current, p.written)) restoreSnapshot(p.snap);
  }, RESTORE_DELAY_MS);
  pending = { timer, snap, written };
}

/** Quitting: put the user's clipboard back now rather than never. */
export function flushPendingRestore(): void {
  if (!pending) return;
  const p = pending;
  clearTimeout(p.timer);
  pending = null;
  try {
    if (shouldRestoreClipboard(clipboard.readText(), p.written)) restoreSnapshot(p.snap);
  } catch { /* quitting anyway */ }
}

/** Put text on the clipboard and leave it there (the user pastes). */
export function copyToClipboard(text: string): boolean {
  // A copy the user is meant to keep must not be undone by an earlier
  // dictation's pending restore.
  if (pending) { clearTimeout(pending.timer); pending = null; }
  try { clipboard.writeText(text); return true; } catch { return false; }
}

export interface ExternalInsertResult {
  strategy: InsertStrategy;
  notice?: InsertNotice;
}

/** Type `text` into whatever app is in front. Never throws. */
export async function insertIntoFrontApp(
  text: string,
  opts: { platform: DictatePlatform; pasteMode: DictatePasteMode; restoreClipboard: boolean }
): Promise<ExternalInsertResult> {
  const paths = toolPaths(opts.platform);
  const choice = chooseInsertStrategy({
    platform: opts.platform,
    env: sessionEnv(),
    tools: toolsFrom(paths),
    accessibilityTrusted: accessibilityTrusted(opts.platform),
    pasteMode: opts.pasteMode
  });
  const cmd = pasteCommand(choice.strategy, paths);
  if (choice.strategy === 'clipboard' || !cmd) {
    copyToClipboard(text);
    return { strategy: 'clipboard', notice: choice.notice ?? 'paste-failed' };
  }

  const snap = opts.restoreClipboard ? takeSnapshot() : null;
  if (!opts.restoreClipboard && pending) { clearTimeout(pending.timer); pending = null; }
  try {
    clipboard.writeText(text);
  } catch {
    return { strategy: 'clipboard', notice: 'paste-failed' };
  }
  const res = await runTool(cmd.file, cmd.args, PASTE_TIMEOUT_MS);
  if (!res.ok) {
    // The words stay on the clipboard (no restore) so the user can paste them.
    console.warn(`[dictate] ${choice.strategy} paste failed:`, res.stderr.slice(0, 300));
    return { strategy: 'clipboard', notice: classifyPasteFailure(choice.strategy, res.stderr) };
  }
  if (snap) scheduleRestore(snap, text);
  return { strategy: choice.strategy };
}
