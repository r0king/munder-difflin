/**
 * "Send the results to an agent with a prompt, so the next job starts from what
 * the floor already knows."
 *
 * Builds the text that rides deliverToAgent: the user's prompt first, then a
 * compact, plainly formatted block of the results they picked — tickets by id,
 * agents by name and id, notes with their author, date, excerpt and the file
 * to read for the rest. Written for the AGENT, so it is plain English markdown
 * like every other machine-facing message in the hive (the composer's
 * "Attached files:" block, PROTOCOL.md); the user's own prompt is passed
 * through untouched in whatever language they wrote it.
 *
 * Bounded: each excerpt is capped, and once the block reaches `maxChars` the
 * remaining items are counted, not included.
 */
import { MAX_DELIVER_TEXT } from '../features/deliver';
import { isoDay, parseNoteDate } from './memoryFormat';
import type { AnswerAgent, AnswerTicket, NoteHit } from './memoryTypes';

export type ContextItem =
  | {
      kind: 'ticket';
      id: string;
      title: string;
      status?: string;
      /** Display names of the agents on it. */
      people: string[];
      excerpt?: string;
    }
  | {
      kind: 'agent';
      id: string;
      name: string;
      role?: string;
      tickets: number;
      notes: number;
    }
  | {
      kind: 'note';
      title: string;
      /** Display name of the author; undefined = the user's own note. */
      author?: string;
      /** Already-formatted date (YYYY-MM-DD). */
      date?: string;
      /** Where it came from: memory, board, notes, knowledge, palace. */
      source: string;
      path?: string;
      excerpt: string;
    };

export interface ContextOptions {
  prompt: string;
  query?: string;
  items: readonly ContextItem[];
  /** Cap on the block (not the prompt). */
  maxChars?: number;
  /** Cap on one excerpt. */
  excerptChars?: number;
}

export const CONTEXT_MAX_CHARS = 12_000;
export const CONTEXT_EXCERPT_CHARS = 600;
/** Longest prompt the screen accepts; the rest of the delivery budget is the block's. */
export const CONTEXT_PROMPT_MAX = 20_000;

const SOURCE_LABEL: Record<string, string> = {
  memory: 'memory',
  board: 'board',
  notes: 'note',
  knowledge: 'document',
  palace: 'memory, by meaning'
};

/** One line of plain text: whitespace collapsed, markdown markers kept (the
 *  agent reads markdown fine), cut at a word near `max`. */
export function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Quote an excerpt as `  > ` lines, keeping its line breaks but capping it. */
function quote(excerpt: string, max: number): string {
  const lines = excerpt.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).filter((l, i, a) => l || (i > 0 && a[i - 1]));
  let used = 0;
  const out: string[] = [];
  for (const l of lines) {
    if (used >= max) { out.push('  > …'); break; }
    const room = max - used;
    const piece = l.length > room ? oneLine(l, room) : l;
    out.push(`  > ${piece}`.trimEnd());
    used += piece.length + 1;
  }
  while (out.length && out[out.length - 1] === '  >') out.pop();
  return out.join('\n');
}

function ticketLine(t: Extract<ContextItem, { kind: 'ticket' }>, excerptChars: number): string {
  let s = `- ${t.id} — ${oneLine(t.title, 200)}`;
  if (t.status) s += ` [${t.status}]`;
  if (t.people.length) s += ` · worked on by ${t.people.join(', ')}`;
  if (t.excerpt?.trim()) s += `\n${quote(t.excerpt, excerptChars)}`;
  return s;
}

function agentLine(a: Extract<ContextItem, { kind: 'agent' }>): string {
  let s = `- ${a.name} (id: ${a.id})`;
  if (a.role?.trim()) s += ` — ${oneLine(a.role, 160)}`;
  const parts: string[] = [];
  if (a.tickets) parts.push(`${a.tickets} ticket${a.tickets === 1 ? '' : 's'}`);
  if (a.notes) parts.push(`${a.notes} note${a.notes === 1 ? '' : 's'}`);
  if (parts.length) s += ` · ${parts.join(', ')} in these results`;
  return s;
}

function noteLine(n: Extract<ContextItem, { kind: 'note' }>, excerptChars: number): string {
  // A user note is the user's; a document or an unattributed drawer is no one's.
  const author = n.author ?? (n.source === 'notes' ? 'the user' : undefined);
  const by = [author, n.date].filter(Boolean).join(', ');
  let s = `- ${oneLine(n.title || '(untitled)', 160)}${by ? ` — ${by}` : ''} (${SOURCE_LABEL[n.source] ?? n.source})`;
  if (n.path) s += `\n  file: ${n.path}`;
  if (n.excerpt.trim()) s += `\n${quote(n.excerpt, excerptChars)}`;
  return s;
}

/** The full delivery text: prompt, then the context block. */
export function buildContextBlock(opts: ContextOptions): string {
  const maxChars = Math.max(500, opts.maxChars ?? CONTEXT_MAX_CHARS);
  const excerptChars = Math.max(80, opts.excerptChars ?? CONTEXT_EXCERPT_CHARS);
  const prompt = (opts.prompt ?? '').trim().slice(0, CONTEXT_PROMPT_MAX);
  const tickets = opts.items.filter((i): i is Extract<ContextItem, { kind: 'ticket' }> => i.kind === 'ticket');
  const agents = opts.items.filter((i): i is Extract<ContextItem, { kind: 'agent' }> => i.kind === 'agent');
  const notes = opts.items.filter((i): i is Extract<ContextItem, { kind: 'note' }> => i.kind === 'note');
  if (!tickets.length && !agents.length && !notes.length) return prompt;

  const sections: Array<{ title: string; lines: string[] }> = [
    { title: 'Tickets', lines: tickets.map((t) => ticketLine(t, excerptChars)) },
    { title: 'Agents', lines: agents.map(agentLine) },
    { title: 'Notes', lines: notes.map((n) => noteLine(n, excerptChars)) }
  ];

  const q = opts.query?.trim() ? ` for "${oneLine(opts.query, 120)}"` : '';
  const head = `Context from the floor's memory${q}:`;
  let body = '';
  let omitted = 0;
  for (const sec of sections) {
    if (!sec.lines.length) continue;
    let chunk = `\n\n${sec.title}`;
    let added = 0;
    for (const line of sec.lines) {
      if (head.length + body.length + chunk.length + line.length + 1 > maxChars) { omitted += 1; continue; }
      chunk += `\n${line}`;
      added += 1;
    }
    if (added) body += chunk;
  }
  if (omitted) body += `\n\n(${omitted} more selected result${omitted === 1 ? '' : 's'} left out to keep this short.)`;
  const footer: string[] = [];
  if (notes.some((n) => n.path)) footer.push('Read the files listed for the full notes.');
  if (tickets.length) footer.push('Tickets are in the hive task ledger (tasks.json) under their ids.');
  if (footer.length) body += `\n\n${footer.join(' ')}`;
  const block = `${head}${body}`;
  const text = prompt ? `${prompt}\n\n---\n${block}` : block;
  return text.length > MAX_DELIVER_TEXT ? text.slice(0, MAX_DELIVER_TEXT) : text;
}

// ─── From the screen's selection ────────────────────────────────────────────

/** Anything the user can tick in an answer. */
export type SelectedResult = AnswerTicket | AnswerAgent | NoteHit;

export interface ContextNames {
  /** Display name for an agent id (the live roster's, else the registry's). */
  name(id: string): string;
  role(id: string): string | undefined;
}

/** The screen's ticked results as context items, in the order ticked. */
export function toContextItems(selected: readonly SelectedResult[], names: ContextNames): ContextItem[] {
  return selected.map((r): ContextItem => {
    if (r.kind === 'ticket') {
      const item: ContextItem = { kind: 'ticket', id: r.id, title: r.title, people: r.agentIds.map((id) => names.name(id)) };
      if (r.status) item.status = r.status;
      if (r.snippet?.text) item.excerpt = r.snippet.text;
      return item;
    }
    if (r.kind === 'agent') {
      const item: ContextItem = { kind: 'agent', id: r.id, name: names.name(r.id), tickets: r.tickets, notes: r.notes };
      const role = names.role(r.id);
      if (role) item.role = role;
      return item;
    }
    const item: ContextItem = { kind: 'note', title: r.title, source: r.source, excerpt: r.text ?? r.snippet.text };
    if (r.authorId) item.author = names.name(r.authorId);
    const d = parseNoteDate(r.at);
    if (d) item.date = isoDay(d);
    if (r.path) item.path = r.path;
    return item;
  });
}
