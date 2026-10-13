/**
 * The room's own record of what you sent an agent (Send and Steer).
 *
 * The transcript only learns of a queued send once the drain types it in, and
 * never sees a steer at all (it rides the hook channel as additionalContext),
 * so without this the room's conversation would drop what you said the moment
 * you said it. One JSONL file per agent, per hive, under the unit's feature
 * data dir (userData — not the hive repo, which is committed and mined).
 *
 * Bounded: a file is compacted to its newest KEEP records once it passes
 * COMPACT_AT, written temp-then-rename so a crash never leaves it half-written.
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SendRecord } from '../../../shared/workspace/agentsConversation';
import { isSafeAgentId } from './readers';

const KEEP = 300;
const COMPACT_AT_BYTES = 512 * 1024;
/** Longest text kept per record. Matching a long send against its transcript
 *  copy only needs the head (agentsConversation.sameMessage). */
const MAX_TEXT = 20_000;

function fileFor(dataDir: string, hiveRoot: string, agentId: string): string | null {
  if (!isSafeAgentId(agentId)) return null;
  const hive = createHash('sha256').update(hiveRoot).digest('hex').slice(0, 16);
  const dir = join(dataDir, 'sends', hive);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${agentId}.jsonl`);
}

function parse(text: string): SendRecord[] {
  const out: SendRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Partial<SendRecord>;
      if (typeof r.id === 'string' && typeof r.ts === 'number' && typeof r.text === 'string'
        && (r.mode === 'send' || r.mode === 'steer')) {
        out.push({ id: r.id, ts: r.ts, text: r.text, mode: r.mode });
      }
    } catch { /* a torn line */ }
  }
  return out;
}

export function readSends(dataDir: string, hiveRoot: string, agentId: string): SendRecord[] {
  const file = fileFor(dataDir, hiveRoot, agentId);
  if (!file) return [];
  try { return parse(readFileSync(file, 'utf8')).slice(-KEEP); } catch { return []; }
}

export function appendSend(
  dataDir: string,
  hiveRoot: string,
  agentId: string,
  input: { text: string; mode: 'send' | 'steer' }
): SendRecord | null {
  const file = fileFor(dataDir, hiveRoot, agentId);
  if (!file) return null;
  const rec: SendRecord = {
    id: `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    ts: Date.now(),
    text: input.text.length > MAX_TEXT ? `${input.text.slice(0, MAX_TEXT)}…` : input.text,
    mode: input.mode
  };
  appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
  try {
    if (statSync(file).size > COMPACT_AT_BYTES) {
      const kept = parse(readFileSync(file, 'utf8')).slice(-KEEP);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      renameSync(tmp, file);
    }
  } catch (e) {
    console.warn('[agents] could not compact the send log:', e);
  }
  return rec;
}
