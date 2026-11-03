/**
 * Tool calls in flight, per agent, from the PreToolUse/PostToolUse hook pairs.
 *
 * A long tool call prints nothing: a hooked `git commit` that runs the full
 * test suite sits silent for 10+ minutes. Every quiet-PTY signal (the
 * renderer's 12s idle fallback, the worker idle reaper, the heartbeat's
 * floor-quiet check, fleet.json's lastActiveSecAgo) read that as idle or
 * stalled (seen live 2026-10-26: Phyllis's hooked commit showed idle, and the
 * human thought she had stalled). This is the busy signal they consult instead.
 * Pure, so main (reaper, fleet.json) and the renderer (floor status) share it.
 */

export interface ToolInFlight {
  /** Open PreToolUse calls without their PostToolUse (parallel calls overlap). */
  open: number;
  /** When the oldest open call started (ms epoch). */
  since: number;
  /** 'running tests', 'running shell' or 'using <Tool>'. */
  label: string;
}

/** Past this an open call is presumed lost and stops counting as busy. An
 *  interrupted call fires no PostToolUse; Stop, the next prompt or the idle
 *  notice normally close it long before. Claude Code caps a foreground Bash
 *  at 10 minutes. */
// ponytail: one fixed ceiling for every provider; make it per-provider if a CLI runs longer tool calls.
export const MAX_IN_FLIGHT_MS = 60 * 60_000;

const SHELL_TOOL_RE = /bash|shell|exec_command/i;
const TEST_CMD_RE = /\b(pytest|vitest|jest|mocha|playwright|node --test|go test|cargo test|make test|(npm|pnpm|yarn|bun) (run )?test|git commit)\b/;
const RANK = ['running tests', 'running shell'];
const rank = (label: string): number => { const i = RANK.indexOf(label); return i < 0 ? RANK.length : i; };

/** What a PreToolUse means on the floor. A hooked `git commit` counts as tests:
 *  in this hive its pre-commit hook runs the suite, and a plain commit is over
 *  too fast for the label to show. */
export function activityLabel(tool: string | undefined, input?: unknown): string {
  if (!tool) return 'working';
  if (!SHELL_TOOL_RE.test(tool)) return `using ${tool}`;
  const cmd = (input as { command?: unknown } | null | undefined)?.command;
  const text = Array.isArray(cmd) ? cmd.join(' ') : typeof cmd === 'string' ? cmd : '';
  return TEST_CMD_RE.test(text) ? 'running tests' : 'running shell';
}

/** A Notification meaning the prompt is back with nothing running. */
export function isIdleNotice(event: string, type?: string, message?: string): boolean {
  if (event !== 'Notification') return false;
  return type === 'idle' || type === 'idle_prompt'
    || (message ?? '').toLowerCase().includes('waiting for your input');
}

/** Fold one hook event into `map`. `label` is only read on PreToolUse. */
export function trackTool(
  map: Map<string, ToolInFlight>, agentId: string, event: string, label: string, now: number, idleNotice = false
): void {
  const cur = map.get(agentId);
  if (event === 'PreToolUse') {
    if (!cur || now - cur.since > MAX_IN_FLIGHT_MS) { map.set(agentId, { open: 1, since: now, label }); return; }
    cur.open++;
    if (rank(label) < rank(cur.label)) cur.label = label;
  } else if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    if (cur && --cur.open <= 0) map.delete(agentId);
  } else if (idleNotice || event === 'Stop' || event === 'UserPromptSubmit'
    || event === 'SessionStart' || event === 'PostInvocation') {
    // The turn is over, or a new one began: anything still open was interrupted.
    map.delete(agentId);
  }
}

/** The agent's open tool call, if one is live. */
export function busyFor(map: Map<string, ToolInFlight>, agentId: string, now: number): ToolInFlight | undefined {
  const cur = map.get(agentId);
  return cur && now - cur.since <= MAX_IN_FLIGHT_MS ? cur : undefined;
}

/** "running tests 3m": the label, plus whole minutes once past one. */
export function busyText(b: ToolInFlight, now: number): string {
  const m = Math.floor((now - b.since) / 60_000);
  return m >= 1 ? `${b.label} ${m}m` : b.label;
}
