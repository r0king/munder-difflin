# Workspace and Stapler: units, ownership, contracts

The Workspace is the professional interface (sidebar, orchestrator screen, agent
cards and rooms, Tasks, Inbox, Automations, Memory, Capabilities), switchable
with the pixel office ("Classic") from the titlebar. The Stapler is the floating
puck window with its ring (screenshot, record message, record meeting, dictate
into any app, make invisible) and local transcription.

Both are built by twelve units in parallel in one tree. This file says who owns
what, the contracts between units, and the rules that keep parallel work from
colliding. The foundation (`ws`) owns the shell, the contracts and the
cross-cutting plumbing; every other unit owns its own files and nothing else.

## Rules

1. **Own files only.** Edit the files your unit owns (below) and new files inside
   your unit's directories. Do not reformat, rewrite or "fix" another unit's
   files — say what you saw in your report.
2. **Shared files are foundation-owned:** `src/main/index.ts`,
   `src/preload/index.ts`, `src/renderer/src/App.tsx`,
   `src/renderer/src/i18n/index.ts`, `src/main/config.ts`,
   `src/renderer/src/store/store.ts`, `src/renderer/src/store/config.ts`,
   `electron.vite.config.ts`, `package.json` (and everything else that existed
   before this work). A unit that truly needs a change there makes the
   **smallest additive edit**, re-reads the file immediately before editing,
   and lists the edit in its report. Prefer the extension points below to any
   shared-file edit.
3. **Never change Classic.** Every hook and service App runs, runs in both
   modes; the Workspace is a presentation swap. Nothing a unit adds may alter
   what Classic shows or does.
4. **Design:** `var(--cth-*)` tokens only (DESIGN.md, design/tokens.css), 4px
   grid, no `border-radius`, fonts via `--cth-font-ui` / `--cth-font-mono` /
   `--cth-font-display`, light and dark both work, logical CSS properties
   (Arabic mirrors). Build from `workspace/ui.tsx`. A unit's own CSS lives in its
   own folder with classes prefixed `cth-ws-<unit>-` (or `cth-stapler-`).
5. **Strings:** every visible string through i18next, `t('<ns>.key')`, from the
   unit's fragment files `src/renderer/src/i18n/features/<ns>.{en,zh-CN,ar}.json`
   — identical key trees, real translations, identical `{{placeholders}}`,
   `{{godName}}` for the orchestrator (never "Michael").
   `test/i18n-feature-fragments.test.cjs` enforces it.
6. **IPC:** channels are `feat:<unit>:<action>` (`<unit>` = the main module
   name: stapler, transcribe, dictate, sidebar, agents, orchestrator, tasks,
   inbox, automations, memory, capabilities). Validate every input in main
   (types, lengths, path containment). Secrets never reach a renderer.
7. **Pure logic** goes in `src/shared/workspace/<unit>*.ts` or
   `src/shared/features/<unit>*.ts` (no React/Electron) with node tests named
   `test/<prefix>-*.test.cjs`, loaded through `test/load-ts.cjs`.
8. No `git` writes, no `npm install`, no new dependencies (only `transcribe` may
   add one).

## Ownership

| Unit | i18n ns | Main | Preload | Renderer | Shared / tests |
|---|---|---|---|---|---|
| `ws` (foundation) | `ws` | `features/index.ts`, `features/types.ts`; wiring in `index.ts` | `features/index.ts`; `features` in `index.ts` | `workspace/{Workspace,ui,TitlebarControls}.tsx`, `workspace/{store,deliver,agentStatus,types,useFeatureBridge,useWorkspaceShortcuts,useStaplerState,useHiveTasks}.ts`, `workspace/workspace.css`, `stapler.html`, `stapler/main.tsx` | `shared/features/{deliver,roster,route,channels,switches}.ts`, `shared/workspace/agentStatus.ts`; `test/{workspace-agent-status,i18n-feature-fragments,features-contracts}.test.cjs` |
| `wsSidebar` | `wsSidebar` | `features/sidebar.ts` | `features/sidebar.ts` | `workspace/sidebar/**` | `shared/workspace/sidebar*.ts`; `test/ws-sidebar-*` |
| `wsAgents` | `wsAgents` | `features/agents.ts` | `features/agents.ts` | `workspace/screens/{AgentsScreen,AgentRoom}.tsx`, `workspace/agents/**` | `shared/workspace/agents*.ts`; `test/ws-agents-*` |
| `wsOrchestrator` | `wsOrchestrator` | `features/orchestrator.ts` | `features/orchestrator.ts` | `workspace/screens/OrchestratorScreen.tsx`, `workspace/orchestrator/**` | `shared/workspace/orchestrator*.ts`; `test/ws-orchestrator-*` |
| `wsTasks` | `wsTasks` | `features/tasks.ts` | `features/tasks.ts` | `workspace/screens/TasksScreen.tsx`, `workspace/tasks/**` | `shared/workspace/tasks*.ts`; `test/ws-tasks-*` |
| `wsInbox` | `wsInbox` | `features/inbox.ts` | `features/inbox.ts` | `workspace/screens/InboxScreen.tsx`, `workspace/inbox/**`; may set `headerExtras` in `Workspace.tsx` (the Ask me bell) | `shared/workspace/inbox*.ts`; `test/ws-inbox-*` |
| `wsAutomations` | `wsAutomations` | `features/automations.ts` | `features/automations.ts` | `workspace/screens/AutomationsScreen.tsx`, `workspace/automations/**` | `shared/workspace/automations*.ts`; `test/ws-automations-*` |
| `wsMemory` | `wsMemory` | `features/memory.ts` | `features/memory.ts` | `workspace/screens/MemoryScreen.tsx`, `workspace/memory/**` | `shared/workspace/memory*.ts`; `test/ws-memory-*` |
| `wsCapabilities` (incl. Temps, role bundles) | `wsCapabilities` | `features/capabilities.ts` | `features/capabilities.ts` | `workspace/screens/CapabilitiesScreen.tsx`, `workspace/capabilities/**` | `shared/workspace/capabilities*.ts`; `test/ws-capabilities-*` |
| `stapler` (puck, ring, screenshot, record message/meeting, meetings library) | `stapler` | `features/stapler.ts` + `features/stapler/**` | `features/stapler.ts` | `stapler/**` except `main.tsx`, `audio/**`, `dictate/**`, `TranscribeSettings.tsx`; `workspace/screens/StaplerScreen.tsx`, `workspace/stapler/**` | `shared/features/stapler.ts`; `test/stapler-*` |
| `transcribe` (local Whisper + Groq, You/Them capture, vocabulary) | `transcribe` | `features/transcribe.ts` + `features/transcribe/**` | `features/transcribe.ts` | `stapler/audio/**`, `stapler/TranscribeSettings.tsx` | `shared/features/transcribe.ts`, `shared/features/vocabulary.ts`; `test/transcribe-*` |
| `dictate` (dictate into any app) | `dictate` | `features/dictate.ts` + `features/dictate/**` | `features/dictate.ts` | `stapler/dictate/**` | `shared/features/dictate.ts`; `test/dictate-*` |

Main paths are under `src/main/`, preload under `src/preload/`, renderer under
`src/renderer/src/`, shared under `src/shared/`.

## Contracts

### Delivering text to an agent — `deliverToAgent`

THE single way any feature hands text and files to an agent or the orchestrator.

```ts
// src/shared/features/deliver.ts
type DeliverTarget = { kind: 'orchestrator' } | { kind: 'agent'; agentId: string };
interface DeliverRequest { target: DeliverTarget; text: string; attachments?: string[]; // absolute paths
                           mode?: 'queue' | 'steer'; source?: string }
interface DeliverResult { ok: boolean; error?: string }
```

- Renderer (app window): `import { deliverToAgent } from '@/workspace/deliver'`.
- Main: `ctx.deliverToAgent(req)` (fire-and-forget; queued in main until the
  main window's bridge is up).
- A feature window (the puck): `window.cth.features.deliver(req)`.

`'queue'` is the composer's Send: the message parks in the agent's queue and the
existing drain types it once the agent is idle, has no user draft or open picker
on its prompt, the floor is not paused, and boot grace is over
(docs/message-queue.md). `'steer'` lands on the next turn: a busy Claude agent
gets a steer note through the hook channel (`control:steer`, injected as
additionalContext at its next tool call or prompt); an idle agent, or an engine
without that channel, gets the message at the front of its queue, released past
the floor pause (the queue's "send now"). Attachments become the composer's
`Attached files:` block (`composeDeliveryText`), which the agent Reads by path —
images included. The orchestrator is addressed by role: whoever is god, or the
`god` id while he boots (his queue drains once he is up).

### Workspace routing — `useWorkspace`

```ts
type WorkspaceRoute = { kind: 'agents' } | { kind: 'agent'; agentId: string }
  | { kind: 'orchestrator'; tab?: string } | { kind: 'tasks' } | { kind: 'inbox'; section?: string }
  | { kind: 'automations' } | { kind: 'memory'; query?: string }
  | { kind: 'capabilities'; tab?: string } | { kind: 'stapler' };
```

`useWorkspace((s) => s.route)`, `navigate(route)` (also `navigateWorkspace(route)`
outside React). `navigate` validates, turns an agent route for god into the
orchestrator route, and selects the agent in the hive store (so the IDE, focus
mode and hold-Option-to-talk follow what is on screen). From main:
`ctx.navigateMainWindow(route)`; from the puck: `window.cth.features.navigate`.
Per-unit view preferences: `loadWsPref(key, fallback, validate?)` /
`saveWsPref(key, value)` (localStorage `cth.ws.<key>`, prefix your key with your
unit).

### Screens

Every screen gets `{ config: HarnessConfig }` (`workspace/types.ts`, App's live
config) plus its route params (`tab`, `section`, `query`; `AgentRoom` gets
`agentId`). Build a screen as `<Screen header={<ScreenHeader title subtitle actions>…</ScreenHeader>}>body</Screen>`.
The shell already handles god booting, an empty floor (for the agents,
agent and orchestrator routes), an agent that has left, and a crash (an error
boundary per screen). The sidebar renders in a resizable, collapsible column the
shell owns.

### Status and live line

`src/shared/workspace/agentStatus.ts`, re-exported by `workspace/agentStatus.ts`:
`deriveAgentStatus({ status, action, ptyId, archived, hasOpenQuestion })` →
`'working' | 'thinking' | 'needs-you' | 'waiting' | 'compacting' | 'looping' | 'idle' | 'offline'`;
`statusColorVar(status)` → `var(--cth-status-…)`; `agentLiveLine(input)` →
`{ kind, detail?, text }`, translated with `liveLineText(t, line)`. The hook
`useAgentPresence(agent, hasOpenQuestion)` returns all of it. `hasOpenQuestion`
comes from `useAskedYou()` in `workspace/useHiveTasks.ts`, the one shared poll
of `hive/tasks.json` (`useHiveTasks()`, `useOpenQuestions()`,
`refreshHiveTasks()` after you write) — do not start your own ledger timer.

### UI primitives — `workspace/ui.tsx`

`Screen`, `ScreenHeader`, `Card`, `Chip` (tones neutral, info, warn, danger, ok,
accent), `StatusDot`, `StatusBadge`, `Tabs`, `SegmentedControl`, `SearchInput`,
`Toggle`, `IconButton`, `Button`, `EmptyState`, `Section`, `Spinner`, `KeyHint`
(+ `formatKeyCombo`, `isMac`), `WsIcon`; CSS classes `cth-ws-navrow`,
`cth-ws-ellipsis`, `cth-ws-muted`, `cth-ws-mono`.

### Main-process modules — `src/main/features/`

```ts
interface FeatureModule { name: string; earlyEnableFeatures?: string[];
  register(ctx: FeatureContext): void; micLive?(): boolean;
  onAppWindowsClosed?(): void; dispose?(): void }
```

`FeatureContext` (types.ts): `isDev`, `preloadPath`,
`loadRendererEntry(win, 'index' | 'stapler', hash?)`, `getMainWindow()`,
`appWindows()`, `featureWindows()`, `broadcast(ch, payload)` (app windows),
`broadcastAll(ch, payload)` (every window), `deliverToAgent(req)`,
`navigateMainWindow(route)`, `getRoster()`, `onRosterChanged(cb)`,
`readConfig()`, `writeConfig(patch)`, `userDataDir`, `harnessHome()`,
`featureDataDir(name)` (`<userData>/features/<name>`),
`readFeatureSettings(name, defaults)` / `writeFeatureSettings(name, defaults, patch)`
(`settings.json` in that dir — use it instead of adding config fields).
`featureContext()` (features/index.ts) returns the context outside `register`.

Lifecycle: `earlyEnableFeatures` are merged into one `--enable-features` before
app ready; `register` runs once after the hive services and the primary window
exist (a throw is logged and skipped); `micLive()` is ORed into the
microphone permission gate; `onAppWindowsClosed` fires when the last app window
closes (close your windows there, or Windows and Linux never quit); `dispose`
runs on quit (kill child processes, unregister shortcuts).

### Preload — `window.cth.features`

One object per unit in `src/preload/features/<unit>.ts` (add members there and
only there; the object's type is the renderer's type). Bridge members:
`onDeliver`, `onNavigate`, `pushRoster`, `bridgeReady` (app window, used only by
useFeatureBridge), and `deliver`, `navigate`, `getRoster`, `onRoster` (feature
windows). Listener helpers return their unsubscribe function.

### Stapler, transcription, dictation

- `StaplerState` (`shared/features/stapler.ts`): `enabled`, `invisible`,
  `recording` are read by other units; `feat:stapler:getState`,
  `feat:stapler:setEnabled`, push `feat:stapler:state`. The titlebar toggle and
  the sidebar use `useStaplerState()` / `setStaplerEnabled()`.
- Capture (renderer, `stapler/audio/capture.ts`): `startCapture({ sessionId, mic,
  system, micDeviceId?, systemDeviceId? }) → CaptureHandle { onLevel(cb), stop(),
  cancel() }`, `stop()` → `{ ok, micWav?, systemWav?, durationMs, error? }`.
- Transcription (main, `features/transcribe.ts`): `transcribeFile(wav, { language?,
  prompt? })`, `transcribeMeeting(micWav?, systemWav?)` → `TranscribeResult
  { ok, text, segments: { speaker?: 'you'|'them', startMs, endMs, text }[], engine, error? }`.
- The Stapler's windows load `stapler.html#<view>`; `StaplerApp` routes on the hash.

## Gotchas

- **The Stapler window has no hive store.** Never import `@/store/store` from
  `src/renderer/src/stapler/**` (or anything it imports): the store reads and
  re-writes the roster (localStorage and `<harnessHome>/roster.json`) at module
  load and on unload, and a second writer with a stale copy clobbers the main
  window's roster. Use `window.cth.features.getRoster()` / `onRoster` and
  `deliver`. Type-only imports are fine.
- **Feature windows are not app windows.** They are not in `appWindows()`, never
  receive hive events, must use `ctx.preloadPath` with `sandbox: true` and
  `contextIsolation: true`, and must close in `onAppWindowsClosed` and
  `dispose`.
- **The mic gate** opens only while `micLive()` answers true, and the window must
  use the default session (no `partition`).
- **Floors.** Each floor window is its own office (own store, own roster);
  `getMainWindow()` is the most recently focused one, and the roster and
  deliveries follow it.
- **Auto restore.** The boot-time restore of last session's team (useRestoreTeam)
  is mounted by the Workspace shell as well as by Classic's agent strip.
- **Keys.** The desk keys (Mod+\\, Mod+, Mod+. Mod+I) are handled by
  `useWorkspaceShortcuts`; inside a terminal on Windows and Linux, Ctrl+\\ and
  Ctrl+I go to the agent (SIGQUIT, Tab). Option alone is hold-to-talk.
