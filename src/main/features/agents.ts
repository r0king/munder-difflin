/**
 * Agent cards + agent rooms — main-process side (owned by the `wsAgents` unit).
 *
 * The controls the room needs already exist and the renderer calls them
 * directly: window.cth.controlPause / controlResume / controlHalt / controlSteer
 * (pause tools, stop after this step, steer), hiveSetAgentHold (1:1),
 * setAgentTokenCap, hivePatchAgentRole, hiveAddTask, telemetry (spend). What
 * did NOT exist is reading an agent's own words off disk, so that is all this
 * module adds — read-only, validated, cached (see ./agents/readers.ts):
 *
 *   feat:agents:activity        per card: last reply, last message, current
 *                               tool call and its result
 *   feat:agents:conversation    the room's sources: transcript, mailbox, ASK ME,
 *                               and the room's own send log
 *   feat:agents:recordSend      append to that send log (Send / Steer)
 *   feat:agents:lastExit        the newest abnormal exit (crash strip)
 *   feat:agents:revealCrashLog  show that exit's crash log in the file manager
 *
 * Every handler takes agent ids, never paths; ids are checked against a slug
 * pattern and joined under `<hive>/agents/` with a containment check.
 */
import { ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { redactSecrets } from '../hive';
import {
  AGENTS_CHANNELS,
  MAX_ACTIVITY_IDS,
  MAX_SEND_TEXT,
  type AgentExitInfo
} from '../../shared/workspace/agentsIpc';
import type { ConversationSources } from '../../shared/workspace/agentsConversation';
import type { AgentActivity } from '../../shared/workspace/agentsSummary';
import {
  isSafeAgentId,
  locateTranscript,
  readActivity,
  readAsks,
  readLastExit,
  readMailbox,
  readTranscriptTail
} from './agents/readers';
import { appendSend, readSends } from './agents/sendLog';
import type { FeatureContext, FeatureModule } from './types';

/** Bytes of transcript the room reads: the recent conversation, bounded so a
 *  3 s poll on a multi-MB session stays a tail read (cached while unchanged). */
const ROOM_TAIL_BYTES = 768 * 1024;

let ctxRef: FeatureContext | null = null;

function hiveRoot(): string | null {
  const home = ctxRef?.harnessHome();
  return home ? join(home, 'hive') : null;
}

function activity(ids: unknown): AgentActivity[] {
  const root = hiveRoot();
  if (!root || !Array.isArray(ids)) return [];
  const out: AgentActivity[] = [];
  for (const id of ids.slice(0, MAX_ACTIVITY_IDS)) {
    if (!isSafeAgentId(id)) continue;
    try { out.push(readActivity(root, id)); } catch (e) { console.warn('[agents] activity read failed:', e); }
  }
  return out;
}

function conversation(agentId: unknown): ConversationSources {
  const empty: ConversationSources = { sends: [], transcript: [], hive: [], asks: [] };
  const root = hiveRoot();
  if (!root || !isSafeAgentId(agentId) || !ctxRef) return empty;
  const found = locateTranscript(root, agentId);
  const sends = readSends(ctxRef.featureDataDir('agents'), root, agentId)
    .map((s) => ({ ...s, text: redactSecrets(s.text) }));
  return {
    sends,
    transcript: 'path' in found ? readTranscriptTail(found.path, ROOM_TAIL_BYTES) : [],
    hive: readMailbox(root, agentId),
    asks: readAsks(root, agentId),
    ...('missing' in found ? { transcriptMissing: found.missing } : {})
  };
}

function recordSend(agentId: unknown, input: unknown): { ok: boolean; error?: string } {
  const root = hiveRoot();
  if (!root || !ctxRef) return { ok: false, error: 'no hive is open' };
  if (!isSafeAgentId(agentId)) return { ok: false, error: 'invalid agent id' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'invalid send' };
  const { text, mode } = input as { text?: unknown; mode?: unknown };
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_SEND_TEXT) return { ok: false, error: 'invalid text' };
  if (mode !== 'send' && mode !== 'steer') return { ok: false, error: 'invalid mode' };
  try {
    appendSend(ctxRef.featureDataDir('agents'), root, agentId, { text, mode });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function lastExit(agentId: unknown): AgentExitInfo | null {
  const root = hiveRoot();
  if (!root || !isSafeAgentId(agentId)) return null;
  const rec = readLastExit(root, agentId);
  return rec ? { ts: rec.ts, exitCode: rec.exitCode, signal: rec.signal, hasLog: !!rec.tailPath } : null;
}

function revealCrashLog(agentId: unknown): { ok: boolean; error?: string } {
  const root = hiveRoot();
  if (!root || !isSafeAgentId(agentId)) return { ok: false, error: 'invalid agent id' };
  // The path comes from the hive's own log and is confined to <hive>/crashes
  // by readLastExit; the renderer never names a path.
  const rec = readLastExit(root, agentId);
  if (!rec?.tailPath) return { ok: false, error: 'no crash log was kept' };
  shell.showItemInFolder(rec.tailPath);
  return { ok: true };
}

const CHANNELS = Object.values(AGENTS_CHANNELS);

export const agentsFeature: FeatureModule = {
  name: 'agents',
  register(ctx) {
    ctxRef = ctx;
    ipcMain.handle(AGENTS_CHANNELS.activity, (_e, ids: unknown) => activity(ids));
    ipcMain.handle(AGENTS_CHANNELS.conversation, (_e, agentId: unknown) => conversation(agentId));
    ipcMain.handle(AGENTS_CHANNELS.recordSend, (_e, agentId: unknown, input: unknown) => recordSend(agentId, input));
    ipcMain.handle(AGENTS_CHANNELS.lastExit, (_e, agentId: unknown) => lastExit(agentId));
    ipcMain.handle(AGENTS_CHANNELS.revealCrashLog, (_e, agentId: unknown) => revealCrashLog(agentId));
  },
  dispose() {
    for (const ch of CHANNELS) {
      try { ipcMain.removeHandler(ch); } catch { /* already gone */ }
    }
    ctxRef = null;
  }
};
