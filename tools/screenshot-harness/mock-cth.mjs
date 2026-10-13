/**
 * The mocked `window.cth` preload bridge for the screenshot harness.
 *
 * In Electron, src/preload/index.ts exposes `window.cth` via contextBridge. In a
 * plain browser there is no preload, so the harness injects this mock with
 * Playwright's `addInitScript` BEFORE any app script runs.
 *
 * Three layers, highest priority first:
 *   1. explicit mocks in `createCthTree` (argument-aware, e.g. updateConfig
 *      merges the patch and fires onConfigChanged);
 *   2. static per-unit fixtures in fixtures.mjs `features.<unit>.<method>`;
 *   3. a Proxy fallback (`wrapWithFallback`): ANY other property, at any depth
 *      (`window.cth.features.newUnit.newMethod()`), is a callable that resolves
 *      to a safe default, and `on*` names subscribe and return an unsubscribe.
 *      Every fallback hit is counted in `window.__cthHarness.fallback` so the
 *      sidecar JSON lists what still needs a real fixture.
 *
 * `createCthTree`, `wrapWithFallback` and `installInBrowser` are serialised
 * with Function.prototype.toString into the init script, so they must stay
 * SELF-CONTAINED: no imports, no references to anything at module scope.
 *
 * CLI: `node tools/screenshot-harness/mock-cth.mjs --coverage` re-reads the
 * preload (src/preload/index.ts + src/preload/features/*.ts) and lists every
 * bridge member that is only covered by the fallback.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildFixtures } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

// ─── 1. Explicit mocks (serialised into the page) ───────────────────────────

/**
 * Build the plain (un-proxied) mock tree. `host` provides the event bus:
 *   host.sub(path, cb, id?) → unsubscribe     host.emit(path, payload, id?)
 * Paths are dotted bridge names: 'onConfigChanged', 'features.stapler.onState'.
 */
export function createCthTree(fx, host) {
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const res = (v) => Promise.resolve(clone(v));
  const ok = (extra) => Promise.resolve(Object.assign({ ok: true }, clone(extra) || {}));
  const nope = (error) => Promise.resolve({ ok: false, error: error || 'not available in the screenshot harness' });
  const done = () => Promise.resolve(undefined);
  const on = (path) => (cb) => host.sub(path, cb);
  const onId = (path) => (id, cb) => host.sub(path, cb, id);
  const now = () => Date.now();
  const feat = fx.features || {};
  const sep = fx.platform === 'win32' ? '\\' : '/';

  // Live, mutable state the mock keeps so a write reads back (and pushes).
  let config = clone(fx.config);
  const setConfig = (patch) => {
    config = Object.assign({}, config, clone(patch) || {});
    host.emit('onConfigChanged', config);
    return clone(config);
  };
  const control = clone(fx.control) || {};
  const ctl = (id, patch) => {
    const cur = control[id] || { paused: false, halted: false, autoDeliveryPaused: false, gatedTools: [], pendingSteers: 0 };
    control[id] = Object.assign({}, cur, typeof patch === 'function' ? patch(cur) : patch);
    return res(control[id]);
  };
  let stapler = clone(fx.stapler);
  const setStapler = (patch) => {
    stapler = Object.assign({}, stapler, patch);
    host.emit('features.stapler.onState', stapler);
    return clone(stapler);
  };
  let orch = clone(feat.orchestrator && feat.orchestrator.getState);
  const setOrch = (fn) => {
    if (!orch) return res(null);
    fn(orch);
    const b = orch.budget;
    if (b) {
      b.fraction = b.dailyCapUsd ? b.spendTodayUsd / b.dailyCapUsd : 0;
      b.remainingUsd = b.dailyCapUsd ? Math.max(0, b.dailyCapUsd - b.spendTodayUsd) : null;
      b.level = !b.dailyCapUsd ? 'none' : b.fraction >= 1 ? 'over' : b.fraction >= 0.8 ? 'near' : 'ok';
    }
    host.emit('features.orchestrator.onState', orch);
    return res(orch);
  };
  let rules = clone(feat.automations && feat.automations.listRules) || [];
  const rulesChanged = () => { host.emit('features.automations.onRules', rules); return res({ ok: true, rules }); };
  let marks = {};
  let dictateState = clone(feat.dictate && feat.dictate.getState);
  let dictateConfig = clone(feat.dictate && feat.dictate.getSettings);
  let transcribeSettings = clone(feat.transcribe && feat.transcribe.getSettings);
  const notes = clone(feat.sidebar && feat.sidebar.notesList && feat.sidebar.notesList.notes) || [];
  const notesDir = (feat.sidebar && feat.sidebar.notesList && feat.sidebar.notesList.dir) || fx.harnessHome;
  const noteDoc = (meta) => Object.assign({}, meta, {
    body: `# ${meta.title}\n\n${meta.excerpt}\n`,
    path: notesDir + sep + meta.slug + '.md'
  });
  const ptyList = () => (fx.ptys || []).map((p) => ({
    id: p.id, cwd: p.cwd, command: p.command, pid: p.pid,
    lastOutputAt: now() - (p.quietMs || 0), hasOutput: p.hasOutput !== false
  }));
  const inRepo = (cwd) => typeof cwd === 'string' && cwd.indexOf(fx.repo) === 0;
  const memorySearch = (lane) => (query) => res({
    ok: true, lane, query: String(query || ''), state: 'ok', answer: fx.memoryAnswer, tookMs: lane === 'meaning' ? 180 : 14
  });
  const dirEntries = [
    { name: 'src', isDir: true, size: 0, mtime: now() - 3_600_000 },
    { name: 'docs', isDir: true, size: 0, mtime: now() - 86_400_000 },
    { name: 'package.json', isDir: false, size: 3_139, mtime: now() - 7_200_000 },
    { name: 'README.md', isDir: false, size: 32_655, mtime: now() - 86_400_000 }
  ];

  const tree = {
    version: fx.version,
    platform: fx.platform,
    arch: fx.platform === 'darwin' ? 'arm64' : 'x64',

    features: {
      // ── Stapler (app window toggle + the puck/overlay windows) ──
      stapler: {
        getState: () => res(stapler),
        setEnabled: (v) => Promise.resolve(setStapler({ enabled: !!v })),
        onState: on('features.stapler.onState'),
        setInvisible: (v) => Promise.resolve(setStapler({ invisible: !!v, hiddenFromCapture: !!v && !!stapler.canHide })),
        resetPosition: () => res(stapler),
        retryShortcut: () => res(stapler),
        setTarget: (t) => res(t),
        setMode: (mode, panel) => res({ mode, panel, width: mode === 'panel' ? 420 : mode === 'ring' ? 220 : 72, height: mode === 'panel' ? 520 : mode === 'ring' ? 220 : 72 }),
        setIgnoreMouse: () => undefined,
        dragStart: () => res(true),
        dragEnd: () => res(null),
        setRecording: (kind) => Promise.resolve(setStapler({ recording: kind || null })),
        onCommand: on('features.stapler.onCommand'),
        screenshot: () => ok(),
        overlayCommit: () => ok(),
        overlayCancel: () => ok(),
        onDraft: on('features.stapler.onDraft'),
        removeAttachment: () => res({ attachments: [] }),
        clearDraft: () => res({ attachments: [] }),
        pickFiles: () => res({ draft: { attachments: [] }, rejected: 0, cancelled: true }),
        addPaths: () => res({ draft: { attachments: [] }, rejected: 0 }),
        send: () => ok(),
        meetingStart: () => nope('recording is not available in the screenshot harness'),
        meetingList: (q) => {
          const all = (feat.stapler && feat.stapler.meetingList) || [];
          const needle = String(q || '').toLowerCase();
          return res(needle ? all.filter((m) => (m.title + ' ' + m.snippet).toLowerCase().indexOf(needle) >= 0) : all);
        },
        onMeetings: on('features.stapler.onMeetings'),
        onFocusMeeting: on('features.stapler.onFocusMeeting')
      },
      // ── Transcription ──
      transcribe: {
        setSettings: (patch) => { transcribeSettings = Object.assign({}, transcribeSettings, clone(patch) || {}); return res(transcribeSettings); },
        getSettings: () => res(transcribeSettings),
        onStatus: on('features.transcribe.onStatus'),
        appendPcm: () => undefined
      },
      // ── Dictation ──
      dictate: {
        getState: () => res(dictateState),
        toggle: () => res(dictateState),
        cancel: () => res(dictateState),
        onState: on('features.dictate.onState'),
        onLevel: on('features.dictate.onLevel'),
        getSettings: () => res(dictateConfig),
        setSettings: (patch) => {
          dictateConfig = Object.assign({}, dictateConfig, clone(patch) || {});
          dictateState = Object.assign({}, dictateState, { enabled: !!dictateConfig.enabled });
          host.emit('features.dictate.onState', dictateState);
          return res({ ok: true, config: dictateConfig, state: dictateState });
        },
        requestPermission: () => res(feat.dictate && feat.dictate.getStatus),
        insertReady: () => undefined,
        onInsert: on('features.dictate.onInsert'),
        insertResult: () => undefined,
        host: {
          ready: () => done(),
          onCommand: on('features.dictate.host.onCommand'),
          event: () => undefined
        }
      },
      // ── Workspace sidebar ──
      sidebar: {
        notesList: () => res({ ok: true, notes, dir: notesDir, truncated: false }),
        notesRead: (slug) => {
          const meta = notes.find((n) => n.slug === slug);
          return res(meta ? { ok: true, note: noteDoc(meta) } : { ok: false, error: 'not-found' });
        },
        notesWrite: (req) => {
          const slug = (req && req.slug) || 'untitled';
          const meta = { slug, title: (req && req.title) || slug, updatedAt: now(), excerpt: String((req && req.body) || '').split('\n')[0] || '' };
          return res({ ok: true, note: noteDoc(meta) });
        },
        notesRename: (req) => {
          const meta = notes.find((n) => n.slug === (req && req.slug)) || { slug: 'untitled', title: 'Untitled', updatedAt: now(), excerpt: '' };
          return res({ ok: true, note: noteDoc(Object.assign({}, meta, { title: (req && req.title) || meta.title })) });
        },
        notesDelete: () => ok(),
        onNotesChanged: on('features.sidebar.onNotesChanged'),
        onFloorInfo: on('features.sidebar.onFloorInfo')
      },
      // ── Agents (cards + rooms) ──
      agents: {
        activity: (ids) => res((Array.isArray(ids) ? ids : []).map((id) => (fx.activity || {})[id]).filter(Boolean)),
        conversation: (id) => res((fx.conversations || {})[id] || { sends: [], transcript: [], hive: [], asks: [], transcriptMissing: 'none' }),
        recordSend: () => ok(),
        revealCrashLog: () => ok()
      },
      // ── Orchestrator screen ──
      orchestrator: {
        getState: () => res(orch),
        setDailyCap: (cap) => setOrch((s) => { s.budget.dailyCapUsd = cap == null ? null : Number(cap); }),
        setDefaultTokenCap: (tokens) => setOrch((s) => { s.budget.defaultAgentTokenCap = tokens == null ? null : Number(tokens); }),
        setDeliveriesPaused: (paused) => setOrch((s) => { s.delivery = paused ? { paused: true, reason: 'manual', since: now() } : { paused: false, reason: null, since: null }; }),
        onState: on('features.orchestrator.onState')
      },
      tasks: {},
      // ── Inbox ──
      inbox: {
        readMarks: () => res({ hiveId: fx.harnessHome, marks }),
        markRead: (entries) => {
          for (const e of Array.isArray(entries) ? entries : []) if (e && e.key) marks[e.key] = e.at;
          host.emit('features.inbox.onReadMarks', { hiveId: fx.harnessHome, marks });
          return res({ ok: true, hiveId: fx.harnessHome, marks });
        },
        onReadMarks: on('features.inbox.onReadMarks')
      },
      // ── Automations (house rules) ──
      automations: {
        listRules: () => res(rules),
        saveRule: (rule) => {
          if (!rule || !rule.id) return res({ ok: false, error: 'invalid', rules });
          const i = rules.findIndex((r) => r.id === rule.id);
          if (i >= 0) rules[i] = clone(rule); else rules.push(clone(rule));
          return rulesChanged();
        },
        deleteRule: (id) => {
          const before = rules.length;
          rules = rules.filter((r) => r.id !== id);
          return before === rules.length ? res({ ok: false, error: 'notFound', rules }) : rulesChanged();
        },
        onRules: on('features.automations.onRules')
      },
      // ── Memory search ──
      memory: {
        search: memorySearch('exact'),
        meaning: memorySearch('meaning')
      },
      // ── Capabilities (grants, bundles, temps) ──
      capabilities: {
        state: (agentIds) => {
          const st = clone(fx.capabilitiesState) || { hive: true, grants: {}, builtinSkills: [], machineSkills: [], agentSkills: {}, mcpKeys: {}, appliedAt: {}, installing: {}, skillErrors: {} };
          for (const id of Array.isArray(agentIds) ? agentIds : []) if (!st.agentSkills[id]) st.agentSkills[id] = [];
          return Promise.resolve(st);
        },
        onChanged: on('features.capabilities.onChanged')
      },

      // ── Feature bridge (foundation-owned) ──
      onDeliver: on('features.onDeliver'),
      onNavigate: on('features.onNavigate'),
      pushRoster: () => undefined,
      bridgeReady: () => res({ deliveries: [], navigate: null }),
      deliver: () => ok(),
      navigate: () => ok(),
      getRoster: () => res(fx.roster),
      onRoster: on('features.onRoster')
    },

    trackMessageSent: () => done(),

    // ── PTY (no real terminals: output comes from fixtures via onPtyData) ──
    spawnPty: (o) => ok({ cwd: o && o.cwd, resumed: !!(o && o.resume) }),
    writePty: () => ok(),
    resizePty: () => ok(),
    redrawPty: () => ok(),
    killPty: () => ok(),
    listPtys: () => Promise.resolve(ptyList()),
    resolveSessionCwd: () => Promise.resolve(null),
    onPtyData: onId('onPtyData'),
    onPtyExit: onId('onPtyExit'),
    onPtyRelaunch: onId('onPtyRelaunch'),

    chooseFolder: () => nope('cancelled'),
    openTerminalAt: () => ok(),
    copyToClipboard: () => ok(),
    readClipboard: () => Promise.resolve(''),
    readClipboardSync: () => '',

    // ── Config ──
    getConfig: () => res(config),
    updateConfig: (patch) => Promise.resolve(setConfig(patch)),
    setAgentTokenCap: (agentId, cap) => {
      const caps = Object.assign({}, config.agentTokenCaps);
      if (cap == null) delete caps[agentId]; else caps[agentId] = cap;
      return Promise.resolve(setConfig({ agentTokenCaps: caps }));
    },
    ensureHarnessHome: () => ok(),
    changeHome: () => nope(),

    // ── Filesystem ──
    listDir: (root, rel) => ok({ entries: dirEntries, path: rel || '' }),
    readFile: (root, rel) => ok({ content: `# ${rel}\n\n(screenshot harness: file contents are not read from disk)\n`, path: rel, size: 64 }),
    readBinary: () => nope(),
    writeFile: (root, rel) => ok({ path: rel }),
    statAbs: (p) => Promise.resolve({ exists: false, isFile: false, path: p }),
    revealPath: () => ok(),

    // ── Git ──
    gitIsRepo: (cwd) => Promise.resolve(inRepo(cwd)),
    gitMainRepo: (cwd) => Promise.resolve(inRepo(cwd) ? fx.repo : null),
    gitBranch: () => res(fx.git.branch),
    gitStatus: () => res(fx.git.status),
    gitLog: (cwd, n) => res(fx.git.log.slice(0, n || 50)),
    gitBranches: () => res(fx.git.branches),
    gitAheadBehind: () => res(fx.git.aheadBehind),
    gitDiff: (cwd, relPath) => res({ ok: true, path: cwd + sep + relPath, relPath, head: '', working: '', headExists: true, workingExists: true, isBinary: false }),
    gitLogGraph: (cwd, n, skip) => res(fx.git.log.slice(skip || 0, (skip || 0) + (n || 50))),
    gitCommitFiles: () => res([{ path: 'src/renderer/src/workspace/sidebar/Sidebar.tsx', status: 'M' }]),
    gitShowFile: () => ok({ exists: true, isBinary: false, content: '' }),
    gitCompareRefs: () => res({ ahead: 1, behind: 0, mergeBase: fx.git.log[1] ? fx.git.log[1].sha : null, files: [] }),
    gitWorktrees: () => res([{ path: fx.repo, head: fx.git.log[0].sha, branch: 'main' }]),
    gitCheckout: () => ok({ detached: false }),

    // ── Hive ──
    hiveRegistry: () => res(fx.registry),
    hivePatchAgentRole: () => ok(),
    hiveRenameAgent: (id, name) => ok({ name }),
    hiveSetAgentHold: (id, hold) => ok({ onHold: !!hold }),
    hiveBoard: () => res(fx.board),
    hiveTasks: () => res(fx.tasks),
    hiveLog: (n) => res(fx.log.slice(-(n || 200))),
    hiveMemory: (id) => res((fx.memory || {})[id] || ''),
    hiveInbox: (id) => res((fx.inbox || {})[id] || []),
    hiveMessages: (opts) => {
      const o = opts || {};
      let list = fx.messages || [];
      if (o.id) list = list.filter((m) => m.id === o.id);
      if (o.agentId) list = list.filter((m) => m.from === o.agentId || m.to === o.agentId);
      if (!o.includeArchived) list = list.filter((m) => !m.archived);
      return res(list.slice(-(o.limit || 50)));
    },
    hiveAgentDirectory: () => res(fx.directory),
    listWorkers: () => res({ live: [], preserved: [], maxWorkers: 4 }),
    stopWorker: () => ok(),
    memoryStatus: () => res(fx.memoryStatus),
    toolsStatus: () => res(fx.tools),
    heroPayload: () => res({ hero: fx.hero, fetchedAt: now(), stale: false }),
    modelCatalog: () => res({ catalog: null, fetchedAt: now(), stale: false }),
    skillsLocal: () => res(fx.skillsLocal || []),
    skillsCatalog: () => res({ skills: fx.skillsCatalog || [], fetchedAt: now(), stale: false }),
    skillsInstall: () => Promise.resolve({ ok: false, error: 'not available in the screenshot harness', unsupported: true }),
    skillsUninstall: () => ok(),
    skillsReveal: () => ok(),
    searchMemory: () => ok({ output: '' }),
    memoryWakeUp: () => ok({ output: '' }),
    mineNow: () => ok(),
    reflectNow: () => res([]),

    // ── Knowledge graph ──
    kgStatus: () => res(fx.kg),
    kgList: () => res([]),
    kgSearch: () => res([]),
    kgGet: () => res(null),
    kgRemove: () => ok(),
    kgAddFiles: () => ok({ results: [] }),
    kgIngestFiles: () => ok({ results: [] }),

    // ── Composer attachments ──
    attachFiles: () => nope('cancelled'),
    pathForFile: (f) => (f && f.name) || '',
    saveClipboardImage: () => nope('no image on the clipboard'),

    // ── Command history ──
    historyAdd: () => ok(),
    historyList: (agentId, limit) => res((fx.history || []).filter((h) => !agentId || h.agentId === agentId).slice(0, limit || 100)),
    historySearch: (q, limit) => {
      const needle = String(q || '').toLowerCase();
      return res((fx.history || []).filter((h) => h.text.toLowerCase().indexOf(needle) >= 0).slice(0, limit || 100));
    },
    hiveSend: (msg, from) => ok({
      message: Object.assign({
        id: 'm-h' + now().toString(36), conversation: 'c-harness', in_reply_to: null, from: from || 'human', to: 'god',
        act: 'request', subject: '', body: '', hops: 0, requires_reply: false, needs_human: false, created_at: new Date().toISOString()
      }, clone(msg) || {})
    }),

    // ── Hive push channels ──
    onHiveHookEvent: on('onHiveHookEvent'),
    onHiveContextUpdate: on('onHiveContextUpdate'),
    onHiveMessage: on('onHiveMessage'),
    onHiveEnqueue: on('onHiveEnqueue'),
    onHiveAgentSpawned: on('onHiveAgentSpawned'),
    onHiveAgentArchived: on('onHiveAgentArchived'),
    onHiveTerminalHandoff: on('onHiveTerminalHandoff'),

    // ── Hires ──
    onHireImport: on('onHireImport'),
    onHireError: on('onHireError'),
    drainPendingHires: () => res([]),
    importHireFiles: () => res({ ok: false, manifests: [], errors: [], error: 'cancelled' }),

    // ── App lifecycle ──
    onConfigChanged: on('onConfigChanged'),
    onCloseRequested: on('onCloseRequested'),
    confirmClose: () => done(),
    cancelClose: () => done(),
    onPowerResume: on('onPowerResume'),
    newFloor: () => res({ ok: false }),
    startClosingTime: () => nope('closing time is not available in the screenshot harness'),
    cancelClosingTime: () => done(),
    onClosingTime: on('onClosingTime'),
    resetAll: () => done(),

    // ── Token telemetry ──
    agentUsage: (cwd) => {
      const a = (fx.agents || []).find((x) => x.cwd === cwd);
      const u = a && (fx.telemetry.usage || []).find((s) => s.agentId === a.id);
      return res(u ? { inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheCreation, estimatedCostUsd: u.usd, model: u.model } : null);
    },
    agentContext: (id) => Promise.resolve((fx.context || {})[id] ? fx.context[id].tokens : null),
    telemetryUsage: (id) => res((fx.telemetry.usage || []).find((u) => u.agentId === id) || null),
    telemetrySpans: (id) => res((fx.telemetry.spans || {})[id] || []),
    telemetrySnapshot: () => res(fx.telemetry),
    onTelemetryEvent: on('onTelemetryEvent'),

    // ── Breaker + operator control ──
    onBreakerState: on('onBreakerState'),
    setBreakerState: (s) => { host.emit('onBreakerState', s); return ok(); },
    controlPause: (id, v) => ctl(id, { paused: !!v }),
    controlAutoDelivery: (id, v) => ctl(id, { autoDeliveryPaused: !!v }),
    controlResume: (id) => ctl(id, { paused: false, halted: false }),
    controlGateTool: (id, tool, v) => ctl(id, (cur) => ({
      gatedTools: v ? cur.gatedTools.concat([tool]).filter((t, i, a) => a.indexOf(t) === i) : cur.gatedTools.filter((t) => t !== tool)
    })),
    controlSteer: (id) => ctl(id, (cur) => ({ pendingSteers: cur.pendingSteers + 1 })),
    controlHalt: (id) => ctl(id, { halted: true }),
    controlSnapshot: (id) => res(control[id] || null),
    onApprovalRequest: on('onApprovalRequest'),

    // ── Task kanban ──
    hiveAddTask: () => ok(),
    hivePatchTask: () => ok(),
    hiveDeleteTask: () => ok(),

    // ── Missions ──
    listMissions: () => res(fx.missions),
    saveMissions: () => ok(),
    onMissionsUpdated: on('onMissionsUpdated'),
    onAutoCompact: on('onAutoCompact'),

    textSearch: () => ok({ results: [] }),
    githubIssues: () => ok({ issues: [] }),
    githubCIRuns: () => ok({ runs: [] }),
    setNotifications: (v) => Promise.resolve(setConfig({ notifications: !!v })),
    openExternal: () => ok(),
    setLoginItem: (v) => Promise.resolve(!!v),
    hiveSetArchived: () => ok(),

    // ── Slack + webhooks ──
    onSlackMessage: on('onSlackMessage'),
    slackStart: () => nope(),
    slackStop: () => ok(),
    slackStatus: () => res({ running: false }),
    slackReply: () => ok(),
    slackReplyScriptPath: () => res(fx.harnessHome + sep + 'slack-reply.cjs'),
    slackSetConfig: () => ok(),
    webhookStart: () => nope(),
    webhookStop: () => ok(),
    webhookStatus: () => res({ running: false }),
    webhookGenerateSecret: () => ok({ secret: 'whsec_harness_0000' }),
    webhookSetConfig: () => ok(),

    // ── Triggers ──
    getContextTrigger: () => res(config.contextTrigger),
    setContextTrigger: (cfg) => { setConfig({ contextTrigger: cfg }); return res(cfg); },
    onContextTrigger: on('onContextTrigger'),
    listWebhooks: () => res(config.webhookTriggers || []),
    saveWebhooks: (list) => { setConfig({ webhookTriggers: list }); return res(list); },
    deleteWebhook: (id) => {
      const list = (config.webhookTriggers || []).filter((w) => w.id !== id);
      setConfig({ webhookTriggers: list });
      return res(list);
    },
    generateWebhookSecret: () => res('whsec_harness_0000'),
    webhooksStatus: () => res({ running: false, url: '', endpoints: [] }),
    getOrgTrigger: () => res(config.orgTrigger),
    setOrgTrigger: (cfg) => { setConfig({ orgTrigger: cfg }); return res(cfg); },
    listTriggerHistory: () => res([]),
    decideTriggerHistory: () => res(null),
    clearTriggerHistory: () => done(),
    onTriggerHistoryUpdated: on('onTriggerHistoryUpdated'),

    // ── Free Flow, integrations, provider keys ──
    freeflowSetConfig: () => ok(),
    freeflowTranscribe: () => nope(),
    integrationsList: () => res([]),
    integrationsTemplates: () => res([]),
    integrationsUpsert: (record) => ok({ record }),
    integrationsSetSecret: () => ok(),
    integrationsRemove: () => ok(),
    integrationsTest: () => nope(),
    providerKeySet: () => ok(),
    providerKeyHas: () => res(false),
    providerKeyClear: () => ok(),

    // ── Realtime Michael ──
    realtimeHasOpenAiKey: () => res(false),
    realtimeMintToken: () => res({ ok: false, error: 'no OpenAI key in the screenshot harness', code: 'no-key' }),
    realtimeAction: () => res({ ok: false, spoken: 'Voice actions are not available in the screenshot harness.' }),
    realtimeActionConfirm: () => res({ ok: false, spoken: 'Voice actions are not available in the screenshot harness.' }),
    realtimeActionCancel: () => res({ ok: true, spoken: 'Cancelled.' }),
    onRealtimeCompletion: on('onRealtimeCompletion'),
    realtimeSetSessionLive: () => ok(),
    realtimeDrainCompletions: () => res([]),
    realtimeWaitFor: (taskId) => res({ timedOut: true, taskId }),
    onRealtimeFloorDelta: on('onRealtimeFloorDelta'),
    onRealtimeEnqueue: on('onRealtimeEnqueue'),
    appInfo: () => res({ version: fx.version, changelog: fx.changelog }),

    // ── Roster mirror (synchronous at boot) ──
    rosterReadSync: () => clone(fx.rosterSnapshot),
    harnessHomeSync: () => fx.harnessHome,
    rosterWrite: () => ok(),

    // ── Auto-update ──
    onUpdateStatus: on('onUpdateStatus'),
    updateCurrent: () => res({ state: 'idle' }),
    updateRestartAndInstall: () => ok(),
    updateCheckNow: () => ok(),
    updateDownload: () => ok(),
    updateOpenRelease: () => ok(),
    updateSimulate: () => nope()
  };

  // ── 2. Static per-unit fixtures (fixtures.mjs `features.<unit>.<method>`) ──
  for (const unit of Object.keys(feat)) {
    const target = tree.features[unit] || (tree.features[unit] = {});
    const table = feat[unit] || {};
    for (const method of Object.keys(table)) {
      if (!(method in target)) target[method] = () => res(table[method]);
    }
  }
  return tree;
}

// ─── 3. The Proxy fallback (serialised into the page) ───────────────────────

/** Wrap the tree so every namespace answers for members it does not have. */
export function wrapWithFallback(tree, host) {
  // Never answer these with a callable: Promise resolution probes `then`,
  // React probes `$$typeof`, JSON probes `toJSON`, test libs probe the rest.
  const NEVER = new Set(['then', 'catch', 'finally', 'toJSON', '$$typeof', 'prototype', 'constructor',
    'nodeType', 'tagName', 'asymmetricMatch', '__esModule', 'valueOf', 'inspect', 'length']);
  const isPlain = (v) => !!v && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]';

  function defaultCall(path, args) {
    host.record(path);
    const name = path.split('.').pop() || '';
    if (/^on[A-Z]/.test(name)) {
      const cb = args.find((a) => typeof a === 'function');
      const id = typeof args[0] === 'string' ? args[0] : undefined;
      return cb ? host.sub(path, cb, id) : () => {};
    }
    if (/Sync$/.test(name)) return null;
    if (/^(list|search|history)/.test(name)) return Promise.resolve([]);
    if (/^(has|is|can)[A-Z]/.test(name)) return Promise.resolve(false);
    return Promise.resolve({ ok: true });
  }

  const unknownCache = new Map();
  function unknown(path) {
    if (unknownCache.has(path)) return unknownCache.get(path);
    const label = `[cth mock fallback ${path}]`;
    const p = new Proxy(function cthFallback() {}, {
      apply: (_t, _self, args) => defaultCall(path, args),
      get: (_t, prop) => {
        if (typeof prop === 'symbol') return prop === Symbol.toPrimitive ? () => label : undefined;
        if (prop === 'toString') return () => label;
        if (NEVER.has(prop)) return undefined;
        return unknown(path + '.' + prop);
      }
    });
    unknownCache.set(path, p);
    return p;
  }

  function namespace(path, obj) {
    for (const key of Object.keys(obj)) {
      if (isPlain(obj[key])) obj[key] = namespace(path ? path + '.' + key : key, obj[key]);
    }
    const fnCache = new Map();
    return new Proxy(obj, {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
        const full = path ? path + '.' + prop : prop;
        if (prop in target) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== 'function' || !Object.prototype.hasOwnProperty.call(target, prop)) return value;
          if (!fnCache.has(prop)) {
            fnCache.set(prop, function (...args) {
              host.count(full);
              try {
                return value.apply(this, args);
              } catch (err) {
                // A bug in the MOCK, not the app: report it separately and answer
                // with the fallback so the screenshot still reflects the app.
                host.mockError(full, err);
                return defaultCall(full, args);
              }
            });
          }
          return fnCache.get(prop);
        }
        if (NEVER.has(prop)) return undefined;
        return unknown(full);
      }
    });
  }

  return namespace('', tree);
}

// ─── The init script ────────────────────────────────────────────────────────

/** Runs in the page before any app script. Seeds localStorage, installs the
 *  event bus, and defines `window.cth` + `window.__cthHarness`. */
function installInBrowser(createCthTree, wrapWithFallback, payload) {
  const fx = payload.fixtures;
  const opts = payload.options || {};
  const H = {
    options: opts,
    calls: {},
    fallback: {},
    mockErrors: [],
    csp: [],
    listeners: 0
  };
  Object.defineProperty(window, '__cthHarness', { value: H, configurable: true });

  // localStorage BEFORE the store, theme, i18n and workspace modules read it.
  try {
    for (const k of Object.keys(payload.localStorage || {})) window.localStorage.setItem(k, payload.localStorage[k]);
  } catch (err) { H.mockErrors.push({ path: 'localStorage', message: String(err) }); }

  // App.tsx reads-and-REMOVES `cth.skipHivePickerOnce` inside a useState
  // initializer. React StrictMode (dev) runs that initializer twice, so the
  // second run would find the flag gone and show the HivePicker. Keep the flag
  // for the whole page life.
  if (opts.pinSkipHivePicker) {
    const removeItem = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (key === 'cth.skipHivePickerOnce') return undefined;
      return removeItem.call(this, key);
    };
  }

  // Deterministic Math.random (the office floor's idle errands, coffee runs
  // and envelope paths are random) so before/after shots line up.
  if (typeof opts.seed === 'number') {
    let a = opts.seed >>> 0;
    Math.random = function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Capture every Pixi Application (the office floor) through Pixi's own
  // devtools hook, so the harness can fast-forward the floor's simulation:
  // under SwiftShader the page renders at ~2-4 fps and Pixi clamps each frame
  // to 100 ms, so agents walking in from the door would take minutes of wall
  // clock to reach their desks.
  H.pixiApps = [];
  const prevAppHook = window.__PIXI_APP_INIT__;
  window.__PIXI_APP_INIT__ = function (app, version) {
    H.pixiApps.push(app);
    if (typeof prevAppHook === 'function') prevAppHook(app, version);
  };
  /** Step every live Pixi app's ticker by `ms` of simulated time WITHOUT
   *  rendering the intermediate frames, then render once. Returns the number
   *  of apps advanced. App exceptions thrown by a tick propagate (they are
   *  real app errors and the harness reports them as such). */
  H.advancePixi = function (ms, stepMs) {
    const step = stepMs || 1000 / 60;
    let n = 0;
    for (const app of H.pixiApps) {
      if (!app || !app.stage || !app.renderer || !app.ticker) continue; // destroyed (StrictMode remount)
      const tk = app.ticker;
      const hadRender = typeof app.render === 'function';
      if (hadRender) tk.remove(app.render, app);
      try {
        let t = tk.lastTime > 0 ? tk.lastTime : performance.now();
        for (let i = 0; i < Math.ceil(ms / step); i++) { t += step; tk.update(t); }
      } finally {
        // Re-anchor on the real clock so the next frame does not see a jump.
        tk.lastTime = performance.now();
        if (hadRender) tk.add(app.render, app, -25 /* UPDATE_PRIORITY.LOW */);
      }
      if (hadRender) app.render();
      n += 1;
    }
    return n;
  };

  document.addEventListener('securitypolicyviolation', (e) => {
    H.csp.push({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber, sample: e.sample });
  });

  // ── Event bus ──
  const listeners = new Map();
  const events = Array.isArray(fx.events) ? fx.events : [];
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  // Delivered on a macrotask, like an IPC event: a throwing app listener then
  // surfaces as an uncaught page error, exactly as it would in Electron.
  const deliver = (entry, payloadValue) => setTimeout(() => {
    if (entry.live) entry.cb(clone(payloadValue));
  }, 0);
  const host = {
    sub(path, cb, id) {
      if (typeof cb !== 'function') return () => {};
      const entry = { cb, id, live: true, timers: [] };
      let set = listeners.get(path);
      if (!set) listeners.set(path, (set = new Set()));
      set.add(entry);
      H.listeners += 1;
      if (opts.events !== false) {
        for (const ev of events) {
          if (ev.channel !== path) continue;
          if (ev.id !== undefined && ev.id !== id) continue;
          entry.timers.push(setTimeout(() => { if (entry.live) entry.cb(clone(ev.payload)); }, ev.delayMs || 0));
        }
      }
      return () => {
        if (!entry.live) return;
        entry.live = false;
        H.listeners -= 1;
        set.delete(entry);
        for (const t of entry.timers) clearTimeout(t);
      };
    },
    emit(path, payloadValue, id) {
      const set = listeners.get(path);
      let n = 0;
      if (set) {
        for (const entry of set) {
          if (id !== undefined && entry.id !== undefined && entry.id !== id) continue;
          deliver(entry, payloadValue);
          n += 1;
        }
      }
      return n;
    },
    record(path) { H.fallback[path] = (H.fallback[path] || 0) + 1; },
    count(path) { H.calls[path] = (H.calls[path] || 0) + 1; },
    mockError(path, err) {
      H.mockErrors.push({ path, message: String((err && err.stack) || err) });
      console.warn('[cth-mock] mock for ' + path + ' threw:', err);
    }
  };
  H.emit = host.emit;

  const tree = createCthTree(fx, host);
  const cth = wrapWithFallback(tree, host);
  Object.defineProperty(window, 'cth', { value: cth, configurable: true, writable: true });
}

/**
 * The init-script source for `page.addInitScript({ content })`.
 * @param {object} payload { fixtures, options, localStorage }
 */
export function buildInitScript(payload) {
  return `(${installInBrowser.toString()})(${createCthTree.toString()}, ${wrapWithFallback.toString()}, ${JSON.stringify(payload)});`;
}

// ─── Coverage: what the real preload exposes vs. what is mocked ─────────────

/** Members of the object literal opened by the first line matching `startRe`
 *  (2-space indented members; a `name: {` member's 4-space children become
 *  `name.child`). A heuristic over the source, good enough for the preload's
 *  consistent formatting. */
function literalMembers(src, startRe) {
  const lines = src.split('\n');
  const i0 = lines.findIndex((l) => startRe.test(l));
  if (i0 < 0) return [];
  if (/=\s*\{\s*\}\s*;?\s*$/.test(lines[i0])) return [];
  const out = [];
  let nested = null;
  for (let i = i0 + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\};?\s*$/.test(l)) break;
    let m = /^ {2}([A-Za-z_$][\w$]*)\s*:\s*(.*)$/.exec(l);
    if (m) {
      if (/^\{\s*$/.test(m[2])) nested = m[1];
      else { nested = null; out.push({ name: m[1], value: m[2] }); }
      continue;
    }
    if (/^ {2}\},?\s*$/.test(l)) { nested = null; continue; }
    m = /^ {4}([A-Za-z_$][\w$]*)\s*:/.exec(l);
    if (m && nested) out.push({ name: `${nested}.${m[1]}`, value: '' });
  }
  return out;
}

/** Every bridge path the real preload exposes, e.g. 'getConfig',
 *  'features.stapler.getState', 'features.dictate.host.ready'. */
export function preloadSurface(repoRoot = REPO_ROOT) {
  const indexSrc = readFileSync(join(repoRoot, 'src/preload/index.ts'), 'utf8');
  const paths = literalMembers(indexSrc, /^const api = \{/)
    .map((m) => m.name)
    .filter((n) => n !== 'features');
  const featDir = join(repoRoot, 'src/preload/features');
  const featIndex = readFileSync(join(featDir, 'index.ts'), 'utf8');
  const importOf = {};
  for (const m of featIndex.matchAll(/import\s*\{\s*(\w+)\s*\}\s*from\s*'\.\/(\w+)'/g)) importOf[m[1]] = m[2];
  for (const member of literalMembers(featIndex, /^export const featuresApi = \{/)) {
    const ref = /^(\w+),?\s*$/.exec(member.value);
    if (ref && importOf[ref[1]]) {
      const file = join(featDir, `${importOf[ref[1]]}.ts`);
      if (!existsSync(file)) continue;
      const unitSrc = readFileSync(file, 'utf8');
      const unitMembers = literalMembers(unitSrc, new RegExp(`^export const ${ref[1]} = \\{`));
      if (!unitMembers.length) paths.push(`features.${member.name}.*`);
      for (const um of unitMembers) paths.push(`features.${member.name}.${um.name}`);
    } else {
      paths.push(`features.${member.name}`);
    }
  }
  return paths;
}

/** Dotted paths of everything explicitly mocked (layers 1 + 2). */
export function mockedSurface(fixtures = buildFixtures()) {
  const tree = createCthTree(fixtures, { sub: () => () => {}, emit: () => 0, record() {}, count() {}, mockError() {} });
  const out = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p);
      else out.push(p);
    }
  };
  walk(tree, '');
  return out;
}

export function coverage(repoRoot = REPO_ROOT) {
  const real = preloadSurface(repoRoot);
  const mocked = new Set(mockedSurface());
  const fallbackOnly = real.filter((p) => !p.endsWith('.*') && !mocked.has(p));
  const emptyUnits = real.filter((p) => p.endsWith('.*'));
  const realSet = new Set(real);
  const stale = [...mocked].filter((p) => !realSet.has(p) && !['version', 'platform', 'arch'].includes(p));
  return { total: real.filter((p) => !p.endsWith('.*')).length, mocked: real.length - fallbackOnly.length - emptyUnits.length, fallbackOnly, emptyUnits, stale };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href && process.argv.includes('--coverage')) {
  const c = coverage();
  console.log(`preload members: ${c.total} · explicitly mocked: ${c.mocked} · Proxy fallback only: ${c.fallbackOnly.length}`);
  if (c.fallbackOnly.length) console.log(`\nfallback only (add a fixture or an explicit mock):\n  ${c.fallbackOnly.join('\n  ')}`);
  if (c.emptyUnits.length) console.log(`\nfeature units with no members yet (fallback answers anything): ${c.emptyUnits.join(', ')}`);
  if (c.stale.length) console.log(`\nmocked but no longer in the preload (stale, harmless):\n  ${c.stale.join('\n  ')}`);
}
