/**
 * Lets this window receive dictation: main sends `feat:dictate:insert` to the
 * window that had focus when a dictation started, and this puts the words at
 * the caret (insertAtCaret.ts), then answers whether it could.
 *
 * Mount it once per window — App.tsx does for every app window; DictateSettings
 * mounts it too so its "try it here" box works in the Stapler's window. Extra
 * mounts are reference-counted onto one listener, so a window never inserts
 * the same words twice.
 */
import { useEffect } from 'react';
import { BUILTIN_VOCABULARY } from '@shared/features/vocabulary';
import type { DictateInsertRequest } from '@shared/features/dictate';
import { insertAtCaret, trackLastField } from './insertAtCaret';

let mounts = 0;
let teardown: (() => void) | null = null;

/** Vocabulary names keep their capital mid-sentence ("and Claude wrote it").
 *  The user's own words come from the transcribe settings, read per insert so
 *  an edit there applies at once. */
async function keepCaseFor(): Promise<(word: string) => boolean> {
  const words = new Set(BUILTIN_VOCABULARY.map((w) => w.toLowerCase()));
  try {
    const s = await window.cth.features.transcribe.getSettings();
    for (const w of s.customVocabulary ?? []) words.add(w.toLowerCase());
  } catch { /* built-ins only */ }
  return (word) => words.has(word.toLowerCase());
}

function install(): () => void {
  const api = window.cth?.features?.dictate;
  if (!api) return () => {};
  const tracker = trackLastField();
  const onInsert = async (req: DictateInsertRequest): Promise<void> => {
    if (!req || typeof req.id !== 'number' || typeof req.text !== 'string') return;
    const keepCase = await keepCaseFor();
    const outcome = insertAtCaret(req.text, tracker.get(), { keepCase });
    api.insertResult(outcome === 'ok' ? { id: req.id, ok: true } : { id: req.id, ok: false, reason: outcome });
  };
  const off = api.onInsert((req) => { void onInsert(req); });
  api.insertReady(true);
  return () => {
    off();
    api.insertReady(false);
    tracker.dispose();
  };
}

export function useDictationInsert(): void {
  useEffect(() => {
    mounts += 1;
    if (mounts === 1) teardown = install();
    return () => {
      mounts -= 1;
      if (mounts === 0) { teardown?.(); teardown = null; }
    };
  }, []);
}
