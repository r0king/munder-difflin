/**
 * Reading an agent's own words out of its Claude Code session transcript.
 *
 * The Workspace's agent cards and rooms want three things the hook stream does
 * not carry: what the agent last SAID (its reply text, in its own words), the
 * tool call it is on right now WITH its argument (`npm test auth/login`, not
 * just `Bash`), and what that call printed. All three are in the session's
 * `.jsonl` transcript, which main tail-reads (src/main/features/agents.ts) and
 * hands to this parser.
 *
 * The transcript format is Claude Code's, not ours, so everything here is
 * defensive: unknown record types are skipped, a malformed line is skipped, a
 * line cut in half by the tail read is skipped, and nothing throws. Only Claude
 * writes this file; other engines simply have no transcript events and the
 * callers fall back to the live line and the hive mailbox.
 *
 * Pure and import-free so node:test loads it through test/load-ts.cjs.
 */

export type TranscriptEventKind =
  /** A prompt submitted to the agent's terminal (by anyone — the user, the
   *  queue drain, an orchestrator work order). */
  | 'prompt'
  /** The agent's own text: one per assistant message, blocks joined. */
  | 'reply'
  /** A tool call, with its argument summarised. */
  | 'tool'
  /** A tool call's output, reduced to one telling line. */
  | 'result'
  /** A slash command run in the terminal (`/compact`, `/model`). */
  | 'command'
  /** The session's context was compacted. */
  | 'compact'
  /** The user interrupted the turn (Esc). */
  | 'interrupt';

export interface TranscriptEvent {
  kind: TranscriptEventKind;
  /** Epoch ms. Records without a parseable timestamp inherit the previous one. */
  ts: number;
  /** Stable id: the record uuid (+ block index), or the tool_use id. */
  id: string;
  /** prompt/reply: the text. tool: the summarised argument. result: one line.
   *  command: the command (`/compact`). */
  text: string;
  /** tool/result: the tool's name (`Bash`, `Read`, `mcp__github__create_issue`). */
  tool?: string;
  /** tool/result: the tool_use id that pairs a result with its call. */
  toolUseId?: string;
  /** result: the tool reported an error. */
  isError?: boolean;
}

/** Longest text kept for a prompt or a reply. Replies can be pages long; the
 *  room renders them in full up to this bound, the card only reads a line. */
export const MAX_EVENT_TEXT = 12_000;
const MAX_TOOL_TEXT = 160;
const MAX_RESULT_TEXT = 160;

// ─── Small helpers ──────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** One line: whitespace runs (newlines included) collapsed to a space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** The last `n` path segments, on either separator. */
function tailPath(p: string, n = 3): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= n) return p;
  return parts.slice(-n).join('/');
}

// ─── Tool calls ─────────────────────────────────────────────────────────────

/**
 * The argument of a tool call as a person would say it: the command for Bash,
 * the file for Read/Edit/Write, the pattern for Grep/Glob, the URL or query for
 * the web tools, the description for a subagent. Unknown tools (MCP servers)
 * fall back to their first short string argument. Always one line, bounded.
 */
export function summarizeToolInput(name: string, input: unknown): string {
  const i = isObj(input) ? input : {};
  const n = name.toLowerCase();
  let out = '';
  if (n === 'bash' || n === 'shell') {
    out = str(i.command).split('\n').find((l) => l.trim()) ?? '';
  } else if (n === 'read' || n === 'edit' || n === 'multiedit' || n === 'write' || n === 'notebookedit' || n === 'notebookread') {
    out = tailPath(str(i.file_path) || str(i.notebook_path) || str(i.path));
  } else if (n === 'grep') {
    const pattern = str(i.pattern);
    const where = str(i.path) || str(i.glob);
    out = where ? `${pattern} in ${tailPath(where, 2)}` : pattern;
  } else if (n === 'glob' || n === 'ls') {
    out = str(i.pattern) || tailPath(str(i.path), 2);
  } else if (n === 'webfetch') {
    const url = str(i.url);
    out = url.replace(/^https?:\/\//i, '');
  } else if (n === 'websearch') {
    out = str(i.query);
  } else if (n === 'task' || n === 'agent') {
    out = str(i.description) || str(i.subagent_type);
  } else if (n === 'todowrite') {
    out = Array.isArray(i.todos) ? `${i.todos.length}` : '';
  } else if (n === 'bashoutput' || n === 'killshell') {
    out = str(i.bash_id) || str(i.shell_id);
  } else {
    for (const v of Object.values(i)) {
      if (typeof v === 'string' && v.trim() && v.length <= 400) { out = v; break; }
    }
  }
  return clip(oneLine(out), MAX_TOOL_TEXT);
}

/** Display name for a tool: MCP tools (`mcp__github__create_issue`) read as
 *  `github create_issue`; everything else as named. */
export function toolDisplayName(name: string): string {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]} ${mcp[2]}`;
  return name;
}

/**
 * The line a person would read off a tool's output: a test summary when there
 * is one ("14 passed, 1 failed"), otherwise the last non-empty line. ANSI is
 * stripped and the line bounded. Empty when there is nothing to say.
 */
export function resultSummaryLine(content: unknown): string {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((b) => (isObj(b) && b.type === 'text' ? str(b.text) : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (!text) return '';
  const lines = stripAnsi(text)
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    // Claude Code's own wrappers around tool output are not the output.
    .filter((l) => l && !/^<\/?(?:system-reminder|tool_use_error)>$/.test(l));
  if (!lines.length) return '';
  const recent = lines.slice(-40);
  // A test runner's summary is the most telling line there is; prefer it when
  // it appears near the end, newest first.
  const summary = [...recent].reverse().find((l) =>
    /\b\d+\s+(?:passed|passing|failed|failing|skipped|errors?|tests?)\b/i.test(l)
    || /^(?:tests?|suites?)\s*:/i.test(l)
  );
  return clip(summary ?? recent[recent.length - 1], MAX_RESULT_TEXT);
}

// ─── Prompts ────────────────────────────────────────────────────────────────

/** Harness/CLI wrappers that are not something anyone typed. */
const WRAPPER_RE = /<(system-reminder|user-prompt-submit-hook)>[\s\S]*?<\/\1>/g;
const SKIP_PREFIXES = [
  '<local-command-stdout>', '<local-command-stderr>', '<local-command-caveat>',
  '<bash-stdout>', '<bash-stderr>', 'Caveat: The messages below were generated'
];

type PromptShape =
  | { kind: 'prompt'; text: string }
  | { kind: 'command'; text: string }
  | { kind: 'interrupt' }
  | null;

/** Classify the text of a user record. Null means "not a prompt; skip". */
export function classifyPromptText(raw: string): PromptShape {
  const text = raw.replace(WRAPPER_RE, '').trim();
  if (!text) return null;
  if (SKIP_PREFIXES.some((p) => text.startsWith(p))) return null;
  if (/^\[Request interrupted by user/.test(text)) return { kind: 'interrupt' };
  const cmd = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(text);
  if (cmd) {
    const name = cmd[1].startsWith('/') ? cmd[1] : `/${cmd[1]}`;
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    return { kind: 'command', text: clip(args ? `${name} ${oneLine(args)}` : name, MAX_TOOL_TEXT) };
  }
  if (text.startsWith('<command-message>')) return null;
  // `! cmd` in the TUI is recorded as <bash-input>.
  const bash = /^<bash-input>([\s\S]*?)<\/bash-input>$/.exec(text);
  if (bash) return { kind: 'command', text: clip(`! ${oneLine(bash[1])}`, MAX_TOOL_TEXT) };
  return { kind: 'prompt', text: clip(text, MAX_EVENT_TEXT) };
}

// ─── The parser ─────────────────────────────────────────────────────────────

function parseTs(v: unknown): number {
  if (typeof v !== 'string') return NaN;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? NaN : ms;
}

/**
 * Parse transcript JSONL (typically a TAIL of the file, so the first line may
 * be cut mid-record) into events, oldest first.
 *
 * - Subagent records (`isSidechain`) and meta records are skipped: the room is
 *   the agent's conversation, not its subagents'.
 * - An assistant message is streamed into several records (one per content
 *   block) sharing `message.id`; their text blocks become ONE reply.
 * - A tool_result's text is reduced to one line (resultSummaryLine).
 */
export function parseTranscript(text: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  const replyByMessage = new Map<string, TranscriptEvent>();
  const toolNames = new Map<string, string>();
  let lastTs = 0;
  let lineNo = 0;

  for (const line of text.split('\n')) {
    lineNo += 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let rec: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isObj(parsed)) continue;
      rec = parsed;
    } catch {
      continue;
    }
    const tsRaw = parseTs(rec.timestamp);
    const ts = Number.isNaN(tsRaw) ? lastTs : tsRaw;
    if (!Number.isNaN(tsRaw)) lastTs = tsRaw;
    const uuid = str(rec.uuid) || `line-${lineNo}`;
    if (rec.isSidechain === true) continue;

    if (rec.type === 'system') {
      if (rec.subtype === 'compact_boundary') events.push({ kind: 'compact', ts, id: uuid, text: '' });
      continue;
    }

    const message = isObj(rec.message) ? rec.message : null;
    if (!message) continue;

    if (rec.type === 'user') {
      if (rec.isMeta === true || rec.isCompactSummary === true) continue;
      const content = message.content;
      if (typeof content === 'string') {
        const shape = classifyPromptText(content);
        if (shape?.kind === 'interrupt') events.push({ kind: 'interrupt', ts, id: uuid, text: '' });
        else if (shape) events.push({ kind: shape.kind, ts, id: uuid, text: shape.text });
        continue;
      }
      if (!Array.isArray(content)) continue;
      const texts: string[] = [];
      content.forEach((block, idx) => {
        if (!isObj(block)) return;
        if (block.type === 'tool_result') {
          const toolUseId = str(block.tool_use_id);
          events.push({
            kind: 'result',
            ts,
            id: toolUseId ? `result-${toolUseId}` : `${uuid}-${idx}`,
            text: resultSummaryLine(block.content),
            tool: toolNames.get(toolUseId),
            toolUseId: toolUseId || undefined,
            isError: block.is_error === true
          });
        } else if (block.type === 'text') {
          texts.push(str(block.text));
        }
      });
      if (texts.length) {
        const shape = classifyPromptText(texts.join('\n'));
        if (shape?.kind === 'interrupt') events.push({ kind: 'interrupt', ts, id: uuid, text: '' });
        else if (shape) events.push({ kind: shape.kind, ts, id: uuid, text: shape.text });
      }
      continue;
    }

    if (rec.type === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : [];
      const messageId = str(message.id) || uuid;
      content.forEach((block, idx) => {
        if (!isObj(block)) return;
        if (block.type === 'text') {
          const t = str(block.text).trim();
          if (!t) return;
          const existing = replyByMessage.get(messageId);
          if (existing) {
            existing.text = clip(`${existing.text}\n\n${t}`, MAX_EVENT_TEXT);
          } else {
            const ev: TranscriptEvent = { kind: 'reply', ts, id: `reply-${messageId}`, text: clip(t, MAX_EVENT_TEXT) };
            replyByMessage.set(messageId, ev);
            events.push(ev);
          }
        } else if (block.type === 'tool_use') {
          const name = str(block.name) || 'tool';
          const toolUseId = str(block.id);
          if (toolUseId) toolNames.set(toolUseId, name);
          events.push({
            kind: 'tool',
            ts,
            id: toolUseId ? `tool-${toolUseId}` : `${uuid}-${idx}`,
            text: summarizeToolInput(name, block.input),
            tool: name,
            toolUseId: toolUseId || undefined
          });
        }
      });
    }
  }
  return events;
}

// ─── What the card needs ────────────────────────────────────────────────────

export interface TranscriptActivity {
  /** The newest reply text (raw markdown, bounded). */
  lastReply?: { text: string; ts: number };
  /** The newest tool call. */
  lastTool?: { tool: string; text: string; ts: number; toolUseId?: string };
  /** The result of `lastTool`, when it has come back. */
  lastResult?: { text: string; ts: number; isError: boolean };
  /** Timestamp of the newest event of any kind. */
  lastTs?: number;
}

/** The latest reply, the latest tool call and that call's result. */
export function transcriptActivity(events: readonly TranscriptEvent[]): TranscriptActivity {
  const out: TranscriptActivity = {};
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (out.lastTs === undefined) out.lastTs = ev.ts;
    if (!out.lastReply && ev.kind === 'reply' && ev.text.trim()) {
      out.lastReply = { text: ev.text, ts: ev.ts };
    }
    if (!out.lastTool && ev.kind === 'tool') {
      out.lastTool = { tool: ev.tool ?? 'tool', text: ev.text, ts: ev.ts, toolUseId: ev.toolUseId };
    }
    if (out.lastReply && out.lastTool) break;
  }
  if (out.lastTool?.toolUseId) {
    const id = out.lastTool.toolUseId;
    const res = events.find((e) => e.kind === 'result' && e.toolUseId === id);
    if (res && res.text) out.lastResult = { text: res.text, ts: res.ts, isError: !!res.isError };
  }
  return out;
}
