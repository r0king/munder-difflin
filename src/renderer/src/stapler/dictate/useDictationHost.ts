/**
 * Retired: dictation no longer records in the puck window. It has its own
 * hidden recorder window (stapler.html#dictate → DictationHostPage), so it works
 * with the Stapler off and a puck reload cannot strand a recording.
 *
 * Kept as a no-op only so StaplerApp's foundation-era call still compiles
 * until the stapler unit removes it; nothing else should call it.
 */
export function useDictationHost(): void {
  /* intentionally empty — see DictationHostPage */
}
