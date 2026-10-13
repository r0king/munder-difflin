/**
 * HOUSE RULES — the "context rules" of the Workspace's Automations screen: short
 * texts every agent on the floor reads before it starts work ("House style:
 * plain English, no exclamation marks", "Commit messages: imperative mood").
 *
 * Not to be confused with `ContextRule` in ../triggers.ts, which is the
 * auto-compact / auto-clear maintenance rule. Both appear under "Context rules"
 * on the Automations screen, but only these carry prose for the agents to read.
 *
 * Shared by main (validation on the way in, and the text handed to the hook
 * server) and the renderer (drafting and display), and import-free so node:test
 * can load it directly.
 *
 * ── How the text reaches an agent ──────────────────────────────────────────
 * The enabled rules are folded into the same hook-channel briefing that carries
 * an agent's standing goal (main/hooks.ts: SessionStart, and again on the next
 * prompt whenever the text changes). That channel already does the two things a
 * rule needs: it lands before the agent's first turn, and a rule switched on or
 * edited mid-session reaches a running agent on its next prompt without a
 * restart. It is deliberately NOT the spawn-time system prompt, which must stay
 * volatile-free for prompt caching (see hive.ts injectedPrompt).
 *
 * Engines with no hook channel (Cursor, Crush, …) get their standing goal from
 * the renderer instead, typed ahead of each queued message (useHive.ts
 * withStandingGoal); `prependStandingGoal` folds the same rules into that
 * preamble, so every engine reads one text and none reads it twice.
 */

export interface HouseRule {
  /** `cr-<base36 time>-<rand>`. Stable for the rule's life. */
  id: string;
  name: string;
  /** What the agents read. */
  text: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A name is a row label, not a paragraph. */
export const HOUSE_RULE_NAME_MAX = 80;
/** One rule: about two pages of prose. Longer belongs in a doc the rule links. */
export const HOUSE_RULE_TEXT_MAX = 8000;
/** More rules than this is a wiki, and every one of them rides into every
 *  agent's context. */
export const HOUSE_RULES_MAX = 40;
/** Hard ceiling on what all enabled rules together inject into one agent. A
 *  briefing larger than this crowds out the work it is meant to shape; rules
 *  past the ceiling are named as omitted rather than silently dropped. */
export const HOUSE_RULES_INJECT_MAX = 20_000;

const ID_RE = /^cr-[a-z0-9]{1,16}-[a-z0-9]{1,12}$/;

export function isHouseRuleId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}

/** Mint an id in the shape main accepts. `rand` is injectable for tests. */
export function newHouseRuleId(now: number, rand: () => number = Math.random): string {
  const r = Math.floor(rand() * 36 ** 6).toString(36).padStart(6, '0').slice(0, 6);
  return `cr-${Math.max(0, Math.floor(now)).toString(36)}-${r}`;
}

/** A fresh rule, OFF: the operator writes it first and switches it on when it
 *  says what they mean — an empty rule live on every agent would be noise. */
export function newHouseRule(name: string, now: number, rand: () => number = Math.random): HouseRule {
  return {
    id: newHouseRuleId(now, rand),
    name: name.trim().slice(0, HOUSE_RULE_NAME_MAX),
    text: '',
    enabled: false,
    createdAt: now,
    updatedAt: now
  };
}

/** Collapse a name to one line: a newline pasted into a row label would break
 *  the row and the `## heading` it becomes in the injected text. */
function oneLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/**
 * Validate one rule from an untrusted source (the renderer, or a settings file
 * someone edited by hand). Returns null for anything unusable. Over-long text is
 * clipped rather than rejected, so a paste that is one character too long does
 * not lose the whole rule.
 */
export function sanitizeHouseRule(raw: unknown, now: number): HouseRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Record<keyof HouseRule, unknown>>;
  if (!isHouseRuleId(r.id)) return null;
  const name = typeof r.name === 'string' ? oneLine(r.name).slice(0, HOUSE_RULE_NAME_MAX) : '';
  const text = typeof r.text === 'string' ? r.text.replace(/\r\n?/g, '\n').slice(0, HOUSE_RULE_TEXT_MAX) : '';
  const createdAt = typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) && r.createdAt > 0
    ? Math.floor(r.createdAt) : now;
  const updatedAt = typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) && r.updatedAt > 0
    ? Math.floor(r.updatedAt) : createdAt;
  return {
    id: r.id,
    name,
    text,
    // A rule with nothing to say cannot be on — the switch would promise the
    // agents are reading something when they are reading nothing.
    enabled: r.enabled === true && text.trim() !== '',
    createdAt,
    updatedAt
  };
}

/** Validate a whole list: drops junk and duplicate ids, keeps order, caps length. */
export function sanitizeHouseRules(raw: unknown, now: number): HouseRule[] {
  if (!Array.isArray(raw)) return [];
  const out: HouseRule[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const rule = sanitizeHouseRule(item, now);
    if (!rule || seen.has(rule.id)) continue;
    seen.add(rule.id);
    out.push(rule);
    if (out.length >= HOUSE_RULES_MAX) break;
  }
  return out;
}

/**
 * The block every agent reads, or null when no rule is on.
 *
 * Rules are listed oldest first — the order the operator wrote them — each under
 * its own heading, so an agent can cite "House style" back to the operator.
 * Past HOUSE_RULES_INJECT_MAX the remaining rules are NAMED as omitted: an agent
 * told a rule exists can ask about it; one that silently never saw it cannot.
 */
export function houseRulesBlock(rules: readonly HouseRule[]): string | null {
  const live = rules
    .filter((r) => r.enabled && r.text.trim())
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (!live.length) return null;
  const head = 'Context rules from the operator. Every agent on this floor reads these before it starts work. '
    + 'Follow them in everything you do unless the operator tells you otherwise directly.';
  const parts: string[] = [];
  const omitted: string[] = [];
  let size = head.length;
  for (const r of live) {
    const title = r.name.trim() || 'Untitled rule';
    const section = `## ${title}\n${r.text.trim()}`;
    if (size + section.length + 2 > HOUSE_RULES_INJECT_MAX) { omitted.push(title); continue; }
    parts.push(section);
    size += section.length + 2;
  }
  if (omitted.length) {
    parts.push(`(Omitted for length: ${omitted.join(', ')}. Ask the operator if you need them.)`);
  }
  return `<context-rules>\n${head}\n\n${parts.join('\n\n')}\n</context-rules>`;
}

/**
 * Fold the rules into an agent's standing-goal briefing (what HookServer
 * delivers at SessionStart and whenever the text changes). Either half may be
 * absent; null means "nothing to deliver", which is also how the hook server
 * learns a previously delivered briefing was withdrawn.
 */
export function withHouseRules(goal: string | null, rules: readonly HouseRule[]): string | null {
  const block = houseRulesBlock(rules);
  const g = goal?.trim() ? goal.trim() : null;
  if (!block) return g;
  return g ? `${g}\n\n${block}` : block;
}

/**
 * The `<goal>` preamble the renderer types ahead of a queued message for an
 * engine that has no hook channel: the standing goal and the house rules,
 * composed exactly as the hook server composes them (`withHouseRules`), so a
 * Cursor agent reads the same briefing a Claude agent does.
 *
 * With no rules on, the output is byte-for-byte what it was before rules
 * existed: the trimmed goal in a `<goal>` block, or the text untouched. Text
 * that already carries a `<goal>` block is never wrapped twice.
 *
 * Like the goal, the rules ride on every delivery rather than once per
 * session: without hooks there is no session start or compaction to key a
 * one-time delivery on, and a briefing the agent has lost is worse than one it
 * reads again.
 */
export function prependStandingGoal(goal: string | null | undefined, rules: readonly HouseRule[], text: string): string {
  const briefing = withHouseRules(typeof goal === 'string' ? goal : null, rules);
  if (!briefing || text.includes('<goal>')) return text;
  return `<goal>\n${briefing}\n</goal>\n\n${text}`;
}
