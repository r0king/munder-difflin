#!/usr/bin/env node
/**
 * One screenshot of the renderer in headless Chromium, with a mocked
 * `window.cth` (no Electron, no PTYs). Writes `<out>.png` and `<out>.json`
 * (console errors/warnings, uncaught page errors mapped to src/ file:line,
 * failed requests, CSP violations, which bridge calls hit the mock fallback).
 *
 *   node tools/screenshot-harness/shoot.mjs --mode workspace --route tasks --theme dark
 *   node tools/screenshot-harness/shoot.mjs --entry stapler --hash puck
 *
 * Exit code: 0 clean · 1 uncaught page error (PNG still written) · 2 harness
 * failure (server, browser or navigation).
 *
 * Also importable: `startHarness()` + `shoot(harness, options)` (shoot-all.mjs).
 */
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer as createNetServer } from 'node:net';
import sourceMapJs from 'source-map-js';
import { createHarnessConfig, HARNESS_PORT } from './vite.config.mjs';
import { buildFixtures } from './fixtures.mjs';
import { buildInitScript, REPO_ROOT } from './mock-cth.mjs';

const { SourceMapConsumer } = sourceMapJs;
const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = join(HERE, 'out');

// ─── Options ────────────────────────────────────────────────────────────────

export const DEFAULTS = {
  entry: 'index',          // 'index' | 'stapler'
  mode: undefined,         // 'classic' | 'workspace' (default classic; --route implies workspace)
  theme: 'light',
  route: undefined,        // workspace route (JSON or shorthand)
  hash: undefined,         // stapler.html#<hash>: puck | overlay | dictate
  platform: 'darwin',
  lang: 'en',
  viewport: '1440x900',
  settle: 3000,            // ms after load + network idle
  advance: undefined,      // ms of office-floor (Pixi) time to fast-forward; default 15000 for the index entry, else 0
  timeout: 45000,
  csp: 'keep',             // CSP meta of the served HTML: keep | relax | strip (vite.config.mjs)
  seed: 1337,              // Math.random seed, or 'off'
  events: true,            // fire fixture subscription events
  staplerEnabled: false,
  keepPicker: false,       // show the HivePicker instead of skipping it
  onboarding: false,       // onboardingComplete:false → the onboarding wizard
  out: undefined
};

/** 'agents' · 'agent:dwight' · 'orchestrator:routing' · 'inbox:needs-you' ·
 *  'memory:budget' · or a JSON WorkspaceRoute. */
export function parseRoute(input) {
  if (!input) return undefined;
  const s = String(input).trim();
  if (s.startsWith('{')) return JSON.parse(s);
  const [kind, ...rest] = s.split(':');
  const param = rest.join(':');
  const key = { agent: 'agentId', orchestrator: 'tab', capabilities: 'tab', inbox: 'section', memory: 'query' }[kind];
  if (kind === 'agent' && !param) throw new Error('route "agent" needs an id: agent:<id>');
  return key && param ? { kind, [key]: param } : { kind };
}

function routeLabel(route) {
  if (!route) return '';
  const extra = route.agentId ?? route.tab ?? route.section ?? route.query;
  return extra ? `${route.kind}-${String(extra).replace(/[^\w-]+/g, '_')}` : route.kind;
}

export function defaultName(o) {
  if (o.entry === 'stapler') return `stapler-${o.hash || 'puck'}-${o.theme}`;
  const mode = o.mode ?? (o.route ? 'workspace' : 'classic');
  const r = parseRoute(o.route);
  return [mode, routeLabel(r), o.onboarding ? 'onboarding' : o.keepPicker ? 'picker' : '', o.theme].filter(Boolean).join('-');
}

// ─── Chromium ───────────────────────────────────────────────────────────────

// The pre-installed Chromium: $CTH_CHROMIUM, else the newest
// <PLAYWRIGHT_BROWSERS_PATH>/chromium-NNNN/chrome-linux/chrome, else
// <PLAYWRIGHT_BROWSERS_PATH>/chromium (a symlink here), else Playwright's own lookup.
export function findChromium() {
  if (process.env.CTH_CHROMIUM) return process.env.CTH_CHROMIUM;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    const dirs = readdirSync(base).filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const p = join(base, d, rel);
        if (existsSync(p)) return p;
      }
    }
    if (existsSync(join(base, 'chromium')) && statSync(join(base, 'chromium')).isFile()) return join(base, 'chromium');
  } catch { /* no browsers dir */ }
  return undefined;
}

export const CHROMIUM_ARGS = [
  // WebGL for the Pixi office floor + xterm's WebGL renderer, on the CPU.
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  // Software compositing: SwiftShader is then used for WebGL canvases only,
  // not for every composited layer (Workspace pages go from ~1-6 fps to 60).
  '--disable-gpu-compositing',
  '--disable-dev-shm-usage',
  '--no-proxy-server',
  '--font-render-hinting=none',
  '--hide-scrollbars'
];

// ─── Harness lifecycle ──────────────────────────────────────────────────────

/** Start the Vite dev server + Chromium once; shoot() as many times as needed. */
/** Resolve with whether 127.0.0.1:<port> can be bound right now. */
function portFree(port) {
  return new Promise((resolvePort) => {
    const probe = createNetServer();
    probe.once('error', () => resolvePort(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolvePort(true)));
  });
}

/** 5190 unless taken — several engineers run the harness at once — then the
 *  next free port up to 5209. An explicit port (option, --port or
 *  $CTH_HARNESS_PORT) is used as is, strictly. */
async function pickPort(explicit) {
  if (explicit) return Number(explicit);
  for (let p = HARNESS_PORT; p < HARNESS_PORT + 20; p++) if (await portFree(p)) return p;
  return HARNESS_PORT; // let Vite report the clash
}

export async function startHarness({ csp = DEFAULTS.csp, port = process.env.CTH_HARNESS_PORT, logLevel = 'error', quiet = false, chromiumArgs = CHROMIUM_ARGS, executablePath = findChromium() } = {}) {
  const t0 = Date.now();
  port = await pickPort(port);
  const server = await createServer(createHarnessConfig({ csp, port, logLevel }));
  await server.listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true, args: chromiumArgs });
  } catch (err) {
    await server.close();
    throw err;
  }
  if (!quiet) console.log(`[harness] vite ${baseUrl} (csp: ${csp}) · chromium ${browser.version()} ${executablePath ?? '(playwright default)'} · up in ${Date.now() - t0}ms`);
  const mapper = new StackMapper(baseUrl);
  return {
    server, browser, baseUrl, csp, mapper,
    async close() {
      await browser.close().catch(() => {});
      await server.close().catch(() => {});
    }
  };
}

// ─── Source mapping (served URL:line:col → src/... file:line) ───────────────

class StackMapper {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cache = new Map();
  }

  /** Repo-relative file for a served URL (no source map needed). */
  servedPath(url) {
    if (!url || !url.startsWith(this.baseUrl)) return url || '';
    const path = decodeURIComponent(new URL(url).pathname);
    if (path.startsWith('/@fs/')) return relative(REPO_ROOT, path.slice(4));
    if (path.startsWith('/node_modules/')) return `src/renderer${path}`;
    return `src/renderer${path}`;
  }

  async consumer(url) {
    const key = url.replace(/[?#].*$/, '') + (url.includes('?') ? '?' + url.split('?')[1].replace(/&?t=\d+/, '') : '');
    if (this.cache.has(key)) return this.cache.get(key);
    const job = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const code = await res.text();
        const m = /\/\/# sourceMappingURL=(\S+)\s*$/m.exec(code.slice(-200_000));
        if (!m) return null;
        let raw;
        if (m[1].startsWith('data:')) {
          raw = Buffer.from(m[1].slice(m[1].indexOf(',') + 1), 'base64').toString('utf8');
        } else {
          const mapRes = await fetch(new URL(m[1], url));
          if (!mapRes.ok) return null;
          raw = await mapRes.text();
        }
        return new SourceMapConsumer(JSON.parse(raw));
      } catch {
        return null;
      }
    })();
    this.cache.set(key, job);
    return job;
  }

  /** `line` is 1-based, `col` 0-based (stack-trace convention minus one). */
  async map(url, line, col) {
    const fallback = { file: this.servedPath(url), line, col: col + 1, mapped: false };
    if (!url || !url.startsWith(this.baseUrl)) return fallback;
    const c = await this.consumer(url);
    if (!c) return fallback;
    const pos = c.originalPositionFor({ line, column: Math.max(0, col) });
    if (!pos || !pos.source) return fallback;
    let src = pos.source;
    if (src.startsWith('file://')) src = fileURLToPath(src);
    const abs = isAbsolute(src) ? src : resolve(dirname(join(REPO_ROOT, fallback.file)), src);
    const file = abs.startsWith(REPO_ROOT) ? relative(REPO_ROOT, abs) : src;
    return { file, line: pos.line, col: (pos.column ?? 0) + 1, mapped: true };
  }

  /** Map every `url:line:col` in a V8 stack. Returns the mapped stack text and
   *  the first frame inside the repo's own src/ (the "points to" location). */
  async mapStack(stack) {
    if (!stack) return { stack: '', at: null };
    const frameRe = /(https?:\/\/[^\s()]+?):(\d+):(\d+)/g;
    const jobs = [];
    for (const m of stack.matchAll(frameRe)) jobs.push(this.map(m[1], Number(m[2]), Number(m[3]) - 1).then((r) => [m[0], r]));
    const mapped = await Promise.all(jobs);
    let text = stack;
    let at = null;
    for (const [orig, r] of mapped) {
      const loc = `${r.file}:${r.line}:${r.col}`;
      text = text.replace(orig, loc);
      if (!at && /^src\//.test(r.file) && !r.file.includes('node_modules')) at = loc;
    }
    if (!at && mapped.length) at = `${mapped[0][1].file}:${mapped[0][1].line}:${mapped[0][1].col}`;
    return { stack: text, at };
  }
}

// ─── One shot ───────────────────────────────────────────────────────────────

function normalise(options) {
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) };
  if (o.hash && o.entry === 'index' && options.entry === undefined) o.entry = 'stapler';
  if (o.entry === 'stapler' && !o.hash) o.hash = 'puck';
  o.route = parseRoute(o.route);
  o.mode = o.mode ?? (o.route ? 'workspace' : 'classic');
  const [w, h] = String(o.viewport).split(/[x×,]/).map(Number);
  o.width = w || 1440;
  o.height = h || 900;
  o.settle = Number(o.settle);
  o.advance = o.advance === undefined ? (o.entry === 'index' ? 15000 : 0) : Number(o.advance) || 0;
  o.timeout = Number(o.timeout);
  o.seed = o.seed === 'off' || o.seed === false ? null : Number(o.seed);
  o.events = !(o.events === false || o.events === 'off' || o.events === 'false');
  for (const [k, allowed] of Object.entries({ entry: ['index', 'stapler'], mode: ['classic', 'workspace'], theme: ['light', 'dark'], csp: ['keep', 'relax', 'strip'] })) {
    if (!allowed.includes(o[k])) throw new Error(`--${k} must be one of ${allowed.join('|')} (got "${o[k]}")`);
  }
  return o;
}

/**
 * @returns {Promise<object>} the sidecar object (also written to <out>.json)
 */
export async function shoot(harness, options = {}) {
  const o = normalise(options);
  const name = options.name || defaultName({ ...o, route: options.route });
  const pngPath = resolve(o.out ? (isAbsolute(o.out) ? o.out : resolve(process.cwd(), o.out)) : join(OUT_DIR, `${name}.png`));
  const jsonPath = pngPath.replace(/\.png$/i, '') + '.json';
  mkdirSync(dirname(pngPath), { recursive: true });
  const t0 = Date.now();

  // ── Mock + localStorage ──
  const version = harness.server.config.define?.__APP_VERSION__ ? JSON.parse(harness.server.config.define.__APP_VERSION__) : '0.0.0';
  const fixtures = buildFixtures({ mode: o.mode, theme: o.theme, platform: o.platform, version, staplerEnabled: o.staplerEnabled });
  if (o.onboarding) fixtures.config.onboardingComplete = false;
  // Programmatic only: tweak the fixtures for one shot (a state to capture,
  // or a deliberately broken payload to prove an error path).
  if (typeof options.patchFixtures === 'function') options.patchFixtures(fixtures);
  const localStorage = {
    'cth.theme': o.theme,
    'cth.language': o.lang,
    // Same hive as fixtures.harnessHome, so the roster file is adopted.
    'cth.rosterHome': fixtures.harnessHome
  };
  if (!o.keepPicker) localStorage['cth.skipHivePickerOnce'] = '1';
  if (o.route) localStorage['cth.ws.route'] = JSON.stringify(o.route);
  const initScript = buildInitScript({
    fixtures,
    localStorage,
    options: { seed: o.seed, events: o.events, pinSkipHivePicker: !o.keepPicker, name }
  });

  const url = o.entry === 'stapler'
    ? `${harness.baseUrl}/stapler.html#${o.hash}`
    : `${harness.baseUrl}/index.html`;

  const context = await harness.browser.newContext({
    viewport: { width: o.width, height: o.height },
    deviceScaleFactor: 1,
    colorScheme: o.theme,
    locale: o.lang === 'en' ? 'en-US' : o.lang,
    timezoneId: 'UTC'
  });
  await context.addInitScript({ content: initScript });
  const page = await context.newPage();

  // ── Collectors ──
  let navigation = 0;
  const pending = [];
  const pageErrors = [];
  const consoleErrors = [];
  const consoleWarnings = [];
  const failedRequests = [];
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigation += 1; });
  page.on('pageerror', (err) => {
    const nav = navigation;
    pending.push(harness.mapper.mapStack(err.stack || '').then(({ stack, at }) => {
      pageErrors.push({ navigation: nav, message: err.message, at, stack: stack.split('\n').slice(0, 25).join('\n') });
    }));
  });
  // Chromium asks every page for /favicon.ico; stapler.html sets no icon and
  // Electron never makes that request, so its 404 is harness noise.
  const isFaviconNoise = (url) => /\/favicon\.ico(\?|$)/.test(url || '');
  page.on('console', (msg) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const nav = navigation;
    const loc = msg.location() || {};
    if (isFaviconNoise(loc.url)) return;
    const job = (async () => {
      const where = await harness.mapper.map(loc.url, (loc.lineNumber ?? 0) + 1, loc.columnNumber ?? 0);
      // An Error passed to console.error carries the stack that matters.
      let errStack = null;
      for (const arg of msg.args().slice(0, 4)) {
        try {
          const s = await arg.evaluate((v) => (v instanceof Error ? String(v.stack || v.message) : null));
          if (s) { errStack = s; break; }
        } catch { /* handle gone after a navigation */ }
      }
      const mappedErr = errStack ? await harness.mapper.mapStack(errStack) : null;
      const entry = {
        navigation: nav,
        text: msg.text().slice(0, 4000),
        at: mappedErr?.at ?? (loc.url ? `${where.file}:${where.line}:${where.col}` : null),
        logged: loc.url ? `${where.file}:${where.line}:${where.col}` : null
      };
      if (mappedErr) entry.stack = mappedErr.stack.split('\n').slice(0, 15).join('\n');
      (type === 'error' ? consoleErrors : consoleWarnings).push(entry);
    })();
    pending.push(job);
  });
  page.on('requestfailed', (req) => {
    const failure = req.failure()?.errorText ?? 'failed';
    // An aborted request on teardown / reload is noise.
    if (/ERR_ABORTED/.test(failure)) return;
    failedRequests.push({ navigation, url: req.url(), failure });
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && !isFaviconNoise(res.url())) failedRequests.push({ navigation, url: res.url(), status: res.status() });
  });

  // ── Load ──
  const notes = [];
  let harnessError = null;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: o.timeout });
    await page.waitForLoadState('networkidle', { timeout: o.timeout }).catch(() => notes.push('network never went idle'));
    if (o.entry === 'index') {
      await page.waitForFunction(() => !document.getElementById('cth-splash'), null, { timeout: Math.min(o.timeout, 20000) })
        .catch(() => notes.push('the boot splash was still showing (React never rendered?)'));
    }
    await page.waitForTimeout(o.settle);
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    if (o.advance > 0) {
      const nav = navigation;
      const advanced = await page.evaluate((ms) => {
        try { return { apps: window.__cthHarness.advancePixi(ms) }; } catch (e) { return { error: String((e && e.stack) || e) }; }
      }, o.advance);
      if (advanced.error) {
        // Thrown by the app's own ticker listeners: a real app error.
        const { stack, at } = await harness.mapper.mapStack(advanced.error);
        pageErrors.push({ navigation: nav, message: `(while fast-forwarding the office floor) ${advanced.error.split('\n')[0]}`, at, stack: stack.split('\n').slice(0, 25).join('\n') });
      } else if (advanced.apps > 0) {
        notes.push(`fast-forwarded ${advanced.apps} Pixi app(s) by ${o.advance}ms of simulated time`);
        await page.waitForTimeout(600);
      }
    }
  } catch (err) {
    harnessError = String(err?.message ?? err);
  }

  // ── Capture ──
  let pngBytes = 0;
  try {
    const buf = await page.screenshot({ path: pngPath, fullPage: false, omitBackground: o.entry === 'stapler', animations: 'allow', timeout: 20000 });
    pngBytes = buf.length;
  } catch (err) {
    harnessError = harnessError ?? `screenshot failed: ${String(err?.message ?? err)}`;
  }

  let probe = {};
  try {
    probe = await page.evaluate(() => {
      const H = window.__cthHarness || {};
      let webgl = null;
      try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        if (gl) {
          const dbg = gl.getExtension('WEBGL_debug_renderer_info');
          webgl = { version: gl.getParameter(gl.VERSION), renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
        }
      } catch { /* none */ }
      const root = document.getElementById('root');
      return {
        title: document.title,
        theme: document.documentElement.dataset.cthTheme ?? null,
        rootChildren: root ? root.childElementCount : 0,
        canvases: document.querySelectorAll('canvas').length,
        textSample: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400),
        webgl,
        fallback: H.fallback || {},
        calls: H.calls || {},
        mockErrors: H.mockErrors || [],
        csp: H.csp || [],
        listeners: H.listeners ?? null
      };
    });
  } catch (err) {
    notes.push(`page probe failed: ${String(err?.message ?? err)}`);
  }
  await Promise.allSettled(pending);
  await context.close().catch(() => {});

  // Only the final navigation counts; an earlier one (e.g. Vite re-optimising
  // deps and reloading) is reported separately.
  const finalNav = navigation;
  const current = (list) => list.filter((e) => e.navigation === finalNav);
  const earlier = (list) => list.filter((e) => e.navigation !== finalNav);
  if (navigation > 1) notes.push(`page navigated ${navigation} times (a Vite dependency re-optimise reloads the page once on a cold cache)`);

  const sidecar = {
    name,
    url,
    options: { entry: o.entry, mode: o.mode, theme: o.theme, route: o.route ?? null, hash: o.hash ?? null, platform: o.platform, lang: o.lang, viewport: `${o.width}x${o.height}`, csp: o.csp, seed: o.seed, settle: o.settle, advance: o.advance },
    png: relative(REPO_ROOT, pngPath),
    pngBytes,
    durationMs: Date.now() - t0,
    ok: !harnessError && current(pageErrors).length === 0,
    harnessError,
    notes,
    pageErrors: current(pageErrors),
    consoleErrors: current(consoleErrors),
    consoleWarnings: current(consoleWarnings).slice(0, 50),
    failedRequests: failedRequests.filter((r) => r.navigation === finalNav),
    cspViolations: probe.csp ?? [],
    mockErrors: probe.mockErrors ?? [],
    fallbackCalls: probe.fallback ?? {},
    page: { title: probe.title, theme: probe.theme, rootChildren: probe.rootChildren, canvases: probe.canvases, webgl: probe.webgl, textSample: probe.textSample },
    bridgeCalls: probe.calls ?? {},
    earlierNavigations: navigation > 1 ? { pageErrors: earlier(pageErrors), consoleErrors: earlier(consoleErrors) } : undefined
  };
  writeFileSync(jsonPath, JSON.stringify(sidecar, null, 2));
  sidecar.jsonPath = jsonPath;
  sidecar.pngPath = pngPath;
  return sidecar;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

export function describeShot(r) {
  const head = `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}  ${(r.pngBytes / 1024).toFixed(0)}KB  console errors: ${r.consoleErrors.length}  uncaught: ${r.pageErrors.length}  (${r.durationMs}ms)`;
  const lines = [head];
  if (r.harnessError) lines.push(`     harness: ${r.harnessError}`);
  for (const e of r.pageErrors) lines.push(`     uncaught: ${e.message.split('\n')[0]}  @ ${e.at ?? '?'}`);
  for (const e of r.consoleErrors.slice(0, 6)) lines.push(`     console.error: ${e.text.split('\n')[0].slice(0, 160)}  @ ${e.at ?? '?'}`);
  if (r.consoleErrors.length > 6) lines.push(`     … ${r.consoleErrors.length - 6} more console errors in ${relative(process.cwd(), r.jsonPath)}`);
  for (const n of r.notes) lines.push(`     note: ${n}`);
  return lines.join('\n');
}

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string' }, theme: { type: 'string' }, route: { type: 'string' },
      entry: { type: 'string' }, hash: { type: 'string' }, out: { type: 'string' },
      platform: { type: 'string' }, lang: { type: 'string' }, viewport: { type: 'string' },
      settle: { type: 'string' }, advance: { type: 'string' }, timeout: { type: 'string' }, csp: { type: 'string' },
      seed: { type: 'string' }, events: { type: 'string' }, port: { type: 'string' },
      'stapler-enabled': { type: 'boolean' }, 'keep-picker': { type: 'boolean' }, onboarding: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  });
  if (values.help) {
    console.log(`usage: node tools/screenshot-harness/shoot.mjs [options]
  --entry index|stapler        which HTML entry (default index)
  --mode classic|workspace     uiMode in the mocked config (default classic; --route implies workspace)
  --route <r>                  agents | agent:<id> | orchestrator[:tab] | tasks | inbox[:section] |
                               automations | memory[:query] | capabilities[:tab] | stapler | '<json>'
  --hash puck|overlay|dictate  stapler.html#<hash> (implies --entry stapler)
  --theme light|dark           (default light)
  --out <file.png>             (default tools/screenshot-harness/out/<name>.png)
  --platform darwin|linux|win32  window.cth.platform (default darwin)
  --lang en|zh-CN|ar  --viewport 1440x900  --settle <ms>  --timeout <ms>
  --advance <ms>               fast-forward the Pixi office floor by <ms> of simulated time
                               before the shot (default 15000 for --entry index, 0 = off)
  --csp keep|relax|strip       how the served HTML's CSP meta is treated (default keep = the real policy)
  --seed <n>|off  --events on|off  --stapler-enabled  --keep-picker  --onboarding
  --port <n>                   dev-server port (default 5190, or the next free one up to 5209)`);
    return 0;
  }
  const options = {
    mode: values.mode, theme: values.theme, route: values.route, entry: values.entry, hash: values.hash,
    out: values.out, platform: values.platform, lang: values.lang, viewport: values.viewport,
    settle: values.settle, advance: values.advance, timeout: values.timeout, csp: values.csp, seed: values.seed, events: values.events,
    staplerEnabled: values['stapler-enabled'], keepPicker: values['keep-picker'], onboarding: values.onboarding
  };
  normalise(options); // validate before starting anything
  let harness;
  try {
    harness = await startHarness({ csp: values.csp ?? DEFAULTS.csp, port: values.port });
  } catch (err) {
    console.error(`[harness] failed to start: ${err?.stack ?? err}`);
    return 2;
  }
  try {
    const r = await shoot(harness, options);
    console.log(describeShot(r));
    console.log(`     → ${relative(process.cwd(), r.pngPath)} + .json`);
    if (r.harnessError) return 2;
    return r.pageErrors.length ? 1 : 0;
  } finally {
    await harness.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((code) => process.exit(code), (err) => { console.error(err?.stack ?? err); process.exit(2); });
}
