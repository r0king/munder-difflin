/**
 * Transcription vocabulary (owned by the `transcribe` unit): 126 built-in
 * technical names plus the user's own words.
 *
 * Used twice per transcription:
 *   1. as the engine's prompt (Whisper's initial prompt / Groq's `prompt`),
 *      which biases recognition toward these spellings — bounded, because
 *      Whisper only reads the last 224 prompt tokens and an over-long list
 *      crowds out the transcript's own context;
 *   2. as a casing pass on the result: an exact whole-word match, compared
 *      case-insensitively, is rewritten to the canonical spelling ("postgresql"
 *      → "PostgreSQL"), and nothing inside a longer word is touched.
 *
 * The built-in list deliberately leaves out names that are also everyday
 * English words (Rust, Swift, React, Slack, Notion, Cursor, Linear, Whisper,
 * Opus, Grok…): pass 2 would capitalise "a rust stain" or "react quickly".
 * Users who want those can add them as their own words.
 *
 * Order matters: when the prompt budget runs out, earlier terms win, so the
 * names Whisper most often gets wrong come first. Pure module; the dictate
 * unit may import `applyVocabularyCasing` for its own text pass.
 */
export const BUILTIN_VOCABULARY: readonly string[] = [
  // First, the names speech models most often get wrong — these are what the
  // prompt budget is spent on. Everything after still gets the casing pass.
  'Anthropic', 'Claude', 'Claude Code', 'Kubernetes', 'kubectl', 'ARR', 'MRR', 'PostgreSQL', 'GitHub',
  'TypeScript', 'OpenAI', 'ChatGPT', 'Munder Difflin', 'Terraform', 'Supabase', 'Vercel', 'LangChain',
  'PyTorch', 'Datadog', 'SaaS', 'EBITDA', 'GraphQL', 'gRPC', 'Node.js', 'Next.js', 'Ollama', 'DeepSeek',
  'Mixtral', 'Qwen', 'Groq', 'nginx', 'ClickHouse', 'DuckDB', 'Cloudflare', 'MCP', 'LLM',
  // AI labs, models and tooling
  'GPT', 'Codex', 'Gemini', 'DeepMind', 'Mistral', 'Llama', 'xAI', 'Hugging Face', 'Midjourney',
  'Stable Diffusion', 'DALL-E', 'GitHub Copilot', 'LlamaIndex', 'TensorFlow', 'CUDA', 'NVIDIA', 'Vertex AI',
  // Cloud and hosting
  'AWS', 'EC2', 'S3', 'AWS Lambda', 'DynamoDB', 'CloudFront', 'Azure', 'GCP', 'Google Cloud', 'BigQuery',
  'Heroku', 'DigitalOcean', 'Firebase', 'Databricks',
  // Infrastructure, data and protocols
  'Docker', 'Ansible', 'Prometheus', 'Grafana', 'PagerDuty', 'Kafka', 'RabbitMQ', 'Redis', 'Postgres',
  'MySQL', 'SQLite', 'MongoDB', 'Elasticsearch', 'etcd', 'WebSocket', 'WebAssembly', 'OAuth', 'JWT',
  'JSON', 'YAML', 'API', 'SDK', 'CLI', 'CI/CD', 'DevOps', 'Okta',
  // Developer tools, languages and platforms
  'GitLab', 'VS Code', 'JetBrains', 'IntelliJ', 'Xcode', 'npm', 'JavaScript', 'Python', 'Kotlin',
  'SwiftUI', 'Django', 'FastAPI', 'Vite', 'webpack', 'ESLint', 'Figma', 'Jira', 'macOS', 'iOS', 'Ubuntu',
  'PostHog',
  // Business and finance
  'NRR', 'ACV', 'CAC', 'LTV', 'GMV', 'B2B', 'YoY', 'KPI', 'OKR', 'SOC 2', 'GDPR', 'HIPAA'
];

const WORD_CHAR = /[A-Za-z0-9_]/;

/** User words + built-ins, user words first, de-duplicated case-insensitively.
 *  A user's spelling of a built-in term wins (they may prefer "Postgres SQL"). */
export function mergeVocabulary(custom: readonly string[], builtin: readonly string[] = BUILTIN_VOCABULARY): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of [...custom, ...builtin]) {
    const t = w.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** Rough token count for Whisper/Groq's BPE when no tokenizer is at hand:
 *  ~1 token per 3 characters of a name plus one for the ", " separator. Errs
 *  high (names tokenise worse than prose), so a budget is never overrun. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3) + 1;
}

export interface PromptOptions {
  /** Token budget for the vocabulary part (default 120 — about half of
   *  Whisper's 224-token prompt window, leaving room for the caller's text). */
  maxTokens?: number;
  /** Exact counter (the local engine passes its tokenizer). */
  countTokens?: (text: string) => number;
  /** Caller-supplied context that goes first, and counts against the budget. */
  lead?: string;
}

/**
 * Build the biasing prompt: optional lead text, then as many vocabulary terms as
 * fit in the budget, as a comma list ending in a full stop (the shape Whisper
 * treats as preceding transcript text). Returns '' when nothing fits.
 */
export function buildVocabularyPrompt(words: readonly string[], opts: PromptOptions = {}): string {
  const max = Math.max(0, opts.maxTokens ?? 120);
  const count = opts.countTokens ?? estimateTokens;
  const lead = (opts.lead ?? '').replace(/\s+/g, ' ').trim();
  const prefix = lead ? (/[.!?]$/.test(lead) ? `${lead} ` : `${lead}. `) : '';
  if (prefix && count(prefix) > max) return '';
  let used: string[] = [];
  for (const w of words) {
    const next = [...used, w];
    if (count(`${prefix}${next.join(', ')}.`) > max) break;
    used = next;
  }
  if (!used.length) return lead && count(prefix) <= max ? prefix.trim() : '';
  return `${prefix}${used.join(', ')}.`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Compile once per vocabulary; the regex alternation tries longer terms first
 *  so "Claude Code" wins over "Claude". Inner spaces match any whitespace run. */
export function compileVocabulary(words: readonly string[]): { re: RegExp; canon: Map<string, string> } | null {
  const canon = new Map<string, string>();
  for (const w of words) {
    const t = w.replace(/\s+/g, ' ').trim();
    if (t) canon.set(t.toLowerCase(), t);
  }
  if (!canon.size) return null;
  const alts = [...canon.values()]
    .sort((a, b) => b.length - a.length)
    .map((t) => escapeRegExp(t).replace(/ /g, '\\s+'));
  // Lookarounds instead of \b: terms may start or end with punctuation
  // (Node.js, CI/CD, DALL-E), where \b would misfire.
  const re = new RegExp(`(?<![A-Za-z0-9_])(?:${alts.join('|')})(?![A-Za-z0-9_])`, 'gi');
  return { re, canon };
}

/**
 * Rewrite exact whole-word matches (case-insensitive) to the vocabulary's
 * spelling. Substrings are never touched ("apiary" keeps its "api", "nodes"
 * stays "nodes"), and a term that ends in a dot does not swallow the sentence's
 * full stop.
 */
export function applyVocabularyCasing(
  text: string,
  words: readonly string[] | ReturnType<typeof compileVocabulary>
): string {
  const compiled = Array.isArray(words) ? compileVocabulary(words as readonly string[]) : (words as ReturnType<typeof compileVocabulary>);
  if (!compiled || !text) return text;
  compiled.re.lastIndex = 0;
  return text.replace(compiled.re, (m: string, offset: number, whole: string) => {
    const key = m.replace(/\s+/g, ' ').toLowerCase();
    const canonical = compiled.canon.get(key);
    if (!canonical) return m;
    // Guard against a match glued to a word char through a regex edge case.
    const before = offset > 0 ? whole[offset - 1] : '';
    if (before && WORD_CHAR.test(before)) return m;
    return canonical;
  });
}
