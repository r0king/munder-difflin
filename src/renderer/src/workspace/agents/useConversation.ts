/**
 * The room's conversation, live: main's sources (transcript, mailbox, ASK ME,
 * the room's send log) plus the terminal history, merged by the pure
 * `buildConversation` (src/shared/workspace/agentsConversation.ts).
 *
 * Polled every 3 s while the room is open and the window visible; `refresh()`
 * re-reads at once (after a send). The merged list keeps its identity when a
 * poll changed nothing, so the thread does not re-render every tick.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildConversation,
  type ConversationItem,
  type ConversationSources
} from '@shared/workspace/agentsConversation';

const POLL_MS = 3000;
const HISTORY_LIMIT = 100;

export interface ConversationState {
  items: ConversationItem[];
  /** False until the first read lands. */
  loaded: boolean;
  /** The last read failed (main unreachable); items are the last good ones. */
  error: boolean;
  /** Why the agent's own replies are absent, when they are. */
  transcriptMissing?: 'engine' | 'none';
  refresh: () => void;
}

export function useConversation(agentId: string): ConversationState {
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [missing, setMissing] = useState<'engine' | 'none' | undefined>(undefined);
  const lastJson = useRef('');
  const inFlight = useRef(false);
  const alive = useRef(true);

  const read = useCallback(async (force: boolean) => {
    if (inFlight.current) return;
    if (!force) {
      try { if (document.visibilityState === 'hidden') return; } catch { /* not a browser */ }
    }
    inFlight.current = true;
    try {
      const [sources, history] = await Promise.all([
        window.cth.features.agents.conversation(agentId) as Promise<ConversationSources>,
        window.cth.historyList(agentId, HISTORY_LIMIT).catch(() => [])
      ]);
      if (!alive.current) return;
      const merged = buildConversation(
        { ...sources, history: history.map((h) => ({ text: h.text, ts: h.ts })) },
        { agentId, limit: 200 }
      );
      const json = JSON.stringify(merged);
      if (json !== lastJson.current) {
        lastJson.current = json;
        setItems(merged);
      }
      setMissing(sources.transcriptMissing);
      setError(false);
      setLoaded(true);
    } catch {
      if (alive.current) { setError(true); setLoaded(true); }
    } finally {
      inFlight.current = false;
    }
  }, [agentId]);

  useEffect(() => {
    alive.current = true;
    lastJson.current = '';
    setItems([]);
    setLoaded(false);
    void read(true);
    const iv = setInterval(() => { void read(false); }, POLL_MS);
    return () => { alive.current = false; clearInterval(iv); };
  }, [read]);

  const refresh = useCallback(() => {
    // The send log write and the drain both land within a beat; read twice so
    // the "queued" item shows at once and the delivery shortly after.
    void read(true);
    setTimeout(() => { void read(true); }, 1200);
  }, [read]);

  return { items, loaded, error, transcriptMissing: missing, refresh };
}
