/**
 * Merge Chromium `--enable-features` lists.
 *
 * Chromium reads ONE `--enable-features` value: a second appendSwitch for the
 * same switch does not add to the first, it competes with it. So every feature
 * module's early flags (and anything already on the command line, e.g. from a
 * developer launching with their own flags) are merged into a single
 * comma-separated value, order-preserving and de-duplicated.
 */
export function mergeEnableFeatures(existing: string | undefined | null, add: readonly string[]): string {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const f = raw.trim();
    if (!f || seen.has(f)) return;
    seen.add(f);
    out.push(f);
  };
  for (const f of (existing ?? '').split(',')) push(f);
  for (const f of add) push(f);
  return out.join(',');
}
