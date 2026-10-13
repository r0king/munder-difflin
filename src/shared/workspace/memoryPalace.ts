/**
 * Reading `mempalace search` output.
 *
 * The CLI has no JSON mode, so this parses the text it prints. The shape has
 * been stable across releases (checked against mempalace 3.x `searcher`):
 *
 *     ============================================================
 *       Results for: "the query"
 *     ============================================================
 *
 *       [1] <wing> / <room>
 *           Source: memory.md
 *           Match:  cosine_sim=0.523  bm25=1.2      (older: "Match:  0.523")
 *
 *           <verbatim drawer text, indented six spaces>
 *
 *       --------------------------------------------------------
 *
 * plus an optional "NOTICE: vector search disabled …" banner, and
 * `No results found for: "…"` when nothing matched. Anything this parser does
 * not recognise is ignored rather than guessed at; if a future release
 * changes the format entirely, `parsePalaceOutput` returns no hits and
 * `unparsed: true`, and the screen shows the raw text instead of nothing.
 */

export interface PalaceHit {
  rank: number;
  /** The wing — the agent id the mine loop filed it under (`--wing <id>`). */
  wing: string;
  room: string;
  source: string;
  /** Vector similarity in [0, 1] when the CLI reported one. */
  similarity?: number;
  bm25?: number;
  text: string;
}

export interface PalaceParse {
  hits: PalaceHit[];
  /** The CLI said, in words, that nothing matched. */
  noResults: boolean;
  /** A banner worth showing (the HNSW-diverged "run mempalace repair" one). */
  notice?: string;
  /** Output was non-empty but held no recognisable hit and no "no results"
   *  line — a format we do not know. */
  unparsed: boolean;
}

const HIT_HEAD = /^\s{1,4}\[(\d+)\]\s+(.+?)\s+\/\s+(.+?)\s*$/;
const SOURCE = /^\s+Source:\s*(.*)$/;
const MATCH = /^\s+Match:\s*(.*)$/;
const RULE = /^\s*-{20,}\s*$/;
const MAX_HIT_TEXT = 8000;

function num(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Pull the numbers out of a "Match:" line, whatever generation printed it. */
export function parseMatchLine(s: string): { similarity?: number; bm25?: number } {
  const sim = /\b[a-z0-9]*_?sim=\s*(-?[\d.]+(?:e-?\d+)?)/i.exec(s);
  const bm = /\bbm25=\s*(-?[\d.]+(?:e-?\d+)?)/i.exec(s);
  if (sim || bm) return { similarity: num(sim?.[1]), bm25: num(bm?.[1]) };
  const bare = /^\s*(-?[\d.]+)\s*$/.exec(s);
  return bare ? { similarity: num(bare[1]) } : {};
}

/** Remove the six-space indent the CLI puts in front of every text line. */
function dedent(lines: string[]): string {
  let min = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    const lead = /^ */.exec(l)?.[0].length ?? 0;
    if (lead < min) min = lead;
  }
  const cut = Number.isFinite(min) ? min : 0;
  return lines.map((l) => l.slice(Math.min(cut, /^ */.exec(l)?.[0].length ?? 0))).join('\n').trim();
}

export function parsePalaceOutput(output: string): PalaceParse {
  const text = typeof output === 'string' ? output.replace(/\r\n/g, '\n') : '';
  const lines = text.split('\n');
  const hits: PalaceHit[] = [];
  let noResults = /No results found for:/i.test(text);
  let notice: string | undefined;
  const noticeAt = lines.findIndex((l) => /^\s*NOTICE:/.test(l));
  if (noticeAt >= 0) {
    const parts: string[] = [];
    for (let i = noticeAt; i < lines.length && lines[i].trim(); i++) parts.push(lines[i].trim());
    notice = parts.join(' ').replace(/^NOTICE:\s*/, '');
  }

  let cur: { head: PalaceHit; body: string[]; inBody: boolean } | null = null;
  const flush = (): void => {
    if (!cur) return;
    const body = dedent(cur.body);
    cur.head.text = body.length > MAX_HIT_TEXT ? `${body.slice(0, MAX_HIT_TEXT)}…` : body;
    if (cur.head.text || cur.head.source) hits.push(cur.head);
    cur = null;
  };
  for (const line of lines) {
    const head = HIT_HEAD.exec(line);
    if (head) {
      flush();
      cur = {
        head: { rank: Number(head[1]), wing: head[2].trim(), room: head[3].trim(), source: '', text: '' },
        body: [],
        inBody: false
      };
      continue;
    }
    if (!cur) continue;
    if (RULE.test(line) && !/^\s{5,}/.test(line)) { flush(); continue; }
    if (!cur.inBody) {
      const src = SOURCE.exec(line);
      if (src) { cur.head.source = src[1].trim(); continue; }
      const m = MATCH.exec(line);
      if (m) { Object.assign(cur.head, parseMatchLine(m[1])); cur.inBody = true; continue; }
      if (!line.trim()) continue;
      // Text before any Match line: an older layout. Treat as body.
      cur.inBody = true;
    }
    cur.body.push(line);
  }
  flush();
  if (hits.length) noResults = false;
  const unparsed = !hits.length && !noResults && text.trim().length > 0;
  return { hits, noResults, notice, unparsed };
}
