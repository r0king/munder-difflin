/**
 * Standalone Vite config that serves the renderer (src/renderer) in a plain
 * browser — the same aliases, `define` and React plugin as the `renderer`
 * section of electron.vite.config.ts, without electron-vite.
 *
 * Usable on its own (`npx vite --config tools/screenshot-harness/vite.config.mjs`,
 * then open http://127.0.0.1:5190/ — you will need a `window.cth` though, see
 * mock-cth.mjs), but normally started programmatically by shoot.mjs.
 *
 * Both renderer entries are reachable: /index.html (the app) and
 * /stapler.html#puck|#overlay (the Stapler's windows).
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
export const HARNESS_PORT = 5190;

const CSP_META = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i;

/**
 * The renderer's HTML entries carry a strict CSP meta (`script-src 'self'`).
 * Under the Vite DEV server that blocks @vitejs/plugin-react's inline
 * react-refresh preamble (every component module then throws "can't detect
 * preamble"). The Playwright init script itself is unaffected (CDP injection
 * bypasses page CSP).
 *
 *   relax (default): keep the policy, add only what Vite dev needs —
 *                    'unsafe-inline' on script-src and the dev server's ws:
 *                    origin on connect-src. 'unsafe-eval' stays OUT, so a
 *                    production-only CSP break (eval / new Function) still
 *                    shows up as a violation in the sidecar.
 *   strip:           remove the CSP meta entirely.
 *   keep:            serve it untouched (expect the preamble error).
 *
 * Only the served HTML changes; src/renderer/*.html are never edited.
 */
export function harnessCspPlugin(mode = 'relax', port = HARNESS_PORT) {
  return {
    name: 'cth-harness-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (mode === 'keep') return html;
        if (mode === 'strip') return html.replace(CSP_META, '<!-- CSP stripped by the screenshot harness -->');
        return html.replace(CSP_META, (_m, content) => {
          const directives = content.split(';').map((d) => d.trim()).filter(Boolean);
          const patched = directives.map((d) => {
            const [name] = d.split(/\s+/);
            if (name === 'script-src') return `${d} 'unsafe-inline'`;
            if (name === 'connect-src') return `${d} ws://127.0.0.1:${port} http://127.0.0.1:${port}`;
            return d;
          });
          return `<meta http-equiv="Content-Security-Policy" content="${patched.join('; ')};" data-cth-harness="relaxed" />`;
        });
      }
    }
  };
}

/**
 * @param {object} [opts]
 * @param {'relax'|'strip'|'keep'} [opts.csp]
 * @param {number} [opts.port]
 * @param {boolean} [opts.watch] watch src/ for changes (default false: other
 *        engineers save files under src/ all the time, and a mid-shot reload
 *        would make the screenshot flaky; each harness run starts a fresh server)
 * @param {string} [opts.logLevel]
 */
export function createHarnessConfig(opts = {}) {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'));
  const port = opts.port ?? HARNESS_PORT;
  return {
    configFile: false,
    root: resolve(REPO_ROOT, 'src/renderer'),
    // Same place electron-vite reads `.env` from (the project root).
    envDir: REPO_ROOT,
    // A cache of our own, so the harness never fights `npm run dev` over
    // node_modules/.vite while it re-optimises deps.
    cacheDir: resolve(HERE, '.vite-cache'),
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    plugins: [react(), harnessCspPlugin(opts.csp ?? 'relax', port)],
    resolve: {
      alias: {
        '@': resolve(REPO_ROOT, 'src/renderer/src'),
        '@brand': resolve(REPO_ROOT, 'docs'),
        '@shared': resolve(REPO_ROOT, 'src/shared')
      }
    },
    server: {
      port,
      strictPort: true,
      host: '127.0.0.1',
      hmr: opts.watch ? undefined : false,
      watch: opts.watch ? undefined : null,
      // @brand (docs/) and @shared (src/shared/) live outside the Vite root.
      fs: { allow: [REPO_ROOT] }
    },
    optimizeDeps: {
      // Crawl BOTH entries up front so a dependency first seen on the second
      // page does not trigger a re-optimise + full reload mid-run.
      entries: ['index.html', 'stapler.html']
    },
    build: {
      outDir: resolve(HERE, 'out', 'build'),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(REPO_ROOT, 'src/renderer/index.html'),
          stapler: resolve(REPO_ROOT, 'src/renderer/stapler.html')
        }
      }
    },
    clearScreen: false,
    logLevel: opts.logLevel ?? 'error'
  };
}

export default defineConfig(createHarnessConfig());
