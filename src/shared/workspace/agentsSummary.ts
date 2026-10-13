/**
 * What an agent card says, decided in one place.
 *
 * A card shows an agent's latest update "in its own words": the last thing it
 * wrote — its newest reply in the terminal, or its newest message to the floor
 * — whichever is newer; and only when it has written nothing, the live line
 * (what the hooks say it is doing). This module makes that choice, reduces the
 * chosen text to a readable line, picks the ticket the card shows, and builds
 * the one-move "Add a ticket" card + the message that tells the agent about it.
 *
 * Also the wire types for `feat:agents:activity` (main → renderer).
 *
 * Pure and import-free (test/ws-agents-summary.test.cjs).
 */

// ─── Activity (what main reads off disk per agent) ──────────────────────────

export interface AgentActivity {
  agentId: string;
  /** The newest reply in its session transcript (Claude agents). */
  lastReply?: { text: string; ts: number };
  /** The newest message it sent to the floor (its outbox). */
  lastMail?: { subject: string; body: string; to: string; ts: number };
  /** The newest tool call, argument summarised (`npm test auth/login`). */
  lastTool?: { tool: string; text: string; ts: number };
  /** That call's output, as one line, once it came back. */
  lastResult?: { text: string; ts: number; isError: boolean };
}

// ─── Markdown → one readable line ───────────────────────────────────────────

/**
 * Reduce agent-written markdown to plain prose for a one- or two-line preview:
 * fenced code and tables dropped, headings/bullets/quotes unmarked, emphasis
 * and inline code unwrapped, links reduced to their text. Takes the first
 * paragraph that still has words in it, whitespace collapsed, bounded at a word
 * boundary with an ellipsis.
 */
export function plainPreview(markdown: string, max = 180): string {
  if (!markdown) return '';
  const withoutFences = markdown.replace(/```[\s\S]*?(```|$)/g, '\n\n').replace(/~~~[\s\S]*?(~~~|$)/g, '\n\n');
  const paragraphs = withoutFences.split(/\n\s*\n/);
  for (const para of paragraphs) {
    const lines = para
      .split('\n')
      .filter((l) => !/^\s*\|.*\|\s*$/.test(l))              // table rows
      .filter((l) => !/^\s*[-*_]{3,}\s*$/.test(l))            // rules
      .map((l) => l
        .replace(/^\s{0,3}#{1,6}\s+/, '')                     // headings
        .replace(/^\s*>\s?/, '')                              // quotes
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')); // bullets, numbers, checkboxes
    let text = lines.join(' ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/<\/?[a-z][^>]*>/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    if (text.length > max) {
      const cut = text.slice(0, max);
      const space = cut.lastIndexOf(' ');
      text = `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
    }
    return text;
  }
  return '';
}

// ─── The latest update ──────────────────────────────────────────────────────

export type LatestUpdateSource = 'reply' | 'mail' | 'live';

export interface LatestUpdate {
  text: string;
  source: LatestUpdateSource;
  /** Epoch ms of what was written; undefined for the live line. */
  ts?: number;
}

/**
 * The card's "latest update in its own words".
 *
 * Newest of {its last reply, its last message to the floor}; a message is read
 * as its subject when it has one (that is the sentence the agent chose to sum
 * itself up with), else its body. Falls back to the live line — the caller's
 * translated `liveText` — when the agent has written nothing readable.
 */
export function pickLatestUpdate(activity: AgentActivity | undefined, liveText: string, max = 180): LatestUpdate {
  const candidates: LatestUpdate[] = [];
  if (activity?.lastReply) {
    const text = plainPreview(activity.lastReply.text, max);
    if (text) candidates.push({ text, source: 'reply', ts: activity.lastReply.ts });
  }
  if (activity?.lastMail) {
    const subject = plainPreview(activity.lastMail.subject, max);
    const body = plainPreview(activity.lastMail.body, max);
    // Harness-written subjects ("Re: …", "[worker worktree preserved] …") are
    // labels, not sentences; a body says more.
    const useSubject = subject && !/^(re|fwd?):/i.test(subject) && !/^\[/.test(subject) && subject.split(' ').length >= 3;
    const text = useSubject ? subject : body || subject;
    if (text) candidates.push({ text, source: 'mail', ts: activity.lastMail.ts });
  }
  candidates.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  return candidates[0] ?? { text: liveText, source: 'live' };
}

// ─── The tool line ──────────────────────────────────────────────────────────

/**
 * Turn the store's `action` into a tool line when the transcript has none
 * (non-Claude engines). The pty parser writes `<tool> <arg>` lower-cased tool
 * names (`bash npm test`), the hooks `using <Tool>`. Bash reads as its command;
 * other tools as "Tool arg". Null when the action names no tool.
 */
export function toolLineFromAction(action: string | undefined): { tool: string; text: string } | null {
  const a = (action ?? '').replace(/\s+/g, ' ').trim();
  if (!a) return null;
  const using = /^using\s+(\S+)$/i.exec(a);
  if (using) return { tool: using[1], text: '' };
  const parts = /^(bash|read|edit|multiedit|write|grep|glob|webfetch|websearch|task|todowrite)\s+(.+)$/i.exec(a);
  if (!parts) return null;
  const tool = parts[1].toLowerCase();
  const name = tool === 'bash' ? 'Bash'
    : tool === 'multiedit' ? 'MultiEdit'
      : tool === 'webfetch' ? 'WebFetch'
        : tool === 'websearch' ? 'WebSearch'
          : tool === 'todowrite' ? 'TodoWrite'
            : tool[0].toUpperCase() + tool.slice(1);
  return { tool: name, text: parts[2] };
}

/** "npm test auth/login" for Bash, "Read src/auth/login.ts" for the rest. */
export function formatToolLine(tool: string, text: string): string {
  const t = tool.toLowerCase();
  if ((t === 'bash' || t === 'shell') && text) return text;
  return text ? `${tool} ${text}` : tool;
}

// ─── Tickets ────────────────────────────────────────────────────────────────

/** The fields of a ledger card this module reads. Structural: the renderer's
 *  HiveTask and a raw tasks.json entry both fit. */
export interface TaskLike {
  id: string;
  title?: string;
  assignee?: string;
  status?: string;
  createdAt?: string;
  humanQA?: Array<{ q?: string; a?: string; askedAt?: string; answeredAt?: string; dismissedAt?: string }>;
}

export interface CardTicket {
  id: string;
  title: string;
  status: string;
}

const STATUS_RANK: Record<string, number> = { doing: 0, blocked: 1, todo: 2 };

function createdMs(t: TaskLike): number {
  const ms = t.createdAt ? Date.parse(t.createdAt) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/** The ticket an agent's card shows: what it is DOING, else what it is blocked
 *  on, else the next thing it has to do. Newest first within a status. Done
 *  cards never show. */
export function pickCurrentTicket(tasks: readonly TaskLike[], agentId: string): CardTicket | null {
  const mine = tasks.filter((t) =>
    t && typeof t.id === 'string' && t.assignee === agentId && t.status !== undefined && t.status in STATUS_RANK
  );
  if (!mine.length) return null;
  mine.sort((a, b) =>
    (STATUS_RANK[a.status ?? ''] - STATUS_RANK[b.status ?? '']) || (createdMs(b) - createdMs(a))
  );
  const t = mine[0];
  return { id: t.id, title: (t.title ?? '').trim() || t.id, status: t.status ?? 'todo' };
}

export interface OpenAsk {
  taskId: string;
  taskTitle: string;
  q: string;
  askedAt?: string;
}

/** The newest unanswered, undismissed ASK ME question on a BLOCKED card
 *  assigned to this agent — the same "waits on the human" rule the ASK ME
 *  board and `useAskedYou` use, so the card, the sidebar and the inbox agree. */
export function openAskFor(tasks: readonly TaskLike[], agentId: string): OpenAsk | null {
  let best: OpenAsk | null = null;
  let bestMs = -Infinity;
  for (const t of tasks) {
    if (!t || t.assignee !== agentId || t.status !== 'blocked' || !Array.isArray(t.humanQA)) continue;
    for (let i = t.humanQA.length - 1; i >= 0; i--) {
      const e = t.humanQA[i];
      if (!e || typeof e.q !== 'string' || !e.q.trim() || e.a || e.dismissedAt) continue;
      const ms = e.askedAt ? Date.parse(e.askedAt) : NaN;
      const rank = Number.isNaN(ms) ? 0 : ms;
      if (!best || rank > bestMs) {
        best = { taskId: t.id, taskTitle: (t.title ?? '').trim() || t.id, q: e.q, askedAt: e.askedAt };
        bestMs = rank;
      }
      break;
    }
  }
  return best;
}

/** Bounds on an inline-added ticket's title. */
export const MAX_TICKET_TITLE = 200;

export interface NewTicket {
  id: string;
  title: string;
  description?: string;
  assignee: string;
  status: 'todo';
  dependsOn: string[];
  priority: number;
  createdAt: string;
}

/**
 * "Add a ticket" from a card: the one input line becomes the title (bounded);
 * a longer entry keeps the full text as the description. Returns null for an
 * empty line.
 */
export function buildTicket(input: string, agentId: string, id: string, now: Date): NewTicket | null {
  const text = input.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const title = text.length > MAX_TICKET_TITLE
    ? `${text.slice(0, MAX_TICKET_TITLE - 1).trimEnd()}…`
    : text;
  return {
    id,
    title,
    ...(text.length > MAX_TICKET_TITLE ? { description: text } : {}),
    assignee: agentId,
    status: 'todo',
    dependsOn: [],
    priority: 3,
    createdAt: now.toISOString()
  };
}

/** What the agent is told when you add a ticket from its card. English on
 *  purpose: it is a prompt for the agent, not UI. */
export function ticketBriefing(ticket: Pick<NewTicket, 'id' | 'title' | 'description'>): string {
  const lines = [
    `New ticket for you: ${ticket.id} — ${ticket.title}`,
    ...(ticket.description ? ['', ticket.description] : []),
    '',
    `It is on the task board (hive/tasks.json) assigned to you, in To do. Move it to "doing" when you start, and to "done" with a one-line result when it is finished.`
  ];
  return lines.join('\n');
}

// ─── Numbers ────────────────────────────────────────────────────────────────

/** Context used as a whole percent of the window, or null when unknown. */
export function contextPercent(tokens: number | undefined, limit: number | undefined): number | null {
  if (typeof tokens !== 'number' || typeof limit !== 'number' || !Number.isFinite(tokens) || !Number.isFinite(limit) || limit <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round((tokens / limit) * 100)));
}

/** Gauge tone from the percent: calm, then warning from 75, then danger from 88
 *  (the Command Center's thresholds). */
export function contextTone(pct: number | null): 'ok' | 'warn' | 'danger' {
  if (pct === null) return 'ok';
  if (pct >= 88) return 'danger';
  if (pct >= 75) return 'warn';
  return 'ok';
}

/** Dollars for a spend chip: "$0.42", "$12.30", "$1,204", "<$0.01". */
export function formatUsd(usd: number | undefined, locale?: string): string | null {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return null;
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  const fmt = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: usd >= 1000 ? 0 : 2,
    maximumFractionDigits: usd >= 1000 ? 0 : 2
  });
  return fmt.format(usd);
}
