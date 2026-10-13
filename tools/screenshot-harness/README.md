# Screenshot harness

Real PNG screenshots of the renderer (the React UI) in headless Chromium, with
no Electron. Use it for before/after evidence on a PR, and to catch runtime
render errors (uncaught exceptions, React error boundaries, console errors)
without launching the app.

The renderer is served by a standalone Vite dev server (same aliases, `define`
and React plugin as `electron.vite.config.ts`). The preload bridge `window.cth`
is replaced by a mock injected before any app script runs. Nothing under `src/`
is touched.

## Run

```sh
# the standard set (13 shots, ~1 min warm, ~1.5 min on a cold cache)
node tools/screenshot-harness/shoot-all.mjs

# a subset, or into another folder (e.g. before/after a change)
node tools/screenshot-harness/shoot-all.mjs --only classic-light,workspace-tasks-light
node tools/screenshot-harness/shoot-all.mjs --out-dir /tmp/shots-before

# one shot
node tools/screenshot-harness/shoot.mjs --mode workspace --route tasks --theme dark
node tools/screenshot-harness/shoot.mjs --route agent:dwight
node tools/screenshot-harness/shoot.mjs --entry stapler --hash overlay
node tools/screenshot-harness/shoot.mjs --onboarding        # the onboarding wizard
node tools/screenshot-harness/shoot.mjs --keep-picker       # the launch-time HivePicker
node tools/screenshot-harness/shoot.mjs --help              # every flag

# which bridge members are only answered by the Proxy fallback
node tools/screenshot-harness/mock-cth.mjs --coverage
```

Output goes to `tools/screenshot-harness/out/` (git-ignored): one `<name>.png`
per shot, a `<name>.json` sidecar, and `summary.json` from `shoot-all`.

Exit codes: `0` clean, `1` at least one uncaught page error (the PNG is still
written), `2` harness failure (server, browser or navigation).

| Flag | Meaning |
| --- | --- |
| `--entry index\|stapler` | which HTML entry (`stapler.html` is the puck/overlay windows) |
| `--mode classic\|workspace` | `uiMode` in the mocked config (`--route` implies workspace) |
| `--route <r>` | `agents`, `agent:<id>`, `orchestrator[:tab]`, `tasks`, `inbox[:section]`, `automations`, `memory[:query]`, `capabilities[:tab]`, `stapler`, or a JSON `WorkspaceRoute` |
| `--hash puck\|overlay\|dictate` | `stapler.html#<hash>` (implies `--entry stapler`) |
| `--theme light\|dark` | sets `localStorage['cth.theme']` (design/theme.ts) |
| `--out <file.png>` | output path (sidecar written next to it) |
| `--platform darwin\|linux\|win32` | `window.cth.platform` (default `darwin`) |
| `--lang en\|zh-CN\|ar` | `localStorage['cth.language']` |
| `--settle <ms>` | wait after load + network idle (default 3000) |
| `--advance <ms>` | fast-forward the Pixi office floor (default 15000 on the index entry, `0` = off; see below) |
| `--csp keep\|relax\|strip` | the served HTML's CSP meta: `keep` (default) serves the real policy; `relax` adds `'unsafe-inline'` + the dev ws origin; `strip` removes it |
| `--seed <n>\|off` | seeds `Math.random` so the floor's idle wandering is repeatable (default 1337) |
| `--events on\|off` | fire the fixture subscription events |
| `--stapler-enabled` | the Stapler toggle reads ON |
| `--port <n>` | dev-server port (default 5190; if it is taken, the next free port up to 5209, since several people run this at once) |

### CSP

`src/renderer/index.html` and `stapler.html` carry a strict CSP meta
(`script-src 'self'`). It does not get in the harness's way, so it is served
unmodified by default:
- the mock arrives through Playwright's `addInitScript` (CDP), which page CSP does not apply to;
- Vite's client and the entry are same-origin `src=` scripts;
- `@vitejs/plugin-react` 4.7 adds no inline preamble to the HTML.

A `transformIndexHtml` plugin in `vite.config.mjs` can relax or strip the policy
if a future Vite or plugin version starts injecting inline scripts. It only
changes the served copy; the HTML files are never edited.

## The sidecar JSON

- `pageErrors`: uncaught exceptions. `at` is the first frame inside the repo's `src/`, mapped through Vite's source maps to the original `file:line:col`. Mapped stack included.
- `consoleErrors` / `consoleWarnings`: `at` is the mapped location of the `Error` passed to `console.error`, when there is one; otherwise where it was logged. React error-boundary crashes (`[workspace] screen crashed: …`) land here.
- `failedRequests`: HTTP ≥ 400 and failed loads, such as a missing asset.
- `cspViolations`: from `securitypolicyviolation` events. One is expected on every app page: zod v4's `allowsEval` probe (`new Function("")` inside a try/catch, reached through `@openai/agents-realtime`). Production's CSP blocks it the same way, and it is harmless.
- `fallbackCalls`: bridge methods the app called that only the Proxy fallback answered. A UI that looks empty or wrong next to one of these needs a fixture.
- `bridgeCalls`: call counts for every mocked method. `mockErrors`: a mock threw (a harness bug, not an app bug).
- `page.webgl`: the WebGL renderer string (SwiftShader). `notes`: anything odd about the run, such as a Vite dep re-optimise reload.

## What is mocked

`mock-cth.mjs` builds `window.cth` from `fixtures.mjs` in three layers, highest first:

1. Explicit mocks for every member of `src/preload/index.ts` and the
   feature units in `src/preload/features/*.ts`. They are argument-aware and
   stateful: `updateConfig` merges and fires `onConfigChanged`,
   `features.stapler.setEnabled` fires `onState`, and so on.
2. Static per-unit fixtures: `fixtures.features.<unit>.<method>` resolves
   to a clone of that value.
3. Proxy fallback: any other property at any depth
   (`window.cth.features.newUnit.newMethod()`) is a callable that resolves to a
   safe default. `on*` subscribes and returns an unsubscribe, `*Sync` returns
   `null`, `list*`/`search*`/`history*` resolve `[]`, `has*`/`is*`/`can*`
   resolve `false`, and everything else resolves `{ ok: true }`. Each hit is
   counted in the sidecar.

Fixtures: `onboardingComplete: true` with `harnessHome` set, and a five-agent
roster served through `rosterReadSync()`, the boot-time roster file that the
zustand store adopts. The roster is Michael (god, Claude Opus), Dwight (Claude
Fable), Jim (Codex), Pam (Gemini) and Angela (Grok, waiting on a permission
prompt). Also included: every agent's PTY listed as live by `listPtys()`, a
seven-card task ledger with one open ASK-ME question, hive mail, routing log,
budget, house rules, notes, meetings, telemetry and git.

Subscriptions replay fixture events shortly after subscribing (see `events` in
`fixtures.mjs`): hook events that set statuses, context-gauge updates, a routed
message, and ANSI terminal output per PTY through `onPtyData`. Delivery uses a
macrotask, like IPC, so a throwing listener shows up as an uncaught page error.

The init script also sets `localStorage` before the app reads it:
- `cth.theme` and `cth.language`;
- `cth.ws.route` (workspace/store.ts) for `--route`;
- `cth.rosterHome`;
- `cth.skipHivePickerOnce`, so the floor renders instead of the HivePicker.

The skip flag is pinned for the page's life. App.tsx removes it inside a
`useState` initializer, and React StrictMode (dev) runs that initializer twice.

## Limitations

- No real PTY: terminal output is canned ANSI from `fixtures.ptyOutput`, and
  writes go nowhere. There is no Electron, `contextBridge`, IPC or main
  process, so main-side behavior (spawning, the hive router, the Stapler's
  native windows) is never exercised.
- The Pixi floor runs on WebGL via SwiftShader (CPU). It works (the renderer
  string is in the sidecar), but this container renders it at about 2–4 fps.
  Pixi clamps each frame to 100 ms, so agents take minutes of wall clock to walk
  in from the door. `--advance` captures the floor's Pixi Application through
  Pixi's own devtools hook (`globalThis.__PIXI_APP_INIT__`). It steps that app's
  ticker by the given simulated time with rendering detached, then renders once.
  An exception from a ticker listener is reported as a page error. If the floor
  fails to initialize WebGL, that also shows up as a page or console error, and
  the note "fast-forwarded N Pixi app(s)" is missing from the sidecar.
- The Stapler windows are transparent in Electron. Their PNGs keep the
  transparency (`omitBackground`) at the full 1440×900 viewport, so the puck is a
  small shape in the top-left corner.
- The dev server runs with HMR and file watching off: other people save files
  under `src/` constantly, and a mid-shot reload would make shots flaky. Each run
  compiles a fresh snapshot of the tree. Deps are pre-bundled into
  `tools/screenshot-harness/.vite-cache` (git-ignored), separate from
  `npm run dev`'s cache.
- Dev-mode React (StrictMode double effects, dev warnings), not the production
  bundle.

## Adding fixtures for a new `window.cth.features.*` method

1. Run `node tools/screenshot-harness/mock-cth.mjs --coverage`. It re-reads the
   preload and lists every member answered only by the fallback.
2. If the result is static, add it to `fixtures.mjs`:
   ```js
   features: { tasks: { activity: { ok: true, ledgerId: 'h-…', activity: {…} } } }
   ```
   Every call then resolves to a fresh clone of that value.
3. If it depends on arguments or state, add it to the unit's object in
   `createCthTree` (mock-cth.mjs), e.g. `features.capabilities.state(ids)`.
   That function is serialized into the page, so use only its locals (`fx`,
   `host`, `res`, `ok`, `on`, …), never module-scope imports.
4. For a subscription such as `onThing`, use `on('features.<unit>.onThing')` (the
   fallback already does this for unknown `on*` names). To push an event, add
   `{ channel: 'features.<unit>.onThing', delayMs: 500, payload: {…} }` to
   `events` in `fixtures.mjs`, or call `host.emit(path, payload)` from a mock
   (for example after a write).
5. Re-run the shot and check that `fallbackCalls` in the sidecar no longer lists it.

## Files

| File | |
| --- | --- |
| `vite.config.mjs` | standalone Vite config (+ the CSP `transformIndexHtml` plugin), port 5190 |
| `mock-cth.mjs` | the mock `window.cth`, the init-script builder, `--coverage` |
| `fixtures.mjs` | all fixture data (`buildFixtures({ mode, theme, platform, version, now })`) |
| `shoot.mjs` | one shot (CLI), plus `startHarness()` / `shoot()` for scripts |
| `shoot-all.mjs` | the standard set and the summary table |
| `package.json` | pins `playwright-core` locally; root `package.json` and lockfile are untouched |

Chromium: `$CTH_CHROMIUM`, else the newest
`$PLAYWRIGHT_BROWSERS_PATH/chromium-NNNN/chrome-linux/chrome`, where
`PLAYWRIGHT_BROWSERS_PATH` defaults to `/opt/pw-browsers`. Elsewhere, run
`npx playwright-core install chromium` inside this folder and Playwright's own
lookup is used. First-time setup in this folder: `npm install --no-audit --no-fund`.
