/**
 * Workspace agent status — the ONE mapping from what the renderer store tracks
 * about an agent to the seven words the Workspace shows (plus offline).
 *
 * The store does not have a "status" in the Workspace's sense. It has the raw
 * signals the classic floor animates from, written by three different sources:
 *
 *   - `Agent.status` (a `StatusKind`): hook events in useHive are authoritative
 *     (PreToolUse → working, Stop → idle, PreCompact → compacting, Notification
 *     → blocked for god / waiting for a worker), the circuit breaker pins
 *     'looping', and the pty parser (usePtyParser) refines it while a terminal
 *     view is mounted. 'blocked' is reserved for GOD waiting on the human —
 *     workers at a prompt read 'waiting' (DESIGN.md §7.3).
 *   - `Agent.action`: a short lower-case phrase, or `using <Tool>` from a hook,
 *     or `<tool> <arg>` from the pty parser (`bash npm test`, `read SPEC.md`).
 *   - `ptyId` / `archived`: whether there is a live terminal at all.
 *
 * And one signal the store does not hold: whether a task card assigned to the
 * agent is waiting on the human (an ASK ME question, `humanQA` on the task
 * ledger). Callers that know it pass `hasOpenQuestion`; the renderer's shared
 * poller (workspace/useHiveTasks.ts) is where it comes from.
 *
 * Pure and import-free on purpose, so node:test can load it through
 * test/load-ts.cjs and so main can reuse it for the roster it caches.
 */

export type WsAgentStatus =
  | 'working'
  | 'thinking'
  | 'needs-you'
  | 'waiting'
  | 'compacting'
  | 'looping'
  | 'idle'
  | 'offline';

/** Every status, in the order a legend or filter should list them. */
export const WS_AGENT_STATUSES: readonly WsAgentStatus[] = [
  'working', 'thinking', 'needs-you', 'waiting', 'compacting', 'looping', 'idle', 'offline'
];

/** What deriveAgentStatus reads. Structural, so the store's `Agent` satisfies it
 *  directly and a test can build one from a literal. */
export interface AgentStatusInput {
  /** The store's `Agent.status` (a StatusKind: idle | thinking | working |
   *  waiting | blocked | success | ghost | compacting | looping | typing). */
  status: string;
  /** The store's `Agent.action`. */
  action?: string;
  /** Present iff the agent has a live PTY. */
  ptyId?: string;
  /** Terminal closed; retained in the archived list. */
  archived?: boolean;
  /** A task assigned to this agent is blocked on an unanswered human question. */
  hasOpenQuestion?: boolean;
}

/** Actions that mean "a model turn is in flight but no tool is running yet". */
const THINKING_ACTIONS = new Set(['thinking']);

/**
 * Map the store's signals to a Workspace status.
 *
 * Precedence, highest first — each step is a stronger claim about what the
 * human should do than the one below it:
 *
 *   1. offline     — no terminal (no ptyId, archived, or a 'ghost'). Nothing
 *                    else the store says about a dead agent is current.
 *   2. looping     — the breaker pinned it; useHive keeps it pinned until a
 *                    genuine Stop, so it outranks every hook-derived state.
 *   3. needs-you   — 'blocked': god is at a prompt only the human can answer.
 *   4. compacting  — boxing up context; it will not respond until done.
 *   5. thinking / working — a turn is in flight. An agent that asked a
 *                    question and then carried on with other work is shown
 *                    WORKING (it is), and the question surfaces as a chip.
 *   6. needs-you   — not mid-turn, and a card it owns waits on the human.
 *   7. waiting     — parked on god or another agent (a worker at a prompt).
 *   8. idle        — everything else, including 'success' and 'typing' (the
 *                    latter is the USER's draft holding the queue, not a state
 *                    of the agent — see PixelBadge).
 */
export function deriveAgentStatus(input: AgentStatusInput): WsAgentStatus {
  const status = input.status;
  if (!input.ptyId || input.archived || status === 'ghost') return 'offline';
  if (status === 'looping') return 'looping';
  if (status === 'blocked') return 'needs-you';
  if (status === 'compacting') return 'compacting';
  if (status === 'thinking') return 'thinking';
  if (status === 'working') {
    return THINKING_ACTIONS.has((input.action ?? '').trim().toLowerCase()) ? 'thinking' : 'working';
  }
  if (input.hasOpenQuestion) return 'needs-you';
  if (status === 'waiting') return 'waiting';
  return 'idle';
}

const COLOR_TOKEN: Record<WsAgentStatus, string> = {
  working: '--cth-status-working',
  thinking: '--cth-status-thinking',
  'needs-you': '--cth-status-blocked',
  waiting: '--cth-status-waiting',
  compacting: '--cth-status-compacting',
  looping: '--cth-status-looping',
  idle: '--cth-status-idle',
  offline: '--cth-status-ghost'
};

/** The status's colour as a ready-to-use CSS value, e.g.
 *  `var(--cth-status-working)`. Light and dark both come from tokens.css. */
export function statusColorVar(status: WsAgentStatus): string {
  return `var(${COLOR_TOKEN[status] ?? COLOR_TOKEN.idle})`;
}

/** The bare token name (`--cth-status-working`), for code that composes its
 *  own `var()` or `color-mix()`. */
export function statusColorToken(status: WsAgentStatus): string {
  return COLOR_TOKEN[status] ?? COLOR_TOKEN.idle;
}

/** Statuses during which the agent is actively doing something — the live dot
 *  pulses for these and only these. */
export function isActiveStatus(status: WsAgentStatus): boolean {
  return status === 'working' || status === 'thinking' || status === 'compacting';
}

/** i18n key suffix for a status (`ws.status.<key>`). Hyphens do not survive as
 *  i18next keys comfortably, so 'needs-you' is 'needsYou'. */
export function statusKey(status: WsAgentStatus): string {
  return status === 'needs-you' ? 'needsYou' : status;
}

// ─── The live line ──────────────────────────────────────────────────────────

/**
 * What the agent is doing, in words. Each kind is an i18n key under
 * `ws.live.<kind>`, and `ws.live.<kind>Detail` (with `{{detail}}`) when a
 * detail is present — the renderer helper `liveLineKey()` picks between them.
 */
export type LiveLineKind =
  | 'offline' | 'starting' | 'idle' | 'thinking' | 'working' | 'inbox'
  | 'compacting' | 'looping' | 'needsYou' | 'askedYou' | 'waiting'
  | 'running' | 'reading' | 'editing' | 'searching' | 'browsing'
  | 'planning' | 'delegating' | 'tool';

export interface LiveLine {
  kind: LiveLineKind;
  /** The specific thing (a command, a path, a tool name, a breaker reason).
   *  Agent- or engine-written text: show it verbatim, never translate it. */
  detail?: string;
  /** English rendering, for logs, main-process callers and tests. The UI
   *  should translate `kind` instead. */
  text: string;
}

export interface LiveLineInput extends AgentStatusInput {
  isGod?: boolean;
}

/** The kinds that HAVE a detail variant (`ws.live.<kind>Detail`). A detail
 *  passed for any other kind is dropped rather than rendered half-translated. */
const DETAIL_KINDS = new Set<LiveLineKind>([
  'working', 'looping', 'running', 'reading', 'editing', 'searching', 'browsing', 'tool'
]);

const EN: Record<LiveLineKind, [string, string?]> = {
  offline: ['Offline'],
  starting: ['Starting up'],
  idle: ['Idle'],
  thinking: ['Thinking'],
  working: ['Working', 'Working: {{detail}}'],
  inbox: ['Reading its inbox'],
  compacting: ['Boxing up its context'],
  looping: ['Stopped by the breaker', 'Stopped by the breaker: {{detail}}'],
  needsYou: ['Waiting on you'],
  askedYou: ['Asked you a question'],
  waiting: ['Waiting on another agent'],
  running: ['Running a command', 'Running {{detail}}'],
  reading: ['Reading files', 'Reading {{detail}}'],
  editing: ['Editing files', 'Editing {{detail}}'],
  searching: ['Searching the code', 'Searching for {{detail}}'],
  browsing: ['Looking something up on the web', 'Looking up {{detail}}'],
  planning: ['Updating its plan'],
  delegating: ['Handing work to a subagent'],
  tool: ['Using a tool', 'Using {{detail}}']
};

/** Build a LiveLine, dropping a detail the kind has no slot for. */
export function liveLine(kind: LiveLineKind, detail?: string): LiveLine {
  const d = detail?.replace(/\s+/g, ' ').trim();
  const withDetail = !!d && DETAIL_KINDS.has(kind);
  const [plain, templ] = EN[kind];
  return withDetail
    ? { kind, detail: d, text: (templ ?? plain).replace('{{detail}}', d) }
    : { kind, text: plain };
}

/** Tool name (from a hook's `using <Tool>`, or the parser's lower-cased first
 *  word) → the kind of work it means. */
function kindForTool(tool: string): LiveLineKind | null {
  const t = tool.toLowerCase();
  if (t === 'bash' || t === 'bashoutput' || t === 'killshell' || t === 'shell') return 'running';
  if (t === 'read' || t === 'notebookread') return 'reading';
  if (t === 'edit' || t === 'multiedit' || t === 'write' || t === 'notebookedit') return 'editing';
  if (t === 'grep' || t === 'glob' || t === 'ls') return 'searching';
  if (t === 'webfetch' || t === 'websearch') return 'browsing';
  if (t === 'todowrite' || t === 'taskcreate' || t === 'taskupdate') return 'planning';
  if (t === 'task' || t === 'agent') return 'delegating';
  return null;
}

/** Actions that describe a terminal coming up rather than work. */
const STARTING_ACTIONS = [
  'starting up', 'reconnecting', 'recreating terminal', 'continuing', 'revived after sleep',
  'worktree gone'
];

/** Actions that carry no information beyond "nothing happening". */
const IDLE_ACTIONS = new Set(['', 'idle', 'awaiting', 'running the floor', 'archived', 'resumed']);

/**
 * The agent's latest action as words.
 *
 * Reads the derived status first (a looping or offline agent's `action` may be
 * stale), then parses `action` in the three shapes the store actually holds:
 * `using <Tool>` (hook), `<tool> <arg>` (pty parser), or a fixed phrase.
 */
export function agentLiveLine(input: LiveLineInput): LiveLine {
  const status = deriveAgentStatus(input);
  const action = (input.action ?? '').replace(/\s+/g, ' ').trim();
  const lower = action.toLowerCase();

  if (status === 'offline') return liveLine('offline');
  if (status === 'looping') {
    // useHive writes the breaker's reason into `action`; the default reason is
    // the literal 'breaker armed', which says nothing the kind does not.
    return liveLine('looping', lower === 'breaker armed' ? undefined : action);
  }
  if (status === 'compacting') return liveLine('compacting');
  if (status === 'needs-you') {
    return input.status === 'blocked' ? liveLine('needsYou') : liveLine('askedYou');
  }
  if (STARTING_ACTIONS.some((p) => lower.startsWith(p))) return liveLine('starting');
  if (status === 'waiting') return liveLine('waiting');
  if (status === 'thinking') return liveLine('thinking');

  if (status === 'working') {
    if (lower === 'reading inbox') return liveLine('inbox');
    // Hook form: `using Bash`, `using mcp__github__create_issue`.
    const using = /^using\s+(\S+)$/i.exec(action);
    if (using) {
      const kind = kindForTool(using[1]);
      return kind ? liveLine(kind) : liveLine('tool', using[1]);
    }
    // Parser form: `<tool> <arg>` — the tool name lower-cased, the arg verbatim.
    const parts = /^(\S+)(?:\s+(.+))?$/.exec(action);
    if (parts) {
      const kind = kindForTool(parts[1]);
      if (kind) return liveLine(kind, parts[2]);
    }
    if (IDLE_ACTIONS.has(lower)) return liveLine('working');
    return liveLine('working', action);
  }
  return liveLine('idle');
}
