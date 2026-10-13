/**
 * Fixture data for the screenshot harness — everything the mocked `window.cth`
 * hands the renderer. Plain JSON-serialisable values only: the whole object is
 * stringified into a Playwright init script (see mock-cth.mjs).
 *
 * Shapes mirror src/preload/index.ts (HarnessConfig, HiveRegistry, HiveTask,
 * VoiceMessage, AgentDirectory, TelemetrySnapshot, …) and the renderer store's
 * persisted `Agent` (src/renderer/src/store/store.ts). When a preload type
 * gains a field, add it here; when a NEW `window.cth.features.<unit>.<method>`
 * lands, add its fixture under `features.<unit>` (see README "Adding fixtures").
 */


function joinPath(platform, ...parts) {
  const sep = platform === 'win32' ? '\\' : '/';
  return parts.join(sep);
}

function homeDir(platform) {
  if (platform === 'win32') return 'C:\\Users\\pam';
  if (platform === 'linux') return '/home/pam';
  return '/Users/pam';
}

/**
 * @param {object} opts
 * @param {'classic'|'workspace'} [opts.mode]
 * @param {'light'|'dark'} [opts.theme]
 * @param {string} [opts.platform]  'darwin' | 'linux' | 'win32'
 * @param {string} [opts.version]   package.json version (for `window.cth.version`)
 * @param {boolean} [opts.staplerEnabled]
 */
export function buildFixtures(opts = {}) {
  // Every fixture time is relative to "now", floored to the minute: the UI's
  // relative ages ("12 min ago", "stale · 2h") then read the same on every
  // run, and nothing looks a day old just because the fixture file is.
  const BASE_TS = opts.now ?? Math.floor(Date.now() / 60_000) * 60_000;
  const platform = opts.platform ?? 'darwin';
  const mode = opts.mode ?? 'classic';
  const theme = opts.theme ?? 'light';
  const version = opts.version ?? '0.0.0-harness';
  const home = homeDir(platform);
  const harnessHome = joinPath(platform, home, 'munder-difflin-hive');
  const repo = joinPath(platform, home, 'code', 'dunder-site');
  const iso = (offsetMin) => new Date(BASE_TS + offsetMin * 60_000).toISOString();
  const ts = (offsetMin) => BASE_TS + offsetMin * 60_000;

  // ─── HarnessConfig (src/main/config.ts DEFAULTS + onboarding complete) ────
  const config = {
    onboardingComplete: true,
    audience: 'technical',
    harnessHome,
    recentHives: [harnessHome, joinPath(platform, home, 'code', 'scranton-hive')],
    registeredRepos: [repo],
    autoMode: true,
    orchestratorMaySpawn: false,
    defaultCommand: 'claude',
    defaultModel: 'claude-fable-5',
    godProvider: 'claude',
    godModel: 'claude-opus-5-5',
    mcpDefaults: {},
    semanticMemory: true,
    embeddingModel: 'minilm',
    missions: [],
    opsStandupSeeded: true,
    heartbeatSeeded: true,
    notifications: false,
    strongKeepalive: false,
    autoUpdate: true,
    telemetryEnabled: false,
    slackEnabled: false,
    slackProactivePosting: false,
    freeflowEnabled: true,
    freeflowModel: 'whisper-large-v3-turbo',
    realtimeVoiceEnabled: false,
    realtimeIdleDisconnectMs: 180_000,
    webhookEnabled: false,
    costCapTokens: 5_000_000,
    agentTokenCaps: {},
    autoDeliveryPausedAgents: [],
    circuitBreaker: { enabled: true, hardStop: false, repeatedToolLimit: 6, errorStormLimit: 5, tokenVelocityPerMin: 60_000 },
    knowledgeGraph: { enabled: false },
    terminalTheme: theme,
    tvShowOffices: false,
    officeTheme: 'office',
    uiMode: mode,
    providerBaseUrls: {},
    providerDefaultModels: {},
    contextTrigger: {
      compact: { enabled: true, everyMs: 7_200_000, minContextPct: 60, minContextPctLargeWindow: 40,
        message: 'Keep the current task, recent decisions, open questions, and file paths in play. Drop resolved tangents.' },
      clear: { enabled: false, everyMs: 7_200_000, minContextPct: 90, minContextPctLargeWindow: 80, message: '' }
    },
    webhookTriggers: [],
    orgTrigger: { apiKey: '', enabled: false, mode: 'auto' },
    triggersMigratedV1: true
  };

  // ─── The roster (store `Agent`, persisted shape) ──────────────────────────
  const agents = [
    {
      id: 'god', name: 'Michael', character: 'michael', accent: 'lemon',
      description: 'orchestrator (god) — runs the floor, triages requests, escalates only critical calls to you',
      project: 'hive', tmuxTarget: '', cwd: harnessHome,
      status: 'idle', action: 'running the floor', progress: 2, currentStation: 'desk',
      ptyId: 'pty-god', command: 'claude --model claude-opus-5-5 --permission-mode bypassPermissions',
      provider: 'claude', model: 'claude-opus-5-5', isGod: true
    },
    {
      id: 'dwight', name: 'Dwight', character: 'dwight', accent: 'coral',
      description: 'Assistant (to the) regional manager — backend, infra and the beet-farm CI',
      project: 'dunder-site', tmuxTarget: '', cwd: repo,
      worktreePath: joinPath(platform, repo, '.worktrees', 'agent-dwight'),
      status: 'working', action: 'using Bash', progress: 3, currentStation: 'terminal', carrying: 'Bash',
      ptyId: 'pty-dwight', command: 'claude --model claude-fable-5-1 --permission-mode bypassPermissions',
      provider: 'claude', model: 'claude-fable-5-1',
      note: 'Do not let him near the sales tab.'
    },
    {
      id: 'jim', name: 'Jim', character: 'jim', accent: 'sky',
      description: 'Frontend — React screens, design tokens, the occasional prank',
      project: 'dunder-site', tmuxTarget: '', cwd: repo,
      status: 'working', action: 'using Edit', progress: 5, currentStation: 'shelf', carrying: 'Edit',
      ptyId: 'pty-jim', command: 'codex --model gpt-6-astra --dangerously-bypass-approvals-and-sandbox',
      provider: 'codex', model: 'gpt-6-astra'
    },
    {
      id: 'pam', name: 'Pam', character: 'pam', accent: 'peach',
      description: 'Docs, release notes and the office art',
      project: 'dunder-site', tmuxTarget: '', cwd: repo,
      status: 'idle', action: 'idle', progress: 1, currentStation: 'desk',
      ptyId: 'pty-pam', command: 'gemini --model pro --yolo',
      provider: 'gemini', model: 'pro'
    },
    {
      id: 'angela', name: 'Angela', character: 'angela', accent: 'lilac',
      description: 'QA and accounting — tests, token budgets, cat pictures',
      project: 'dunder-site', tmuxTarget: '', cwd: repo,
      status: 'waiting', action: 'awaiting approval', progress: 2, currentStation: 'desk',
      ptyId: 'pty-angela', command: 'grok --model grok-4.6 --always-approve',
      provider: 'grok', model: 'grok-4.6'
    }
  ];

  /** `<harnessHome>/roster.json` as `rosterReadSync()` returns it. A non-empty
   *  file wins over localStorage (store/rosterSource.ts), so this is what seeds
   *  the zustand store at module load. */
  const rosterSnapshot = {
    version: 1,
    savedAt: iso(-1),
    agents,
    archived: [
      {
        id: 'toby', name: 'Toby', character: 'toby', accent: 'mint',
        description: 'HR — retired after the last compliance sprint',
        project: 'dunder-site', tmuxTarget: '', cwd: repo,
        status: 'idle', action: 'archived', progress: 0,
        command: 'claude --permission-mode bypassPermissions', provider: 'claude', model: 'claude-fable-5',
        archived: true
      }
    ],
    restorable: [],
    queues: {},
    selectedId: 'god'
  };

  const statusFor = { god: 'working', dwight: 'working', jim: 'working', pam: 'idle', angela: 'waiting' };

  // ─── Hive registry + voice directory ──────────────────────────────────────
  const registry = {
    godId: 'god',
    agents: Object.fromEntries(agents.map((a) => [a.id, {
      id: a.id, name: a.name, provider: a.provider,
      role: a.isGod ? 'orchestrator (god)' : a.description,
      capabilities: a.isGod ? ['orchestration'] : ['code'],
      cwd: a.cwd, isGod: !!a.isGod,
      status: statusFor[a.id] ?? 'idle',
      lastSeen: ts(-1),
      sessionId: `sess-${a.id}-7f3a`
    }]))
  };
  registry.agents.toby = {
    id: 'toby', name: 'Toby', provider: 'claude', role: 'HR', capabilities: ['code'], cwd: repo,
    status: 'archived', lastSeen: ts(-60 * 24 * 3), archived: true
  };

  const tokensFor = { god: 184_200, dwight: 612_400, jim: 221_900, pam: 48_300, angela: 97_100 };
  const usdFor = { god: 4.82, dwight: 7.14, jim: 1.96, pam: 0.21, angela: 0.63 };
  const contextFor = {
    god: { tokens: 68_400, limit: 200_000 },
    dwight: { tokens: 121_900, limit: 200_000 },
    jim: { tokens: 54_000, limit: 200_000 },
    pam: { tokens: 12_300, limit: 200_000 },
    angela: { tokens: 31_700, limit: 200_000 }
  };
  const lastToolFor = { god: 'TodoWrite', dwight: 'Bash', jim: 'Edit', pam: null, angela: 'Read' };

  const directory = {
    godId: 'god',
    agents: agents.map((a) => ({
      id: a.id, name: a.name, role: registry.agents[a.id].role, provider: a.provider,
      model: a.model ?? null, status: statusFor[a.id] ?? 'idle', cwd: a.cwd, cwdValid: true,
      archived: false, isGod: !!a.isGod, isAssistant: false, sessionId: `sess-${a.id}-7f3a`,
      hasMemory: a.id !== 'pam', inboxBacklog: a.id === 'god' ? 2 : 0, breaker: 'healthy',
      tokens: tokensFor[a.id], usd: usdFor[a.id], lastTool: lastToolFor[a.id],
      lastActiveSecAgo: a.id === 'pam' ? 840 : 12,
      contextTokens: contextFor[a.id].tokens, contextLimit: contextFor[a.id].limit,
      contextPct: Math.round((contextFor[a.id].tokens / contextFor[a.id].limit) * 100)
    }))
  };

  // ─── Live PTYs (every agent's terminal is "alive") ────────────────────────
  const ptys = agents.map((a, i) => ({
    id: a.ptyId, cwd: a.cwd, command: a.command.split(' ')[0], pid: 41_000 + i,
    // lastOutputAt is stamped at call time in the mock; quietMs is how long ago.
    quietMs: a.id === 'pam' ? 840_000 : 1_500,
    hasOutput: true
  }));

  // ─── Task ledger (hive/tasks.json) ────────────────────────────────────────
  const tasks = {
    tasks: [
      { id: 't-101', title: 'Ship the Workspace sidebar', description: 'Collapsible rail, resize handle, keyboard nav. Mirror the classic strip’s ordering.',
        assignee: 'jim', status: 'doing', dependsOn: [], priority: 1, createdAt: iso(-180) },
      { id: 't-102', title: 'Wire feat:stapler:getState to main', description: 'The titlebar toggle must render what main settled on, never the request.',
        assignee: 'dwight', status: 'doing', dependsOn: [], priority: 2, createdAt: iso(-150) },
      { id: 't-103', title: 'Release notes for 0.4.7', description: 'Workspace mode, the Stapler, dictation. Keep the drop template.',
        assignee: 'pam', status: 'todo', dependsOn: ['t-101'], priority: 3, createdAt: iso(-120) },
      { id: 't-104', title: 'Token budget report per agent, per day', description: 'Roll the OTel usage samples into a daily table for Settings → Budget.',
        assignee: 'angela', status: 'blocked', dependsOn: [], priority: 2, createdAt: iso(-100),
        humanQA: [{ q: 'Should the daily report count cache-read tokens as spend, or only input + output?', askedAt: iso(-20) }] },
      { id: 't-105', title: 'Fix the beet-farm CI flake', description: 'Intermittent ETIMEDOUT in the e2e job.',
        assignee: 'dwight', status: 'done', dependsOn: [], priority: 2, createdAt: iso(-600),
        result: 'Pinned Node 22.12 and bumped the job timeout; green across 20 consecutive runs.' },
      { id: 't-106', title: 'Migrate hire manifests to v2', assignee: undefined, status: 'todo', dependsOn: ['t-101'], priority: 4, createdAt: iso(-90) },
      { id: 't-107', title: 'Dark-theme pass on the office floor', assignee: 'jim', status: 'done', dependsOn: [], priority: 3, createdAt: iso(-700),
        result: 'Tokens swapped under data-cth-theme=dark; monitors and envelopes re-tinted.' }
    ]
  };

  // ─── Hive mail ────────────────────────────────────────────────────────────
  const mail = [
    { id: 'm-1', conversation: 'c-sidebar', in_reply_to: null, from: 'god', to: 'jim', act: 'request',
      subject: 'Sidebar: ship the collapsible rail', body: 'Take t-101. Keep the classic strip ordering; the resize handle must be keyboard-operable.',
      hops: 0, requires_reply: true, needs_human: false, created_at: iso(-170) },
    { id: 'm-2', conversation: 'c-sidebar', in_reply_to: 'm-1', from: 'jim', to: 'god', act: 'agree',
      subject: 'Re: Sidebar', body: 'On it. Rail + handle landed locally; writing the keyboard tests now.',
      hops: 1, requires_reply: false, needs_human: false, created_at: iso(-140) },
    { id: 'm-3', conversation: 'c-stapler', in_reply_to: null, from: 'god', to: 'dwight', act: 'request',
      subject: 'Stapler state over IPC', body: 'Take t-102. The toggle renders what main settled on, never the request.',
      hops: 0, requires_reply: true, needs_human: false, created_at: iso(-130) },
    { id: 'm-4', conversation: 'c-budget', in_reply_to: null, from: 'angela', to: 'god', act: 'query',
      subject: 'Budget report: count cache reads?', body: 'Blocked on t-104 — do cache-read tokens count as spend in the daily table?',
      hops: 0, requires_reply: true, needs_human: true, created_at: iso(-25) },
    { id: 'm-5', conversation: 'c-ci', in_reply_to: null, from: 'dwight', to: 'god', act: 'done',
      subject: 't-105 done: CI flake fixed', body: 'Pinned Node 22.12, bumped the job timeout. 20/20 green.',
      hops: 0, requires_reply: false, needs_human: false, created_at: iso(-15) }
  ];

  /** hive:inbox per agent. Left EMPTY on purpose: a non-empty inbox makes
   *  useHive queue an "inbox nudge" into the agent's message queue, which is
   *  persisted and shows up as a queued card. Override per screenshot if you
   *  want that state. */
  const inbox = {};

  /** hive:messages (the redacted voice read-layer). */
  const messages = mail.map((m) => ({
    id: m.id, conversation: m.conversation, from: m.from, to: m.to, act: m.act,
    subject: m.subject, body: m.body, requires_reply: m.requires_reply,
    direction: m.from === 'god' ? 'outbox' : 'inbox', owner: 'god', archived: false, created_at: m.created_at
  }));

  /** hive:log — log.jsonl rows (kind:'message' rows feed the memory graph). */
  const log = [
    { ts: ts(-240), kind: 'spawn', agentId: 'god', name: 'Michael' },
    { ts: ts(-200), kind: 'spawn', agentId: 'dwight', name: 'Dwight' },
    { ts: ts(-195), kind: 'spawn', agentId: 'jim', name: 'Jim' },
    ...mail.map((m) => ({ ts: Date.parse(m.created_at), kind: 'message', id: m.id, from: m.from, to: m.to, act: m.act, subject: m.subject })),
    { ts: ts(-10), kind: 'task', id: 't-105', status: 'done', by: 'dwight' }
  ];

  const board = [
    '# Board',
    '',
    '## Now',
    '- t-101 Ship the Workspace sidebar — Jim (doing)',
    '- t-102 Wire feat:stapler:getState to main — Dwight (doing)',
    '',
    '## Blocked',
    '- t-104 Token budget report — Angela (needs a human answer)',
    '',
    '## Done today',
    '- t-105 Beet-farm CI flake — Dwight',
    ''
  ].join('\n');

  const memory = {
    god: '# Michael — memory\n\n## Standing decisions\n- Workspace ships behind `uiMode`; Classic stays the default.\n- Jim owns the sidebar, Dwight owns the Stapler IPC.\n\n## Open\n- Angela’s budget question (t-104) is waiting on the human.\n',
    dwight: '# Dwight — memory\n\n- CI flake root cause: Node 22.11 DNS timeout under load. Pinned 22.12.\n- The Stapler toggle renders main’s settled state (never the request).\n',
    jim: '# Jim — memory\n\n- Sidebar min 200px, max 560px, default 248px (workspace/store.ts).\n- Resize handle: pointer capture, Home resets.\n',
    angela: '# Angela — memory\n\n- Token meter excludes cache reads (breaker.ts #189). Report may differ — asked.\n'
  };

  // ─── Telemetry (OTel seam) ────────────────────────────────────────────────
  const telemetry = {
    usage: agents.map((a) => ({
      agentId: a.id, sessionId: `sess-${a.id}-7f3a`, ts: ts(-2),
      input: Math.round(tokensFor[a.id] * 0.55), output: Math.round(tokensFor[a.id] * 0.15),
      cacheRead: Math.round(tokensFor[a.id] * 0.25), cacheCreation: Math.round(tokensFor[a.id] * 0.05),
      model: a.model ?? 'unknown', usd: usdFor[a.id]
    })),
    spans: {
      dwight: [
        { agentId: 'dwight', sessionId: 'sess-dwight-7f3a', ts: ts(-6), tool: 'Read', success: true, durationMs: 140 },
        { agentId: 'dwight', sessionId: 'sess-dwight-7f3a', ts: ts(-5), tool: 'Edit', success: true, durationMs: 310 },
        { agentId: 'dwight', sessionId: 'sess-dwight-7f3a', ts: ts(-3), tool: 'Bash', success: true, durationMs: 8_200 },
        { agentId: 'dwight', sessionId: 'sess-dwight-7f3a', ts: ts(-1), tool: 'Bash', success: false, durationMs: 1_900, error: 'exit 1' }
      ],
      jim: [
        { agentId: 'jim', sessionId: 'sess-jim-7f3a', ts: ts(-4), tool: 'Grep', success: true, durationMs: 90 },
        { agentId: 'jim', sessionId: 'sess-jim-7f3a', ts: ts(-2), tool: 'Edit', success: true, durationMs: 420 }
      ],
      god: [
        { agentId: 'god', sessionId: 'sess-god-7f3a', ts: ts(-8), tool: 'Read', success: true, durationMs: 120 },
        { agentId: 'god', sessionId: 'sess-god-7f3a', ts: ts(-7), tool: 'TodoWrite', success: true, durationMs: 60 }
      ]
    }
  };

  const control = Object.fromEntries(agents.map((a) => [a.id, {
    paused: false, halted: false, autoDeliveryPaused: false, gatedTools: [], pendingSteers: 0
  }]));

  // ─── Scheduler, tools, memory, knowledge, git, history ────────────────────
  const missions = [
    { id: 'ops-standup', label: 'Hourly ops standup', intervalMs: 3_600_000, to: 'god', enabled: true, lastFiredAt: ts(-37),
      body: 'Hourly ops standup. Review every agent and the task board; flag stale agents and at-risk tasks.' },
    { id: 'heartbeat', label: 'Floor heartbeat', intervalMs: 120_000, to: 'god', enabled: false, kind: 'heartbeat', quietThresholdMs: 300_000,
      body: 'Floor heartbeat: the team has gone quiet. Re-engage anyone stalled.' },
    { id: 'compact-maintenance', label: 'Auto-compact (maintenance)', intervalMs: 7_200_000, to: '', body: '', enabled: false, autoCompact: true, kind: 'compact' }
  ];

  const toolRow = (id, label, kind, found, extra = {}) => ({
    id, bin: id, label, kind,
    why: extra.why ?? `${label} is used by the harness.`,
    essential: extra.essential ?? false,
    install: { posix: extra.posix ?? `brew install ${id}`, win32: extra.win32 ?? `winget install ${id}` },
    found, path: found ? joinPath(platform, home, '.local', 'bin', id) : null,
    installCommand: platform === 'win32' ? (extra.win32 ?? `winget install ${id}`) : (extra.posix ?? `brew install ${id}`),
    detail: extra.detail
  });
  const tools = [
    toolRow('uv', 'uv', 'prerequisite', true, { essential: true, why: 'Installs and runs mempalace.', posix: 'curl -LsSf https://astral.sh/uv/install.sh | sh' }),
    toolRow('mempalace', 'MemPalace', 'memory', true, { essential: true, why: 'Semantic memory across agents.', posix: 'uv tool install mempalace', detail: 'palace initialised' }),
    toolRow('git', 'git', 'prerequisite', true, { essential: true, why: 'Worktrees and the IDE git views.' }),
    toolRow('node', 'Node.js', 'prerequisite', true, { essential: true, why: 'Runs the hook shims.', detail: 'v22.12.0' }),
    toolRow('claude', 'Claude Code', 'engine', true, { posix: 'npm i -g @anthropic-ai/claude-code', win32: 'npm i -g @anthropic-ai/claude-code' }),
    toolRow('codex', 'Codex CLI', 'engine', true, { posix: 'npm i -g @openai/codex', win32: 'npm i -g @openai/codex' }),
    toolRow('gemini', 'Gemini CLI', 'engine', true, { posix: 'npm i -g @google/gemini-cli', win32: 'npm i -g @google/gemini-cli' }),
    toolRow('grok', 'Grok CLI', 'engine', false, { posix: 'npm i -g @vibe-kit/grok-cli', win32: 'npm i -g @vibe-kit/grok-cli' })
  ];

  const memoryStatus = {
    available: true, enabled: true, active: true, initialized: true,
    palacePath: joinPath(platform, harnessHome, 'palace'), model: 'minilm',
    bin: joinPath(platform, home, '.local', 'bin', 'mempalace')
  };

  const kg = { enabled: false, root: joinPath(platform, harnessHome, 'knowledge'), docCount: 0, chunkCount: 0, byModality: {} };

  const git = {
    branch: { current: 'main', detached: false },
    status: {
      staged: [{ path: 'src/renderer/src/workspace/sidebar/Sidebar.tsx', index: 'M', worktree: ' ' }],
      unstaged: [
        { path: 'src/renderer/src/workspace/Workspace.tsx', index: ' ', worktree: 'M' },
        { path: 'src/renderer/src/workspace/workspace.css', index: ' ', worktree: 'M' }
      ],
      untracked: ['tools/screenshot-harness/']
    },
    log: [
      { sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', shortSha: 'a1b2c3d', parents: ['b2c3d4e5f60718293a4b5c6d7e8f901234567890'], subject: 'workspace: collapsible sidebar rail', author: 'Jim', time: ts(-40), refs: ['HEAD -> main'] },
      { sha: 'b2c3d4e5f60718293a4b5c6d7e8f901234567890', shortSha: 'b2c3d4e', parents: ['c3d4e5f60718293a4b5c6d7e8f90123456789012'], subject: 'ci: pin node 22.12 (fixes the e2e flake)', author: 'Dwight', time: ts(-300), refs: ['origin/main'] },
      { sha: 'c3d4e5f60718293a4b5c6d7e8f90123456789012', shortSha: 'c3d4e5f', parents: ['d4e5f60718293a4b5c6d7e8f9012345678901234'], subject: 'stapler: state contract + titlebar toggle', author: 'Dwight', time: ts(-900), refs: [] },
      { sha: 'd4e5f60718293a4b5c6d7e8f9012345678901234', shortSha: 'd4e5f60', parents: ['e5f60718293a4b5c6d7e8f901234567890123456'], subject: 'docs: release notes scaffold for 0.4.7', author: 'Pam', time: ts(-1400), refs: ['v0.4.6'] },
      { sha: 'e5f60718293a4b5c6d7e8f901234567890123456', shortSha: 'e5f6071', parents: [], subject: 'office: dark-theme pass on the floor', author: 'Jim', time: ts(-2000), refs: [] }
    ],
    branches: { local: ['main', 'agent/dwight', 'agent/jim'], remote: ['origin/main'], current: 'main' },
    aheadBehind: { ahead: 1, behind: 0, upstream: 'origin/main' }
  };

  const history = [
    { id: 3, agentId: 'god', cwd: harnessHome, text: 'Status check: who is on what, and is t-104 still blocked?', ts: ts(-30) },
    { id: 2, agentId: 'jim', cwd: repo, text: 'Make the sidebar resize handle keyboard-operable (Home resets).', ts: ts(-120) },
    { id: 1, agentId: 'dwight', cwd: repo, text: 'Why does the e2e job time out on Node 22.11 only?', ts: ts(-400) }
  ];

  // ─── Feature layer ────────────────────────────────────────────────────────
  const stapler = {
    enabled: !!opts.staplerEnabled,
    invisible: false,
    recording: null,
    hiddenFromCapture: false,
    canHide: platform !== 'linux',
    meetingShortcut: { accelerator: platform === 'darwin' ? 'Shift+Command+Space' : 'Shift+Ctrl+Space', registered: true },
    meeting: null,
    pendingAttachments: 0,
    meetingsDir: joinPath(platform, home, 'Documents', 'Munder Difflin', 'Meetings')
  };

  /** RosterEntry[] (src/shared/features/roster.ts) — what feature windows read. */
  const wsStatusFor = { god: 'working', dwight: 'working', jim: 'working', pam: 'idle', angela: 'waiting' };
  const roster = agents.map((a) => ({
    id: a.id, name: a.name, isGod: !!a.isGod, model: a.model, provider: a.provider,
    project: a.isGod ? 'munder-difflin-hive' : 'dunder-site', status: wsStatusFor[a.id] ?? 'idle'
  }));

  /** Per-unit STATIC fixtures for `window.cth.features.<unit>.<method>`.
   *
   *  A method listed here (and not implemented explicitly in mock-cth.mjs)
   *  resolves to a fresh clone of its value, whatever arguments it gets. A
   *  method on no list falls through to the Proxy default (see mock-cth.mjs).
   *  To mock a NEW feature method, add `<unit>: { <method>: <value> }` here;
   *  for a subscription, add an `events` entry with
   *  `channel: 'features.<unit>.on<Thing>'`. */
  const dictatePlatform = platform === 'darwin' || platform === 'win32' || platform === 'linux' ? platform : 'other';
  const shortcut = (accelerator) => ({ accelerator, registered: true });
  const memoryAnswer = {
    tickets: [
      { kind: 'ticket', id: 't-104', title: 'Token budget report per agent, per day', status: 'blocked',
        agentIds: ['angela'], at: iso(-20), score: 0.92, mentioned: false,
        snippet: { text: 'Roll the OTel usage samples into a daily table for Settings → Budget.', marks: [[9, 18]] } },
      { kind: 'ticket', id: 't-105', title: 'Fix the beet-farm CI flake', status: 'done',
        agentIds: ['dwight'], at: iso(-15), score: 0.61, mentioned: true }
    ],
    agents: [
      { kind: 'agent', id: 'angela', direct: false, tickets: 1, notes: 1, score: 0.88 },
      { kind: 'agent', id: 'dwight', direct: false, tickets: 1, notes: 1, score: 0.55 }
    ],
    notes: [
      { kind: 'note', key: 'memory:angela:0', source: 'memory', title: 'Token meter excludes cache reads', authorId: 'angela',
        at: iso(-30), path: joinPath(platform, harnessHome, 'hive', 'agents', 'angela', 'memory.md'),
        ref: { kind: 'memory', agentId: 'angela', section: 0 }, ticketRefs: ['t-104'], score: 0.9,
        snippet: { text: 'Token meter excludes cache reads (breaker.ts #189). Report may differ — asked.', marks: [[0, 11]] } },
      { kind: 'note', key: 'memory:dwight:0', source: 'memory', title: 'CI flake root cause', authorId: 'dwight',
        at: iso(-300), path: joinPath(platform, harnessHome, 'hive', 'agents', 'dwight', 'memory.md'),
        ref: { kind: 'memory', agentId: 'dwight', section: 0 }, ticketRefs: ['t-105'], score: 0.5,
        snippet: { text: 'Node 22.11 DNS timeout under load. Pinned 22.12.', marks: [[0, 10]] } }
    ],
    people: [
      { id: 'god', name: 'Michael', role: 'orchestrator (god)', isGod: true },
      { id: 'angela', name: 'Angela', role: 'QA and accounting' },
      { id: 'dwight', name: 'Dwight', role: 'backend and infra' }
    ],
    totals: { tickets: 2, agents: 2, notes: 2 }
  };
  const transcribeSettings = { engine: 'local', customVocabulary: ['Munder Difflin', 'Scranton'], micDeviceId: '', systemDeviceId: '' };
  const features = {
    stapler: {
      getEnv: { platform, screenPermission: 'granted', sessionType: platform === 'linux' ? 'x11' : null },
      getTarget: { kind: 'orchestrator' },
      getDraft: { attachments: [] },
      puckReady: { commands: [], layout: { mode: 'puck', width: 72, height: 72 }, draft: { attachments: [] }, target: { kind: 'orchestrator' }, clickThrough: false },
      overlayInit: { ok: true, image: undefined, width: 1440, height: 900, remembered: null, shotCount: 0 },
      meetingList: [
        { id: '2026-10-12 0900 standup', title: 'Monday standup', description: 'Sidebar, Stapler IPC, budget report.',
          startedAt: iso(-30), durationMs: 14 * 60_000 + 12_000, status: 'ready', segmentCount: 42,
          snippet: 'you: Jim, where are we on the sidebar? them: Rail and handle landed, tests today.' },
        { id: '2026-10-09 1600 budget review', title: 'Budget review with Angela', description: '',
          startedAt: iso(-60 * 24 * 3), durationMs: 31 * 60_000, status: 'ready', segmentCount: 88,
          snippet: 'them: Cache reads are 25% of the token volume but almost none of the spend.' }
      ],
      meetingGet: null,
      takeMeetingFocus: null
    },
    transcribe: {
      getSettings: transcribeSettings,
      getStatus: {
        engine: 'local', effectiveEngine: 'local', modelReady: true,
        engines: [
          { id: 'local', available: true },
          { id: 'local-large', available: false, reason: 'model-missing' },
          { id: 'apple', available: platform === 'darwin', ...(platform === 'darwin' ? {} : { reason: 'macos-only' }) },
          { id: 'groq', available: false, reason: 'no-groq-key' }
        ],
        models: [
          { id: 'base', repo: 'onnx-community/whisper-base', sizeBytes: 80_000_000, state: 'bundled' },
          { id: 'large', repo: 'onnx-community/whisper-large-v3-turbo', sizeBytes: 820_000_000, state: 'missing' }
        ],
        groqKey: false, busy: false, platform, systemAudio: platform === 'linux' ? 'monitor' : 'loopback', builtinVocabularyCount: 120
      },
      getVocabulary: { builtin: ['Munder Difflin', 'Michael', 'Dwight', 'worktree', 'hive'] }
    },
    dictate: {
      getState: {
        enabled: true, phase: 'idle', startedAt: null, stopsAt: null, target: null, error: null, last: null,
        shortcut: shortcut(dictatePlatform === 'darwin' ? 'Alt+Space' : 'Control+Alt+Space'),
        cancelShortcut: shortcut('Escape')
      },
      getSettings: {
        enabled: true, accelerator: dictatePlatform === 'darwin' ? 'Alt+Space' : 'Control+Alt+Space',
        cancelAccelerator: 'Escape', pasteMode: 'paste', restoreClipboard: true, maxSeconds: 120
      },
      getStatus: {
        platform: dictatePlatform, linuxSession: dictatePlatform === 'linux' ? 'x11' : null,
        accessibility: dictatePlatform === 'darwin' ? 'granted' : null, microphone: 'granted',
        tools: { xdotool: dictatePlatform === 'linux' ? true : null, wtype: null, powershell: dictatePlatform === 'win32' ? true : null },
        strategy: dictatePlatform === 'darwin' ? 'osascript' : dictatePlatform === 'win32' ? 'sendkeys' : 'in-app',
        globalShortcuts: 'ok'
      }
    },
    sidebar: {
      notesList: {
        ok: true, dir: joinPath(platform, harnessHome, 'notes'), truncated: false,
        notes: [
          { slug: 'release-checklist', title: 'Release checklist', updatedAt: ts(-50), excerpt: 'Bump version, build, notarize, smoke-test the dmg.' },
          { slug: 'sidebar-ideas', title: 'Sidebar ideas', updatedAt: ts(-300), excerpt: 'Projects group agents by repo; notes live under the roster.' }
        ]
      },
      notesSearch: { ok: true, hits: [] },
      floorInfo: { number: 1, count: 1 }
    },
    agents: {
      lastExit: null
    },
    orchestrator: {
      getState: {
        budget: {
          ready: true, noHive: false, today: iso(0).slice(0, 10),
          spendTodayUsd: 14.76, dailyCapUsd: 40, level: 'ok', fraction: 14.76 / 40, remainingUsd: 40 - 14.76,
          history: [6.2, 11.9, 3.4, 0, 18.3, 22.1, 14.76].map((usd, i) => ({ day: new Date(BASE_TS - (6 - i) * 86_400_000).toISOString().slice(0, 10), usd })),
          byAgent: Object.entries(usdFor).sort((a, b) => b[1] - a[1]).map(([agentId, usd]) => ({ agentId, usd })),
          defaultAgentTokenCap: null, lastTrip: null
        },
        delivery: { paused: false, reason: null, since: null }
      },
      routingLog: {
        ok: true, truncated: false,
        entries: [
          ...mail.map((m) => ({
            key: `message:${m.id}:${Date.parse(m.created_at)}`, ts: Date.parse(m.created_at), kind: 'message', id: m.id,
            from: m.from, to: m.to, act: m.act, subject: m.subject, delivered: [m.to], reason: null
          })),
          { key: `drop:m-0:${ts(-200)}`, ts: ts(-200), kind: 'drop', id: 'm-0', from: 'jim', to: 'creed', act: 'query',
            subject: 'Who owns the fax machine?', delivered: [], reason: 'no-inbox' }
        ].sort((a, b) => b.ts - a.ts)
      }
    },
    tasks: {
      activity: {
        ok: true, ledgerId: 'h-3f9a2c', folderKey: 'MUN', observedAt: ts(0),
        activity: Object.fromEntries(tasks.tasks.map((t, i) => [t.id, { changedAt: ts(-5 - i * 7), statusSince: ts(-20 - i * 11) }]))
      }
    },
    inbox: {
      messages: {
        hive: true, hiveId: harnessHome, total: mail.length, truncated: false,
        messages: [...mail].reverse().map((m) => ({
          id: m.id, conversation: m.conversation, inReplyTo: m.in_reply_to, from: m.from, to: m.to, act: m.act,
          subject: m.subject, body: m.body, requiresReply: m.requires_reply, needsHuman: m.needs_human, createdAt: m.created_at
        }))
      },
      readMarks: { hiveId: harnessHome, marks: {} }
    },
    automations: {
      listRules: [
        { id: 'cr-mgx1k2-a1b2c3', name: 'Tests before done', text: 'Never mark a card done until the relevant test suite passes locally. Paste the command you ran.', enabled: true, createdAt: ts(-5000), updatedAt: ts(-900) },
        { id: 'cr-mgx1k3-d4e5f6', name: 'No force-push', text: 'Do not force-push to main or to another agent’s branch.', enabled: true, createdAt: ts(-4000), updatedAt: ts(-4000) },
        { id: 'cr-mgx1k4-0a9b8c', name: 'Quiet hours', text: 'Between 22:00 and 07:00 do not message the human; queue questions on the card instead.', enabled: false, createdAt: ts(-3000), updatedAt: ts(-3000) }
      ]
    },
    memory: {
      stats: { ok: true, state: 'ok', topics: 48, tickets: tasks.tasks.length, agentsWithMemory: 4, entries: 19, notes: 2, documents: 0 },
      // `search` / `meaning` are implemented in mock-cth.mjs (they echo the
      // query) and return the top-level `memoryAnswer` below.
      readNote: { ok: true, title: 'Token meter excludes cache reads', text: memory.angela }
    },
    capabilities: {
      // `state(agentIds)` is implemented in mock-cth.mjs on top of this.
      temps: {
        version: 1, maxConcurrent: 3, running: 1, hive: true,
        active: [
          { id: 'tmp-1', workerId: 'worker-tmp-1', job: 'Triage the 14 open GitHub issues and label them', provider: 'claude', model: 'claude-fable-5',
            cwd: repo, isolate: true, state: 'running', createdAt: ts(-9), submittedAt: ts(-9), startedAt: ts(-8), baseBranch: 'main' }
        ],
        history: [
          { id: 'tmp-0', job: 'Bump electron-builder and re-run the mac build', provider: 'claude', model: 'claude-fable-5', cwd: repo,
            outcome: 'done', createdAt: ts(-200), startedAt: ts(-199), endedAt: ts(-170), durationMs: 29 * 60_000, tokens: 182_000 }
        ]
      }
    }
  };

  /** features.capabilities.state(agentIds) — CapabilitiesState. */
  const capabilitiesState = {
    hive: true,
    grants: {
      dwight: { skills: ['docx'], mcp: ['github-token', 'git'], connections: [], bundle: 'software-engineer', role: 'Software Engineer', updatedAt: ts(-300) },
      jim: { skills: [], mcp: ['context7'], connections: [], updatedAt: ts(-400) }
    },
    builtinSkills: ['hive-protocol', 'handoff'],
    machineSkills: ['docx', 'pdf'],
    agentSkills: {},
    mcpKeys: { 'github-token': true },
    appliedAt: { dwight: ts(-300) },
    installing: {},
    skillErrors: {}
  };

  /** window.cth.skillsCatalog() / skillsLocal(). */
  const skillsCatalog = [
    { name: 'docx', description: 'Create, edit and review Word documents.', url: 'https://github.com/anthropics/skills/tree/main/docx', category: 'Documents', owner: 'anthropics' },
    { name: 'pdf', description: 'Read, fill and merge PDFs.', url: 'https://github.com/anthropics/skills/tree/main/pdf', category: 'Documents', owner: 'anthropics' },
    { name: 'webapp-testing', description: 'Drive a local web app with Playwright and report what broke.', url: 'https://github.com/anthropics/skills/tree/main/webapp-testing', category: 'Development', owner: 'anthropics' },
    { name: 'stripe-best-practices', description: 'Integrate Stripe the way Stripe recommends.', url: 'https://github.com/stripe/ai/tree/main/skills/stripe-best-practices', category: 'Payments', owner: 'stripe' }
  ];
  const skillsLocal = [
    { id: 'claude:user:docx', name: 'docx', description: 'Create, edit and review Word documents.', provider: 'claude', scope: 'user', path: joinPath(platform, home, '.claude', 'skills', 'docx') },
    { id: 'claude:user:pdf', name: 'pdf', description: 'Read, fill and merge PDFs.', provider: 'claude', scope: 'user', path: joinPath(platform, home, '.claude', 'skills', 'pdf') }
  ];

  /** features.agents.conversation(agentId) — ConversationSources per agent. */
  const conversations = {
    god: {
      sends: [{ id: 's-1', ts: ts(-32), text: 'Status check: who is on what, and is t-104 still blocked?', mode: 'send' }],
      transcript: [
        { kind: 'prompt', ts: ts(-32), id: 'tr-god-1', text: 'Status check: who is on what, and is t-104 still blocked?' },
        { kind: 'tool', ts: ts(-31), id: 'tr-god-2', text: 'hive/tasks.json', tool: 'Read', toolUseId: 'tu-1' },
        { kind: 'result', ts: ts(-31), id: 'tr-god-3', text: 'read 7 cards', tool: 'Read', toolUseId: 'tu-1' },
        { kind: 'reply', ts: ts(-30), id: 'tr-god-4', text: 'Jim is on the sidebar (t-101), Dwight on the Stapler IPC (t-102). t-104 is still blocked on your answer about cache-read tokens.' }
      ],
      hive: mail.filter((m) => m.from === 'god' || m.to === 'god').map((m) => ({
        id: m.id, from: m.from, to: m.to, act: m.act, subject: m.subject, body: m.body, ts: Date.parse(m.created_at),
        direction: m.to === 'god' ? 'inbox' : 'outbox', conversation: m.conversation, requiresReply: m.requires_reply
      })),
      asks: [{ taskId: 't-104', taskTitle: 'Token budget report per agent, per day', q: 'Should the daily report count cache-read tokens as spend, or only input + output?', askedAt: ts(-20) }]
    }
  };
  for (const a of agents) {
    if (conversations[a.id]) continue;
    conversations[a.id] = {
      sends: [],
      transcript: a.provider === 'claude' ? [
        { kind: 'prompt', ts: ts(-12), id: `tr-${a.id}-1`, text: 'Pick up your card from the board.' },
        { kind: 'tool', ts: ts(-6), id: `tr-${a.id}-2`, text: 'npm run typecheck:web', tool: 'Bash', toolUseId: `tu-${a.id}` },
        { kind: 'result', ts: ts(-5), id: `tr-${a.id}-3`, text: '0 errors', tool: 'Bash', toolUseId: `tu-${a.id}` },
        { kind: 'reply', ts: ts(-4), id: `tr-${a.id}-4`, text: 'Typecheck is clean. Running the stapler-shared tests next.' }
      ] : [],
      hive: mail.filter((m) => m.from === a.id || m.to === a.id).map((m) => ({
        id: m.id, from: m.from, to: m.to, act: m.act, subject: m.subject, body: m.body, ts: Date.parse(m.created_at),
        direction: m.to === a.id ? 'inbox' : 'outbox', conversation: m.conversation, requiresReply: m.requires_reply
      })),
      asks: [],
      ...(a.provider === 'claude' ? {} : { transcriptMissing: 'engine' })
    };
  }

  /** features.agents.activity(ids) — AgentActivity per agent. */
  const activity = {
    god: { agentId: 'god', lastReply: { text: 'Jim is on the sidebar, Dwight on the Stapler IPC. t-104 waits on you.', ts: ts(-30) },
      lastMail: { subject: 'Pin node in the e2e job too', body: 'Same fix as t-105, for the e2e job.', to: 'dwight', ts: ts(-2) },
      lastTool: { tool: 'TodoWrite', text: '3 items', ts: ts(-7) } },
    dwight: { agentId: 'dwight', lastReply: { text: 'Typecheck is clean. Running the stapler-shared tests next.', ts: ts(-4) },
      lastTool: { tool: 'Bash', text: 'node --test test/stapler-shared.test.cjs', ts: ts(-1) } },
    jim: { agentId: 'jim', lastMail: { subject: 'Re: Sidebar', body: 'Rail + handle landed locally.', to: 'god', ts: ts(-140) },
      lastTool: { tool: 'Edit', text: 'src/renderer/src/workspace/sidebar/Sidebar.tsx', ts: ts(-2) },
      lastResult: { text: '+31 / -4', ts: ts(-2), isError: false } },
    pam: { agentId: 'pam', lastReply: { text: 'Release notes draft saved to docs/drops/0.4.7.md.', ts: ts(-14) } },
    angela: { agentId: 'angela', lastMail: { subject: 'Budget report: count cache reads?', body: 'Blocked on t-104.', to: 'god', ts: ts(-25) },
      lastTool: { tool: 'Read', text: 'src/main/breaker.ts', ts: ts(-8) },
      lastResult: { text: 'read 212 lines', ts: ts(-8), isError: false } }
  };

  // ─── Fake terminal output per PTY (ANSI; delivered via onPtyData) ─────────
  const C = { dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', r: '\x1b[0m', bold: '\x1b[1m' };
  const banner = (name, model) => [
    `${C.bold}${name}${C.r} ${C.dim}· ${model} · ${harnessHome}${C.r}`,
    `${C.dim}screenshot harness — this is a mocked PTY, not a live session${C.r}`,
    ''
  ];
  const ptyOutput = {
    'pty-god': [
      ...banner('Michael', 'claude-opus-5-5'),
      `${C.cyan}●${C.r} Read hive/tasks.json`,
      `  ${C.dim}⎿  read 7 cards${C.r}`,
      `${C.cyan}●${C.r} TodoWrite 3 items`,
      `  ${C.dim}⎿  t-101 doing · t-102 doing · t-104 blocked (asked the human)${C.r}`,
      '',
      'Jim is on the sidebar, Dwight on the Stapler IPC. Angela is waiting on your',
      'answer about cache-read tokens (t-104). Nothing else needs you right now.',
      ''
    ].join('\r\n'),
    'pty-dwight': [
      ...banner('Dwight', 'claude-fable-5-1'),
      `${C.cyan}●${C.r} Bash(npm run typecheck:web)`,
      `  ${C.dim}⎿  > tsc --noEmit -p tsconfig.web.json${C.r}`,
      `  ${C.green}✓${C.r} 0 errors`,
      `${C.cyan}●${C.r} Bash(node --test test/stapler-shared.test.cjs)`,
      `  ${C.dim}⎿  running…${C.r}`
    ].join('\r\n'),
    'pty-jim': [
      ...banner('Jim', 'gpt-6-astra'),
      `${C.cyan}●${C.r} Edit src/renderer/src/workspace/sidebar/Sidebar.tsx`,
      `  ${C.dim}⎿  +31 / -4${C.r}`,
      `${C.cyan}●${C.r} Edit src/renderer/src/workspace/workspace.css`,
      `  ${C.dim}⎿  +12 / -0${C.r}`
    ].join('\r\n'),
    'pty-pam': [
      ...banner('Pam', 'gemini pro'),
      'Release notes draft saved to docs/drops/0.4.7.md. Waiting for the sidebar to land',
      'before I write its section.',
      '',
      `${C.yellow}❯${C.r} `
    ].join('\r\n'),
    'pty-angela': [
      ...banner('Angela', 'grok-4.6'),
      `${C.cyan}●${C.r} Read src/main/breaker.ts`,
      `  ${C.dim}⎿  read 212 lines${C.r}`,
      '',
      `${C.yellow}Grok needs your permission to use Bash${C.r}`,
      '  node --test test/budget.test.cjs',
      '',
      '  ❯ 1. Yes',
      '    2. Yes, and don’t ask again',
      '    3. No'
    ].join('\r\n')
  };

  // ─── Subscription events (fired shortly after each subscription) ──────────
  //
  // `channel` is the `window.cth.<onX>` name (nested: 'features.stapler.onState').
  // `id` scopes per-id subscriptions (onPtyData / onPtyExit / onPtyRelaunch).
  // `delayMs` is relative to the subscribe() call.
  const events = [
    { channel: 'onHiveHookEvent', delayMs: 400, payload: { agentId: 'god', event: 'PreToolUse', tool: 'TodoWrite' } },
    { channel: 'onHiveHookEvent', delayMs: 450, payload: { agentId: 'dwight', event: 'PreToolUse', tool: 'Bash' } },
    { channel: 'onHiveHookEvent', delayMs: 500, payload: { agentId: 'jim', event: 'PreToolUse', tool: 'Edit' } },
    { channel: 'onHiveHookEvent', delayMs: 550, payload: { agentId: 'pam', event: 'Stop' } },
    { channel: 'onHiveHookEvent', delayMs: 560, payload: { agentId: 'angela', event: 'PreToolUse', tool: 'Read' } },
    { channel: 'onHiveHookEvent', delayMs: 650, payload: { agentId: 'angela', event: 'Notification', notificationType: 'permission_prompt', message: 'Grok needs your permission to use Bash' } },
    ...agents.map((a, i) => ({ channel: 'onHiveContextUpdate', delayMs: 700 + i * 10, payload: { agentId: a.id, tokens: contextFor[a.id].tokens, limit: contextFor[a.id].limit } })),
    { channel: 'onHiveMessage', delayMs: 900, payload: { id: 'm-6', from: 'god', to: 'dwight', act: 'request', subject: 'Pin node in the e2e job too', targets: ['dwight'], needsHuman: false } },
    { channel: 'onTelemetryEvent', delayMs: 950, payload: { kind: 'tool_result', span: { agentId: 'dwight', sessionId: 'sess-dwight-7f3a', ts: ts(0), tool: 'Bash', success: true, durationMs: 2_400 } } },
    ...Object.entries(ptyOutput).map(([id, data]) => ({ channel: 'onPtyData', id, delayMs: 300, payload: data }))
  ];

  const hero = {
    plan: { label: 'Local', blurb: 'Every agent runs on your machine, in your folders, under your own keys. No seat limit, nothing metered.' },
    sponsor: null,
    notice: null
  };

  const changelog = `## ${version}\n\n- Workspace interface (opt-in, titlebar switch).\n- The Stapler: screenshots, voice messages and meetings for your agents.\n- Dictate into any app.\n`;

  return {
    version, platform, harnessHome, repo,
    config, agents, rosterSnapshot, registry, directory, ptys, tasks, inbox, messages, log, board, memory,
    telemetry, context: contextFor, control, missions, tools, memoryStatus, kg, git, history,
    stapler, roster, features, memoryAnswer, capabilitiesState, skillsCatalog, skillsLocal, conversations, activity, ptyOutput, events, hero, changelog
  };
}

export default buildFixtures;
