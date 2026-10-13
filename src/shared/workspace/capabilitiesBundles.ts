/**
 * The eleven role bundles — a job description an agent gets in one click.
 *
 * DATA ONLY, and only references to things that exist:
 *   - built-in skills are folders in resources/skills (every agent already has
 *     them; listing one says "this job uses it");
 *   - catalog skills are rows of the public catalog main/skills.ts parses
 *     (abubakarsiddik31/claude-skills-collection), named `owner` + `name` exactly
 *     as that parser reports them, and resolved to an installable folder at
 *     grant time — a row the catalog drops shows up as "not in the catalog";
 *   - MCP servers are MCP_CATALOG ids;
 *   - connections are INTEGRATION_TEMPLATES `idSuggestion`s, matched to the
 *     user's registered records when the bundle is granted.
 * test/ws-capabilities-bundles.test.cjs pins every reference to its source.
 *
 * `gaps` names what a bundle's one-line description promises but the app has no
 * piece for yet (Gmail and Calendar are OAuth, which the broker does not do; no
 * analytics, accounting or e-signature template exists). The UI shows them on
 * the bundle card instead of quietly granting less than it says.
 *
 * Names and descriptions are i18n keys (`wsCapabilities.bundles.<id>.name` /
 * `.summary`); `role` is the English job string written to the hive registry,
 * which the agents themselves read.
 */
import type { RoleBundle } from './capabilities';

const builtin = (id: string) => ({ kind: 'builtin' as const, id });
const catalog = (owner: string, name: string) => ({ kind: 'catalog' as const, owner, name });

export const ROLE_BUNDLES: readonly RoleBundle[] = [
  {
    id: 'software-engineer',
    role: 'Software Engineer',
    // "Code, git, GitHub, docs, a database, an audit skill"
    skills: [builtin('md-audit'), catalog('obra', 'systematic-debugging'), catalog('obra', 'test-driven-development'), catalog('mattpocock', 'code-review')],
    mcp: ['filesystem', 'git', 'github-token', 'context7', 'db'],
    connections: ['github'],
    gaps: []
  },
  {
    id: 'designer',
    role: 'Designer',
    // "References, docs, files in the workspace"
    skills: [builtin('md-fetch-summarize'), catalog('anthropics', 'frontend-design'), catalog('anthropics', 'canvas-design'), catalog('anthropics', 'brand-guidelines')],
    mcp: ['filesystem', 'fetch', 'context7'],
    connections: [],
    gaps: ['figma']
  },
  {
    id: 'product-manager',
    role: 'Product Manager',
    // "Issues, mail and calendar, web search"
    skills: [catalog('digidai', 'product-manager-skills'), catalog('mattpocock', 'to-tickets')],
    mcp: ['github-token', 'email-calendar', 'search-with-key'],
    connections: ['linear', 'jira'],
    gaps: ['oauthMail']
  },
  {
    id: 'community-manager',
    role: 'Community Manager',
    // "The web, mail and GitHub"
    skills: [builtin('md-fetch-summarize'), catalog('coreyhaines31', 'social-content'), catalog('coreyhaines31', 'copywriting')],
    mcp: ['fetch', 'search-with-key', 'email-calendar', 'github-token'],
    connections: ['github'],
    gaps: ['social']
  },
  {
    id: 'cold-outreach',
    role: 'Cold Outreach',
    // "Finds people and writes to them"
    skills: [catalog('coreyhaines31', 'cold-email'), catalog('coreyhaines31', 'email-sequence')],
    mcp: ['search-with-key', 'fetch', 'email-calendar'],
    connections: ['hubspot'],
    gaps: ['peopleSearch']
  },
  {
    id: 'frontend',
    role: 'Frontend Engineer',
    skills: [catalog('anthropics', 'frontend-design'), catalog('anthropics', 'webapp-testing'), catalog('vercel-labs', 'web-design-guidelines')],
    mcp: ['filesystem', 'git', 'context7', 'fetch'],
    connections: ['github'],
    gaps: []
  },
  {
    id: 'growth',
    role: 'Growth',
    skills: [
      catalog('coreyhaines31', 'page-cro'), catalog('coreyhaines31', 'ab-test-setup'),
      catalog('coreyhaines31', 'analytics-tracking'), catalog('coreyhaines31', 'seo-audit')
    ],
    mcp: ['fetch', 'search-with-key'],
    connections: [],
    gaps: ['analytics']
  },
  {
    id: 'demand-gen',
    role: 'Demand Generation',
    skills: [
      catalog('coreyhaines31', 'content-strategy'), catalog('coreyhaines31', 'lead-magnets'),
      catalog('coreyhaines31', 'ad-creative'), catalog('coreyhaines31', 'email-sequence')
    ],
    mcp: ['fetch', 'search-with-key', 'email-calendar'],
    connections: ['hubspot'],
    gaps: ['adPlatforms']
  },
  {
    id: 'cfo',
    role: 'CFO',
    skills: [catalog('anthropics', 'xlsx'), catalog('coreyhaines31', 'pricing-strategy'), catalog('coffeefuelbump', 'csv-data-summarizer')],
    mcp: ['db', 'fetch', 'time'],
    connections: ['stripe'],
    gaps: ['accounting']
  },
  {
    id: 'legal',
    role: 'Legal',
    skills: [catalog('anthropics', 'docx'), catalog('anthropics', 'pdf')],
    mcp: ['filesystem', 'fetch', 'search-with-key'],
    connections: [],
    gaps: ['esign']
  },
  {
    id: 'founders-office',
    role: "Founder's Office",
    skills: [catalog('anthropics', 'internal-comms'), catalog('anthropics', 'pptx'), catalog('obra', 'brainstorming')],
    mcp: ['email-calendar', 'search-with-key', 'fetch', 'sequential-thinking'],
    connections: ['notion', 'linear'],
    gaps: ['oauthMail']
  }
];

/** The five the screen leads with; the rest sit behind "and six more". */
export const FEATURED_BUNDLE_IDS: readonly string[] = [
  'software-engineer', 'designer', 'product-manager', 'community-manager', 'cold-outreach'
];

export function roleBundle(id: string): RoleBundle | undefined {
  return ROLE_BUNDLES.find((b) => b.id === id);
}
