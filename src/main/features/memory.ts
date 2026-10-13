/**
 * Memory — main-process side (owned by the `wsMemory` unit).
 *
 * "Ask the floor what it knows." Four invoke channels (MEMORY_CHANNELS):
 *
 *   feat:memory:search    the exact lane: the literal words over every agent's
 *                         memory.md, the task ledger, the board, the user's
 *                         notes and the knowledge graph (memory/search.ts)
 *   feat:memory:meaning   the meaning lane: `mempalace search`, parsed and
 *                         attributed to agents and tickets
 *   feat:memory:stats     the header's "N topics" and friends
 *   feat:memory:readNote  the full text behind one result
 *
 * Both lanes answer in the same grouped shape (tickets, agents, notes), so the
 * renderer does no file I/O and no grouping of its own.
 *
 * The meaning lane runs through its OWN MemoryManager instance — read-only:
 * it is never start()ed, so it never mines and never touches the palace's
 * writer lock; it only spawns `mempalace search`. index.ts's instance owns the
 * mine loop and stays the one the status poll (hive:memoryStatus) re-arms.
 * A second instance is needed because the existing search IPC asks for five
 * results, which is too few to group into three shapes.
 */
import { ipcMain } from 'electron';
import { join } from 'node:path';
import { MemoryManager } from '../memory';
import { KnowledgeManager } from '../knowledge';
import { parseQuery } from '../../shared/workspace/memoryQuery';
import {
  MEMORY_CHANNELS,
  emptyAnswer,
  isMemoryNoteRef,
  type MemorySearchResult
} from '../../shared/workspace/memoryTypes';
import type { FeatureContext, FeatureModule } from './types';
import { FloorCorpus } from './memory/corpus';
import { PALACE_RESULTS, exactSearch, floorStats, meaningAnswer, readNote, type KnowledgeLike } from './memory/search';

const corpus = new FloorCorpus();
let palace: MemoryManager | null = null;
let knowledge: KnowledgeLike | null = null;

/** Meaning searches run one at a time (each is a Python process that may be
 *  loading an embedding model); a newer query supersedes any still waiting. */
let meaningSeq = 0;
let meaningChain: Promise<unknown> = Promise.resolve();

const MAX_ERROR_CHARS = 400;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

function hiveRoot(ctx: FeatureContext): string | null {
  const home = ctx.harnessHome();
  return home ? join(home, 'hive') : null;
}

function palaceFor(ctx: FeatureContext): MemoryManager {
  if (!palace) {
    palace = new MemoryManager(
      () => ctx.harnessHome(),
      () => {
        const c = ctx.readConfig();
        return { enabled: c.semanticMemory !== false, model: c.embeddingModel ?? 'minilm' };
      }
    );
  }
  return palace;
}

function knowledgeGraph(): KnowledgeLike | null {
  if (!knowledge) {
    try { knowledge = new KnowledgeManager(); } catch (e) {
      console.warn('[memory] knowledge graph unavailable:', e instanceof Error ? e.message : e);
      return null;
    }
  }
  return knowledge;
}

function cleanError(e: unknown): string {
  const s = (e instanceof Error ? e.message : String(e ?? '')).replace(ANSI, '').trim();
  return s.length > MAX_ERROR_CHARS ? `${s.slice(0, MAX_ERROR_CHARS)}…` : s;
}

async function searchByMeaning(ctx: FeatureContext, raw: unknown): Promise<MemorySearchResult> {
  const t0 = Date.now();
  const base = (patch: Partial<MemorySearchResult>): MemorySearchResult => ({
    ok: false, lane: 'meaning', query: typeof raw === 'string' ? raw.slice(0, 200) : '', state: 'ok',
    answer: emptyAnswer(), tookMs: Date.now() - t0, ...patch
  });
  const q = typeof raw === 'string' ? parseQuery(raw) : null;
  if (!q) return base({ state: 'error', error: 'empty query' });
  const root = hiveRoot(ctx);
  if (!root) return base({ query: q.raw, state: 'no-hive' });

  const mm = palaceFor(ctx);
  // status() resolves the CLI once and caches it. A user who installed
  // mempalace after this instance first looked gets one fresh look here.
  let st = mm.status();
  if (!st.available) { mm.resetBinCache(); st = mm.status(); }
  if (!st.available) return base({ query: q.raw, state: 'not-installed' });
  if (!st.enabled) return base({ query: q.raw, state: 'disabled' });
  if (!st.initialized) return base({ query: q.raw, state: 'not-ready' });

  const ticket = ++meaningSeq;
  const run = meaningChain.then(async (): Promise<MemorySearchResult> => {
    if (ticket !== meaningSeq) return base({ query: q.raw, state: 'superseded' });
    const res = await mm.search(q.raw, { results: PALACE_RESULTS });
    if (!res.ok) return base({ query: q.raw, state: 'error', error: cleanError(res.error || 'search failed') });
    const out = await meaningAnswer(corpus, root, q, res.output.replace(ANSI, ''));
    const result: MemorySearchResult = {
      ok: true, lane: 'meaning', query: q.raw, state: 'ok', answer: out.answer, tookMs: Date.now() - t0
    };
    if (out.notice) result.notice = out.notice;
    if (out.raw) result.raw = out.raw;
    return result;
  });
  meaningChain = run.catch(() => undefined);
  try {
    return await run;
  } catch (e) {
    return base({ query: q.raw, state: 'error', error: cleanError(e) });
  }
}

export const memoryFeature: FeatureModule = {
  name: 'memory',
  register(ctx) {
    ipcMain.handle(MEMORY_CHANNELS.search, async (_evt, query: unknown): Promise<MemorySearchResult> => {
      if (typeof query !== 'string') {
        return { ok: false, lane: 'exact', query: '', state: 'error', answer: emptyAnswer(), error: 'empty query', tookMs: 0 };
      }
      try {
        return await exactSearch(corpus, hiveRoot(ctx), query, knowledgeGraph());
      } catch (e) {
        console.error('[memory] exact search failed:', e);
        return { ok: false, lane: 'exact', query: query.slice(0, 200), state: 'error', answer: emptyAnswer(), error: cleanError(e), tookMs: 0 };
      }
    });

    ipcMain.handle(MEMORY_CHANNELS.meaning, (_evt, query: unknown) => searchByMeaning(ctx, query));

    ipcMain.handle(MEMORY_CHANNELS.stats, async () => {
      try {
        return await floorStats(corpus, hiveRoot(ctx), knowledgeGraph());
      } catch (e) {
        console.error('[memory] stats failed:', e);
        return { ok: false, state: 'ok', topics: 0, tickets: 0, agentsWithMemory: 0, entries: 0, notes: 0, documents: 0 };
      }
    });

    ipcMain.handle(MEMORY_CHANNELS.readNote, async (_evt, ref: unknown) => {
      if (!isMemoryNoteRef(ref)) return { ok: false, title: '', text: '', error: 'invalid note' };
      try {
        return await readNote(hiveRoot(ctx), ref, knowledgeGraph());
      } catch (e) {
        return { ok: false, title: '', text: '', error: cleanError(e) };
      }
    });
  },
  dispose() {
    corpus.cache.clear();
  }
};
