/**
 * Tailscale Serve integration (#hosting): publish the web UI to the user's
 * tailnet with real HTTPS, zero inbound firewall rules, and no third-party
 * tunnel service.
 *
 * Why this shape: the web UI (src/main/webui.ts) deliberately binds LOOPBACK
 * by default and demands a bearer token for any wider bind, because plain
 * HTTP puts that token on the wire. Tailscale Serve dissolves the dilemma:
 * `tailscale serve` proxies a tailnet-only HTTPS URL (automatic valid certs)
 * to a loopback port, so the app keeps its loopback posture and the browser
 * still reaches it from anywhere in the tailnet — https://machine.tailnet.ts.net.
 *
 * This module is a THIN, total-functions wrapper around the `tailscale` CLI:
 *  - every command is a pure argv builder (unit-testable, no shell string
 *    interpolation — args go to execFile, never through a shell);
 *  - status parsing is a pure function over `serve status --json` output,
 *    defensive by design (the JSON shape has drifted across CLI versions);
 *  - the runner is injectable so tests drive every path without a CLI.
 * The Electron-facing wiring (IPC handlers, web UI start/stop) lives in
 * index.ts. No Electron value imports here — this stays loadable under plain
 * Node, same contract as webui.ts.
 */
import { execFile } from 'node:child_process';

/** The CLI argv that publishes `port` as a background serve. */
export function buildServeOnArgv(port: number): string[] {
  return ['serve', '--bg', String(port)];
}

/** The argv list tried, in order, to unpublish. `serve reset` clears every
 *  serve entry (fine: this app owns the only one it creates); the targeted
 *  `--https=443 off` form is the fallback for CLIs where reset is unavailable. */
export function buildServeOffArgvList(): string[][] {
  return [['serve', 'reset'], ['serve', '--https=443', 'off']];
}

export interface TailscaleServeStatus {
  /** The `tailscale` CLI exists on PATH. */
  installed: boolean;
  /** A serve entry is currently active. */
  serving: boolean;
  /** The public https URL serve publishes (first https URL in the status). */
  url: string | null;
  /** This machine's tailnet DNS name, when resolvable. */
  dnsName: string | null;
}

const EMPTY_STATUS: TailscaleServeStatus = { installed: false, serving: false, url: null, dnsName: null };

/**
 * Parse `tailscale serve status --json` output. Deliberately lenient: the
 * schema moved between releases (`isServing` boolean, `ServeConfig` map, plain
 * text fallback), so this trusts only what it can see — any https URL string,
 * plus an explicit serving flag when present.
 */
export function parseServeStatus(output: string): { serving: boolean; url: string | null } {
  let flag: boolean | null = null;
  try {
    const json = JSON.parse(output) as Record<string, unknown>;
    for (const [k, v] of Object.entries(json)) {
      if (/^isserving$/i.test(k)) flag = v === true;
    }
  } catch {
    // Plain-text mode ("https://machine.ts.net (serve)"), or garbage — fall
    // through to the regex, which is the one thing every format shares.
  }
  const m = output.match(/https:\/\/[a-z0-9.-]+/i);
  if (m) return { serving: true, url: m[0] };
  return { serving: flag === true, url: null };
}

/** Pull this machine's tailnet DNS name from `tailscale status --json`
 *  (`Self.DNSName`, trailing dot stripped). Null when anything is missing. */
export function parseDnsName(output: string): string | null {
  try {
    const json = JSON.parse(output) as { Self?: { DNSName?: string } };
    const name = json.Self?.DNSName?.replace(/\.+$/, '');
    return name || null;
  } catch { return null; }
}

export interface RunResult { code: number; stdout: string; stderr: string }

/** Injectable runner contract — execFile-shaped, promisified. */
export type Runner = (argv: string[]) => Promise<RunResult>;

/** Real runner: locate the CLI on PATH and run it (never through a shell). */
export function makeNodeRunner(cli: string, cwd?: string): Runner {
  return (argv) => new Promise((resolvePromise) => {
    execFile(cli, argv, { timeout: 15_000, cwd }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException).code === 'number'
        ? (err as unknown as { code: number }).code
        : (err ? 1 : 0);
      resolvePromise({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** Full status read. Two CLI calls, each best-effort; a missing CLI yields the
 *  EMPTY status rather than an error, which is what the toggle checks first. */
export async function readTailscaleStatus(run: Runner): Promise<TailscaleServeStatus> {
  let serveOut: string;
  try {
    const r = await run(['serve', 'status', '--json']);
    if (r.code !== 0 && !r.stdout.trim()) return EMPTY_STATUS; // CLI missing or broken
    serveOut = r.stdout;
  } catch { return EMPTY_STATUS; }
  const { serving, url } = parseServeStatus(serveOut);
  let dnsName: string | null = null;
  try {
    const r = await run(['status', '--json']);
    if (r.code === 0) dnsName = parseDnsName(r.stdout);
  } catch { /* tailnet name is cosmetic — the serve URL already carries it */ }
  return { installed: true, serving, url, dnsName };
}

/** Publish the given (already-running, loopback) web UI port. Returns the
 *  public https URL when one can be read back from status. */
export async function enableServe(port: number, run: Runner): Promise<{ ok: boolean; url?: string; error?: string }> {
  let r: RunResult;
  try { r = await run(buildServeOnArgv(port)); } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (r.code !== 0) {
    const err = (r.stderr || r.stdout || 'tailscale serve failed').trim();
    return { ok: false, error: err.split('\n')[0] };
  }
  const status = await readTailscaleStatus(run);
  return { ok: true, url: status.url ?? undefined };
}

/** Unpublish. Both off-forms are attempted before giving up. */
export async function disableServe(run: Runner): Promise<{ ok: boolean; error?: string }> {
  let lastError = 'tailscale serve off failed';
  for (const argv of buildServeOffArgvList()) {
    let r: RunResult;
    try { r = await run(argv); } catch (e) { lastError = e instanceof Error ? e.message : String(e); continue; }
    if (r.code === 0) return { ok: true };
    lastError = (r.stderr || r.stdout || lastError).trim().split('\n')[0];
  }
  return { ok: false, error: lastError };
}
