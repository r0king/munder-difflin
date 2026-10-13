/**
 * The Memory screen's data: both search lanes, MemPalace's install state and
 * the header stats.
 *
 * One `run(query)` fires both lanes at once. The exact lane comes back in
 * milliseconds; the meaning lane spawns `mempalace search`, which can take a
 * minute on a cold model, so each lane has its own state and renders as soon
 * as it lands. A sequence number drops any answer that arrives after a newer
 * query was submitted.
 *
 * The meaning lane is only asked when MemPalace is installed and on (from the
 * existing `memoryStatus()`, whose poll also arms the palace's mine loop after
 * a late install) — otherwise the lane shows how to get it instead of making
 * main look for a CLI that is not there on every keystroke.
 *
 * The last answer is kept at module level, so leaving the screen and coming
 * back to the same query shows it at once rather than searching again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MemorySearchResult, MemoryStats } from '@shared/workspace/memoryTypes';

export type PalaceStatus = Awaited<ReturnType<typeof window.cth.memoryStatus>>;

export interface LaneView {
  phase: 'idle' | 'loading' | 'done';
  result: MemorySearchResult | null;
}

const IDLE: LaneView = { phase: 'idle', result: null };

interface Remembered {
  query: string;
  exact: LaneView;
  meaning: LaneView;
}
let remembered: Remembered | null = null;

export function palaceUsable(p: PalaceStatus | null): boolean {
  return !!p && p.available && p.enabled;
}

function failed(lane: 'exact' | 'meaning', query: string, e: unknown): MemorySearchResult {
  return {
    ok: false, lane, query, state: 'error',
    answer: { tickets: [], agents: [], notes: [], people: [], totals: { tickets: 0, agents: 0, notes: 0 } },
    error: e instanceof Error ? e.message : String(e), tookMs: 0
  };
}

export function useMemorySearch() {
  const [submitted, setSubmitted] = useState<string>(remembered?.query ?? '');
  const [exact, setExact] = useState<LaneView>(remembered?.exact ?? IDLE);
  const [meaning, setMeaning] = useState<LaneView>(remembered?.meaning ?? IDLE);
  const [palace, setPalace] = useState<PalaceStatus | null>(null);
  const [palaceChecking, setPalaceChecking] = useState(true);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  // One sequence per lane: re-running the meaning lane alone must not orphan
  // an exact answer still on its way.
  const exactSeq = useRef(0);
  const meaningSeq = useRef(0);
  const palaceReq = useRef<Promise<PalaceStatus | null> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const checkPalace = useCallback((): Promise<PalaceStatus | null> => {
    setPalaceChecking(true);
    const req = window.cth.memoryStatus()
      .then((s) => s, () => null)
      .then((s) => {
        if (mounted.current) { setPalace(s); setPalaceChecking(false); }
        return s;
      });
    palaceReq.current = req;
    return req;
  }, []);

  const refreshStats = useCallback(() => {
    window.cth.features.memory.stats()
      .then((s) => { if (mounted.current) setStats(s); })
      .catch(() => { /* keep the last counts */ });
  }, []);

  useEffect(() => {
    void checkPalace();
    refreshStats();
  }, [checkPalace, refreshStats]);

  const remember = (patch: Partial<Remembered>): void => {
    remembered = { query: '', exact: IDLE, meaning: IDLE, ...(remembered ?? {}), ...patch };
  };

  const runMeaning = useCallback(async (query: string, mine: number): Promise<void> => {
    const status = palaceReq.current ? await palaceReq.current : await checkPalace();
    if (mine !== meaningSeq.current) return;
    if (!palaceUsable(status)) {
      if (mounted.current) setMeaning(IDLE);
      if (remembered?.query === query) remember({ meaning: IDLE });
      return;
    }
    let result: MemorySearchResult;
    try { result = await window.cth.features.memory.meaning(query); } catch (e) { result = failed('meaning', query, e); }
    // A newer query took this one's place in main's queue: its own answer is coming.
    if (mine !== meaningSeq.current || result.state === 'superseded') return;
    const view: LaneView = { phase: 'done', result };
    if (mounted.current) setMeaning(view);
    // An answer that outlived its screen still fills the cache — for its own query only.
    if (remembered?.query === query) remember({ meaning: view });
  }, [checkPalace]);

  const run = useCallback((raw: string) => {
    const query = raw.replace(/\s+/g, ' ').trim();
    const mine = ++exactSeq.current;
    const mineMeaning = ++meaningSeq.current;
    setSubmitted(query);
    if (!query) {
      setExact(IDLE);
      setMeaning(IDLE);
      remembered = null;
      return;
    }
    if (remembered?.query === query && remembered.exact.phase === 'done' && remembered.meaning.phase !== 'loading') {
      setExact(remembered.exact);
      setMeaning(remembered.meaning);
      return;
    }
    const loading: LaneView = { phase: 'loading', result: null };
    setExact(loading);
    setMeaning(loading);
    remember({ query, exact: loading, meaning: loading });
    void (async () => {
      let result: MemorySearchResult;
      try { result = await window.cth.features.memory.search(query); } catch (e) { result = failed('exact', query, e); }
      if (mine !== exactSeq.current) return;
      const view: LaneView = { phase: 'done', result };
      if (mounted.current) setExact(view);
      if (remembered?.query === query) remember({ exact: view });
    })();
    void runMeaning(query, mineMeaning);
    refreshStats();
  }, [runMeaning, refreshStats]);

  /** Re-run only the meaning lane (after "Try again", "Turn on", "Check again"). */
  const rerunMeaning = useCallback(async () => {
    await checkPalace();
    if (!submitted) return;
    const mine = ++meaningSeq.current;
    setMeaning({ phase: 'loading', result: null });
    await runMeaning(submitted, mine);
  }, [checkPalace, runMeaning, submitted]);

  return { submitted, exact, meaning, palace, palaceChecking, stats, run, rerunMeaning, checkPalace };
}
