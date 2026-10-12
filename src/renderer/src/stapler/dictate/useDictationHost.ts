/**
 * Dictation host, mounted once in the Stapler's puck window (StaplerApp). Owned
 * by the `dictate` unit.
 *
 * The puck window is always alive while the Stapler is on, so it is where the
 * hold-to-talk capture runs: main signals key down/up over feat:dictate:*,
 * this hook records with audio/capture.ts, hands the WAV to transcription and
 * main types the text where the cursor is.
 *
 * FOUNDATION STUB — does nothing yet.
 */
export function useDictationHost(): void {
  // TODO(dictate): subscribe to feat:dictate:* here.
}
