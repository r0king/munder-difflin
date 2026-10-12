/**
 * Quick replies — the options a question CLEARLY enumerates, as button labels
 * (owned by the `wsInbox` unit).
 *
 * The orchestrator is told to write an ask as one bold sentence plus "-" or
 * "1." bullets per option (hive.ts, the ASK ME protocol), and agents often ask
 * "`logo.svg` or `logo_old.svg`?". When the choices are that explicit, the
 * Inbox offers each one as a button that answers with its label.
 *
 * The bar is "clearly", on purpose. The same bullet syntax also lists STEPS
 * ("1. create the account 2. paste the key"), and a button that answers
 * "create the account" to that ask is worse than no button. So a list only
 * counts when the text around it asks for a choice (a question mark or a
 * choice word) and every item yields a short label; anything doubtful yields
 * no options and the reply box stays the only way to answer.
 *
 * Pure and import-free (node:test loads it via test/load-ts.cjs).
 */

/** At most this many buttons; a longer list is a menu, not a quick reply. */
export const MAX_OPTIONS = 6;
/** A label longer than this is a sentence, not an option. */
export const MAX_LABEL = 80;

// "- x", "* x", "+ x", "• x", "1. x", "1) x", "a) x", "(a) x", "A. x"
const LIST_ITEM = /^\s{0,3}(?:[-*+•]|\d{1,2}[.)]|\(?[A-Za-z][.)])\s+(.+?)\s*$/;

/** Words that make the text around a list a CHOICE rather than a procedure.
 *  English, Chinese and Arabic, since agents answer in the user's language. */
const CHOICE_CUE = /\?|？|؟|\b(?:which|choose|choice|pick|prefer|preferred|select|option|options|either|or|should i|do you want|would you like|decide|approve)\b|还是|哪|选|أو|أي|اختر|اختيار|تفضل/i;

/** Strip inline markdown down to readable text. */
function plain(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The label one list item answers with.
 *
 * An item that LEADS with emphasis or code ("**Keep both** — archive the
 * old one", "`logo.svg`: the new mark") is labelled by that lead: it is the
 * option's name and the rest is its explanation. Otherwise the whole item,
 * cut at a dash or colon explanation when the item is long.
 */
export function optionLabel(item: string): string {
  const lead = /^(?:\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`)/.exec(item.trim());
  if (lead) {
    const label = plain(lead[1] ?? lead[2] ?? lead[3] ?? '').replace(/[\s:：,，.。—–-]+$/, '');
    if (label) return label;
  }
  const text = plain(item);
  if (text.length <= 48) return text.replace(/[.。]$/, '');
  const cut = /^(.{2,60}?)(?:\s+[—–-]\s+|[:：]\s+)/.exec(text);
  return (cut ? cut[1] : text).replace(/[.。]$/, '').trim();
}

interface ListBlock {
  items: string[];
  /** Line index of the first item. */
  start: number;
}

function listBlocks(lines: string[]): ListBlock[] {
  const blocks: ListBlock[] = [];
  let current: ListBlock | null = null;
  lines.forEach((line, i) => {
    const m = LIST_ITEM.exec(line);
    if (m) {
      if (!current) { current = { items: [], start: i }; blocks.push(current); }
      current.items.push(m[1]);
      return;
    }
    // A blank line inside a list does not end it (loose markdown lists); any
    // other non-item line does.
    if (line.trim() === '' && current) return;
    current = null;
  });
  return blocks;
}

function dedupe(labels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of labels) {
    const key = l.toLowerCase();
    if (!l || seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

/** Options from the LAST list in the text that reads as a choice. */
function fromLists(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const blocks = listBlocks(lines).filter((b) => b.items.length >= 2 && b.items.length <= MAX_OPTIONS);
  for (let k = blocks.length - 1; k >= 0; k--) {
    const block = blocks[k];
    // The lead-in: up to three non-empty lines right above the list.
    const lead = lines.slice(Math.max(0, block.start - 3), block.start).join('\n');
    const labelled = block.items.every((item) => /^\s*(?:option\s+)?[A-Za-z0-9][.):]\s/i.test(item) || /^(?:\*\*|__|`)/.test(item.trim()));
    if (!CHOICE_CUE.test(lead) && !/^\s*option\b/i.test(block.items[0]) && !(labelled && /\?|？|؟/.test(text))) continue;
    const labels = block.items.map(optionLabel);
    if (labels.some((l) => !l || l.length > MAX_LABEL)) return [];
    const unique = dedupe(labels);
    return unique.length >= 2 ? unique : [];
  }
  return [];
}

/**
 * Options named inline in one question: "`logo.svg` or `logo_old.svg`?",
 * "**Ship** or **hold**?", "`a`, `b` or `c`?". Only code or bold spans that
 * are separated by nothing but commas, slashes and "or", inside a sentence
 * that ends in a question mark — "edit `a.ts` to call `b()`?" names two
 * things but offers no choice, and yields nothing.
 */
function fromInline(text: string): string[] {
  const sentences = text.split(/(?<=[?？؟])\s+|\n+/);
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!/[?？؟]$/.test(sentence)) continue;
    const spans: Array<{ label: string; start: number; end: number }> = [];
    const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sentence)) !== null) {
      spans.push({ label: (m[1] ?? m[2]).trim(), start: m.index, end: m.index + m[0].length });
    }
    if (spans.length < 2) continue;
    // Longest run of spans joined only by separators, containing an "or".
    let best: string[] = [];
    let run: string[] = [spans[0].label];
    let hasOr = false;
    for (let i = 1; i < spans.length; i++) {
      const gap = sentence.slice(spans[i - 1].end, spans[i].start);
      if (/^\s*(?:,|，|\/|、)?\s*(?:or|还是|或者|或|أو)?\s*$/i.test(gap) && gap.trim() !== '' ) {
        run.push(spans[i].label);
        if (/\b(?:or)\b|还是|或|أو|\//i.test(gap)) hasOr = true;
      } else {
        if (hasOr && run.length > best.length) best = run;
        run = [spans[i].label];
        hasOr = false;
      }
    }
    if (hasOr && run.length > best.length) best = run;
    const labels = dedupe(best.map(plain));
    if (labels.length >= 2 && labels.length <= MAX_OPTIONS && labels.every((l) => l.length <= MAX_LABEL)) return labels;
  }
  return [];
}

/**
 * The quick-reply options a question clearly enumerates, in the order it
 * lists them. Empty when it enumerates none (or when doubtful).
 */
export function extractOptions(text: string): string[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  // Fenced code is content, never a list of options.
  const clean = text.replace(/```[\s\S]*?```/g, '');
  const listed = fromLists(clean);
  if (listed.length) return listed;
  return fromInline(clean);
}
