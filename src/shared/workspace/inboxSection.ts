/**
 * Inbox sections — the `section` of an `{ kind: 'inbox' }` Workspace route
 * (owned by the `wsInbox` unit).
 *
 * A route rides IPC (`feat:navigate`) and sits in localStorage, so `section`
 * is a plain string and anything may arrive in it. This is the one parser:
 * known spellings map to a section, an agent section keeps its id, and
 * everything else falls back to Ask me — the section the Inbox is for.
 *
 *   askme                    Ask me (the default)
 *   agent:<id>               one agent's messages to / about you
 *   everyone                 every routed message
 *   outside | webhooks       Outside → Webhooks
 *   slack                    Outside → Slack threads
 *   org                      Outside → other offices (peer org messages)
 *
 * The section's canonical string doubles as its read-state key.
 *
 * Pure and import-free (node:test loads it via test/load-ts.cjs).
 */

export type OutsideTab = 'webhook' | 'slack' | 'org';

export type InboxSection =
  | { kind: 'askme' }
  | { kind: 'agent'; agentId: string }
  | { kind: 'everyone' }
  | { kind: 'outside'; tab: OutsideTab };

export const DEFAULT_INBOX_SECTION: InboxSection = { kind: 'askme' };

/** Same shape the hive accepts for an agent id, plus room for `worker-…` ids. */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function parseInboxSection(section: unknown): InboxSection {
  if (typeof section !== 'string') return DEFAULT_INBOX_SECTION;
  const raw = section.trim();
  if (raw.startsWith('agent:')) {
    const id = raw.slice('agent:'.length);
    return AGENT_ID.test(id) ? { kind: 'agent', agentId: id } : DEFAULT_INBOX_SECTION;
  }
  switch (raw.toLowerCase()) {
    case 'everyone':
    case 'all':
      return { kind: 'everyone' };
    case 'outside':
    case 'webhook':
    case 'webhooks':
    case 'outside:webhook':
      return { kind: 'outside', tab: 'webhook' };
    case 'slack':
    case 'outside:slack':
      return { kind: 'outside', tab: 'slack' };
    case 'org':
    case 'outside:org':
      return { kind: 'outside', tab: 'org' };
    default:
      return DEFAULT_INBOX_SECTION;
  }
}

/** The canonical string for a section (route `section` and read-state key). */
export function formatInboxSection(section: InboxSection): string {
  switch (section.kind) {
    case 'agent': return `agent:${section.agentId}`;
    case 'everyone': return 'everyone';
    case 'outside': return section.tab === 'webhook' ? 'webhooks' : section.tab;
    default: return 'askme';
  }
}

export function sameSection(a: InboxSection, b: InboxSection): boolean {
  return formatInboxSection(a) === formatInboxSection(b);
}

/** Read-state key for one agent's row. */
export function agentSectionKey(agentId: string): string {
  return `agent:${agentId}`;
}

/** Keys main accepts for a read mark: any section's canonical string, or the
 *  baseline. Validated main-side before it reaches disk. */
export function isReadMarkKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length > 140) return false;
  if (key === '*') return true;
  if (key.startsWith('agent:')) return AGENT_ID.test(key.slice('agent:'.length));
  return key === 'everyone' || key === 'webhooks' || key === 'slack' || key === 'org' || key === 'askme';
}
