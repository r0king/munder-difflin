# Devices Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Devices: a moved agent keeps its conversation, "Runs on: Auto" places fresh starts on the least-loaded machine, Check catches a missing base folder and WSL2 gaps, god and the other engines run on devices, and the phone-first control page is wired into the app.

**Architecture:** Everything builds on phase 1's `DeviceLink` (`exec` over the SSH master) and `spawnAgentCore`. `exec` gains a stdin argument, which carries transcripts and engine hook files to a device. Placement and the conversation copy happen once, at the start of `spawnAgentCore`, so every spawn path (hire, restart, restore, god's spawn requests) gets them. The control page module (`remoteFloor.ts`) is already built; phase 2 adds the `FloorSource` adapter, a "today" cost figure, the restart round-trip to the renderer, and the Settings toggle.

**Tech Stack:** Electron main process (TypeScript), node-pty, the OpenSSH client (`-O forward`), React + zustand + react-i18next in the renderer, `node:test` for tests.

**Spec:** `docs/superpowers/specs/2026-10-29-devices-phase2-design.md`. It builds on `docs/superpowers/specs/2026-10-29-devices-design.md` and `docs/superpowers/plans/2026-10-29-devices.md` (phase 1). Read the phase 2 spec before any task.

## Global Constraints

- Worktree `/home/royal/Pro/Zensible/munder-difflin-wt/devices`, branch `feat/devices`. Every path below is relative to it. A task built in a parallel worktree (see "Parallel groups") uses its own path wherever `/home/royal/Pro/Zensible/munder-difflin-wt/devices` appears.
- Phase 2 starts after phase 1 Tasks 1–12 are merged. Several anchors below quote code that phase 1 Tasks 10 and 11 add. Each such anchor says so.
- Follow the spec exactly. macOS devices stay out of scope. Voice needs no code (spec §7).
- Placement: candidates are this laptop plus every online device whose last Check passed. Load is `load1 / cores`, and a candidate qualifies below **1.5**. The pick is the qualifying candidate with the most MemAvailable; if none qualifies, the most MemAvailable overall. **Ties go to this laptop.** Running agents are never moved.
- Device command for load, exactly: `cat /proc/loadavg; nproc; grep MemAvailable /proc/meminfo`. On this laptop: `os.loadavg()`, `os.cpus().length`, `os.freemem()`.
- Conversation copy: `~/.claude/projects/<projectKey(cwd)>/<sid>.jsonl`, same path on both machines. Device to device passes through this laptop. The text when it cannot be copied, in English: `conversation stayed on <device> (<reason>); started fresh`.
- The base folder is the parent of the hive home: `dirname(harnessHome)`, which is `dirname(dirname(hive.root()))`. Fixes, exactly: `sudo ln -s /home/<user> /home/royal` (same layout, other user) and `sudo mkdir -p /home/royal/Pro && sudo ln -s <their folder> /home/royal/Pro/Zensible` (other layout).
- Engines allowed on a device: `claude`, `codex`, `antigravity` (agy), `grok`, `qwen`, `crush`, `custom`. Anything else is refused on a device with a clear error.
- Proxy ports on the device: `base+3`, `base+4`, … in the order engines need them, each on the device's loopback.
- Control page: config `remoteFloorEnabled` (default off) and `remoteFloorPort` (default **47980**). It never binds anything but this laptop's Tailscale IPv4 (`remoteFloor.ts` does that).
- **Test gate.** Several Claude sessions share this machine. Every `Run:` line that runs tests is written out in full and starts with the gate. If it prints `BUSY`, wait with a bounded until-loop (the Monitor tool, at most 10 minutes) and re-run the same line. Never kill another session's run. Never `pkill -f` or `pgrep -f`. One test file at a time.
- **Shared lock.** Tests and type-checks run through `flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock <cmd>`, exactly as each `Run:` line shows.
- Unit tests never SSH anywhere real. They use `test/fake-ssh.cjs`. Real machines appear only in Task 10, which is manual.
- Commits: run the gate first, because a hooked commit counts as a suite. Stage explicit paths only (`git -C <wt> add -- <paths>`). Commit with `git -C <wt> commit -m '<subject>' -m '<body>' -m '<attribution>'`. The two attribution lines go in ONE `-m`, exactly as each commit step shows. Never `--no-verify`, never push.
- Code style: match the surrounding comment density. This codebase's block comments say *why*.
- Every new user-facing string goes through i18n in `en`, `ar` and `zh-CN`. `test/arabic-ui.test.cjs` must keep passing: same key tree, no Arabic string equal to its English source, and every `{{var}}` kept.

## Review Focus

The five failure modes most likely to bite a person using this, each pinned by a test in the task that owns the code:

1. **A transcript full of multi-byte characters (emoji, CJK) is copied off a device.** Per-chunk `toString()` turns a character split across two pipe reads into two replacement characters, and `--resume` then reads a corrupted conversation. The copy must be byte for byte. Pinned in Task 1: "device → laptop: … byte for byte".
2. **An Auto agent's roster entry says `device: "auto"`, not a device id.** Without care, reconcile kills its tmux session on every reconnect (`rosterAgentsOn` matches nothing), the card greys out forever (`'auto'` is not an online device), and Settings lets you remove the device it runs on. Pinned in Task 2: "an Auto agent counts as on the device it last ran on".
3. **A proxy-tier agent (qwen, crush) on a device after its link drops and comes back.** A new ControlMaster starts with only its three forwards, so the sidecar's `-O forward` is gone and every LLM call fails. The link must re-add it on every connect. Pinned in Task 7: "forwards come back after a reconnect".
4. **A device whose `~/.gemini/config/hooks.json` already holds other tools' hooks, or garbage.** Installing agy's hooks there must keep every other key, and replace an unparseable file rather than crash the spawn, exactly as it does on this laptop. Pinned in Task 6: "the home-file merge keeps other keys and survives garbage".
5. **Today's cost after an app restart in the middle of the day, and across midnight.** Ledger rows are cumulative per session, and they reset when the app restarts. A naive "sum today's rows" or "last minus first" is wrong in both cases. Pinned in Task 8: "a counter reset today still counts both halves" and "yesterday's spend is not today's".

---

## File map

| File | Tasks | Responsibility in phase 2 |
|---|---|---|
| `src/shared/devices.ts` | 1, 2, 3, 5, 6, 7 | `ConversationStayed`, `AUTO_DEVICE`, new check item ids, `DEVICE_PROVIDERS`, `usageUnavailableOnDevice`. |
| `src/main/deviceCommands.ts` | 1, 2, 3, 5, 6, 7 | Pure builders: transcript read/write, load, pick, base path, WSL probe, engine check, home-file write/merge, `-O forward`. |
| `src/main/devices.ts` | 1, 2, 3, 5, 6, 7 | `exec` stdin, `copyTranscript`, `readLoad`/`localLoad`, base-path fix on mount failure, Check items, `remoteTerminal` command, forwards. |
| `src/main/hive.ts` | 2, 6, 7 | god prompt and COMMANDS.md, `RemoteHome`, agy/grok/codex hooks on a device, shim port mode, proxy port mapping. |
| `src/main/index.ts` | 1, 2, 4, 6, 7, 9 | Spawn: move/copy, Auto, god guard, engines; Check bookkeeping; control page wiring. |
| `src/main/costLifetime.ts` | 8 | `usdTodayFor`. |
| `src/main/remoteFloorSource.ts` (new) | 8 | `FloorActivity`, `createFloorSource`. |
| `src/main/config.ts`, `src/preload/index.ts`, `src/renderer/src/store/config.ts` | 1, 2, 9 | Spawn result types; `remoteFloorEnabled`, `remoteFloorPort`; control page IPC. |
| Renderer: `store/devices.ts`, `store/store.ts`, `workspace/agents/restartAgent.ts`, `components/EditAgentModal.tsx`, `components/AddAgentModal.tsx`, `components/AgentStrip.tsx`, `components/AgentCard.tsx`, `components/DevicesSettings.tsx`, `hooks/useHive.ts` | 1–7 | Move restart, Auto choice and tag, god warning, reminders, engine names, usage line. |
| Renderer (new): `components/RemoteFloorSettings.tsx`, `hooks/useRemoteRestart.ts`; edit `App.tsx` | 9 | Control page toggle and the restart listener. |
| Locales `src/renderer/src/i18n/locales/{en,ar,zh-CN}.json` | 1–7, 9 | New strings. |
| `docs/devices-wsl2.md` (new) | 5 | The WSL2 setup guide. |
| `test/fake-ssh.cjs` | 1 | Pass stdin through to the fake device. |
| Tests (new) | 1–9 | `transcript-copy`, `auto-placement`, `device-base-path`, `god-on-device`, `device-wsl`, `devices-engines`, `devices-proxy`, `cost-today`, `remote-floor-source`, `remote-floor-config`. |

## Parallel groups

- **Group A, in order: Tasks 1 → 2 → 3 → 4 → 5 → 6 → 7.** They share `deviceCommands.ts`, `devices.ts`, `shared/devices.ts`, `index.ts`'s spawn path and the locales. Each later task's anchors quote the text the earlier one leaves, so they must run in this order, in one worktree.
- **Group B: Task 8, then Task 9.** The spec calls the control page "the most independent item". It can run in its own worktree, alongside Group A.
  - **Task 8 touches no file that Group A touches:** `costLifetime.ts`, the new `remoteFloorSource.ts`, and two new tests.
  - **Task 9 shares four files with Group A, in small anchored edits:** `index.ts` (new blocks next to `hookServer`, `control:autoDelivery`, `hive.setRoutedObserver`, `writeFleetSnapshot`, `onConfigWritten`, `bootstrapHiveServices` and the quit list, none of which Group A edits), `src/preload/index.ts` (a new block before `// ─── Dialog`), `DevicesSettings.tsx` (one line at its end) and the three locale files (a new top-level `remoteFloor` key).
  - Merge Group B after Group A, or rebase it. Conflicts, if any, are adjacent-line ones.
- **Task 10 (manual acceptance)** runs last, on the merged branch.

---

### Task 1: Copy the conversation when an agent moves

**Files:**
- Modify: `src/shared/devices.ts` (append `ConversationStayed`)
- Modify: `src/main/deviceCommands.ts` (append the transcript commands)
- Modify: `src/main/devices.ts` (imports; `exec`/`run`/`spawnSsh` take stdin and decode UTF-8 as a stream; append `copyTranscript`)
- Modify: `src/main/index.ts` (imports; `spawnAgentCore`)
- Modify: `src/preload/index.ts` (`spawnPty` result type)
- Modify: `src/renderer/src/store/devices.ts` (append `conversationStayedText`)
- Modify: `src/renderer/src/workspace/agents/restartAgent.ts`
- Modify: `src/renderer/src/components/EditAgentModal.tsx` (the move restart phase 1 Task 10 added)
- Modify: the three locale files
- Modify: `test/fake-ssh.cjs` (stdin reaches the fake device; big outputs)
- Test: `test/transcript-copy.test.cjs`

**Interfaces:**
- Consumes: `DeviceLink`, `ExecResult` (phase 1 Task 4); `projectKey(cwd)` (`transcript.ts`); `shq` (phase 1 Task 2); `restartAgentProcess`, `RestartOptions` (renderer); `fakeDevice`, `waitForState` (`test/fake-ssh.cjs`).
- Produces:
  - `interface ConversationStayed { device: string; reason: 'offline' | 'missing' | 'failed' }` in `src/shared/devices.ts`. `device` is a device id, or `'local'` for this laptop.
  - In `deviceCommands.ts`: `TRANSCRIPT_MISSING = 3`, `readTranscriptCommand(cwd: string, sessionId: string): string`, `writeTranscriptCommand(cwd: string, sessionId: string): string`.
  - `DeviceLink.exec(cmd: string, timeoutMs = 15_000, input?: string): Promise<ExecResult>`. `input` is fed to the remote command's stdin.
  - `type TranscriptCopyResult = { ok: true } | { ok: false; reason: ConversationStayed['reason'] }` and `copyTranscript(from: DeviceLink | undefined, to: DeviceLink | undefined, cwd: string, sessionId: string, home?: string): Promise<TranscriptCopyResult>` in `devices.ts`. `undefined` means this laptop.
  - In `spawnAgentCore` (`index.ts`): `const prevDevice: string | undefined`, `const moved: boolean`, `let conversationStayed: ConversationStayed | undefined`. The spawn result gains `conversationStayed?: ConversationStayed`.
  - `RestartOptions.moved?: boolean` (renderer). `conversationStayedText(t, s: ConversationStayed): string` in `store/devices.ts`.
  - i18n keys `devices.conversationStayed`, `devices.stayedReason.{offline,missing,failed}`.

- [ ] **Step 1: Let the fake device read stdin (`test/fake-ssh.cjs`)**

In the `FAKE_SSH` template, replace

```js
  const r = spawnSync('sh', ['-c', a[a.indexOf('--') + 1]], { stdio: ['ignore', 'pipe', 'inherit'] });
```
with
```js
  const r = spawnSync('sh', ['-c', a[a.indexOf('--') + 1]], { stdio: ['inherit', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
```

Commands that send no input are unaffected: `DeviceLink` gives them `/dev/null` as stdin.

- [ ] **Step 2: Write the failing test**

Create `test/transcript-copy.test.cjs`:

```js
'use strict';
/**
 * Devices phase 2, item 1: a moved agent's conversation file follows it.
 * Routing (laptop → device, device → laptop, device → device), the offline
 * and missing fallbacks, and byte-exact unicode, against fake devices
 * (test/fake-ssh.cjs). Nothing here touches the network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { fakeDevice, waitForState } = require('./fake-ssh.cjs');

const { DeviceLink, copyTranscript } = loadTs('src/main/devices.ts');
const { projectKey } = loadTs('src/main/transcript.ts');
const { conversationStayedText } = loadTs('src/renderer/src/store/devices.ts');

const CWD = '/home/royal/Pro/Zensible/repo-x';
const SID = '0f3c2a9e-1111-4222-8333-944455556666';
const file = (home) => path.join(home, '.claude', 'projects', projectKey(CWD), `${SID}.jsonl`);
const put = (home, body) => {
  fs.mkdirSync(path.dirname(file(home)), { recursive: true });
  fs.writeFileSync(file(home), body);
};
// About 1 MB of lines full of 3- and 4-byte characters behind a 1-byte lead,
// so the pipe's chunk boundaries land inside a character somewhere.
const BODY = 'x' + Array.from({ length: 3000 }, (_, i) =>
  JSON.stringify({ i, text: '😀€中文 '.repeat(20) })).join('\n') + '\n';

function tmpHome(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'md-copy-home-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function online(t, f, id) {
  const link = new DeviceLink({ id, host: '100.65.189.1' }, f.env);
  t.after(() => link.stop());
  link.start();
  await waitForState(link, 'online');
  return link;
}

test('laptop → device: the file lands at the same path in the device home', async (t) => {
  const f = fakeDevice(t);
  const link = await online(t, f, 'my-lap');
  const home = tmpHome(t);
  put(home, BODY);
  assert.deepEqual(await copyTranscript(undefined, link, CWD, SID, home), { ok: true });
  assert.equal(fs.readFileSync(file(f.home), 'utf8'), BODY);
  assert.deepEqual(fs.readdirSync(path.dirname(file(f.home))), [`${SID}.jsonl`], 'no .part file left behind');
});

test('device → laptop: copied byte for byte, multi-byte characters included', async (t) => {
  const f = fakeDevice(t);
  const link = await online(t, f, 'my-lap');
  const home = tmpHome(t);
  put(f.home, BODY);
  assert.deepEqual(await copyTranscript(link, undefined, CWD, SID, home), { ok: true });
  assert.ok(fs.readFileSync(file(home)).equals(Buffer.from(BODY, 'utf8')));
});

test('device → device: read from one, written to the other', async (t) => {
  const a = fakeDevice(t);
  const b = fakeDevice(t);
  const from = await online(t, a, 'my-lap');
  const to = await online(t, b, 'big-box');
  put(a.home, BODY);
  assert.deepEqual(await copyTranscript(from, to, CWD, SID, tmpHome(t)), { ok: true });
  assert.equal(fs.readFileSync(file(b.home), 'utf8'), BODY);
});

test('the old device is offline: nothing is copied, reason offline', async (t) => {
  const f = fakeDevice(t);
  const link = new DeviceLink({ id: 'my-lap', host: '100.65.189.1' }, f.env); // never started
  const home = tmpHome(t);
  assert.deepEqual(await copyTranscript(link, undefined, CWD, SID, home), { ok: false, reason: 'offline' });
  assert.equal(fs.existsSync(file(home)), false);
});

test('the file is missing on either side: reason missing', async (t) => {
  const f = fakeDevice(t);
  const link = await online(t, f, 'my-lap');
  assert.deepEqual(await copyTranscript(link, undefined, CWD, SID, tmpHome(t)), { ok: false, reason: 'missing' });
  assert.deepEqual(await copyTranscript(undefined, link, CWD, SID, tmpHome(t)), { ok: false, reason: 'missing' });
});

test('a session id that is not one never becomes a path', async (t) => {
  const f = fakeDevice(t);
  const link = await online(t, f, 'my-lap');
  assert.deepEqual(await copyTranscript(undefined, link, CWD, '../../etc/passwd', tmpHome(t)), { ok: false, reason: 'missing' });
});

test('the floor says where the conversation stayed, in the spec words', () => {
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/i18n/locales/en.json'), 'utf8'));
  const t = (k, o = {}) => k.split('.').reduce((x, p) => x?.[p], en).replace(/\{\{(\w+)\}\}/g, (_, v) => o[v]);
  assert.equal(conversationStayedText(t, { device: 'my-lap', reason: 'offline' }), 'conversation stayed on my-lap (offline); started fresh');
  assert.equal(conversationStayedText(t, { device: 'local', reason: 'missing' }), 'conversation stayed on This laptop (not found); started fresh');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/transcript-copy.test.cjs; fi`
Expected: FAIL, `copyTranscript is not a function`.

- [ ] **Step 4: `ConversationStayed` (`src/shared/devices.ts`)**

Append at the end of the file:

```ts

/** A moved agent whose conversation could not follow it (devices phase 2,
 *  item 1): where it stayed (`local` = this laptop) and why. The agent
 *  started fresh, and the floor says so. */
export interface ConversationStayed {
  device: string;
  reason: 'offline' | 'missing' | 'failed';
}
```

- [ ] **Step 5: The transcript commands (`src/main/deviceCommands.ts`)**

Append at the end of the file:

```ts

// ─── Moving an agent: its conversation file (devices phase 2, item 1) ────────

/** readTranscriptCommand's exit code when the file is not there. */
export const TRANSCRIPT_MISSING = 3;

function projectDirSh(cwd: string): string {
  return `"$HOME"/.claude/projects/${shq(projectKey(cwd))}`;
}

/** Print a session's transcript, or exit TRANSCRIPT_MISSING. */
export function readTranscriptCommand(cwd: string, sessionId: string): string {
  const f = `${projectDirSh(cwd)}/${shq(`${sessionId}.jsonl`)}`;
  return `[ -f ${f} ] || exit ${TRANSCRIPT_MISSING}; cat ${f}`;
}

/** Write stdin as a session's transcript. It goes through a temp file, so a
 *  link cut mid-copy never leaves half a conversation where `--resume`
 *  would find it. */
export function writeTranscriptCommand(cwd: string, sessionId: string): string {
  const d = projectDirSh(cwd);
  const part = `${d}/${shq(`.${sessionId}.jsonl.part`)}`;
  return `mkdir -p ${d} && cat > ${part} && mv -f ${part} ${d}/${shq(`${sessionId}.jsonl`)}`;
}
```

- [ ] **Step 6: `exec` takes stdin and decodes UTF-8 as a stream; `copyTranscript` (`src/main/devices.ts`)**

Imports:
- Replace `import { tmpdir, userInfo } from 'node:os';` with `import { homedir, tmpdir, userInfo } from 'node:os';`.
- Replace `import { dirname } from 'node:path';` with `import { dirname, join } from 'node:path';`.
- In the `import { … } from 'node:fs';` line, add `readFileSync` to the braces and keep everything already there.
- In the `import { … } from '../shared/devices';` line, add `type ConversationStayed` to the braces.
- In the `import { … } from './deviceCommands';` list, add `readTranscriptCommand, TRANSCRIPT_MISSING, writeTranscriptCommand`.
- After that import, add `import { projectKey } from './transcript';`.

Replace

```ts
  exec(cmd: string, timeoutMs = 15_000): Promise<ExecResult> {
```
with
```ts
  exec(cmd: string, timeoutMs = 15_000, input?: string): Promise<ExecResult> {
```

and in its body replace `    return this.run(cmd, timeoutMs);` with `    return this.run(cmd, timeoutMs, input);`.

Replace

```ts
  private async run(cmd: string, timeoutMs: number): Promise<ExecResult> {
    const r = await this.spawnSsh(execArgs(this.ctl(), this.target(), cmd), timeoutMs);
```
with
```ts
  private async run(cmd: string, timeoutMs: number, input?: string): Promise<ExecResult> {
    const r = await this.spawnSsh(execArgs(this.ctl(), this.target(), cmd), timeoutMs, input);
```

Replace

```ts
  private spawnSsh(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
```
with
```ts
  private spawnSsh(args: string[], timeoutMs: number, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
```

Replace

```ts
      const p = spawn(this.sshBin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.env.sshEnv });
```
with
```ts
      const p = spawn(this.sshBin, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], env: this.env.sshEnv });
      if (input !== undefined) {
        // ssh may die before reading it all; its exit reports that, not this.
        p.stdin?.on('error', () => { /* reported by close */ });
        p.stdin?.end(input);
      }
```

Replace

```ts
      p.stdout?.on('data', (d) => { stdout += d.toString(); });
```
with
```ts
      // One decoder for the whole stream: a multi-byte character split
      // across two reads would become two U+FFFD with a per-chunk toString().
      p.stdout?.setEncoding('utf8');
      p.stdout?.on('data', (d: string) => { stdout += d; });
```

Append at the end of the file:

```ts

// ─── Moving an agent: its conversation file (devices phase 2, item 1) ────────

export type TranscriptCopyResult = { ok: true } | { ok: false; reason: ConversationStayed['reason'] };

/** Claude's session ids are UUIDs. Anything else never becomes a path. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A transcript is a few MB; over Tailscale that takes seconds. */
const COPY_TIMEOUT_MS = 120_000;

function localTranscript(home: string, cwd: string, sessionId: string): string {
  return join(home, '.claude', 'projects', projectKey(cwd), `${sessionId}.jsonl`);
}

/** Copy `~/.claude/projects/<projectKey(cwd)>/<sid>.jsonl` from where the
 *  agent ran to where it is about to run: this laptop (`undefined`) or a
 *  device, at the same path. Device to device passes through this laptop.
 *  `home` is this laptop's home folder (a test seam). */
export async function copyTranscript(
  from: DeviceLink | undefined,
  to: DeviceLink | undefined,
  cwd: string,
  sessionId: string,
  home: string = homedir()
): Promise<TranscriptCopyResult> {
  if (!SESSION_ID.test(sessionId)) return { ok: false, reason: 'missing' };
  let body: string;
  if (from) {
    if (from.state !== 'online') return { ok: false, reason: 'offline' };
    const r = await from.exec(readTranscriptCommand(cwd, sessionId), COPY_TIMEOUT_MS);
    if (r.code === TRANSCRIPT_MISSING) return { ok: false, reason: 'missing' };
    // -1: the command never ran or never finished, i.e. the link went down.
    if (!r.ok) return { ok: false, reason: r.code === -1 ? 'offline' : 'failed' };
    body = r.stdout;
  } else {
    try { body = readFileSync(localTranscript(home, cwd, sessionId), 'utf8'); }
    catch { return { ok: false, reason: 'missing' }; }
  }
  if (to) {
    const w = await to.exec(writeTranscriptCommand(cwd, sessionId), COPY_TIMEOUT_MS, body);
    return w.ok ? { ok: true } : { ok: false, reason: 'failed' };
  }
  try {
    const dest = localTranscript(home, cwd, sessionId);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(`${dest}.part`, body);
    renameSync(`${dest}.part`, dest);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}
```

- [ ] **Step 7: `conversationStayedText` (`src/renderer/src/store/devices.ts`)**

Replace `import type { DeviceStatus } from '@shared/devices';` with `import { LOCAL_DEVICE, type ConversationStayed, type DeviceStatus } from '@shared/devices';`.

Append at the end of the file:

```ts

/** The card caption when a moved agent's conversation could not follow it. */
export function conversationStayedText(
  t: (key: string, opts?: Record<string, unknown>) => string,
  s: ConversationStayed
): string {
  return t('devices.conversationStayed', {
    device: s.device === LOCAL_DEVICE ? t('devices.thisLaptop') : s.device,
    reason: t(`devices.stayedReason.${s.reason}`)
  });
}
```

- [ ] **Step 8: The strings, in all three locales**

Run once, from the worktree:

```bash
cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && node - <<'EOF'
const fs = require('fs');
const dir = 'src/renderer/src/i18n/locales/';
const add = {
  en: { devices: {
    conversationStayed: 'conversation stayed on {{device}} ({{reason}}); started fresh',
    stayedReason: { offline: 'offline', missing: 'not found', failed: 'copy failed' },
    restartsHint: 'Changing it restarts the agent there; its conversation is copied over.'
  } },
  ar: { devices: {
    conversationStayed: 'بقيت المحادثة على {{device}} ({{reason}})؛ بدأ من جديد',
    stayedReason: { offline: 'غير متصل', missing: 'غير موجودة', failed: 'فشل النسخ' },
    restartsHint: 'تغييره يعيد تشغيل الوكيل هناك، وتُنسخ محادثته معه.'
  } },
  'zh-CN': { devices: {
    conversationStayed: '对话留在了 {{device}}（{{reason}}）；已重新开始',
    stayedReason: { offline: '离线', missing: '未找到', failed: '复制失败' },
    restartsHint: '更改后会在那里重启该智能体，并复制其对话。'
  } }
};
const merge = (b, a) => { for (const [k, v] of Object.entries(a)) { if (v && typeof v === 'object') { b[k] = b[k] || {}; merge(b[k], v); } else b[k] = v; } };
for (const [loc, obj] of Object.entries(add)) {
  const f = dir + loc + '.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  merge(j, obj);
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
}
EOF
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/transcript-copy.test.cjs; fi`
Expected: PASS, 7 tests.

- [ ] **Step 10: Copy on a move, in `spawnAgentCore` (`src/main/index.ts`)**

(a) Imports. Change `import { DeviceRegistry, checkDevice, remoteTerminal, type DeviceLink } from './devices';` so the braces also hold `copyTranscript`. In the `import { … } from '../shared/devices';` line, add `type ConversationStayed`.

(b) Replace the signature line

```ts
async function spawnAgentCore(opts: AgentSpawnOptions, owner: Electron.WebContents | null): Promise<{ ok: boolean; error?: string; cwd?: string; worktreePath?: string; resumeNotFound?: boolean; resumed?: boolean; seedPrompt?: string }> {
```
with
```ts
async function spawnAgentCore(opts: AgentSpawnOptions, owner: Electron.WebContents | null): Promise<{ ok: boolean; error?: string; cwd?: string; worktreePath?: string; resumeNotFound?: boolean; resumed?: boolean; seedPrompt?: string; conversationStayed?: ConversationStayed }> {
```

(c) Immediately after

```ts
  const deviceId = opts.hive
    ? normalizeDeviceId(opts.hive.device !== undefined ? opts.hive.device : hive.registry().agents[opts.hive.id]?.device)
    : undefined;
```
insert
```ts
  // Where it ran last time (registry.json, written by the previous spawn).
  // A different place is a move, and a move brings its conversation along
  // (devices phase 2, item 1).
  const prevDevice = opts.hive ? normalizeDeviceId(hive.registry().agents[opts.hive.id]?.device) : undefined;
  const moved = !!opts.hive && !!hive.registry().agents[opts.hive.id] && prevDevice !== deviceId;
  let conversationStayed: ConversationStayed | undefined;
```

(d) In the Claude resume block, replace

```ts
    if (sid && !args.includes('--resume')) {
      // On a device the transcript must already be there: copying one in from
      // another folder (seedSessionTranscript) is a laptop-only step.
      const present = link
        ? (await link.exec(transcriptExistsCommand(opts.cwd, sid))).ok
        : seedSessionTranscript(opts.cwd, sid);
```
with
```ts
    if (sid && !args.includes('--resume')) {
      // A move: copy the conversation from where it ran. When that fails (the
      // old device is offline, the file is missing) the agent starts fresh
      // and the floor says so, rather than resume an older copy that may sit
      // on the new machine from an earlier stay.
      let copied = true;
      if (moved) {
        const from = prevDevice ? devices.get(prevDevice) : undefined;
        const c = prevDevice && !from
          ? { ok: false as const, reason: 'offline' as const } // the device was removed from Settings
          : await copyTranscript(from, link, opts.cwd, sid);
        if (!c.ok) {
          copied = false;
          conversationStayed = { device: prevDevice ?? LOCAL_DEVICE, reason: c.reason };
          console.warn(`[devices] conversation ${sid} stayed on ${prevDevice ?? 'this laptop'} (${c.reason}); starting fresh`);
        }
      }
      // On a device the transcript must already be there: copying one in from
      // another folder (seedSessionTranscript) is a laptop-only step.
      const present = copied && (link
        ? (await link.exec(transcriptExistsCommand(opts.cwd, sid))).ok
        : seedSessionTranscript(opts.cwd, sid));
```

(e) Other engines keep their sessions in their own places (spec §1 covers Claude's file), so a moved non-Claude agent starts fresh. Replace

```ts
  if (opts.hive && !claudeProvider) {
```
(the generic resume block that follows the Claude one) with
```ts
  // A moved non-Claude agent starts fresh: its engine's session store is not
  // the file spec §1 copies, and resuming an id the new machine lacks fails.
  if (opts.hive && !claudeProvider && !moved) {
```

(f) A conversation that stayed behind is a fresh start, not a failed resume. Replace `  if (opts.requireResume === true && !didResume) {` with `  if (opts.requireResume === true && !didResume && !conversationStayed) {`.

(g) In the final `return { ...res, cwd: opts.cwd, …` line of `spawnAgentCore`, replace `...(seedPrompt ? { seedPrompt } : {}) };` with `...(seedPrompt ? { seedPrompt } : {}), ...(conversationStayed ? { conversationStayed } : {}) };`.

- [ ] **Step 11: The spawn result type (`src/preload/index.ts`)**

In the `import type { … } from '../shared/devices';` line, add `ConversationStayed`. In the `spawnPty:` member, replace `resumed?: boolean; seedPrompt?: string }> =>` with `resumed?: boolean; seedPrompt?: string; conversationStayed?: ConversationStayed }> =>`.

- [ ] **Step 12: A move restarts with resume (`restartAgent.ts`, `EditAgentModal.tsx`)**

`src/renderer/src/workspace/agents/restartAgent.ts`:
- After `import { roleForHiveSpawn } from '@shared/agentRole';` add `import i18n from '@/i18n';` and `import { conversationStayedText } from '@/store/devices';`.
- Replace

```ts
  /** Resume if possible, else start fresh instead of failing. */
  resumeOptional?: boolean;
}
```
with
```ts
  /** Resume if possible, else start fresh instead of failing. */
  resumeOptional?: boolean;
  /** The agent changed device (Edit → Runs on). Main copies its
   *  conversation from the old machine, so a transcript missing HERE is no
   *  reason to give up before asking. */
  moved?: boolean;
}
```
- Replace `      else if (provider === 'claude' && !a.device && !(await window.cth.resolveSessionCwd(resumeSessionId))) {` (phase 1 Task 10's line) with `      else if (provider === 'claude' && !a.device && !opts.moved && !(await window.cth.resolveSessionCwd(resumeSessionId))) {`.
- Replace `    if (resume && res.resumed !== true) throw new RestartRefused('resumeRefused');` with

```ts
    // A conversation that stayed on an unreachable machine is a fresh start
    // main chose on purpose (and the caption says so), not a refusal.
    if (resume && res.resumed !== true && !res.conversationStayed) throw new RestartRefused('resumeRefused');
```
- Replace

```ts
      action: resume
        ? 'continuing…'
        : provider === previousProvider ? 'restarting…' : `switching to ${providerPreset(provider).label}…`
    });
    return { ok: true, resumed: resume };
```
with
```ts
      action: res.conversationStayed
        ? conversationStayedText((k, o) => String(i18n.t(k, o)), res.conversationStayed)
        : res.resumed === true
          ? 'continuing…'
          : provider === previousProvider ? 'restarting…' : `switching to ${providerPreset(provider).label}…`
    });
    return { ok: true, resumed: res.resumed === true };
```

`src/renderer/src/components/EditAgentModal.tsx`: replace phase 1 Task 10's

```tsx
    // A move restarts the agent on its new device with a fresh session. The
    // conversation stays where it ran; memory.md is in the shared hive, so it
    // carries over. Stopping it on the old device is the restart's own kill.
    if ((device || undefined) !== (agent.device || undefined) && agent.ptyId) {
      void restartAgentProcess(agent.id);
    }
```
with
```tsx
    // A move restarts the agent on its new device and continues its
    // conversation: main copies the transcript across (devices phase 2,
    // item 1), or starts fresh and says why. Stopping it on the old device
    // is the restart's own kill.
    if ((device || undefined) !== (agent.device || undefined) && agent.ptyId) {
      void restartAgentProcess(agent.id, { resume: true, resumeOptional: true, moved: true });
    }
```

- [ ] **Step 13: Type-check**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock npm run typecheck`
Expected: exits 0.

- [ ] **Step 14: Re-run the tests this touches, one line at a time**

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/devices-link.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/device-check.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/devices-ui.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/arabic-ui.test.cjs; fi`

Expected: all PASS.

- [ ] **Step 15: Commit**

```bash
git -C /home/royal/Pro/Zensible/munder-difflin-wt/devices add -- src/shared/devices.ts src/main/deviceCommands.ts src/main/devices.ts src/main/index.ts src/preload/index.ts src/renderer/src/store/devices.ts src/renderer/src/workspace/agents/restartAgent.ts src/renderer/src/components/EditAgentModal.tsx src/renderer/src/i18n/locales/en.json src/renderer/src/i18n/locales/ar.json src/renderer/src/i18n/locales/zh-CN.json test/fake-ssh.cjs test/transcript-copy.test.cjs
git -C /home/royal/Pro/Zensible/munder-difflin-wt/devices commit -m 'devices: a moved agent keeps its conversation' -m 'When an agent changes device, its transcript is copied to the same path on the new machine (laptop to device, device to laptop, or device to device through this laptop) and it resumes there. exec takes stdin and decodes UTF-8 as one stream. An offline old device or a missing file starts it fresh and the card says where the conversation stayed.' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G3wAo6k5J6tkH89c7qqJnG'
```

---

### Task 2: Automatic placement ("Runs on: Auto")

**Files:**
- Modify: `src/shared/devices.ts` (`AUTO_DEVICE`; `isValidDeviceId` refuses it)
- Modify: `src/main/deviceCommands.ts` (load command, parser, picker; `rosterAgentsOn`; `validateSpawnDevice`)
- Modify: `src/main/devices.ts` (`readLoad`, `localLoad`)
- Modify: `src/main/index.ts` (Check bookkeeping, `placeAuto`, `spawnAgentCore`, `processSpawnRequest`)
- Modify: `src/main/hive.ts` (god's prompt line and COMMANDS.md, both from phase 1 Task 11)
- Modify: `src/preload/index.ts` (`spawnPty` result, `HiveAgentMeta.device` comment, `onHiveAgentSpawned` record)
- Modify: `src/renderer/src/store/store.ts` (`Agent.lastDevice`)
- Modify: `src/renderer/src/store/devices.ts` (`effectiveDevice`, `deviceLabel`, `deviceInUse`)
- Modify: `src/renderer/src/components/AddAgentModal.tsx`, `EditAgentModal.tsx`, `AgentStrip.tsx`, `src/renderer/src/workspace/agents/restartAgent.ts`, `src/renderer/src/hooks/useHive.ts`
- Modify: the three locale files
- Modify: `test/god-devices.test.cjs` (phase 1 Task 11's prompt assertion)
- Test: `test/auto-placement.test.cjs`

**Interfaces:**
- Consumes: `conversationStayed`, `prevDevice`, `moved` (Task 1); `checkDevice`, `rosterAgentsOn`, the `devices:check` handler (phase 1 Tasks 8 and 9); `validateSpawnDevice`, `HiveManager.setDeviceIds`, `processSpawnRequest`'s `placement` (phase 1 Task 11); `AddAgentModal`/`EditAgentModal` "Runs on" (phase 1 Task 10).
- Produces:
  - `AUTO_DEVICE = 'auto'` in `src/shared/devices.ts`. No device may be named `auto`.
  - In `deviceCommands.ts`: `LOAD_COMMAND: string`; `interface LoadSample { id: string; load1: number; cores: number; memAvailable: number }` (bytes; `id` is a device id or `'local'`); `parseLoad(id: string, out: string): LoadSample | null`; `pickDevice(samples: LoadSample[]): string` (a device id or `'local'`).
  - `readLoad(link: DeviceLink): Promise<LoadSample | null>` and `localLoad(): LoadSample` in `devices.ts`.
  - In `index.ts`: `const deviceCheckOk: Map<string, boolean>`; `async function runDeviceCheck(id: string): Promise<DeviceCheckItem[]>`; `async function placeAuto(lastDevice: string | undefined, resuming: boolean): Promise<string | undefined>`; the spawn result gains `device?: string` (concrete; `''` = this laptop).
  - Renderer: `Agent.lastDevice?: string`; `effectiveDevice(device?: string, lastDevice?: string): string | undefined`; `deviceLabel(device: string | undefined, lastDevice: string | undefined, thisLaptop: string): string | undefined`; `deviceInUse(agents: Array<{ device?: string; lastDevice?: string }>, id: string): boolean`. The `hive:agentSpawned` record gains `lastDevice?: string`.
  - i18n keys `devices.auto`, `devices.autoHint`.

- [ ] **Step 1: Write the failing test**

Create `test/auto-placement.test.cjs`:

```js
'use strict';
/**
 * Devices phase 2, item 2: "Runs on: Auto". The load parser and the pick
 * rule with fixed inputs, the reserved id, and the places where an Auto
 * agent must count as being on the device it last ran on.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { fakeDevice, waitForState } = require('./fake-ssh.cjs');

const dc = loadTs('src/main/deviceCommands.ts');
const { DeviceLink, readLoad, localLoad } = loadTs('src/main/devices.ts');
const { isValidDeviceId, normalizeDevices } = loadTs('src/shared/devices.ts');
const { effectiveDevice, deviceLabel, deviceInUse, deviceOffline } = loadTs('src/renderer/src/store/devices.ts');

const GB = 1024 ** 3;
const s = (id, load1, cores, memGb) => ({ id, load1, cores, memAvailable: memGb * GB });

test('parseLoad reads loadavg, nproc and MemAvailable', () => {
  assert.deepEqual(dc.parseLoad('my-lap', '0.52 0.61 0.70 2/345 6789\n8\nMemAvailable:    8123456 kB\n'),
    { id: 'my-lap', load1: 0.52, cores: 8, memAvailable: 8123456 * 1024 });
  assert.equal(dc.parseLoad('my-lap', 'nonsense'), null);
  assert.equal(dc.parseLoad('my-lap', '0.5 0.5 0.5 1/1 1\n0\nMemAvailable: 1 kB\n'), null, 'zero cores');
});

test('pick: the calm candidate with the most memory', () => {
  assert.equal(dc.pickDevice([s('local', 14, 8, 1.3), s('my-lap', 2, 8, 9), s('big', 30, 8, 20)]), 'my-lap');
});

test('pick: nobody calm, so the most memory overall', () => {
  assert.equal(dc.pickDevice([s('local', 14, 8, 1.3), s('my-lap', 20, 8, 9), s('big', 30, 8, 20)]), 'big');
});

test('pick: load per core exactly 1.5 does not qualify', () => {
  assert.equal(dc.pickDevice([s('local', 12, 8, 2), s('my-lap', 11.9, 8, 1)]), 'my-lap');
});

test('pick: a tie goes to this laptop, wherever it sits in the list', () => {
  assert.equal(dc.pickDevice([s('my-lap', 1, 8, 4), s('local', 1, 8, 4)]), 'local');
  assert.equal(dc.pickDevice([s('local', 1, 8, 4), s('my-lap', 1, 8, 4)]), 'local');
  assert.equal(dc.pickDevice([]), 'local');
});

test('the load command reads real numbers on a (fake) device and here', async (t) => {
  const f = fakeDevice(t);
  const link = new DeviceLink({ id: 'my-lap', host: '100.65.189.1' }, f.env);
  t.after(() => link.stop());
  link.start();
  await waitForState(link, 'online');
  const r = await readLoad(link);
  assert.equal(r.id, 'my-lap');
  assert.ok(r.cores > 0 && r.memAvailable > 0 && r.load1 >= 0);
  const l = localLoad();
  assert.equal(l.id, 'local');
  assert.ok(l.cores > 0 && l.memAvailable > 0);
});

test('"auto" can never name a device', () => {
  assert.equal(isValidDeviceId('auto'), false);
  assert.deepEqual(normalizeDevices([{ id: 'auto', host: 'h' }, { id: 'my-lap', host: 'h' }]).map((d) => d.id), ['my-lap']);
});

test('an Auto agent counts as on the device it last ran on', () => {
  const roster = { agents: [
    { id: 'a1', cwd: '/r', device: 'auto', lastDevice: 'my-lap' },
    { id: 'a2', cwd: '/r', device: 'auto' },
    { id: 'a3', cwd: '/r', device: 'my-lap' }
  ] };
  assert.deepEqual(dc.rosterAgentsOn(roster, 'my-lap').map((a) => a.id), ['a1', 'a3']);
  assert.equal(effectiveDevice('auto', 'my-lap'), 'my-lap');
  assert.equal(effectiveDevice('auto', ''), undefined);
  assert.equal(effectiveDevice('my-lap', 'other'), 'my-lap');
  assert.equal(deviceInUse([{ device: 'auto', lastDevice: 'my-lap' }], 'my-lap'), true);
  const states = { 'my-lap': { id: 'my-lap', state: 'online' } };
  assert.equal(deviceOffline(effectiveDevice('auto', 'my-lap'), states), false);
  assert.equal(deviceOffline(effectiveDevice('auto', undefined), states), false, 'Auto on this laptop is never offline');
});

test('the card tag says where Auto put it', () => {
  assert.equal(deviceLabel('auto', 'my-lap', 'This laptop'), 'my-lap (auto)');
  assert.equal(deviceLabel('auto', '', 'This laptop'), 'This laptop (auto)');
  assert.equal(deviceLabel('my-lap', undefined, 'This laptop'), 'my-lap');
  assert.equal(deviceLabel(undefined, undefined, 'This laptop'), undefined);
});

test("god's spawn requests may say auto", () => {
  assert.deepEqual(dc.validateSpawnDevice('auto', {}), { device: 'auto' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/auto-placement.test.cjs; fi`
Expected: FAIL, `dc.parseLoad is not a function`.

- [ ] **Step 3: `AUTO_DEVICE` (`src/shared/devices.ts`)**

After `export const LOCAL_DEVICE = 'local';` add:

```ts
/** "Runs on: Auto" (devices phase 2, item 2): the place is picked at each
 *  fresh start. Stored on the roster entry; never a device id. */
export const AUTO_DEVICE = 'auto';
```

Replace

```ts
  return ID_RE.test(id) && id !== LOCAL_DEVICE && !taken.includes(id);
```
with
```ts
  return ID_RE.test(id) && id !== LOCAL_DEVICE && id !== AUTO_DEVICE && !taken.includes(id);
```

- [ ] **Step 4: Load, pick, roster and spawn requests (`src/main/deviceCommands.ts`)**

In the `import { … } from '../shared/devices';` line at the top, add `AUTO_DEVICE, LOCAL_DEVICE` to the braces.

In `rosterAgentsOn` (phase 1 Task 8), replace

```ts
    const { id, cwd, device } = a as Record<string, unknown>;
    if (typeof id === 'string' && device === deviceId) out.push(typeof cwd === 'string' ? { id, cwd } : { id });
```
with
```ts
    const { id, cwd, device, lastDevice } = a as Record<string, unknown>;
    // An Auto agent lives where it last ran: reconcile must keep its session,
    // and Check must cover its folder there.
    const on = device === AUTO_DEVICE ? lastDevice : device;
    if (typeof id === 'string' && on === deviceId) out.push(typeof cwd === 'string' ? { id, cwd } : { id });
```

In `validateSpawnDevice` (phase 1 Task 11), replace

```ts
  const id = normalizeDeviceId(device);
  if (!id) return {};
```
with
```ts
  const id = normalizeDeviceId(device);
  if (!id) return {};
  // Placed when the worker starts (index.ts placeAuto).
  if (id === AUTO_DEVICE) return { device: AUTO_DEVICE };
```

Append at the end of the file:

```ts

// ─── Automatic placement (devices phase 2, item 2) ───────────────────────────

/** One device's load, as the spec states it. */
export const LOAD_COMMAND = 'cat /proc/loadavg; nproc; grep MemAvailable /proc/meminfo';

/** One candidate machine. `id` is a device id, or 'local' for this laptop. */
export interface LoadSample {
  id: string;
  load1: number;
  cores: number;
  /** Bytes. */
  memAvailable: number;
}

export function parseLoad(id: string, out: string): LoadSample | null {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const load1 = parseFloat((lines[0] ?? '').split(/\s+/)[0]);
  const cores = parseInt(lines[1] ?? '', 10);
  const kb = /^MemAvailable:\s+(\d+)\s*kB/.exec(lines[2] ?? '');
  if (!Number.isFinite(load1) || !(cores > 0) || !kb) return null;
  return { id, load1, cores, memAvailable: Number(kb[1]) * 1024 };
}

/** Candidates under 1.5 load per core qualify; the one with the most free
 *  memory wins; if none qualifies, the most free memory overall. Ties go to
 *  this laptop, so an agent never crosses the network for nothing. */
export function pickDevice(samples: LoadSample[]): string {
  const calm = samples.filter((x) => x.load1 / x.cores < 1.5);
  const pool = calm.length ? calm : samples;
  let best: LoadSample | undefined;
  for (const x of pool) {
    if (!best || x.memAvailable > best.memAvailable || (x.memAvailable === best.memAvailable && x.id === LOCAL_DEVICE)) best = x;
  }
  return best?.id ?? LOCAL_DEVICE;
}
```

- [ ] **Step 5: Reading load (`src/main/devices.ts`)**

Replace `import { homedir, tmpdir, userInfo } from 'node:os';` (Task 1) with `import { cpus, freemem, homedir, loadavg, tmpdir, userInfo } from 'node:os';`. In the `'../shared/devices'` import braces add `LOCAL_DEVICE`. In the `./deviceCommands` import list add `LOAD_COMMAND, parseLoad, type LoadSample`.

Append at the end of the file:

```ts

// ─── Automatic placement (devices phase 2, item 2) ───────────────────────────

/** A device's load, or null when it did not answer (it is then no candidate). */
export async function readLoad(link: DeviceLink): Promise<LoadSample | null> {
  const r = await link.exec(LOAD_COMMAND, 10_000);
  return r.ok ? parseLoad(link.id, r.stdout) : null;
}

/** This laptop's load, the same three numbers. */
export function localLoad(): LoadSample {
  return { id: LOCAL_DEVICE, load1: loadavg()[0], cores: cpus().length || 1, memAvailable: freemem() };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/auto-placement.test.cjs; fi`
Expected: FAIL only in the two tests that need the renderer helpers (`effectiveDevice is not a function`); the rest PASS. Step 9 adds the helpers.

- [ ] **Step 7: Check bookkeeping and `placeAuto` (`src/main/index.ts`)**

Imports: add `localLoad, readLoad` to the `./devices` import braces; add `pickDevice, type LoadSample` to the `./deviceCommands` list; add `AUTO_DEVICE, type DeviceCheckItem` to the `'../shared/devices'` braces.

Replace the `devices:check` handler (phase 1 Task 9)

```ts
ipcMain.handle('devices:check', async (_evt, id: unknown) => {
  const root = hive.root();
  if (typeof id !== 'string' || !root) return [];
  const folders = [...new Set(rosterAgentsOn(roster.read(), id).map((a) => a.cwd).filter((c): c is string => !!c))];
  return checkDevice(devices.get(id), root, folders);
});
```
with
```ts
ipcMain.handle('devices:check', async (_evt, id: unknown) => (typeof id === 'string' ? runDeviceCheck(id) : []));
```

Immediately before `async function startDevices(): Promise<void> {` insert:

```ts
/** Devices whose last Check passed. Only these, and this laptop, take Auto
 *  agents (devices phase 2, item 2). */
const deviceCheckOk = new Map<string, boolean>();

/** Run Check on one device and remember whether every item passed. */
async function runDeviceCheck(id: string): Promise<DeviceCheckItem[]> {
  const root = hive.root();
  if (!root) return [];
  const folders = [...new Set(rosterAgentsOn(roster.read(), id).map((a) => a.cwd).filter((c): c is string => !!c))];
  const items = await checkDevice(devices.get(id), root, folders);
  deviceCheckOk.set(id, items.every((i) => i.ok));
  return items;
}
// Every connect re-runs Check, so "last Check passed" holds after an app
// restart, or after a fix made on the device, without anyone pressing Check.
devices.on('online', (link: DeviceLink) => { void runDeviceCheck(link.id); });

/** "Runs on: Auto". A restart that continues a conversation stays where it
 *  last ran while that machine is up. Otherwise: the least-loaded of this
 *  laptop and every online device whose last Check passed. Returns a device
 *  id, or undefined for this laptop. */
async function placeAuto(lastDevice: string | undefined, resuming: boolean): Promise<string | undefined> {
  if (resuming) {
    if (!lastDevice) return undefined;
    if (devices.get(lastDevice)?.state === 'online') return lastDevice;
  }
  const links = devices.all().filter((l) => l.state === 'online' && deviceCheckOk.get(l.id) === true);
  const remote = (await Promise.all(links.map(readLoad))).filter((x): x is LoadSample => !!x);
  return normalizeDeviceId(pickDevice([localLoad(), ...remote]));
}

```

- [ ] **Step 8: Auto in `spawnAgentCore` and `processSpawnRequest` (`src/main/index.ts`)**

(a) Replace (phase 1 Task 6 plus Task 1)

```ts
  const deviceId = opts.hive
    ? normalizeDeviceId(opts.hive.device !== undefined ? opts.hive.device : hive.registry().agents[opts.hive.id]?.device)
    : undefined;
  // Where it ran last time (registry.json, written by the previous spawn).
  // A different place is a move, and a move brings its conversation along
  // (devices phase 2, item 1).
  const prevDevice = opts.hive ? normalizeDeviceId(hive.registry().agents[opts.hive.id]?.device) : undefined;
```
with
```ts
  // Where it ran last time (registry.json, written by the previous spawn).
  // A different place is a move, and a move brings its conversation along
  // (devices phase 2, item 1).
  const prevDevice = opts.hive ? normalizeDeviceId(hive.registry().agents[opts.hive.id]?.device) : undefined;
  const requested = opts.hive
    ? normalizeDeviceId(opts.hive.device !== undefined ? opts.hive.device : hive.registry().agents[opts.hive.id]?.device)
    : undefined;
  // "Runs on: Auto" is decided here, once per start, and never again while
  // the agent runs (devices phase 2, item 2). The registry then records the
  // machine it picked, which is the next start's "last ran on".
  const resuming = !!opts.hive && (!!opts.resumeSessionId?.trim() || (opts.resume === true && !!hive.lastSession(opts.hive.id)));
  const deviceId = requested === AUTO_DEVICE ? await placeAuto(prevDevice, resuming) : requested;
```

(b) In the final `return { ...res, cwd: opts.cwd, …` line, replace `...(conversationStayed ? { conversationStayed } : {}) };` with `...(conversationStayed ? { conversationStayed } : {}), ...(opts.hive ? { device: deviceId ?? '' } : {}) };`, and in the signature line replace `conversationStayed?: ConversationStayed }> {` with `conversationStayed?: ConversationStayed; device?: string }> {`.

(c) In `processSpawnRequest` (phase 1 Task 11), replace

```ts
  if (placement.error) { fail(placement.error); return; }
  const link = placement.device ? devices.get(placement.device) : undefined;
```
with
```ts
  if (placement.error) { fail(placement.error); return; }
  // "auto" is placed here, once, so the folder and CLI checks below run on
  // the machine the worker will actually run on.
  const auto = placement.device === AUTO_DEVICE;
  if (auto) placement.device = await placeAuto(undefined, false);
  const link = placement.device ? devices.get(placement.device) : undefined;
```

and in the `hive:agentSpawned` broadcast replace `      device: placement.device,` with

```ts
      device: auto ? AUTO_DEVICE : placement.device,
      lastDevice: auto ? (placement.device ?? '') : undefined,
```

- [ ] **Step 9: Renderer helpers, the roster field and the card (`store/devices.ts`, `store.ts`, `AgentStrip.tsx`)**

`src/renderer/src/store/devices.ts`: replace `import { LOCAL_DEVICE, type ConversationStayed, type DeviceStatus } from '@shared/devices';` with `import { AUTO_DEVICE, LOCAL_DEVICE, type ConversationStayed, type DeviceStatus } from '@shared/devices';`. Replace

```ts
export function deviceInUse(agents: Array<{ device?: string }>, id: string): boolean {
  return agents.some((a) => a.device === id);
}
```
with
```ts
export function deviceInUse(agents: Array<{ device?: string; lastDevice?: string }>, id: string): boolean {
  return agents.some((a) => effectiveDevice(a.device, a.lastDevice) === id);
}

/** Where an agent runs: an Auto agent lives where it last ran. */
export function effectiveDevice(device: string | undefined, lastDevice: string | undefined): string | undefined {
  return (device === AUTO_DEVICE ? lastDevice : device) || undefined;
}

/** The card's device tag: "my-lap", or "my-lap (auto)" so you can see where
 *  Auto put it ("This laptop (auto)" when it stayed here). */
export function deviceLabel(device: string | undefined, lastDevice: string | undefined, thisLaptop: string): string | undefined {
  if (device !== AUTO_DEVICE) return device || undefined;
  return `${lastDevice || thisLaptop} (auto)`;
}
```

`src/renderer/src/store/store.ts`: replace

```ts
  device?: string;
  goal?: string;
```
with
```ts
  device?: string;
  /** For `device: 'auto'`: the machine Auto last picked ('' = this laptop).
   *  Shown on the card; reconcile and Check treat the agent as living there. */
  lastDevice?: string;
  goal?: string;
```

`src/renderer/src/components/AgentStrip.tsx`: replace `import { deviceOffline, useDeviceStates } from '@/store/devices';` with `import { deviceLabel, deviceOffline, effectiveDevice, useDeviceStates } from '@/store/devices';`, and replace

```tsx
            device={a.device}
            deviceOffline={deviceOffline(a.device, deviceStates)}
```
with
```tsx
            device={deviceLabel(a.device, a.lastDevice, t('devices.thisLaptop'))}
            deviceOffline={deviceOffline(effectiveDevice(a.device, a.lastDevice), deviceStates)}
```

- [ ] **Step 10: The Auto choice (`AddAgentModal.tsx`, `EditAgentModal.tsx`), and keeping `lastDevice` (`restartAgent.ts`, `useHive.ts`, preload)**

`AddAgentModal.tsx`: after the `@shared/…` imports add `import { AUTO_DEVICE } from '@shared/devices';`. Replace (phase 1 Task 10)

```tsx
                          <option value="">{tr('devices.thisLaptop')}</option>
```
with
```tsx
                          <option value="">{tr('devices.thisLaptop')}</option>
                          <option value={AUTO_DEVICE}>{tr('devices.auto')}</option>
```

replace `                            {tr('devices.runsOnHint', { device })}` with `                            {device === AUTO_DEVICE ? tr('devices.autoHint') : tr('devices.runsOnHint', { device })}`, and in the `const agent: Agent = { … }` object replace `      device: device || undefined,` with

```tsx
      device: device || undefined,
      lastDevice: spawnRes.device || undefined,
```

`EditAgentModal.tsx`: replace (phase 1 Task 10)

```tsx
                    <option value="">{t('devices.thisLaptop')}</option>
```
with
```tsx
                    <option value="">{t('devices.thisLaptop')}</option>
                    {/* god is never placed automatically (spec §4). */}
                    {!agent.isGod && <option value="auto">{t('devices.auto')}</option>}
```

`restartAgent.ts`: replace

```ts
    updateAgent(a.id, {
      command: command.trim(),
```
with
```ts
    updateAgent(a.id, {
      // Where it runs now (Auto may have picked again on a fresh start).
      ...(res.device !== undefined ? { lastDevice: res.device } : {}),
      command: command.trim(),
```

`useHive.ts`: replace (phase 1 Task 10) `        device: rec.device,` with

```tsx
        device: rec.device,
        lastDevice: rec.lastDevice,
```

`src/preload/index.ts`:
- In the `onHiveAgentSpawned` record type, replace `worktreePath?: string; device?: string;` with `worktreePath?: string; device?: string; lastDevice?: string;`.
- In `spawnPty`'s result type, replace `conversationStayed?: ConversationStayed }> =>` with `conversationStayed?: ConversationStayed; device?: string }> =>`.
- In `HiveAgentMeta`, replace `  /** The device this agent runs on; '' or absent = this laptop. Mirrors src/main/hive.ts. */` with `  /** The device this agent runs on; '' or absent = this laptop; 'auto' = picked at start (main resolves it). Mirrors src/main/hive.ts. */`.

- [ ] **Step 11: god's line recommends `auto` (`src/main/hive.ts`, `test/god-devices.test.cjs`)**

In `deviceSpawnHint` (phase 1 Task 11), replace

```ts
      ? ` Optional \`device\` (${this._deviceIds.join(', ')}) runs the worker on that machine instead of this laptop: heavy work (type-checks, suites, builds) is best placed on a device. An unknown or offline device fails the request with the reason.`
```
with
```ts
      ? ` Optional \`device\` (auto, ${this._deviceIds.join(', ')}) runs the worker on another machine instead of this laptop: heavy work (type-checks, suites, builds) is best placed on a device, and \`"device": "auto"\` picks the least-loaded machine when the worker starts, so use it for heavy work. The default stays this laptop. An unknown or offline device fails the request with the reason.`
```

In the COMMANDS.md text (phase 1 Task 11), replace

```
\`device\` (optional) runs the worker on another machine from Settings → Devices instead of this
laptop; heavy work (type-checks, suites, builds) is best placed there. Only Claude Code runs on a
device. An unknown or offline device fails the request into \`spawn-requests/.failed/\` with the reason.
```
with
```
\`device\` (optional) runs the worker on another machine from Settings → Devices instead of this
laptop. \`"auto"\` picks the least-loaded machine, this laptop included, when the worker starts:
use it for heavy work (type-checks, suites, builds). Only Claude Code runs on a device.
An unknown or offline device fails the request into \`spawn-requests/.failed/\` with the reason.
```

In `test/god-devices.test.cjs`, replace `  assert.ok(p.includes('`device` (my-lap)'));` with

```js
  assert.ok(p.includes('`device` (auto, my-lap)'));
  assert.ok(p.includes('`"device": "auto"` picks the least-loaded machine'));
```

- [ ] **Step 12: The strings, in all three locales**

```bash
cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && node - <<'EOF'
const fs = require('fs');
const dir = 'src/renderer/src/i18n/locales/';
const add = {
  en: { devices: {
    auto: 'Auto (least loaded)',
    autoHint: 'Picks this laptop or a checked device with the most free memory at each fresh start. It never moves while running.'
  } },
  ar: { devices: {
    auto: 'تلقائي (الأقل حملًا)',
    autoHint: 'يختار هذا الحاسوب أو جهازًا مفحوصًا لديه أكبر ذاكرة متاحة عند كل بدء جديد، ولا ينتقل أثناء التشغيل.'
  } },
  'zh-CN': { devices: {
    auto: '自动（负载最低）',
    autoHint: '每次全新启动时，从这台笔记本和已通过检查的设备中选出可用内存最多的一台；运行期间不会迁移。'
  } }
};
const merge = (b, a) => { for (const [k, v] of Object.entries(a)) { if (v && typeof v === 'object') { b[k] = b[k] || {}; merge(b[k], v); } else b[k] = v; } };
for (const [loc, obj] of Object.entries(add)) {
  const f = dir + loc + '.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  merge(j, obj);
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
}
EOF
```

- [ ] **Step 13: Run the test to verify it passes**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/auto-placement.test.cjs; fi`
Expected: PASS, 10 tests.

- [ ] **Step 14: Type-check**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock npm run typecheck`
Expected: exits 0.

- [ ] **Step 15: Re-run the tests this touches, one line at a time**

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/god-devices.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/device-lifecycle.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/devices-config.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/devices-ui.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/arabic-ui.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/hive-generated-docs.test.cjs; fi`

Expected: all PASS.

- [ ] **Step 16: Commit**

```bash
git -C /home/royal/Pro/Zensible/munder-difflin-wt/devices add -- src/shared/devices.ts src/main/deviceCommands.ts src/main/devices.ts src/main/index.ts src/main/hive.ts src/preload/index.ts src/renderer/src/store/store.ts src/renderer/src/store/devices.ts src/renderer/src/components/AddAgentModal.tsx src/renderer/src/components/EditAgentModal.tsx src/renderer/src/components/AgentStrip.tsx src/renderer/src/workspace/agents/restartAgent.ts src/renderer/src/hooks/useHive.ts src/renderer/src/i18n/locales/en.json src/renderer/src/i18n/locales/ar.json src/renderer/src/i18n/locales/zh-CN.json test/god-devices.test.cjs test/auto-placement.test.cjs
git -C /home/royal/Pro/Zensible/munder-difflin-wt/devices commit -m 'devices: Runs on: Auto' -m 'A fresh start picks this laptop or the online, checked device with the most free memory among those under 1.5 load per core (ties stay here). A resumed start stays where it last ran while that is up. Check re-runs on every connect. The card says "my-lap (auto)"; reconcile and Check treat an Auto agent as living where it last ran. god spawn requests may say auto.' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G3wAo6k5J6tkH89c7qqJnG'
```

---

### Task 3: The path check and its fix

**Files:**
- Modify: `src/shared/devices.ts` (`DeviceCheckItem` gets `'base'`)
- Modify: `src/main/deviceCommands.ts` (append `baseFolder`, `BASE_OK`, `basePathCommand`, `basePathFix`)
- Modify: `src/main/devices.ts` (`LinkEnv.localHome`; the mount-failure reason; `checkDevice` gets a `base` item)
- Modify: the three locale files
- Modify: `test/device-check.test.cjs` (phase 1 Task 9's item list gains `base`)
- Test: `test/device-base-path.test.cjs`

**Interfaces:**
- Consumes: `checkDevice`, `checkCommands` (phase 1 Task 9); `fakeDevice` (`test/fake-ssh.cjs`).
- Produces:
  - In `deviceCommands.ts`: `baseFolder(hiveRoot: string): string`; `BASE_OK: string`; `basePathCommand(base: string, localHome: string): string`; `basePathFix(base: string, localHome: string, probeOut: string): string | null`.
  - `LinkEnv.localHome?: string` (a test seam; default `os.homedir()`).
  - `checkDevice(link, hiveRoot, folders, localHome = homedir())`. Its items are now: login, **base**, claude, node, tmux, sshfs, mount, folders.
  - i18n key `devices.items.base`.

- [ ] **Step 1: Write the failing test**

Create `test/device-base-path.test.cjs`:

```js
'use strict';
/**
 * Devices phase 2, item 3: this laptop's base folder (the parent of the hive
 * home) must exist on the device, following symlinks. Check says so, and
 * so does a failed mount, each with the fix the spec gives.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { fakeDevice, waitForState } = require('./fake-ssh.cjs');

const dc = loadTs('src/main/deviceCommands.ts');
const { DeviceLink, checkDevice } = loadTs('src/main/devices.ts');

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-base-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const probe = (cmd, home) => spawnSync('bash', ['-c', cmd], { env: { ...process.env, HOME: home }, encoding: 'utf8' }).stdout;

test('the base folder is the parent of the hive home', () => {
  assert.equal(dc.baseFolder('/home/royal/Pro/Zensible/HarnessAgents/hive'), '/home/royal/Pro/Zensible');
});

test('present (a symlink counts): no fix', (t) => {
  const dir = sandbox(t);
  fs.mkdirSync(path.join(dir, 'real'), { recursive: true });
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'Zensible'));
  const base = path.join(dir, 'Zensible');
  const out = probe(dc.basePathCommand(base, '/home/royal'), dir);
  assert.equal(dc.basePathFix(base, '/home/royal', out), null);
});

test('same layout, another user: link their home to this one', (t) => {
  const dir = sandbox(t);
  const alice = path.join(dir, 'alice');
  fs.mkdirSync(path.join(alice, 'Pro', 'Zensible'), { recursive: true });
  const localHome = path.join(dir, 'royal');
  const base = path.join(localHome, 'Pro', 'Zensible');
  const out = probe(dc.basePathCommand(base, localHome), alice);
  assert.equal(dc.basePathFix(base, localHome, out), `sudo ln -s ${dc.shq(alice)} ${dc.shq(localHome)}`);
});

test('another layout: make the parent and link their folder', (t) => {
  const dir = sandbox(t);
  const out = probe(dc.basePathCommand('/home/royal/Pro/Zensible', '/home/royal'), dir);
  assert.equal(dc.basePathFix('/home/royal/Pro/Zensible', '/home/royal', out),
    "sudo mkdir -p '/home/royal/Pro' && sudo ln -s <their folder> '/home/royal/Pro/Zensible'");
});

test('Check lists the base folder right after login', async (t) => {
  const f = fakeDevice(t);
  const link = new DeviceLink({ id: 'my-lap', host: '100.65.189.1' }, f.env);
  t.after(() => link.stop());
  link.start();
  await waitForState(link, 'online');
  const items = await checkDevice(link, f.hive, []);
  assert.deepEqual(items.slice(0, 2).map((i) => [i.id, i.ok]), [['login', true], ['base', true]]);
  assert.equal(items[1].path, path.dirname(path.dirname(f.hive)));
});

test('a mount that fails for a missing base folder says how to fix it', { skip: process.getuid?.() === 0, timeout: 20_000 }, async (t) => {
  const f = fakeDevice(t);
  // Not creatable by a normal user, so the mount's mkdir fails (exit 2).
  const root = `/md-nobase-${process.pid}`;
  const localHome = `${root}/royal`;
  const hiveRoot = `${localHome}/Pro/Zensible/HarnessAgents/hive`;
  fs.mkdirSync(path.join(f.home, 'Pro', 'Zensible'), { recursive: true }); // the device user's own layout matches
  const link = new DeviceLink({ id: 'my-lap', host: '100.65.189.1' }, { ...f.env, hiveRoot, localHome });
  t.after(() => link.stop());
  const why = new Promise((resolve) => link.on('state', (s) => { if (s.error?.includes('sudo ln -s')) resolve(s.error); }));
  link.start();
  const error = await why;
  assert.match(error, new RegExp(`${root}/royal/Pro/Zensible does not exist on my-lap`));
  assert.ok(error.includes(`sudo ln -s ${dc.shq(f.home)} ${dc.shq(localHome)}`));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/device-base-path.test.cjs; fi`
Expected: FAIL, `dc.baseFolder is not a function`.

- [ ] **Step 3: The item id (`src/shared/devices.ts`)**

Replace

```ts
  id: 'login' | 'claude' | 'node' | 'tmux' | 'sshfs' | 'mount' | 'folder';
```
with
```ts
  id: 'login' | 'base' | 'claude' | 'node' | 'tmux' | 'sshfs' | 'mount' | 'folder';
```

and replace `  /** The agent folder, for \`folder\` items. */` with `  /** The agent folder, for \`folder\` items; the base folder, for \`base\`. */`.

- [ ] **Step 4: The probe and its fix (`src/main/deviceCommands.ts`)**

After `import { projectKey } from './transcript';` add `import { posix } from 'node:path';`.

Append at the end of the file:

```ts

// ─── The base folder (devices phase 2, item 3) ───────────────────────────────
// The hive's own files hold absolute paths (PROTOCOL.md, fleet.json, task
// cards, mail), so the device must have the same paths. A symlink there makes
// them exist with no translation anywhere.

/** The parent of the hive home: `/home/royal/Pro/Zensible` for a hive at
 *  `/home/royal/Pro/Zensible/<home>/hive`. */
export function baseFolder(hiveRoot: string): string {
  return posix.dirname(posix.dirname(hiveRoot));
}

export const BASE_OK = 'MD_BASE_OK';

/** Prints BASE_OK when the base folder exists (symlinks followed); else
 *  `home:<device $HOME>` when the same layout exists under the device
 *  user's home; else `missing`. */
export function basePathCommand(base: string, localHome: string): string {
  const rest = base === localHome ? '' : base.startsWith(`${localHome}/`) ? base.slice(localHome.length + 1) : null;
  const same = rest === null ? '' : `elif [ -d "$HOME"/${shq(rest)} ]; then printf 'home:%s\\n' "$HOME"; `;
  return `if [ -d ${shq(base)} ]; then echo ${BASE_OK}; ${same}else echo missing; fi`;
}

/** The command that makes the base folder exist on the device, or null when
 *  it already does. `<their folder>` is left for the person to fill in: only
 *  they know where the repos live on that machine. */
export function basePathFix(base: string, localHome: string, probeOut: string): string | null {
  if (probeOut.includes(BASE_OK)) return null;
  const home = /^home:(.+)$/m.exec(probeOut);
  if (home) return `sudo ln -s ${shq(home[1].trim())} ${shq(localHome)}`;
  return `sudo mkdir -p ${shq(posix.dirname(base))} && sudo ln -s <their folder> ${shq(base)}`;
}
```

- [ ] **Step 5: The mount failure and Check (`src/main/devices.ts`)**

Imports: add `basePathCommand, basePathFix, baseFolder` to the `./deviceCommands` list.

In `interface LinkEnv`, replace `  backoff?: (attempt: number) => number;` with

```ts
  backoff?: (attempt: number) => number;
  /** This laptop's home folder, for the base-path fix (a test seam). */
  localHome?: string;
```

In `connect()`, replace

```ts
    if (!mount.ok) {
      this.killReason = mount.stdout.includes(NOT_EMPTY)
        ? `The hive folder on ${this.id} is not empty, so it was not mounted. Move it aside on ${this.id}: mv ${this.env.hiveRoot} ${this.env.hiveRoot}.local`
        : `Could not mount the hive on ${this.id}: ${mount.error ?? (mount.stderr.trim() || `exit ${mount.code}`)}`;
```
with
```ts
    if (!mount.ok) {
      // mkdir failed (exit 2): usually this laptop's base folder does not
      // exist there (another user, another layout). Say how to make it exist.
      const fix = mount.code === 2 ? await this.baseFix() : null;
      if (this.master !== m) return;
      this.killReason = mount.stdout.includes(NOT_EMPTY)
        ? `The hive folder on ${this.id} is not empty, so it was not mounted. Move it aside on ${this.id}: mv ${this.env.hiveRoot} ${this.env.hiveRoot}.local`
        : fix
          ? `${baseFolder(this.env.hiveRoot)} does not exist on ${this.id}, so the hive cannot be mounted at the same path. On ${this.id}, run: ${fix}`
          : `Could not mount the hive on ${this.id}: ${mount.error ?? (mount.stderr.trim() || `exit ${mount.code}`)}`;
```

Immediately before `  /** The master gives no "ready" signal, so ask it (\`-O check\`) until it answers. */` insert:

```ts
  /** The command that makes this laptop's base folder exist on the device,
   *  or null when it exists or the probe got no answer. */
  private async baseFix(): Promise<string | null> {
    const base = baseFolder(this.env.hiveRoot);
    const home = this.env.localHome ?? homedir();
    const r = await this.run(basePathCommand(base, home), 10_000);
    return r.ok ? basePathFix(base, home, r.stdout) : null;
  }

```

Replace the `checkDevice` signature and loop

```ts
export async function checkDevice(link: DeviceLink | undefined, hiveRoot: string, folders: string[]): Promise<DeviceCheckItem[]> {
```
with
```ts
export async function checkDevice(
  link: DeviceLink | undefined,
  hiveRoot: string,
  folders: string[],
  localHome: string = homedir()
): Promise<DeviceCheckItem[]> {
```

and

```ts
    out.push({ id: c.item, ...(c.path ? { path: c.path } : {}), ok: r.ok, ...(r.ok ? {} : { fix: c.fix }) });
  }
  return out;
```
with
```ts
    out.push({ id: c.item, ...(c.path ? { path: c.path } : {}), ok: r.ok, ...(r.ok ? {} : { fix: c.fix }) });
    // Right after login: the base folder, which every path the hive holds needs.
    if (c.item === 'login') out.push(await checkBase(link, hiveRoot, localHome));
  }
  return out;
```

Append at the end of the file:

```ts

/** Check's base-folder item (devices phase 2, item 3). */
async function checkBase(link: DeviceLink, hiveRoot: string, localHome: string): Promise<DeviceCheckItem> {
  const base = baseFolder(hiveRoot);
  const r = await link.exec(basePathCommand(base, localHome), 20_000);
  const fix = basePathFix(base, localHome, r.ok ? r.stdout : '');
  return fix ? { id: 'base', path: base, ok: false, fix } : { id: 'base', path: base, ok: true };
}
```

- [ ] **Step 6: Phase 1's Check test lists `base` (`test/device-check.test.cjs`)**

Replace

```js
  assert.deepEqual(items.map((i) => [i.id, i.ok]), [
    ['login', true], ['claude', true], ['node', true], ['tmux', true], ['sshfs', true],
    ['mount', true], ['folder', true], ['folder', false]
  ]);
  assert.equal(items[0].fix, undefined, 'a pass carries no fix');
  assert.equal(items[7].path, '/no/such/folder');
  assert.match(items[7].fix, /^mkdir -p '\/no\/such\/folder'/);
```
with
```js
  assert.deepEqual(items.map((i) => [i.id, i.ok]), [
    ['login', true], ['base', true], ['claude', true], ['node', true], ['tmux', true], ['sshfs', true],
    ['mount', true], ['folder', true], ['folder', false]
  ]);
  assert.equal(items[0].fix, undefined, 'a pass carries no fix');
  assert.equal(items[8].path, '/no/such/folder');
  assert.match(items[8].fix, /^mkdir -p '\/no\/such\/folder'/);
```

- [ ] **Step 7: The string, in all three locales**

```bash
cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && node - <<'EOF'
const fs = require('fs');
const dir = 'src/renderer/src/i18n/locales/';
const add = {
  en: { devices: { items: { base: 'Base folder {{path}}' } } },
  ar: { devices: { items: { base: 'المجلد الأساسي {{path}}' } } },
  'zh-CN': { devices: { items: { base: '基础文件夹 {{path}}' } } }
};
const merge = (b, a) => { for (const [k, v] of Object.entries(a)) { if (v && typeof v === 'object') { b[k] = b[k] || {}; merge(b[k], v); } else b[k] = v; } };
for (const [loc, obj] of Object.entries(add)) {
  const f = dir + loc + '.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  merge(j, obj);
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
}
EOF
```

- [ ] **Step 8: Run the tests to verify they pass, one line at a time**

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/device-base-path.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/device-check.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/devices-link.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/arabic-ui.test.cjs; fi`

Expected: all PASS (`device-base-path`: 6 tests).

- [ ] **Step 9: Type-check**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock npm run typecheck`
Expected: exits 0.

- [ ] **Step 10: Commit**

```bash
git -C /home/royal/Pro/Zensible/munder-difflin-wt/devices add -- src/shared/devices.ts src/main/deviceCommands.ts src/main/devices.ts src/renderer/src/i18n/locales/en.json src/renderer/src/i18n/locales/ar.json src/renderer/src/i18n/locales/zh-CN.json test/device-check.test.cjs test/device-base-path.test.cjs
git -C /home/royal/Pro/Zensible/munder-difflin-wt/devices commit -m 'devices: check the base folder exists on the device' -m 'Check verifies the parent of the hive home exists there (symlinks followed), and a mount that fails on it says so. The fix is a symlink: the device user home linked to this one when the layout matches, otherwise their folder linked into place.' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G3wAo6k5J6tkH89c7qqJnG'
```

---

### Task 4: god on a device

**Files:**
- Modify: `src/main/index.ts` (`spawnAgentCore`: god is never Auto)
- Modify: `src/renderer/src/components/EditAgentModal.tsx` (the warning when god moves)
- Modify: the three locale files
- Test: `test/god-on-device.test.cjs`

**Interfaces:**
- Consumes: `requested`, `AUTO_DEVICE` (Task 2); `EditAgentModal`'s `device` state and Runs on row (phase 1 Task 10, Task 2).
- Produces: i18n key `devices.godWarning` (with `{{device}}`). A spawn of god with `device: 'auto'` fails with `god is never placed automatically: pick This laptop or a device.`

god already runs on a device through phase 1's path. It runs in the hive home, which the device sees at the same path through the mount. It uses the device's own hook shim, so the 10-minute pause applies to it. Its mail lands in the hive on this laptop. Memory condensing, fleet beats, and spawn and compact requests run in this laptop's main process and do not move. This task adds the two rules the spec gives: no Auto for god, and a warning.

- [ ] **Step 1: Write the failing test**

Create `test/god-on-device.test.cjs`:

```js
'use strict';
/**
 * Devices phase 2, item 4: god may run on a device. Moving it warns that
 * the floor has no god while that device is offline.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (l) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/i18n/locales', `${l}.json`), 'utf8'));

test('the god warning names the device in every locale', () => {
  for (const l of ['en', 'ar', 'zh-CN']) {
    const w = read(l).devices.godWarning;
    assert.equal(typeof w, 'string', `${l}: devices.godWarning`);
    assert.ok(w.includes('{{device}}'), `${l}: {{device}} kept`);
  }
});

test('god is offered no Auto, and the main process refuses it too', () => {
  const modal = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/EditAgentModal.tsx'), 'utf8');
  assert.match(modal, /!agent\.isGod && <option value="auto">/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(main, /requested === AUTO_DEVICE && opts\.hive\?\.isGod/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/god-on-device.test.cjs; fi`
Expected: FAIL, `en: devices.godWarning`.

- [ ] **Step 3: god is never Auto (`src/main/index.ts`)**

Replace (Task 2)

```ts
  const deviceId = requested === AUTO_DEVICE ? await placeAuto(prevDevice, resuming) : requested;
```
with
```ts
  // god is never placed automatically and never moved by the app (spec §4);
  // the renderer offers no Auto for it, and a hand-edited roster gets this.
  if (requested === AUTO_DEVICE && opts.hive?.isGod) {
    return { ok: false, error: 'god is never placed automatically: pick This laptop or a device.' };
  }
  const deviceId = requested === AUTO_DEVICE ? await placeAuto(prevDevice, resuming) : requested;
```

- [ ] **Step 4: The warning when you move god (`EditAgentModal.tsx`)**

Replace (phase 1 Task 10 plus Task 2)

```tsx
                    {!agent.isGod && <option value="auto">{t('devices.auto')}</option>}
                    {(config?.devices ?? []).map((d) => <option key={d.id} value={d.id}>{d.id}</option>)}
                  </select>
```
with
```tsx
                    {!agent.isGod && <option value="auto">{t('devices.auto')}</option>}
                    {(config?.devices ?? []).map((d) => <option key={d.id} value={d.id}>{d.id}</option>)}
                  </select>
                  {agent.isGod && device && (
                    <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-coral)' }}>
                      {t('devices.godWarning', { device })}
                    </span>
                  )}
```

- [ ] **Step 5: The string, in all three locales**

```bash
cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && node - <<'EOF'
const fs = require('fs');
const dir = 'src/renderer/src/i18n/locales/';
const add = {
  en: { devices: { godWarning: 'While {{device}} is offline the floor has no god: mail to it waits, and it pauses after the offline limit like any agent.' } },
  ar: { devices: { godWarning: 'ما دام {{device}} غير متصل فلا يوجد مدير للطابق: تنتظر رسائله، ويتوقف بعد مهلة الانقطاع مثل أي وكيل.' } },
  'zh-CN': { devices: { godWarning: '{{device}} 离线期间，楼层没有 god：发给它的邮件会等待，超过离线时限后它会像其他智能体一样暂停。' } }
};
const merge = (b, a) => { for (const [k, v] of Object.entries(a)) { if (v && typeof v === 'object') { b[k] = b[k] || {}; merge(b[k], v); } else b[k] = v; } };
for (const [loc, obj] of Object.entries(add)) {
  const f = dir + loc + '.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  merge(j, obj);
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
}
EOF
```

- [ ] **Step 6: Run the tests to verify they pass, one line at a time**

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/god-on-device.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/arabic-ui.test.cjs; fi`

Expected: both PASS.

- [ ] **Step 7: Type-check**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock npm run typecheck`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git -C /home/royal/Pro/Zensible/munder-difflin-wt/devices add -- src/main/index.ts src/renderer/src/components/EditAgentModal.tsx src/renderer/src/i18n/locales/en.json src/renderer/src/i18n/locales/ar.json src/renderer/src/i18n/locales/zh-CN.json test/god-on-device.test.cjs
git -C /home/royal/Pro/Zensible/munder-difflin-wt/devices commit -m 'devices: god may run on a device' -m 'god gets This laptop or a device, never Auto (refused in main too). Moving it warns that the floor has no god while that device is offline. The floor own hive work stays on this laptop.' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G3wAo6k5J6tkH89c7qqJnG'
```

---

### Task 5: The WSL2 Check and the setup guide

**Files:**
- Modify: `src/shared/devices.ts` (four WSL item ids; `reminder`)
- Modify: `src/main/deviceCommands.ts` (append `WSL_PROBE`, `wslSystemdOn`, `parseWslProbe`, `wslCheckItems`)
- Modify: `src/main/devices.ts` (`checkDevice` appends the WSL items)
- Modify: `src/renderer/src/components/DevicesSettings.tsx` (reminders)
- Modify: the three locale files
- Create: `docs/devices-wsl2.md`
- Test: `test/device-wsl.test.cjs`

**Interfaces:**
- Consumes: `checkDevice` (Task 3); DevicesSettings' item list (phase 1 Task 10).
- Produces:
  - `DeviceCheckItem.id` gains `'wslSystemd' | 'wslFuse' | 'wslIdle' | 'wslSleep'`; `DeviceCheckItem.reminder?: boolean`, meaning "cannot be checked from inside WSL; shown with its instruction". A reminder has `ok: true`, so it never fails Check and never blocks Auto.
  - In `deviceCommands.ts`: `WSL_PROBE: string`; `wslSystemdOn(conf: string): boolean`; `parseWslProbe(out: string): { wsl: boolean; systemd: boolean; fuse: boolean }`; `wslCheckItems(p: { wsl: boolean; systemd: boolean; fuse: boolean }): DeviceCheckItem[]`.
  - i18n keys `devices.items.{wslSystemd,wslFuse,wslIdle,wslSleep}`, `devices.reminder`.

- [ ] **Step 1: Write the failing test**

Create `test/device-wsl.test.cjs`:

```js
'use strict';
/**
 * Devices phase 2, item 6: a Windows machine runs as a Linux device inside
 * WSL2. Check spots WSL and adds its items: systemd and /dev/fuse are
 * checked; two Windows-side settings are printed as reminders.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { fakeDevice, waitForState } = require('./fake-ssh.cjs');

const dc = loadTs('src/main/deviceCommands.ts');
const { DeviceLink, checkDevice } = loadTs('src/main/devices.ts');

const WSL_VERSION = 'Linux version 5.15.153.1-microsoft-standard-WSL2 (root@x) (gcc) #1 SMP\n';

test('systemd: only systemd=true under [boot] counts', () => {
  assert.equal(dc.wslSystemdOn('[boot]\nsystemd=true\n'), true);
  assert.equal(dc.wslSystemdOn('[boot]\n  systemd = TRUE  # on\n'), true);
  assert.equal(dc.wslSystemdOn('[network]\nsystemd=true\n'), false, 'wrong section');
  assert.equal(dc.wslSystemdOn('[boot]\n# systemd=true\n'), false, 'commented out');
  assert.equal(dc.wslSystemdOn('[boot]\nsystemd=true\nsystemd=false\n'), false, 'the last one wins');
  assert.equal(dc.wslSystemdOn(''), false);
});

test('the probe: WSL from /proc/version, then wsl.conf, then /dev/fuse', () => {
  assert.deepEqual(dc.parseWslProbe(`${WSL_VERSION}__MD_WSL__\n[boot]\nsystemd=true\n__MD_WSL__\nfuse\n`),
    { wsl: true, systemd: true, fuse: true });
  assert.deepEqual(dc.parseWslProbe(`${WSL_VERSION}__MD_WSL__\n__MD_WSL__\n`), { wsl: true, systemd: false, fuse: false });
  assert.equal(dc.parseWslProbe('Linux version 6.9.7-arch1-1\n__MD_WSL__\n__MD_WSL__\n').wsl, false);
  assert.equal(dc.parseWslProbe('').wsl, false, 'no answer is not WSL');
});

test('WSL items: two checks with fixes, two reminders that never fail', () => {
  const items = dc.wslCheckItems({ wsl: true, systemd: false, fuse: true });
  assert.deepEqual(items.map((i) => [i.id, i.ok, !!i.reminder]),
    [['wslSystemd', false, false], ['wslFuse', true, false], ['wslIdle', true, true], ['wslSleep', true, true]]);
  assert.match(items[0].fix, /systemd=true/);
  assert.match(items[2].fix, /vmIdleTimeout=-1/);
  assert.ok(items[3].fix.length > 0);
  assert.deepEqual(dc.wslCheckItems({ wsl: false, systemd: false, fuse: false }), []);
});

test('Check on a plain Linux device adds no WSL items', async (t) => {
  const f = fakeDevice(t);
  const link = new DeviceLink({ id: 'my-lap', host: '100.65.189.1' }, f.env);
  t.after(() => link.stop());
  link.start();
  await waitForState(link, 'online');
  const ids = (await checkDevice(link, f.hive, [])).map((i) => i.id);
  assert.ok(!ids.some((id) => id.startsWith('wsl')), ids.join(','));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/device-wsl.test.cjs; fi`
Expected: FAIL, `dc.wslSystemdOn is not a function`.

- [ ] **Step 3: The item ids and `reminder` (`src/shared/devices.ts`)**

Replace

```ts
  id: 'login' | 'base' | 'claude' | 'node' | 'tmux' | 'sshfs' | 'mount' | 'folder';
```
with
```ts
  id: 'login' | 'base' | 'claude' | 'node' | 'tmux' | 'sshfs' | 'mount' | 'folder'
    | 'wslSystemd' | 'wslFuse' | 'wslIdle' | 'wslSleep';
```

and replace

```ts
  ok: boolean;
  fix?: string;
}
```
with
```ts
  ok: boolean;
  fix?: string;
  /** Cannot be checked from the device (a Windows-side setting of a WSL2
   *  device): shown with its instruction, and counted as passing. */
  reminder?: boolean;
}
```

- [ ] **Step 4: The probe and its items (`src/main/deviceCommands.ts`)**

Append at the end of the file:

```ts

// ─── Windows through WSL2 (devices phase 2, item 6) ──────────────────────────

const WSL_SEP = '__MD_WSL__';

/** /proc/version, /etc/wsl.conf and /dev/fuse, in one round trip. */
export const WSL_PROBE = `cat /proc/version 2>/dev/null; echo ${WSL_SEP}; cat /etc/wsl.conf 2>/dev/null; echo ${WSL_SEP}; [ -e /dev/fuse ] && echo fuse`;

/** Is `systemd=true` set under `[boot]`? The last setting wins. */
export function wslSystemdOn(conf: string): boolean {
  let section = '';
  let on = false;
  for (const raw of conf.split('\n')) {
    const line = raw.replace(/[#;].*$/, '').trim();
    const head = /^\[(.+)\]$/.exec(line);
    if (head) { section = head[1].trim().toLowerCase(); continue; }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (section === 'boot' && kv && kv[1].trim().toLowerCase() === 'systemd') on = kv[2].trim().toLowerCase() === 'true';
  }
  return on;
}

export function parseWslProbe(out: string): { wsl: boolean; systemd: boolean; fuse: boolean } {
  const [version = '', conf = '', fuse = ''] = out.split(`${WSL_SEP}\n`);
  return { wsl: /microsoft/i.test(version), systemd: wslSystemdOn(conf), fuse: fuse.trim() === 'fuse' };
}

/** Check's WSL items; none on a plain Linux device. systemd keeps tailscaled
 *  and our tmux running; /dev/fuse is what the hive mount needs. The two
 *  Windows-side settings cannot be seen from inside WSL, so they are
 *  reminders. */
export function wslCheckItems(p: { wsl: boolean; systemd: boolean; fuse: boolean }): DeviceCheckItem[] {
  if (!p.wsl) return [];
  return [
    p.systemd
      ? { id: 'wslSystemd', ok: true }
      : { id: 'wslSystemd', ok: false, fix: 'sudoedit /etc/wsl.conf   # under [boot] set systemd=true; then, in Windows: wsl --shutdown' },
    p.fuse
      ? { id: 'wslFuse', ok: true }
      : { id: 'wslFuse', ok: false, fix: 'sudo apt install fuse3   # then, in Windows: wsl --shutdown' },
    { id: 'wslIdle', ok: true, reminder: true, fix: 'In Windows, %UserProfile%\\.wslconfig: [wsl2] vmIdleTimeout=-1, then wsl --shutdown' },
    { id: 'wslSleep', ok: true, reminder: true, fix: 'In Windows, an admin terminal: powercfg /change standby-timeout-ac 0 and powercfg /change hibernate-timeout-ac 0' }
  ];
}
```

- [ ] **Step 5: Check appends them (`src/main/devices.ts`)**

Imports: add `parseWslProbe, WSL_PROBE, wslCheckItems` to the `./deviceCommands` list.

In `checkDevice`, replace

```ts
    if (c.item === 'login') out.push(await checkBase(link, hiveRoot, localHome));
  }
  return out;
```
with
```ts
    if (c.item === 'login') out.push(await checkBase(link, hiveRoot, localHome));
  }
  // A Windows machine through WSL2 (devices phase 2, item 6).
  out.push(...wslCheckItems(parseWslProbe((await link.exec(WSL_PROBE, 20_000)).stdout)));
  return out;
```

- [ ] **Step 6: Show reminders (`src/renderer/src/components/DevicesSettings.tsx`)**

Replace (phase 1 Task 10)

```tsx
                    <span style={{ color: it.ok ? 'var(--cth-mint)' : 'var(--cth-coral)' }}>{it.ok ? '✓' : '✗'}</span>{' '}
                    {t(`devices.items.${it.id}`, { path: it.path })}
                    {!it.ok && it.fix && (
                      <div style={{ ...mono, color: 'var(--cth-ink-700)', marginInlineStart: 16, userSelect: 'text' }}>
                        {t('devices.fix')} {it.fix}
                      </div>
                    )}
```
with
```tsx
                    <span style={{ color: it.reminder ? 'var(--cth-ink-500)' : it.ok ? 'var(--cth-mint)' : 'var(--cth-coral)' }}>
                      {it.reminder ? 'ℹ' : it.ok ? '✓' : '✗'}
                    </span>{' '}
                    {t(`devices.items.${it.id}`, { path: it.path })}
                    {/* A reminder always shows its instruction: Check cannot see it. */}
                    {(!it.ok || it.reminder) && it.fix && (
                      <div style={{ ...mono, color: 'var(--cth-ink-700)', marginInlineStart: 16, userSelect: 'text' }}>
                        {it.reminder ? t('devices.reminder') : t('devices.fix')} {it.fix}
                      </div>
                    )}
```

- [ ] **Step 7: The strings, in all three locales**

```bash
cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && node - <<'EOF'
const fs = require('fs');
const dir = 'src/renderer/src/i18n/locales/';
const add = {
  en: { devices: {
    reminder: 'Check by hand:',
    items: { wslSystemd: 'systemd on in WSL', wslFuse: '/dev/fuse in WSL', wslIdle: 'Windows keeps WSL running', wslSleep: 'Windows never sleeps' }
  } },
  ar: { devices: {
    reminder: 'تحقق يدويًا:',
    items: { wslSystemd: 'systemd مفعّل في WSL', wslFuse: 'وجود ‎/dev/fuse في WSL', wslIdle: 'ويندوز يُبقي WSL يعمل', wslSleep: 'ويندوز لا يدخل السكون أبدًا' }
  } },
  'zh-CN': { devices: {
    reminder: '请手动确认：',
    items: { wslSystemd: 'WSL 中已启用 systemd', wslFuse: 'WSL 中存在 /dev/fuse', wslIdle: 'Windows 保持 WSL 运行', wslSleep: 'Windows 从不休眠' }
  } }
};
const merge = (b, a) => { for (const [k, v] of Object.entries(a)) { if (v && typeof v === 'object') { b[k] = b[k] || {}; merge(b[k], v); } else b[k] = v; } };
for (const [loc, obj] of Object.entries(add)) {
  const f = dir + loc + '.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  merge(j, obj);
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
}
EOF
```

- [ ] **Step 8: The setup guide (`docs/devices-wsl2.md`)**

Create `docs/devices-wsl2.md`:

````markdown
# A Windows machine as a device, through WSL2

Munder Difflin runs agents on Linux devices. A Windows machine joins as one by
running Ubuntu in WSL2 with Tailscale installed inside it. From the floor's
side it is an ordinary Linux device. Do these steps in order.

1. **Install WSL2 and Ubuntu.** In an administrator PowerShell, run
   `wsl --install -d Ubuntu`, reboot, then open Ubuntu and create your user.
   Use your laptop's username if you can, so you can skip step 8.

2. **Turn on systemd** so `tailscaled` and the agents' tmux keep running. In
   Ubuntu, run `sudoedit /etc/wsl.conf` and make sure it contains:

   ```ini
   [boot]
   systemd=true
   ```

   Then, in PowerShell, run `wsl --shutdown`. Open Ubuntu again and check that
   `systemctl is-system-running` prints `running` or `degraded`.

3. **Keep the WSL VM running when no window is open.** In Windows, create or
   edit `%UserProfile%\.wslconfig`:

   ```ini
   [wsl2]
   vmIdleTimeout=-1
   ```

   Then run `wsl --shutdown` again.

4. **Never sleep.** In Windows: Settings → System → Power → Screen and sleep →
   "When plugged in, put my device to sleep after" → Never. Or, in an
   administrator terminal: `powercfg /change standby-timeout-ac 0` and
   `powercfg /change hibernate-timeout-ac 0`.

5. **Start WSL after Windows restarts.** WSL starts only when something opens
   it. Open Ubuntu once after each reboot, or add a Task Scheduler task "At log
   on" that runs `wsl.exe -d Ubuntu --exec true`.

6. **Install Tailscale inside Ubuntu** (not only in Windows):
   `curl -fsSL https://tailscale.com/install.sh | sh`, then
   `sudo tailscale up --ssh`. In the Tailscale SSH policy, give this machine
   `"action": "accept"`, as for every device. Note its address:
   `tailscale ip -4`.

7. **Install the tools** in Ubuntu:
   `sudo apt update && sudo apt install -y nodejs tmux sshfs fuse3`. Check that
   `/dev/fuse` exists (`ls -l /dev/fuse`). Install Claude Code with
   `curl -fsSL https://claude.ai/install.sh | bash`, run `claude` and `/login`.
   Install any other engine your agents use there too.

8. **Use the same folder layout as the laptop.** If your Ubuntu user is not
   the laptop's, run `sudo ln -s /home/<your user> /home/royal`. If your repos
   live elsewhere, run
   `sudo mkdir -p /home/royal/Pro && sudo ln -s <your folder> /home/royal/Pro/Zensible`.
   Clone the repos your agents work in.

9. **Add it on the floor.** Open Settings → Devices → Add, with a name (for
   example `server`) and the Tailscale address from step 6. Then press Check.
   On WSL, Check adds "systemd on in WSL" and "/dev/fuse in WSL", and reminds
   you of steps 3 and 4, which it cannot see from inside WSL.
````

- [ ] **Step 9: Run the tests to verify they pass, one line at a time**

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/device-wsl.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/device-check.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/arabic-ui.test.cjs; fi`

Expected: all PASS (`device-wsl`: 4 tests).

- [ ] **Step 10: Type-check**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock npm run typecheck`
Expected: exits 0.

- [ ] **Step 11: Commit**

```bash
git -C /home/royal/Pro/Zensible/munder-difflin-wt/devices add -- src/shared/devices.ts src/main/deviceCommands.ts src/main/devices.ts src/renderer/src/components/DevicesSettings.tsx src/renderer/src/i18n/locales/en.json src/renderer/src/i18n/locales/ar.json src/renderer/src/i18n/locales/zh-CN.json docs/devices-wsl2.md test/device-wsl.test.cjs
git -C /home/royal/Pro/Zensible/munder-difflin-wt/devices commit -m 'devices: WSL2 Check items and setup guide' -m 'On WSL, Check verifies systemd under [boot] and /dev/fuse, and prints the .wslconfig idle timeout and Windows sleep settings as reminders, since neither is visible from inside WSL. docs/devices-wsl2.md lists the setup in order.' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G3wAo6k5J6tkH89c7qqJnG'
```

---

### Task 6: Other engines on devices: CLIs, hook bridges and Check

**Files:**
- Modify: `src/shared/devices.ts` (`'engine'` item; `name`; `DEVICE_PROVIDERS`)
- Modify: `src/main/deviceCommands.ts` (`rosterAgentsOn` returns provider and command; append engine and home-file builders)
- Modify: `src/main/devices.ts` (`checkDevice` engine items; `remoteTerminal` takes the command)
- Modify: `src/main/hive.ts` (`RemoteHome`; `ensureAgent` option `remote`; agy, grok and codex hooks on a device; port mode in the translating shims; COMMANDS.md)
- Modify: `src/main/index.ts` (`spawnAgentCore`, `remoteHomeFor`, `runDeviceCheck`)
- Modify: `src/renderer/src/components/DevicesSettings.tsx` (the engine name in its line)
- Modify: the three locale files
- Test: `test/devices-engines.test.cjs`

**Interfaces:**
- Consumes: `DeviceLink.exec(cmd, timeoutMs, input)` (Task 1); `runDeviceCheck` (Task 2); `checkDevice(link, hiveRoot, folders, localHome)` (Task 3); `REMOTE_HOOK_COMMAND`, `installShimCommand` (phase 1: the device's `~/.cache/munder-difflin/cth-hook.cjs` is refreshed on every connect); `installInfoForProvider`, `inferAgentProvider`, `providerPreset`, `bridgeOf` (`src/shared/agentProvider.ts`).
- Produces:
  - `DEVICE_PROVIDERS: readonly AgentProvider[]` in `src/shared/devices.ts`. `DeviceCheckItem.id` gains `'engine'`; `DeviceCheckItem.name?: string` (the engine's binary).
  - In `deviceCommands.ts`: `rosterAgentsOn(...)` returns `Array<{ id: string; cwd?: string; provider?: string; command?: string }>`; `engineCheck(provider: AgentProvider, bin: string): { cmd: string; fix: string }`; `REMOTE_ENV_PROBE: string`; `parseRemoteEnv(out: string): { home: string; node: string } | null`; `writeHomeFileCommand(rel: string): string`; `mergeHomeJsonCommand(rel: string, key: string): string`.
  - `checkDevice(link, hiveRoot, folders, localHome = homedir(), engines: Array<{ provider: AgentProvider; bin: string }> = [])`.
  - `remoteTerminal(link, hiveRoot, o)`: `o.command?: string` (default `'claude'`).
  - In `hive.ts`: `export interface RemoteHome { home: string; node: string; write(files: Array<{ path: string; content: string; mergeKey?: string }>): Promise<void> }`; `ensureAgent` option `remote?: RemoteHome`; `installAgyHooks(remote?: RemoteHome): Promise<void>`; `installGrokHooks(remote?: RemoteHome): Promise<void>`; `installCodexHooks(dir, agentId, hookCommand?: string)`.
  - In `index.ts`: `async function remoteHomeFor(link: DeviceLink): Promise<RemoteHome>`.
  - i18n key `devices.items.engine` (with `{{name}}`).

- [ ] **Step 1: Write the failing test**

Create `test/devices-engines.test.cjs`:

```js
'use strict';
/**
 * Devices phase 2, item 5: engines other than Claude Code on a device. Hook
 * files that live in the user's home are built here and written to the
 * DEVICE's home; they run the device's own node and its own copy of the
 * shim; the shims reach the floor over the forwarded port. Check finds each
 * engine's CLI with an install command. No network: a fake RemoteHome and
 * the fake ssh (test/fake-ssh.cjs).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { fakeDevice, waitForState } = require('./fake-ssh.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};
const { HiveManager } = loadTs('src/main/hive.ts');
const dc = loadTs('src/main/deviceCommands.ts');
const { DeviceLink, checkDevice } = loadTs('src/main/devices.ts');
const { DEVICE_PROVIDERS } = loadTs('src/shared/devices.ts');
const { installInfoForProvider } = loadTs('src/shared/agentProvider.ts');

const DEVICE = { home: '/home/alice', node: '/usr/bin/node' };

/** A temp hive home, with HOME pointed at it so a stray local write shows. */
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-engines-'));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  assert.equal(os.homedir(), home);
  const writes = [];
  const remote = { ...DEVICE, write: async (files) => { writes.push(...files); } };
  return { home, hive: new HiveManager(() => home), writes, remote };
}

test('only the engines the spec lists run on a device', () => {
  assert.deepEqual([...DEVICE_PROVIDERS].sort(), ['antigravity', 'claude', 'codex', 'crush', 'custom', 'grok', 'qwen']);
});

test('agy on a device: its hooks go to the device home, run by the device node', async (t) => {
  const { home, hive, writes, remote } = setup(t);
  await hive.ensureAgent({ id: 'agy-1', name: 'Agy', provider: 'antigravity', cwd: home }, { remote });
  assert.deepEqual(writes.map((w) => w.path).sort(),
    ['.cache/munder-difflin/agy-hook.cjs', '.gemini/antigravity-cli/hooks.json', '.gemini/config/hooks.json']);
  const cfg = writes.find((w) => w.path === '.gemini/config/hooks.json');
  assert.equal(cfg.mergeKey, 'munder-hive');
  assert.equal(JSON.parse(cfg.content).Stop[0].hooks[0].command,
    '"/usr/bin/node" "/home/alice/.cache/munder-difflin/agy-hook.cjs" Stop');
  assert.equal(fs.existsSync(path.join(home, '.gemini')), false, "this laptop's home is untouched");
});

test('grok on a device: same, with its own file', async (t) => {
  const { home, hive, writes, remote } = setup(t);
  await hive.ensureAgent({ id: 'grok-1', name: 'Grok', provider: 'grok', cwd: home }, { remote });
  assert.deepEqual(writes.map((w) => w.path).sort(), ['.cache/munder-difflin/grok-hook.cjs', '.grok/hooks/munder-hive.json']);
  const hooks = JSON.parse(writes.find((w) => w.path === '.grok/hooks/munder-hive.json').content).hooks;
  assert.equal(hooks.Stop[0].hooks[0].command, '"/usr/bin/node" "/home/alice/.cache/munder-difflin/grok-hook.cjs"');
  assert.equal(fs.existsSync(path.join(home, '.grok')), false);
});

test("codex on a device: its hive CODEX_HOME runs the device's shim copy", async (t) => {
  const { home, hive, writes, remote } = setup(t);
  const inj = await hive.ensureAgent({ id: 'cx-1', name: 'Codex', provider: 'codex', cwd: home }, { remote });
  const toml = fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8');
  assert.ok(toml.includes(`command = ${JSON.stringify('"/usr/bin/node" "/home/alice/.cache/munder-difflin/cth-hook.cjs"')}`), toml);
  assert.ok(!toml.includes('hive-node'), "never this laptop's Electron launcher");
  assert.deepEqual(writes, [], 'codex keeps its config in the hive, which the device mounts');
});

async function hookLine(t, shim, args, stdin) {
  const lines = [];
  const server = net.createServer((c) => {
    c.setEncoding('utf8');
    c.on('data', (d) => { lines.push(d); c.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const p = spawn(process.execPath, [shim, ...args], {
    env: { PATH: process.env.PATH, AGENT_ID: 'a-1', HIVE_HOOK_PORT: String(server.address().port) },
    stdio: ['pipe', 'ignore', 'ignore']
  });
  p.stdin.end(stdin);
  await new Promise((r) => p.on('close', r));
  return lines.join('');
}

test('the agy and grok shims reach the floor over HIVE_HOOK_PORT, with no HIVE_SOCK', async (t) => {
  const { home, hive, remote } = setup(t);
  await hive.ensureAgent({ id: 'agy-1', name: 'Agy', provider: 'antigravity', cwd: home }, { remote });
  await hive.ensureAgent({ id: 'grok-1', name: 'Grok', provider: 'grok', cwd: home }, { remote });
  const agy = await hookLine(t, path.join(home, 'hive', 'bin', 'agy-hook.cjs'), ['Stop'], '{}');
  assert.equal(JSON.parse(agy).hook_event_name, 'Stop');
  const grok = await hookLine(t, path.join(home, 'hive', 'bin', 'grok-hook.cjs'), [], '{"hookEventName":"stop"}');
  assert.equal(JSON.parse(grok).agent_id, 'a-1');
});

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-homefile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sh = (cmd, input) => spawnSync('bash', ['-c', cmd], {
    env: { ...process.env, HOME: dir, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` }, input, encoding: 'utf8'
  });
  return { dir, sh };
}

test('a home file is written from stdin, folders made', (t) => {
  const { dir, sh } = sandbox(t);
  assert.equal(sh(dc.writeHomeFileCommand('.grok/hooks/munder-hive.json'), '{"hooks":{}}').status, 0);
  assert.equal(fs.readFileSync(path.join(dir, '.grok/hooks/munder-hive.json'), 'utf8'), '{"hooks":{}}');
});

test('the home-file merge keeps other keys and survives garbage', (t) => {
  const { dir, sh } = sandbox(t);
  const f = path.join(dir, '.gemini/config/hooks.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ theirs: { x: 1 }, 'munder-hive': { old: true } }));
  assert.equal(sh(dc.mergeHomeJsonCommand('.gemini/config/hooks.json', 'munder-hive'), '{"Stop":[]}').status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { theirs: { x: 1 }, 'munder-hive': { Stop: [] } });
  fs.writeFileSync(f, 'not json at all');
  assert.equal(sh(dc.mergeHomeJsonCommand('.gemini/config/hooks.json', 'munder-hive'), '{"Stop":[]}').status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { 'munder-hive': { Stop: [] } });
});

test("the device's $HOME and node, or nothing", () => {
  assert.deepEqual(dc.parseRemoteEnv('home=/home/alice\nnode=/usr/bin/node\n'), DEVICE);
  assert.equal(dc.parseRemoteEnv('home=/home/alice\nnode=\n'), null, 'no node');
  assert.equal(dc.parseRemoteEnv('home=relative\nnode=/usr/bin/node\n'), null);
});

test("Check finds each engine's CLI, with the engine's own install command", async (t) => {
  const f = fakeDevice(t);
  f.tool('md-fake-engine', 'exit 0');
  const link = new DeviceLink({ id: 'my-lap', host: '100.65.189.1' }, f.env);
  t.after(() => link.stop());
  link.start();
  await waitForState(link, 'online');
  const items = (await checkDevice(link, f.hive, [], os.homedir(), [
    { provider: 'codex', bin: 'md-fake-engine' },
    { provider: 'codex', bin: 'md-missing-engine' }
  ])).filter((i) => i.id === 'engine');
  assert.deepEqual(items.map((i) => [i.name, i.ok]), [['md-fake-engine', true], ['md-missing-engine', false]]);
  const info = installInfoForProvider('codex', 'linux');
  assert.equal(items[1].fix, info.nativeCommand ?? info.command);
});

test('rosterAgentsOn carries each agent engine for Check', () => {
  const roster = { agents: [{ id: 'a', cwd: '/r', device: 'my-lap', provider: 'codex', command: 'codex --model x' }] };
  assert.deepEqual(dc.rosterAgentsOn(roster, 'my-lap'), [{ id: 'a', cwd: '/r', provider: 'codex', command: 'codex --model x' }]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/devices-engines.test.cjs; fi`
Expected: FAIL, `DEVICE_PROVIDERS` is undefined (`[...undefined]` throws).

- [ ] **Step 3: `DEVICE_PROVIDERS`, the item id and `name` (`src/shared/devices.ts`)**

At the top, after the file's doc comment, add `import type { AgentProvider } from './agentProvider';`.

Replace

```ts
    | 'wslSystemd' | 'wslFuse' | 'wslIdle' | 'wslSleep';
```
with
```ts
    | 'wslSystemd' | 'wslFuse' | 'wslIdle' | 'wslSleep' | 'engine';
```

and replace `  /** The agent folder, for \`folder\` items; the base folder, for \`base\`. */` with

```ts
  /** An engine's binary, for `engine` items. */
  name?: string;
  /** The agent folder, for `folder` items; the base folder, for `base`. */
```

Append at the end of the file:

```ts

/** The engines that run on a device (devices phase 2, item 5). Each has its
 *  CLI checked there, and its hook bridge set up for the device. */
export const DEVICE_PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'antigravity', 'grok', 'qwen', 'crush', 'custom'];
```

- [ ] **Step 4: Engine and home-file builders (`src/main/deviceCommands.ts`)**

After `import { projectKey } from './transcript';` add `import { installInfoForProvider, type AgentProvider } from '../shared/agentProvider';`.

Replace `rosterAgentsOn` (phase 1 Task 8 plus Task 2) in full:

```ts
export function rosterAgentsOn(
  roster: { agents?: unknown[]; restorable?: unknown[] } | null,
  deviceId: string
): Array<{ id: string; cwd?: string; provider?: string; command?: string }> {
  const out: Array<{ id: string; cwd?: string; provider?: string; command?: string }> = [];
  for (const a of [...(roster?.agents ?? []), ...(roster?.restorable ?? [])]) {
    if (!a || typeof a !== 'object') continue;
    const { id, cwd, device, lastDevice, provider, command } = a as Record<string, unknown>;
    // An Auto agent lives where it last ran: reconcile must keep its session,
    // and Check must cover its folder there.
    const on = device === AUTO_DEVICE ? lastDevice : device;
    if (typeof id !== 'string' || on !== deviceId) continue;
    // Check also needs each agent's engine (devices phase 2, item 5).
    out.push({
      id,
      ...(typeof cwd === 'string' ? { cwd } : {}),
      ...(typeof provider === 'string' ? { provider } : {}),
      ...(typeof command === 'string' ? { command } : {})
    });
  }
  return out;
}
```

Append at the end of the file:

```ts

// ─── Other engines on a device (devices phase 2, item 5) ─────────────────────

/** Is an engine's CLI on the device's login PATH, and how to install it. */
export function engineCheck(provider: AgentProvider, bin: string): { cmd: string; fix: string } {
  const info = installInfoForProvider(provider, 'linux');
  return {
    cmd: `command -v ${shq(bin)} >/dev/null`,
    fix: info.nativeCommand ?? info.command ?? `install ${bin} on the device, on its login PATH`
  };
}

/** The device's $HOME and the login shell's node: hook commands bake in both
 *  as absolute paths, because engines run hooks with a stripped PATH. */
export const REMOTE_ENV_PROBE = `printf 'home=%s\\nnode=%s\\n' "$HOME" "$(command -v node)"`;

export function parseRemoteEnv(out: string): { home: string; node: string } | null {
  const home = /^home=(.*)$/m.exec(out)?.[1].trim() ?? '';
  const node = /^node=(.*)$/m.exec(out)?.[1].trim() ?? '';
  return home.startsWith('/') && node.startsWith('/') ? { home, node } : null;
}

/** Write stdin to a file under the device's home, making its folders. */
export function writeHomeFileCommand(rel: string): string {
  return `f="$HOME"/${shq(rel)}; mkdir -p "$(dirname "$f")" && cat > "$f"`;
}

// The same rule installAgyHooks follows on this laptop: an unparseable or
// non-object file becomes {}, every other key is kept, only `key` is set.
const MERGE_JS = [
  "const fs=require('fs'),p=require('path');",
  "const f=p.join(require('os').homedir(),process.argv[1]),k=process.argv[2];let v='';",
  "process.stdin.setEncoding('utf8').on('data',d=>{v+=d}).on('end',()=>{",
  "let o={};try{o=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){}",
  'if(!o||typeof o!=="object"||Array.isArray(o))o={};',
  'o[k]=JSON.parse(v);fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(o,null,2))})'
].join('');

/** Set one key of a JSON file under the device's home to the JSON on stdin. */
export function mergeHomeJsonCommand(rel: string, key: string): string {
  return `node -e ${shq(MERGE_JS)} ${shq(rel)} ${shq(key)}`;
}
```

- [ ] **Step 5: Engine items in Check; the terminal runs the engine (`src/main/devices.ts`)**

Imports: add `engineCheck` to the `./deviceCommands` list; add `import type { AgentProvider } from '../shared/agentProvider';`.

Replace

```ts
  folders: string[],
  localHome: string = homedir()
): Promise<DeviceCheckItem[]> {
```
with
```ts
  folders: string[],
  localHome: string = homedir(),
  engines: Array<{ provider: AgentProvider; bin: string }> = []
): Promise<DeviceCheckItem[]> {
```

and replace

```ts
  // A Windows machine through WSL2 (devices phase 2, item 6).
```
with
```ts
  // Each other engine an agent here uses: its CLI, found by the login shell
  // (devices phase 2, item 5). Claude has its own item above.
  for (const e of engines) {
    const c = engineCheck(e.provider, e.bin);
    const r = await link.exec(c.cmd, 20_000);
    out.push(r.ok ? { id: 'engine', name: e.bin, ok: true } : { id: 'engine', name: e.bin, ok: false, fix: c.fix });
  }
  // A Windows machine through WSL2 (devices phase 2, item 6).
```

In `remoteTerminal`, replace

```ts
  o: { ptyId: string; agentId: string; cwd: string; env: Record<string, string>; args: string[]; cols?: number; rows?: number }
```
with
```ts
  o: { ptyId: string; agentId: string; cwd: string; env: Record<string, string>; args: string[]; cols?: number; rows?: number; command?: string }
```

and replace `command: 'claude', args: o.args` with `command: o.command ?? 'claude', args: o.args`.

- [ ] **Step 6: Hooks on the device (`src/main/hive.ts`)**

(a) Immediately before the line `/** Build env + extra spawn args that make an agent process hive-aware. */` insert:

```ts
/** Devices phase 2, item 5: for an agent on a device, an engine's hook files
 *  that live in the user's home go to the DEVICE's home. They are built here,
 *  as for a local agent; only the write is remote. The hooks run the
 *  device's node and the device's own copy of the shim, because the hive
 *  there is a mount that fails while the link is down. */
export interface RemoteHome {
  /** The device's $HOME, and its login shell's node (absolute paths). */
  home: string;
  node: string;
  /** Write files under the device's home. `path` is relative to it. With
   *  `mergeKey`, `content` (JSON) replaces that one key of an existing JSON
   *  file instead of the whole file. */
  write(files: Array<{ path: string; content: string; mergeKey?: string }>): Promise<void>;
}

/** Where a device keeps its own copies of the hook shims (the same folder
 *  phase 1's installShimCommand copies cth-hook.cjs into). */
const DEVICE_SHIM_DIR = '.cache/munder-difflin';

function deviceHookCommand(r: RemoteHome, script: string, ...args: string[]): string {
  return [`"${r.node}"`, `"${r.home}/${DEVICE_SHIM_DIR}/${script}"`, ...args].join(' ');
}

```

(b) In `ensureAgent`'s options type, replace

```ts
      hookCommand?: string;
    } = {}
```
with
```ts
      hookCommand?: string;
      /** A non-Claude agent on a device: where its home-config hooks go. */
      remote?: RemoteHome;
    } = {}
```

(c) In `ensureAgent`, replace

```ts
            if (desc.shim === 'agy') this.installAgyHooks();
            else if (desc.shim === 'codex') {
              env.CODEX_HOME = this.installCodexHooks(dir, meta.id);
```
with
```ts
            if (desc.shim === 'agy') await this.installAgyHooks(opts.remote);
            else if (desc.shim === 'codex') {
              // On a device, CODEX_HOME is still in the hive (the device mounts
              // it), but its hooks run the device's node and shim copy.
              env.CODEX_HOME = this.installCodexHooks(dir, meta.id, opts.remote ? deviceHookCommand(opts.remote, 'cth-hook.cjs') : undefined);
```

and replace `            else if (desc.shim === 'grok') this.installGrokHooks();` with `            else if (desc.shim === 'grok') await this.installGrokHooks(opts.remote);`.

(d) `installAgyHooks`: replace

```ts
  private installAgyHooks(): void {
    const root = this.root();
    if (!root) return;
    const shim = join(root, 'bin', 'agy-hook.cjs');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(shim, AGY_HOOK_SHIM, 'utf8');
    // Bundled node, not bare `node` — agy's hooks run with a stripped PATH too.
    const command = (event: string) => process.platform === 'win32'
      ? this.nodeRunUnquoted(shim, event)
      : this.nodeRun(shim, event);
```
with
```ts
  private async installAgyHooks(remote?: RemoteHome): Promise<void> {
    const root = this.root();
    if (!root) return;
    const shim = join(root, 'bin', 'agy-hook.cjs');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(shim, AGY_HOOK_SHIM, 'utf8');
    // Bundled node, not bare `node` — agy's hooks run with a stripped PATH too.
    // On a device: the device's node, by absolute path, for the same reason.
    const command = (event: string) => remote
      ? deviceHookCommand(remote, 'agy-hook.cjs', event)
      : process.platform === 'win32'
        ? this.nodeRunUnquoted(shim, event)
        : this.nodeRun(shim, event);
```

and replace

```ts
    const gem = join(homedir(), '.gemini');
```
with
```ts
    if (remote) {
      // The device's own home; other tools' hooks in these files are kept.
      await remote.write([
        { path: `${DEVICE_SHIM_DIR}/agy-hook.cjs`, content: AGY_HOOK_SHIM },
        { path: '.gemini/config/hooks.json', content: JSON.stringify(group), mergeKey: 'munder-hive' },
        { path: '.gemini/antigravity-cli/hooks.json', content: JSON.stringify(group), mergeKey: 'munder-hive' }
      ]);
      return;
    }
    const gem = join(homedir(), '.gemini');
```

(e) `installGrokHooks`: replace

```ts
  private installGrokHooks(): void {
```
with
```ts
  private async installGrokHooks(remote?: RemoteHome): Promise<void> {
```

replace

```ts
        hooks: [{ type: 'command', command: this.nodeRun(shim) }]
```
with
```ts
        hooks: [{ type: 'command', command: remote ? deviceHookCommand(remote, 'grok-hook.cjs') : this.nodeRun(shim) }]
```

and replace

```ts
      const hookDir = join(homedir(), '.grok', 'hooks');
```
with
```ts
      if (remote) {
        await remote.write([
          { path: `${DEVICE_SHIM_DIR}/grok-hook.cjs`, content: GROK_HOOK_SHIM },
          { path: '.grok/hooks/munder-hive.json', content: JSON.stringify({ hooks }, null, 2) }
        ]);
        return;
      }
      const hookDir = join(homedir(), '.grok', 'hooks');
```

(f) `installCodexHooks`: replace

```ts
  private installCodexHooks(dir: string, agentId: string): string {
```
with
```ts
  private installCodexHooks(dir: string, agentId: string, hookCommand?: string): string {
```

replace `      if (shim) {` (inside `installCodexHooks`, the one followed by `const events = ['PreToolUse', …`) with `      if (shim || hookCommand) {`, and replace

```ts
        const command = process.platform === 'win32'
          ? this.nodeRunUnquoted(shim)
          : this.nodeRun(shim);
```
with
```ts
        // A device agent's command is given (the device's node and shim copy).
        const command = hookCommand ?? (process.platform === 'win32'
          ? this.nodeRunUnquoted(shim!)
          : this.nodeRun(shim!));
```

(g) Port mode for the translating shims. On a device, `HIVE_SOCK` is not set and `HIVE_HOOK_PORT` is (phase 1 `remoteAgentEnv`). Replace every occurrence of

```js
  const sock = process.env.HIVE_SOCK;
```
with
```js
  const sock = Number(process.env.HIVE_HOOK_PORT) ? { host: '127.0.0.1', port: Number(process.env.HIVE_HOOK_PORT) } : process.env.HIVE_SOCK;
```

Use Edit with `replace_all: true`. It occurs three times, in `AGY_HOOK_SHIM`, `GEMINI_HOOK_SHIM` and `GROK_HOOK_SHIM`. Check with `grep -c "const sock = Number(process.env.HIVE_HOOK_PORT)" src/main/hive.ts`, which must print `3`. `net.createConnection` takes either form.

(h) In the COMMANDS.md text, replace `Only Claude Code runs on a device.` with `Claude Code, Codex, Antigravity, Grok, Qwen, Crush and custom engines run on a device.`.

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/devices-engines.test.cjs; fi`
Expected: PASS, 11 tests.

- [ ] **Step 8: Spawn other engines on a device (`src/main/index.ts`)**

Imports: in the `./deviceCommands` list add `engineCheck, mergeHomeJsonCommand, parseRemoteEnv, REMOTE_ENV_PROBE, writeHomeFileCommand`; in the `'../shared/devices'` braces add `DEVICE_PROVIDERS`; after the `./devices` import add `import type { RemoteHome } from './hive';`.

(a) Replace

```ts
    if (!claudeProvider) return { ok: false, error: `Only Claude Code runs on devices; a ${provider} agent runs on this laptop.` };
```
with
```ts
    if (!DEVICE_PROVIDERS.includes(provider)) {
      return { ok: false, error: `${providerPreset(provider).label} does not run on devices; run it on this laptop.` };
    }
```

(b) Replace

```ts
    if (!(await link.exec(dirExistsCommand(opts.cwd))).ok) {
      return { ok: false, error: `cwd does not exist on ${deviceId}: ${opts.cwd}` };
    }
```
with
```ts
    if (!(await link.exec(dirExistsCommand(opts.cwd))).ok) {
      return { ok: false, error: `cwd does not exist on ${deviceId}: ${opts.cwd}` };
    }
    // The engine's CLI must be there too, on the device's login PATH. (Check
    // covers claude; the local auto-installer never runs for a device.)
    if (!claudeProvider) {
      const e = engineCheck(provider, opts.command);
      if (!(await link.exec(e.cmd)).ok) {
        return { ok: false, error: `${opts.command} is not installed on ${deviceId}. Install it there: ${e.fix}` };
      }
    }
```

(c) Replace

```ts
  if (opts.hive) opts.hive = { ...opts.hive, device: deviceId };
```
with
```ts
  if (opts.hive) opts.hive = { ...opts.hive, device: deviceId };
  // A non-Claude engine's home-config hooks are written on the device; its
  // $HOME and node are read once here. A device that cannot answer fails
  // the spawn now rather than start an agent the floor cannot hear.
  let remoteHome: RemoteHome | undefined;
  if (link && !claudeProvider) {
    try { remoteHome = await remoteHomeFor(link); }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }
```

(d) In the `hive.ensureAgent(…)` options, replace

```ts
          hookCommand: link ? REMOTE_HOOK_COMMAND : undefined
```
with
```ts
          hookCommand: link ? REMOTE_HOOK_COMMAND : undefined,
          // A non-Claude engine's home-config hooks go to the device's home.
          remote: remoteHome
```

(e) Replace

```ts
      env: opts.env ?? {}, args: opts.args ?? [], cols: opts.cols, rows: opts.rows
    });
```
with
```ts
      env: opts.env ?? {}, args: opts.args ?? [], cols: opts.cols, rows: opts.rows,
      // The engine's own CLI; claude is found by the device's login PATH.
      command: claudeProvider ? 'claude' : opts.command
    });
```

(f) Codex Remote starts a daemon on THIS laptop, so a device agent skips it. Replace `  if (provider === 'codex' && opts.hive?.id) {` with `  if (provider === 'codex' && opts.hive?.id && !link) {`.

(g) Immediately before `async function startDevices(): Promise<void> {` insert:

```ts
/** What ensureAgent needs to write a non-Claude engine's home-config hooks
 *  on a device (devices phase 2, item 5). */
async function remoteHomeFor(link: DeviceLink): Promise<RemoteHome> {
  const r = await link.exec(REMOTE_ENV_PROBE);
  const env = r.ok ? parseRemoteEnv(r.stdout) : null;
  if (!env) throw new Error(`Could not find node on ${link.id}. Run Check in Settings → Devices.`);
  return {
    ...env,
    write: async (files) => {
      for (const f of files) {
        const cmd = f.mergeKey ? mergeHomeJsonCommand(f.path, f.mergeKey) : writeHomeFileCommand(f.path);
        const w = await link.exec(cmd, 30_000, f.content);
        if (!w.ok) throw new Error(`Could not write ~/${f.path} on ${link.id}: ${w.error ?? (w.stderr.trim() || `exit ${w.code}`)}`);
      }
    }
  };
}

```

(h) In `runDeviceCheck` (Task 2), replace

```ts
  const folders = [...new Set(rosterAgentsOn(roster.read(), id).map((a) => a.cwd).filter((c): c is string => !!c))];
  const items = await checkDevice(devices.get(id), root, folders);
```
with
```ts
  const agents = rosterAgentsOn(roster.read(), id);
  const folders = [...new Set(agents.map((a) => a.cwd).filter((c): c is string => !!c))];
  // Every other engine an agent here uses, once per binary.
  const engines = new Map<string, AgentProvider>();
  for (const a of agents) {
    const provider = inferAgentProvider(a.command, a.provider);
    if (provider === 'claude') continue;
    const bin = a.command?.trim().split(/\s+/)[0] || providerPreset(provider).defaultCommand;
    if (bin) engines.set(bin, provider);
  }
  const items = await checkDevice(devices.get(id), root, folders, undefined, [...engines].map(([bin, provider]) => ({ provider, bin })));
```

If `AgentProvider` is not yet imported as a type in `index.ts`, add `type AgentProvider` to its existing `'../shared/agentProvider'` import.

- [ ] **Step 9: The engine's name in Check (`DevicesSettings.tsx`) and the string**

In `DevicesSettings.tsx`, replace `{t(\`devices.items.${it.id}\`, { path: it.path })}` with `{t(\`devices.items.${it.id}\`, { path: it.path, name: it.name })}`.

```bash
cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && node - <<'EOF'
const fs = require('fs');
const dir = 'src/renderer/src/i18n/locales/';
const add = {
  en: { devices: { items: { engine: '{{name}} found' } } },
  ar: { devices: { items: { engine: 'تم العثور على {{name}}' } } },
  'zh-CN': { devices: { items: { engine: '已找到 {{name}}' } } }
};
const merge = (b, a) => { for (const [k, v] of Object.entries(a)) { if (v && typeof v === 'object') { b[k] = b[k] || {}; merge(b[k], v); } else b[k] = v; } };
for (const [loc, obj] of Object.entries(add)) {
  const f = dir + loc + '.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  merge(j, obj);
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
}
EOF
```

- [ ] **Step 10: Type-check**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock npm run typecheck`
Expected: exits 0.

- [ ] **Step 11: Re-run the tests this touches, one line at a time**

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/hive-hook-node.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/device-lifecycle.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/devices-remote-spawn.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/hive-generated-docs.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/arabic-ui.test.cjs; fi`

Expected: all PASS.

- [ ] **Step 12: Commit**

```bash
git -C /home/royal/Pro/Zensible/munder-difflin-wt/devices add -- src/shared/devices.ts src/main/deviceCommands.ts src/main/devices.ts src/main/hive.ts src/main/index.ts src/renderer/src/components/DevicesSettings.tsx src/renderer/src/i18n/locales/en.json src/renderer/src/i18n/locales/ar.json src/renderer/src/i18n/locales/zh-CN.json test/devices-engines.test.cjs
git -C /home/royal/Pro/Zensible/munder-difflin-wt/devices commit -m 'devices: codex, agy, grok, qwen, crush and custom engines on devices' -m 'The spawn checks the engine CLI on the device. agy and grok hook files are built here and written to the device home (merged, other keys kept); codex keeps its hive CODEX_HOME. All of them run the device node and its own shim copy, and the shims use the forwarded hook port. Check lists each engine an agent there uses, with its install command.' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G3wAo6k5J6tkH89c7qqJnG'
```

---

### Task 7: Proxy-tier engines on devices, and the usage line

**Files:**
- Modify: `src/shared/devices.ts` (append `usageUnavailableOnDevice`)
- Modify: `src/main/deviceCommands.ts` (append `forwardArgs`, `PROXY_SLOT_FIRST`)
- Modify: `src/main/devices.ts` (`DeviceLink.addForward`, `removeForward`; re-add on connect)
- Modify: `src/main/hive.ts` (`RemoteHome.forward`; the proxy branch)
- Modify: `src/main/index.ts` (`remoteHomeFor` forwards; `teardownPty` releases)
- Modify: `src/renderer/src/components/AgentCard.tsx`, `AgentStrip.tsx`
- Modify: the three locale files
- Test: `test/devices-proxy.test.cjs`

**Interfaces:**
- Consumes: `RemoteHome`, `remoteHomeFor`, the `remote` option (Task 6); `effectiveDevice` (Task 2); `bridgeOf`, `isClaudeProvider` (`agentProvider.ts`).
- Produces:
  - `PROXY_SLOT_FIRST = 3`; `forwardArgs(ctl: string, target: string, op: 'forward' | 'cancel', devicePort: number, localPort: number): string[]` in `deviceCommands.ts`.
  - `DeviceLink.addForward(key: string, localPort: number): Promise<number | null>` (the device port, or null) and `DeviceLink.removeForward(key: string): Promise<void>`. Forwards are re-added after every reconnect.
  - `RemoteHome.forward(localPort: number): Promise<number | null>`.
  - `usageUnavailableOnDevice(provider: AgentProvider): boolean` in `src/shared/devices.ts`.
  - `AgentCard` prop `usageUnavailable?: boolean`; i18n key `devices.usageUnavailable`.

- [ ] **Step 1: Write the failing test**

Create `test/devices-proxy.test.cjs`:

```js
'use strict';
/**
 * Devices phase 2, item 5, proxy tier: qwen and crush talk to a sidecar on
 * THIS laptop, whose port is forwarded to the device's loopback at base+3,
 * base+4, … A reconnect re-adds the forwards. Engines whose usage comes from
 * files on this laptop say so instead of showing a wrong zero.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { fakeDevice, waitForState } = require('./fake-ssh.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};
const dc = loadTs('src/main/deviceCommands.ts');
const { DeviceLink } = loadTs('src/main/devices.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { usageUnavailableOnDevice } = loadTs('src/shared/devices.ts');

const forwards = (f) => f.calls().filter((a) => a.includes('-O') && a[a.indexOf('-O') + 1] === 'forward').map((a) => a[a.indexOf('-R') + 1]);

async function online(t, f) {
  const link = new DeviceLink({ id: 'my-lap', host: '100.65.189.1' }, f.env);
  t.after(() => link.stop());
  link.start();
  await waitForState(link, 'online');
  return link;
}

test('forward argv: one -R on the device loopback, through the master', () => {
  assert.deepEqual(dc.forwardArgs('/c', 'u@h', 'forward', 47993, 5555),
    ['-S', '/c', '-O', 'forward', '-R', '127.0.0.1:47993:127.0.0.1:5555', '--', 'u@h']);
});

test('slots: base+3, base+4, and a freed slot is reused', async (t) => {
  const f = fakeDevice(t);
  const link = await online(t, f);
  assert.equal(await link.addForward('proxy:a', 5555), 47993);
  assert.equal(await link.addForward('proxy:b', 6666), 47994);
  await link.removeForward('proxy:a');
  assert.equal(await link.addForward('proxy:c', 7777), 47993);
  assert.deepEqual(forwards(f), ['127.0.0.1:47993:127.0.0.1:5555', '127.0.0.1:47994:127.0.0.1:6666', '127.0.0.1:47993:127.0.0.1:7777']);
});

test('forwards come back after a reconnect', { timeout: 20_000 }, async (t) => {
  const f = fakeDevice(t);
  const link = await online(t, f);
  await link.addForward('proxy:a', 5555);
  // Kill the master as a dropped link would: the fake master's pid is in the ControlPath.
  process.kill(Number(fs.readFileSync(link.ctl(), 'utf8')), 'SIGTERM');
  await waitForState(link, 'offline');
  await waitForState(link, 'online');
  assert.deepEqual(forwards(f), ['127.0.0.1:47993:127.0.0.1:5555', '127.0.0.1:47993:127.0.0.1:5555']);
});

function hiveWith(t, forward) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-proxy-dev-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.startProxyBridge = async () => 43210; // the sidecar on this laptop
  const calls = [];
  const remote = { home: '/home/alice', node: '/usr/bin/node', write: async () => {}, forward: async (p) => { calls.push(p); return forward; } };
  return { home, hive, remote, calls };
}

test("qwen on a device: its base URL is the forwarded port on the device's loopback", async (t) => {
  const { home, hive, remote, calls } = hiveWith(t, 47993);
  const inj = await hive.ensureAgent({ id: 'qw-1', name: 'Qwen', provider: 'qwen', cwd: home }, { remote });
  assert.deepEqual(calls, [43210]);
  assert.equal(inj.env.OPENAI_BASE_URL, 'http://127.0.0.1:47993');
  assert.equal(inj.degraded, undefined);
});

test('crush on a device: its config points at the forwarded port', async (t) => {
  const { home, hive, remote } = hiveWith(t, 47994);
  await hive.ensureAgent({ id: 'cr-1', name: 'Crush', provider: 'crush', cwd: home }, { remote });
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'agents', 'cr-1', 'crush.json'), 'utf8'));
  assert.equal(cfg.providers.openai.base_url, 'http://127.0.0.1:47994');
});

test('a forward that fails degrades the agent out loud', async (t) => {
  const { home, hive, remote } = hiveWith(t, null);
  const inj = await hive.ensureAgent({ id: 'qw-2', name: 'Qwen', provider: 'qwen', cwd: home }, { remote });
  assert.ok(inj.degraded);
  assert.equal(inj.env.OPENAI_BASE_URL, undefined);
});

test('usage: only engines that count from files on this laptop lose it on a device', () => {
  assert.equal(usageUnavailableOnDevice('claude'), false, 'OTLP is forwarded');
  assert.equal(usageUnavailableOnDevice('qwen'), false, 'its sidecar is here');
  assert.equal(usageUnavailableOnDevice('crush'), false);
  assert.equal(usageUnavailableOnDevice('codex'), true);
  assert.equal(usageUnavailableOnDevice('grok'), true);
  assert.equal(usageUnavailableOnDevice('antigravity'), true);
  assert.equal(usageUnavailableOnDevice('custom'), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/devices-proxy.test.cjs; fi`
Expected: FAIL, `dc.forwardArgs is not a function`.

- [ ] **Step 3: `forwardArgs` (`src/main/deviceCommands.ts`)**

Append at the end of the file:

```ts

// ─── Proxy-tier engines on a device (devices phase 2, item 5) ────────────────

/** The first proxy slot: base = SFTP, +1 hooks, +2 telemetry, then proxies. */
export const PROXY_SLOT_FIRST = 3;

/** Add or cancel one remote forward on the running master. A new master
 *  starts with only its three, so the link re-adds these on every connect. */
export function forwardArgs(ctl: string, target: string, op: 'forward' | 'cancel', devicePort: number, localPort: number): string[] {
  return ['-S', ctl, '-O', op, '-R', `127.0.0.1:${devicePort}:127.0.0.1:${localPort}`, '--', target];
}
```

- [ ] **Step 4: Forwards on the link (`src/main/devices.ts`)**

Imports: add `forwardArgs, PROXY_SLOT_FIRST` to the `./deviceCommands` list.

In `class DeviceLink`, replace

```ts
  /** Set when the link ends the master itself, so the exit says why. */
  private killReason: string | undefined;
```
with
```ts
  /** Set when the link ends the master itself, so the exit says why. */
  private killReason: string | undefined;
  /** Proxy sidecar forwards, by key: device port → this laptop's port. Kept
   *  across reconnects and re-added on each one. */
  private readonly forwards = new Map<string, { device: number; local: number }>();
```

In `connect()`, replace

```ts
    this.attempt = 0;
    this.setState('online', undefined);
```
with
```ts
    // A new master has only its three forwards: put the proxies back.
    for (const f of this.forwards.values()) {
      await this.spawnSsh(forwardArgs(this.ctl(), this.target(), 'forward', f.device, f.local), 10_000);
    }
    if (this.master !== m) return;
    this.attempt = 0;
    this.setState('online', undefined);
```

Immediately before `  private setState(state: DeviceState, error: string | undefined): void {` insert:

```ts
  /** Forward a loopback port of this laptop to the first free proxy slot on
   *  the device's loopback (base+3, base+4, …). Resolves the device port, or
   *  null when the master refused it. */
  async addForward(key: string, localPort: number): Promise<number | null> {
    await this.removeForward(key);
    const used = new Set([...this.forwards.values()].map((f) => f.device));
    let device = this.portBase + PROXY_SLOT_FIRST;
    while (used.has(device)) device++;
    if (device > 65535 || this.state !== 'online') return null;
    const r = await this.spawnSsh(forwardArgs(this.ctl(), this.target(), 'forward', device, localPort), 10_000);
    if (r.code !== 0) return null;
    this.forwards.set(key, { device, local: localPort });
    return device;
  }

  /** Drop a forward (its agent ended). Idempotent. */
  async removeForward(key: string): Promise<void> {
    const f = this.forwards.get(key);
    if (!f) return;
    this.forwards.delete(key);
    if (this.state === 'online') await this.spawnSsh(forwardArgs(this.ctl(), this.target(), 'cancel', f.device, f.local), 5_000);
  }

```

- [ ] **Step 5: The proxy branch on a device (`src/main/hive.ts`)**

In `interface RemoteHome` (Task 6), replace

```ts
  write(files: Array<{ path: string; content: string; mergeKey?: string }>): Promise<void>;
}
```
with
```ts
  write(files: Array<{ path: string; content: string; mergeKey?: string }>): Promise<void>;
  /** Forward a loopback port of this laptop to the device's loopback;
   *  resolves the device-side port, or null when that failed. */
  forward(localPort: number): Promise<number | null>;
}
```

In `ensureAgent`'s proxy branch, replace

```ts
            if (port > 0) {
              const loopback = `http://127.0.0.1:${port}`;
```
with
```ts
            // On a device, the CLI reaches this laptop's sidecar through a port
            // forwarded to the device's own loopback (base+3, base+4, …).
            const reach = port > 0 && opts.remote ? await opts.remote.forward(port) : port;
            if (reach && reach > 0) {
              const loopback = `http://127.0.0.1:${reach}`;
```

- [ ] **Step 6: Wire the forwards (`src/main/index.ts`)**

Replace

```ts
async function remoteHomeFor(link: DeviceLink): Promise<RemoteHome> {
```
with
```ts
async function remoteHomeFor(link: DeviceLink, agentId: string): Promise<RemoteHome> {
```

and in its returned object replace

```ts
  return {
    ...env,
    write: async (files) => {
```
with
```ts
  return {
    ...env,
    // One forward per agent; teardownPty releases it.
    forward: (localPort) => link.addForward(`proxy:${agentId}`, localPort),
    write: async (files) => {
```

Replace `  if (link && !claudeProvider) {\n    try { remoteHome = await remoteHomeFor(link); }` with:

```ts
  if (link && !claudeProvider && opts.hive) {
    try { remoteHome = await remoteHomeFor(link, opts.hive.id); }
```

In `teardownPty`, replace

```ts
    try { hive.stopProxyBridge(agentId); } catch (e) { console.error('[hive] stopProxyBridge failed:', e); }
```
with
```ts
    try { hive.stopProxyBridge(agentId); } catch (e) { console.error('[hive] stopProxyBridge failed:', e); }
    // …and its forward to a device, if it ran on one.
    for (const l of devices.all()) void l.removeForward(`proxy:${agentId}`);
```

- [ ] **Step 7: The usage line (`src/shared/devices.ts`, `AgentCard.tsx`, `AgentStrip.tsx`)**

`src/shared/devices.ts`: replace `import type { AgentProvider } from './agentProvider';` with `import { bridgeOf, isClaudeProvider, type AgentProvider } from './agentProvider';`, and append:

```ts

/** Usage that would read wrong on a device. Claude's comes over the
 *  forwarded OTLP port and a proxy engine's from its sidecar here; every
 *  other engine's fallback reads conversation files on THIS laptop, which a
 *  device agent never writes. */
export function usageUnavailableOnDevice(provider: AgentProvider): boolean {
  return !isClaudeProvider(provider) && bridgeOf(provider)?.kind !== 'proxy';
}
```

`AgentCard.tsx`: replace (phase 1 Task 10)

```tsx
  /** Its device's link is down: the card greys out, "offline · reconnecting". */
  deviceOffline?: boolean;
}
```
with
```tsx
  /** Its device's link is down: the card greys out, "offline · reconnecting". */
  deviceOffline?: boolean;
  /** On a device, this engine's usage cannot be read: say so, not a wrong zero. */
  usageUnavailable?: boolean;
}
```

replace `  doingCount = 0, onTaskNoteClick, draggable, note, onEditNote, device, deviceOffline` with `  doingCount = 0, onTaskNoteClick, draggable, note, onEditNote, device, deviceOffline, usageUnavailable`, and replace

```tsx
  const gaugeTitle = contextTokens !== undefined && contextLimit
```
with
```tsx
  const gaugeTitle = usageUnavailable ? t('devices.usageUnavailable') : contextTokens !== undefined && contextLimit
```

`AgentStrip.tsx`: add `import { inferAgentProvider } from '@/store/config';` (skip it if the file already imports it) and `import { usageUnavailableOnDevice } from '@shared/devices';`. Replace

```tsx
            deviceOffline={deviceOffline(effectiveDevice(a.device, a.lastDevice), deviceStates)}
```
with
```tsx
            deviceOffline={deviceOffline(effectiveDevice(a.device, a.lastDevice), deviceStates)}
            usageUnavailable={!!effectiveDevice(a.device, a.lastDevice) && usageUnavailableOnDevice(inferAgentProvider(a.command, a.provider))}
```

```bash
cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && node - <<'EOF'
const fs = require('fs');
const dir = 'src/renderer/src/i18n/locales/';
const add = {
  en: { devices: { usageUnavailable: 'usage not available on a device' } },
  ar: { devices: { usageUnavailable: 'الاستهلاك غير متاح على جهاز آخر' } },
  'zh-CN': { devices: { usageUnavailable: '在设备上无法获取用量' } }
};
const merge = (b, a) => { for (const [k, v] of Object.entries(a)) { if (v && typeof v === 'object') { b[k] = b[k] || {}; merge(b[k], v); } else b[k] = v; } };
for (const [loc, obj] of Object.entries(add)) {
  const f = dir + loc + '.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  merge(j, obj);
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
}
EOF
```

- [ ] **Step 8: Run the tests to verify they pass, one line at a time**

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/devices-proxy.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/proxy-bridge-retry.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/devices-link.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/arabic-ui.test.cjs; fi`

Expected: all PASS (`devices-proxy`: 7 tests).

- [ ] **Step 9: Type-check**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock npm run typecheck`
Expected: exits 0.

- [ ] **Step 10: Commit**

```bash
git -C /home/royal/Pro/Zensible/munder-difflin-wt/devices add -- src/shared/devices.ts src/main/deviceCommands.ts src/main/devices.ts src/main/hive.ts src/main/index.ts src/renderer/src/components/AgentCard.tsx src/renderer/src/components/AgentStrip.tsx src/renderer/src/i18n/locales/en.json src/renderer/src/i18n/locales/ar.json src/renderer/src/i18n/locales/zh-CN.json test/devices-proxy.test.cjs
git -C /home/royal/Pro/Zensible/munder-difflin-wt/devices commit -m 'devices: proxy engines on devices, and the usage line' -m 'A qwen or crush sidecar on this laptop is forwarded to the device loopback at base+3, base+4 and so on, re-added on every reconnect and released when the agent ends. Engines whose usage comes from files on this laptop show "usage not available on a device" instead of a zero.' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G3wAo6k5J6tkH89c7qqJnG'
```

---

### Task 8: The control page's floor: today's cost, activity, and the `FloorSource` adapter

**Files:**
- Modify: `src/main/costLifetime.ts` (`usdTodayFor`)
- Create: `src/main/remoteFloorSource.ts`
- Test: `test/cost-today.test.cjs`, `test/remote-floor-source.test.cjs`

**Interfaces:**
- Consumes: `FloorSource`, `FloorState`, `FloorActionResult`, `FloorAgentStatus` (`src/main/remoteFloor.ts`, merged); `classifyHook`, `isTurnHook` (`src/main/workerWake.ts`); `answerHumanQA`, `answerMail`, `findRawTask` (`src/shared/workspace/inboxAsk.ts`); `DeviceStatus` (`src/shared/devices.ts`); `HiveManager` (in the test only).
- Produces:
  - `CostLedgerTotals.usdTodayFor(agentId: string, now?: number): number | null`. It is null until the first fold.
  - In `remoteFloorSource.ts`: `type Activity = 'working' | 'idle' | 'needs-you'`; `class FloorActivity { note(agentId: string | undefined, event: string, message: string | undefined): void; get(agentId: string): Activity }`; `interface FloorDeps` (below); `PAGE_MAIL_SUBJECT = 'Message from the human'`; `createFloorSource(d: FloorDeps): FloorSource & { changed(): void }`.

This task touches no file that Group A touches, so it can be built in its own worktree at any time.

- [ ] **Step 1: Write the failing cost test**

Create `test/cost-today.test.cjs`:

```js
'use strict';
/**
 * Devices phase 2, item 8: the control page shows each agent's spend today.
 * Ledger rows are cumulative per (agent, session) and reset when the app
 * restarts, so "today" is the session's climb since its last row before
 * local midnight, summed over sessions, counting each reset segment.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { CostLedgerTotals } = loadTs('src/main/costLifetime.ts');

const at = (d, h) => new Date(2026, 9, d, h).getTime(); // local time, October 2026
const NOW = at(29, 18);
const row = (agent, session, usd, ts) => JSON.stringify({
  agent_id: agent, session_id: session, ts, input: 0, output: 0, cache_read: 0, cache_creation: 0, model: '', usd
});

async function today(t, lines, agent = 'a') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cost-today-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'cost-ledger.jsonl');
  fs.writeFileSync(p, lines.length ? `${lines.join('\n')}\n` : '');
  const c = new CostLedgerTotals();
  await c.refreshFully(p);
  return c.usdTodayFor(agent, NOW);
}

test('yesterday\'s spend is not today\'s', async (t) => {
  assert.equal(await today(t, [row('a', 's1', 1.0, at(28, 20)), row('a', 's1', 1.5, at(29, 9)), row('a', 's1', 2.0, at(29, 10))]), 1.0);
});

test('a session that started today counts in full', async (t) => {
  assert.equal(await today(t, [row('a', 's1', 0.3, at(29, 9)), row('a', 's1', 0.7, at(29, 11))]), 0.7);
});

test('a counter reset today still counts both halves', async (t) => {
  // 1.0 by last night; +0.5 this morning; app restart (counter back to 0); +0.5 more.
  const v = await today(t, [
    row('a', 's1', 1.0, at(28, 20)), row('a', 's1', 1.5, at(29, 9)),
    row('a', 's1', 0.2, at(29, 12)), row('a', 's1', 0.5, at(29, 13))
  ]);
  assert.ok(Math.abs(v - 1.0) < 1e-9, String(v));
});

test('several sessions add up; other agents and idle sessions do not', async (t) => {
  assert.equal(await today(t, [
    row('a', 's1', 0.4, at(29, 9)), row('a', 's2', 0.6, at(29, 10)),
    row('b', 's3', 9.0, at(29, 10)), row('a', 's0', 5.0, at(27, 10))
  ]), 1.0);
});

test('null until the ledger has been read', () => {
  assert.equal(new CostLedgerTotals().usdTodayFor('a', NOW), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/cost-today.test.cjs; fi`
Expected: FAIL, `c.usdTodayFor is not a function`.

- [ ] **Step 3: `usdTodayFor` (`src/main/costLifetime.ts`)**

After the `MAX_BYTES_PER_PASS` constant, add:

```ts

/** A timestamp's local calendar day, `YYYY-MM-DD`, which sorts as a string. */
function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
```

In `class CostLedgerTotals`, after `  private readonly seg = new Map<string, Segment>();` add:

```ts
  /** `agentId \t sessionId` → the local day of its newest row, and the
   *  segment's running total (committed + peak) just before that day's first
   *  row. Today's spend is the running total now minus that base. */
  private readonly day = new Map<string, { day: string; base: number }>();
```

After the `usdFor` method, add:

```ts
  /** Spend today (local time) for one agent, or null when the ledger has not
   *  been folded yet (the control page shows "unknown", never a cold $0).
   *  `committed + peak` only ever climbs, resets included, so the climb since
   *  the last row before midnight is exactly today's spend. */
  usdTodayFor(agentId: string, now: number = Date.now()): number | null {
    if (!this.warm) return null;
    const today = localDay(now);
    let usd = 0;
    for (const [key, d] of this.day) {
      if (d.day !== today || key.slice(0, key.indexOf('\t')) !== agentId) continue;
      const s = this.seg.get(key);
      if (s) usd += s.committed + s.peak - d.base;
    }
    return usd;
  }
```

In `foldLine`, replace

```ts
    let s = this.seg.get(key);
    if (!s) { s = { committed: 0, peak: 0 }; this.seg.set(key, s); }
```
with
```ts
    let s = this.seg.get(key);
    if (!s) { s = { committed: 0, peak: 0 }; this.seg.set(key, s); }
    // The first row of a newer day fixes that day's base: the total so far.
    const day = localDay(typeof (row as { ts?: unknown }).ts === 'number' ? (row as { ts: number }).ts : 0);
    const seen = this.day.get(key);
    if (!seen || day > seen.day) this.day.set(key, { day, base: s.committed + s.peak });
```

In `reset()`, after `    this.seg.clear();` add `    this.day.clear();`.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/cost-today.test.cjs; fi`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing adapter test**

Create `test/remote-floor-source.test.cjs`:

```js
'use strict';
/**
 * Devices phase 2, item 8: the FloorSource the control page serves. Agent
 * status, open questions and mail come from the same state the floor
 * renders; answering a question writes the same task file the floor's Ask
 * Me does, and sends the same mail.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};
const { FloorActivity, createFloorSource, PAGE_MAIL_SUBJECT } = loadTs('src/main/remoteFloorSource.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { answerHumanQA, findRawTask } = loadTs('src/shared/workspace/inboxAsk.ts');

const NOW = new Date('2026-10-29T12:00:00.000Z');

function deps(over = {}) {
  const calls = [];
  const d = {
    registry: () => ({ godId: 'god', agents: {
      god: { name: 'Michael', isGod: true },
      pam: { name: 'Pam', role: 'worker', device: 'my-lap' },
      jim: { name: 'Jim' },
      old: { name: 'Old', archived: true }
    } }),
    tasks: () => ({ tasks: [{ id: 't1', title: 'Ship it', humanQA: [
      { q: 'Done one?', a: 'yes' }, { q: 'Which branch?', askedAt: '2026-10-29T10:00:00Z' }, { q: 'Skip?', dismissedAt: 'x' }
    ] }] }),
    patchTask: () => true,
    send: (msg, from) => { calls.push(['send', msg, from]); },
    messages: () => [
      { id: 'm1', from: 'human', to: 'pam', subject: 's', body: 'b', created_at: '2026-10-29T09:00:00Z' },
      { id: 'm1', from: 'human', to: 'pam', subject: 's', body: 'b', created_at: '2026-10-29T09:00:00Z' },
      { id: 'm2', from: 'pam', to: 'god', subject: 's', body: 'b', created_at: '2026-10-29T11:00:00Z' },
      { id: 'm3', from: 'pam', to: 'jim', subject: 's', body: 'b', created_at: '2026-10-29T11:30:00Z' }
    ],
    isGod: (id) => id === 'god',
    activity: (id) => (id === 'jim' ? 'needs-you' : 'working'),
    paused: () => false,
    deliveryPaused: (id) => id === 'pam',
    contextPct: () => 42,
    costToday: () => 1.25,
    devices: () => [{ id: 'my-lap', state: 'online' }],
    halt: (id) => calls.push(['halt', id]),
    restart: async (id) => { calls.push(['restart', id]); return { ok: true }; },
    setAutoDelivery: (id, p) => calls.push(['auto', id, p]),
    messageSent: () => calls.push(['counted']),
    now: () => NOW,
    ...over
  };
  return { d, calls };
}

test('state: live agents with status, device, context, cost and delivery', async () => {
  const { d } = deps();
  const s = await createFloorSource(d).state();
  assert.deepEqual(s.agents.map((a) => [a.id, a.status, a.device]), [['god', 'working', 'local'], ['pam', 'working', 'my-lap'], ['jim', 'needs-you', 'local']]);
  const pam = s.agents[1];
  assert.deepEqual([pam.role, pam.contextPct, pam.costTodayUsd, pam.deliveryPaused, pam.remoteControlUrl], ['worker', 42, 1.25, true, null]);
  assert.equal(s.agents[0].role, 'orchestrator');
  assert.deepEqual(s.devices, [{ id: 'my-lap', name: 'my-lap', state: 'online' }]);
});

test('status: paused beats a dropped device, which beats activity', async () => {
  const { d } = deps({ devices: () => [{ id: 'my-lap', state: 'offline' }], paused: (id) => id === 'god' });
  const s = await createFloorSource(d).state();
  assert.deepEqual(s.agents.map((a) => a.status), ['paused', 'offline', 'needs-you']);
});

test('questions: only open humanQA entries, with their index', async () => {
  const { d } = deps();
  assert.deepEqual((await createFloorSource(d).state()).questions,
    [{ taskId: 't1', taskTitle: 'Ship it', qIndex: 1, q: 'Which branch?', askedAt: '2026-10-29T10:00:00Z' }]);
});

test('mail: to or from the human or god, once each, newest first', async () => {
  const { d } = deps();
  assert.deepEqual((await createFloorSource(d).state()).mail.map((m) => m.id), ['m2', 'm1']);
});

function realHive(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-floor-src-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  hive.writeTasks([{ id: 't1', title: 'Ship it', status: 'blocked', humanQA: [{ q: 'Which branch?', askedAt: 'x', extra: 'kept' }] }]);
  return { hive, file: path.join(home, 'hive', 'tasks.json') };
}

test('answering from the page writes the same task file as the floor, and mails god', async (t) => {
  const page = realHive(t);
  const floor = realHive(t);
  const { d, calls } = deps({ tasks: () => page.hive.tasks(), patchTask: (id, p) => page.hive.patchTask(id, p) });
  assert.deepEqual(await createFloorSource(d).answerQuestion('t1', 0, '  main  '), { ok: true });
  // The floor's Ask Me path (workspace/inbox/actions.ts), on an identical hive.
  const raw = findRawTask(floor.hive.tasks(), 't1');
  floor.hive.patchTask('t1', { humanQA: answerHumanQA(raw.humanQA, 'Which branch?', 'main', NOW.toISOString()) });
  assert.equal(fs.readFileSync(page.file, 'utf8'), fs.readFileSync(floor.file, 'utf8'));
  const [, mail, from] = calls.find((c) => c[0] === 'send');
  assert.equal(from, 'human');
  assert.equal(mail.to, 'god');
  assert.match(mail.subject, /HUMAN ANSWER on task "Ship it"/);
});

test('a question no longer open is refused, and nothing is written', async (t) => {
  const page = realHive(t);
  const { d, calls } = deps({ tasks: () => page.hive.tasks(), patchTask: (id, p) => page.hive.patchTask(id, p) });
  const src = createFloorSource(d);
  await src.answerQuestion('t1', 0, 'main');
  assert.equal((await src.answerQuestion('t1', 0, 'again')).ok, false);
  assert.equal((await src.answerQuestion('t1', 5, 'x')).ok, false);
  assert.equal(calls.filter((c) => c[0] === 'send').length, 1);
});

test('actions route to the floor handlers and fire a change', async () => {
  const { d, calls } = deps();
  const src = createFloorSource(d);
  let changes = 0;
  src.onChange(() => { changes++; });
  assert.deepEqual(await src.sendMail('pam', ' hi '), { ok: true });
  assert.deepEqual(await src.stopAgent('pam'), { ok: true });
  assert.deepEqual(await src.restartAgent('pam'), { ok: true });
  assert.deepEqual(await src.setAutoDelivery('pam', true), { ok: true });
  assert.deepEqual(calls, [
    ['send', { to: 'pam', act: 'inform', subject: PAGE_MAIL_SUBJECT, body: 'hi' }, 'human'], ['counted'],
    ['halt', 'pam'], ['restart', 'pam'], ['auto', 'pam', true]
  ]);
  assert.equal(changes, 4);
  assert.equal((await src.stopAgent('old')).ok, false, 'archived');
  assert.equal((await src.sendMail('nobody', 'x')).ok, false);
  assert.equal((await src.sendMail('pam', '   ')).ok, false);
});

test('activity: a permission prompt is needs-you until the next turn event', () => {
  const a = new FloorActivity();
  assert.equal(a.get('pam'), 'idle');
  a.note('pam', 'PreToolUse', undefined);
  assert.equal(a.get('pam'), 'working');
  a.note('pam', 'Notification', 'Claude needs your permission to use Bash');
  assert.equal(a.get('pam'), 'needs-you');
  a.note('pam', 'PostToolUse', undefined);
  assert.equal(a.get('pam'), 'working');
  a.note('pam', 'Stop', undefined);
  assert.equal(a.get('pam'), 'idle');
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/remote-floor-source.test.cjs; fi`
Expected: FAIL, `Cannot find module` for `src/main/remoteFloorSource.ts`.

- [ ] **Step 7: Create `src/main/remoteFloorSource.ts`**

```ts
/**
 * The control page's view of the floor (devices phase 2, item 8): the
 * FloorSource that remoteFloor.ts serves. It is built from the same state
 * and actions the floor uses, so the hive cannot tell which surface a person
 * used. Everything is injected (FloorDeps), so
 * test/remote-floor-source.test.cjs drives it without Electron.
 */
import type { FloorActionResult, FloorAgentStatus, FloorMail, FloorQuestion, FloorSource, FloorState } from './remoteFloor';
import type { DeviceStatus } from '../shared/devices';
import { classifyHook, isTurnHook } from './workerWake';
import { answerHumanQA, answerMail, findRawTask } from '../shared/workspace/inboxAsk';

/** What an agent's hooks last said it is doing. */
export type Activity = 'working' | 'idle' | 'needs-you';

/** Fed from HookServer's onEvent observer, the one channel every engine has.
 *  A permission prompt holds "needs-you" until the next turn event. */
export class FloorActivity {
  private readonly state = new Map<string, Activity>();

  note(agentId: string | undefined, event: string, message: string | undefined): void {
    if (!agentId) return;
    const c = classifyHook(event, message);
    if (c === 'needsHuman') this.state.set(agentId, 'needs-you');
    else if (c === 'idle' || event === 'Stop' || event === 'StopFailure' || event === 'SessionStart') this.state.set(agentId, 'idle');
    else if (isTurnHook(event)) this.state.set(agentId, 'working');
  }

  get(agentId: string): Activity {
    return this.state.get(agentId) ?? 'idle';
  }
}

interface RegistryLike {
  godId: string | null;
  agents: Record<string, { name: string; role?: string; isGod?: boolean; archived?: boolean; device?: string }>;
}

interface MailLike { id: string; from: string; to: string; subject: string; body: string; created_at: string }

/** What src/main/index.ts hands the adapter: each member is the floor's own
 *  state or handler (see each line there). */
export interface FloorDeps {
  registry(): RegistryLike;
  tasks(): unknown;
  patchTask(id: string, patch: { humanQA: unknown[] }): boolean;
  send(msg: { to: string; act: 'inform'; subject: string; body: string }, from: string): unknown;
  /** Recent mail, bodies already redacted (hive.voiceMessages). */
  messages(limit: number): MailLike[];
  isGod(agentId: string): boolean;
  activity(agentId: string): Activity;
  /** Paused or halted (ControlRegistry). */
  paused(agentId: string): boolean;
  deliveryPaused(agentId: string): boolean;
  contextPct(agentId: string): number | null;
  costToday(agentId: string): number | null;
  devices(): DeviceStatus[];
  halt(agentId: string): void;
  restart(agentId: string): Promise<FloorActionResult>;
  setAutoDelivery(agentId: string, paused: boolean): void;
  /** analytics.trackMessageSent('hive'): the page's mail is a person's. */
  messageSent(): void;
  now?(): Date;
}

/** The subject of mail sent from the page's box. */
export const PAGE_MAIL_SUBJECT = 'Message from the human';
const MAIL_SHOWN = 30;

export function createFloorSource(d: FloorDeps): FloorSource & { changed(): void } {
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const l of listeners) { try { l(); } catch { /* a closed stream */ } }
  };
  const live = (id: string): boolean => {
    const a = d.registry().agents[id];
    return !!a && !a.archived;
  };
  const unknown: FloorActionResult = { ok: false, error: 'No such agent on the floor.' };
  const notOpen: FloorActionResult = { ok: false, error: 'That question is no longer open.' };

  function questions(): FloorQuestion[] {
    const ledger = d.tasks() as { tasks?: unknown };
    const out: FloorQuestion[] = [];
    for (const raw of Array.isArray(ledger?.tasks) ? ledger.tasks : []) {
      if (!raw || typeof raw !== 'object') continue;
      const task = raw as Record<string, unknown>;
      const qa = Array.isArray(task.humanQA) ? task.humanQA : [];
      qa.forEach((e, qIndex) => {
        if (!e || typeof e !== 'object') return;
        const { q, a, dismissedAt, askedAt } = e as Record<string, unknown>;
        // TasksKanban openQuestion(): a string q, no answer, not dismissed.
        if (typeof q !== 'string' || a || dismissedAt) return;
        out.push({
          taskId: String(task.id),
          taskTitle: typeof task.title === 'string' ? task.title : String(task.id),
          qIndex,
          q,
          ...(typeof askedAt === 'string' ? { askedAt } : {})
        });
      });
    }
    return out;
  }

  function mail(): FloorMail[] {
    const seen = new Set<string>();
    return d.messages(200)
      .filter((m) => [m.from, m.to].some((p) => p === 'human' || d.isGod(p)))
      // A message shows once, though it sits in a sender's outbox and a
      // recipient's inbox.
      .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
      .sort((x, y) => (x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : 0))
      .slice(0, MAIL_SHOWN)
      .map((m) => ({ id: m.id, from: m.from, to: m.to, subject: m.subject, body: m.body, createdAt: m.created_at }));
  }

  function state(): FloorState {
    const reg = d.registry();
    const devs = d.devices();
    const linkState = new Map(devs.map((s) => [s.id, s.state]));
    const agents = Object.entries(reg.agents)
      .filter(([, a]) => !a.archived)
      .map(([id, a]) => {
        const status: FloorAgentStatus = d.paused(id)
          ? 'paused'
          : a.device && linkState.get(a.device) !== 'online' ? 'offline' : d.activity(id);
        return {
          id,
          name: a.name,
          role: a.role ?? (a.isGod ? 'orchestrator' : 'agent'),
          device: a.device || 'local',
          status,
          contextPct: d.contextPct(id),
          costTodayUsd: d.costToday(id),
          // Nothing records a session's Remote Control URL yet.
          remoteControlUrl: null,
          deliveryPaused: d.deliveryPaused(id)
        };
      });
    return { agents, questions: questions(), mail: mail(), devices: devs.map((s) => ({ id: s.id, name: s.id, state: s.state })) };
  }

  return {
    state,
    changed,
    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    // The Ask Me path, step for step (workspace/inbox/actions.ts answerAsk):
    // re-read the card, answer the question still open at that index, write
    // it, then mail god the same words.
    async answerQuestion(taskId, qIndex, text) {
      const task = findRawTask(d.tasks(), taskId);
      const entry = task && Array.isArray(task.humanQA) ? task.humanQA[qIndex] : undefined;
      const q = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).q : undefined;
      if (!task || typeof q !== 'string') return notOpen;
      const humanQA = answerHumanQA(task.humanQA, q, text, (d.now?.() ?? new Date()).toISOString());
      if (!humanQA) return notOpen;
      if (!d.patchTask(taskId, { humanQA })) return { ok: false, error: 'Could not write the task.' };
      d.send(answerMail({ id: taskId, title: typeof task.title === 'string' ? task.title : taskId }, q, text), 'human');
      changed();
      return { ok: true };
    },
    async sendMail(agentId, text) {
      const body = text.trim();
      if (!live(agentId)) return unknown;
      if (!body) return { ok: false, error: 'The message is empty.' };
      d.send({ to: agentId, act: 'inform', subject: PAGE_MAIL_SUBJECT, body }, 'human');
      d.messageSent();
      changed();
      return { ok: true };
    },
    async stopAgent(agentId) {
      if (!live(agentId)) return unknown;
      d.halt(agentId);
      changed();
      return { ok: true };
    },
    async restartAgent(agentId) {
      if (!live(agentId)) return unknown;
      const r = await d.restart(agentId);
      changed();
      return r;
    },
    async setAutoDelivery(agentId, paused) {
      if (!live(agentId)) return unknown;
      d.setAutoDelivery(agentId, paused);
      changed();
      return { ok: true };
    }
  };
}
```

If `FloorMail` or `FloorQuestion` is not exported from `remoteFloor.ts`, export it there (each is an `export interface` today).

- [ ] **Step 8: Run both tests to verify they pass, one line at a time**

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/remote-floor-source.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/cost-lifetime.test.cjs; fi`

Expected: PASS (`remote-floor-source`: 9 tests), and `cost-lifetime` still PASS.

- [ ] **Step 9: Type-check**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock npm run typecheck`
Expected: exits 0.

- [ ] **Step 10: Commit**

```bash
git -C /home/royal/Pro/Zensible/munder-difflin-wt/devices add -- src/main/costLifetime.ts src/main/remoteFloorSource.ts test/cost-today.test.cjs test/remote-floor-source.test.cjs
git -C /home/royal/Pro/Zensible/munder-difflin-wt/devices commit -m 'remoteFloor: the floor source and today cost' -m 'The cost ledger fold now also knows each session total at local midnight, so today spend survives counter resets. createFloorSource builds the control page state from the registry, hook activity, tasks and mail, and routes its actions through the floor own handlers; answering writes the same task file as Ask Me.' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G3wAo6k5J6tkH89c7qqJnG'
```

---

### Task 9: Wire the control page into the app

**Files:**
- Modify: `src/main/config.ts` (`remoteFloorEnabled`, `remoteFloorPort`, sanitising)
- Modify: `src/main/index.ts` (imports, `floorActivity`, `setAutoDeliveryPaused`, the control page block, change triggers, start/stop, quit)
- Modify: `src/preload/index.ts` (config type; `remoteFloorAddress`, `onRemoteRestart`)
- Modify: `src/renderer/src/store/config.ts` (config type)
- Create: `src/renderer/src/components/RemoteFloorSettings.tsx`
- Modify: `src/renderer/src/components/DevicesSettings.tsx` (render it)
- Create: `src/renderer/src/hooks/useRemoteRestart.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: the three locale files (a new top-level `remoteFloor` key)
- Test: `test/remote-floor-config.test.cjs`

**Interfaces:**
- Consumes: `RemoteFloor`, `DEFAULT_REMOTE_FLOOR_PORT` (`remoteFloor.ts`); `FloorActivity`, `createFloorSource` (Task 8); `CostLedgerTotals.usdTodayFor` (Task 8); `restartAgentProcess` (renderer); `devices`, `agentDevice` (phase 1).
- Produces:
  - `HarnessConfig.remoteFloorEnabled?: boolean` and `HarnessConfig.remoteFloorPort?: number` (main, preload, renderer). The port is kept only when it is an integer in 1024–65535.
  - In `index.ts`: `function setAutoDeliveryPaused(agentId: string, on: boolean): void`; `function syncRemoteFloor(cfg: { remoteFloorEnabled?: boolean; remoteFloorPort?: number }): void`; IPC `remoteFloor:address` → `{ ip: string; port: number } | null`; push `remoteFloor:restart` `{ reqId: number; agentId: string }` with the reply on `remoteFloor:restartDone` (reqId, `{ ok: boolean; error?: string }`).
  - Preload: `window.cth.remoteFloorAddress(): Promise<{ ip: string; port: number } | null>`; `window.cth.onRemoteRestart(cb: (agentId: string) => Promise<{ ok: boolean; error?: string }>): () => void`.
  - `<RemoteFloorSettings config />`; `useRemoteRestart(): void`; i18n keys `remoteFloor.{toggle,hint,address,waiting}`.

- [ ] **Step 1: Write the failing test**

Create `test/remote-floor-config.test.cjs`:

```js
'use strict';
/**
 * Devices phase 2, item 8: the control page's two config keys, sanitised on
 * write, and its strings in every locale.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-remote-floor-config-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => userData }, Notification: class { show() {} static isSupported() { return false; } } }
};
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));
const { writeConfig, readConfig } = loadTs('src/main/config.ts');

test('off by default; the toggle and a good port survive a round trip', () => {
  writeConfig({});
  assert.notEqual(readConfig().remoteFloorEnabled, true);
  writeConfig({ remoteFloorEnabled: true, remoteFloorPort: 47981 });
  assert.equal(readConfig().remoteFloorEnabled, true);
  assert.equal(readConfig().remoteFloorPort, 47981);
});

test('a bad port is dropped, which means the default', () => {
  for (const bad of [80, 70000, 1.5, '47980', null]) {
    writeConfig({ remoteFloorPort: 47981 });
    writeConfig({ remoteFloorPort: bad });
    assert.equal(readConfig().remoteFloorPort, undefined, String(bad));
  }
  writeConfig({ remoteFloorEnabled: 'yes' });
  assert.equal(readConfig().remoteFloorEnabled, false, 'only true turns it on');
});

test('the control page strings exist in every locale, {{url}} kept', () => {
  for (const l of ['en', 'ar', 'zh-CN']) {
    const r = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/i18n/locales', `${l}.json`), 'utf8')).remoteFloor;
    for (const k of ['toggle', 'hint', 'address', 'waiting']) assert.equal(typeof r?.[k], 'string', `${l}: remoteFloor.${k}`);
    assert.ok(r.address.includes('{{url}}'), `${l}: {{url}}`);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/remote-floor-config.test.cjs; fi`
Expected: FAIL in "a bad port is dropped" and the strings test.

- [ ] **Step 3: The config keys (`config.ts`, preload, renderer)**

`src/main/config.ts`: replace

```ts
   *  before their turn is stopped ("paused"). Default 10; 0 = never pause. */
  deviceOfflinePauseMin?: number;
}
```
with
```ts
   *  before their turn is stopped ("paused"). Default 10; 0 = never pause. */
  deviceOfflinePauseMin?: number;
  /** The phone-first control page (Settings → Devices → Control page). Off
   *  unless true. It binds only to this laptop's Tailscale address. */
  remoteFloorEnabled?: boolean;
  /** Its port; default 47980 (remoteFloor.ts DEFAULT_REMOTE_FLOOR_PORT). */
  remoteFloorPort?: number;
}
```

and replace

```ts
    else delete next.deviceOfflinePauseMin;
  }
  return persistConfig(next);
```
with
```ts
    else delete next.deviceOfflinePauseMin;
  }
  // The control page: on only when exactly true; a port outside 1024–65535
  // is dropped, which means the default.
  if ('remoteFloorEnabled' in patch) next.remoteFloorEnabled = patch.remoteFloorEnabled === true;
  if ('remoteFloorPort' in patch) {
    const p = patch.remoteFloorPort;
    if (typeof p === 'number' && Number.isInteger(p) && p >= 1024 && p <= 65535) next.remoteFloorPort = p;
    else delete next.remoteFloorPort;
  }
  return persistConfig(next);
```

`src/preload/index.ts` and `src/renderer/src/store/config.ts`: in each `HarnessConfig`, replace

```ts
  /** Minutes cut off before a device's agents pause (default 10, 0 = never). Mirrors src/main/config.ts. */
  deviceOfflinePauseMin?: number;
```
with
```ts
  /** Minutes cut off before a device's agents pause (default 10, 0 = never). Mirrors src/main/config.ts. */
  deviceOfflinePauseMin?: number;
  /** The control page is on. Mirrors src/main/config.ts. */
  remoteFloorEnabled?: boolean;
  /** The control page's port (default 47980). Mirrors src/main/config.ts. */
  remoteFloorPort?: number;
```

- [ ] **Step 4: The strings, in all three locales**

```bash
cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && node - <<'EOF'
const fs = require('fs');
const dir = 'src/renderer/src/i18n/locales/';
const add = {
  en: { remoteFloor: {
    toggle: 'Control page: the floor on your phone',
    hint: 'Served on this laptop’s Tailscale address only. Only your Tailscale login gets in.',
    address: 'Open {{url}}',
    waiting: 'Waiting for Tailscale…'
  } },
  ar: { remoteFloor: {
    toggle: 'صفحة التحكم: الطابق على هاتفك',
    hint: 'تُقدَّم على عنوان Tailscale لهذا الحاسوب فقط، ولا يدخلها إلا حسابك في Tailscale.',
    address: 'افتح {{url}}',
    waiting: 'بانتظار Tailscale…'
  } },
  'zh-CN': { remoteFloor: {
    toggle: '控制页：在手机上查看楼层',
    hint: '仅在这台笔记本的 Tailscale 地址上提供，只有你的 Tailscale 账号可以访问。',
    address: '打开 {{url}}',
    waiting: '正在等待 Tailscale…'
  } }
};
const merge = (b, a) => { for (const [k, v] of Object.entries(a)) { if (v && typeof v === 'object') { b[k] = b[k] || {}; merge(b[k], v); } else b[k] = v; } };
for (const [loc, obj] of Object.entries(add)) {
  const f = dir + loc + '.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  merge(j, obj);
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
}
EOF
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/remote-floor-config.test.cjs; fi`
Expected: PASS, 3 tests.

- [ ] **Step 6: Main wiring (`src/main/index.ts`)**

(a) After `import { RosterStore } from './roster';` add:

```ts
import { RemoteFloor, DEFAULT_REMOTE_FLOOR_PORT, type FloorActionResult } from './remoteFloor';
import { FloorActivity, createFloorSource } from './remoteFloorSource';
```

(b) Immediately before `const hookServer = new HookServer(` insert:

```ts
// What each agent's hooks last said it is doing, for the control page.
const floorActivity = new FloorActivity();
```

and replace `    workerWake.noteHook(agentId, event, message);` with

```ts
    workerWake.noteHook(agentId, event, message);
    floorActivity.note(agentId, event, message);
```

(c) Share the auto-delivery handler's body. Replace

```ts
ipcMain.handle('control:autoDelivery', (_evt, agentId: unknown, paused: unknown) => {
  if (typeof agentId !== 'string') return null;
  const on = paused === true;
  control.pauseAutoDelivery(agentId, on);
  const current = new Set(readConfig().autoDeliveryPausedAgents ?? []);
  if (on) current.add(agentId); else current.delete(agentId);
  writeConfig({ autoDeliveryPausedAgents: Array.from(current).sort() });
  // The Workspace's floor-wide hold shows up in every snapshot (below), so the
  // Classic floor switch reads it as "paused"; resuming from there must lift it
  // too, or that switch would flip to "auto" while nothing moved.
  if (!on) liftFloorDeliveryPause();
  return controlSnapshotWithFloorHold(agentId);
});
```
with
```ts
/** Pause or resume one agent's auto-delivery, and persist it. The floor's
 *  switch and the control page both come through here. */
function setAutoDeliveryPaused(agentId: string, on: boolean): void {
  control.pauseAutoDelivery(agentId, on);
  const current = new Set(readConfig().autoDeliveryPausedAgents ?? []);
  if (on) current.add(agentId); else current.delete(agentId);
  writeConfig({ autoDeliveryPausedAgents: Array.from(current).sort() });
  // The Workspace's floor-wide hold shows up in every snapshot (below), so the
  // Classic floor switch reads it as "paused"; resuming from there must lift it
  // too, or that switch would flip to "auto" while nothing moved.
  if (!on) liftFloorDeliveryPause();
}
ipcMain.handle('control:autoDelivery', (_evt, agentId: unknown, paused: unknown) => {
  if (typeof agentId !== 'string') return null;
  setAutoDeliveryPaused(agentId, paused === true);
  return controlSnapshotWithFloorHold(agentId);
});
```

(d) Replace `hive.setRoutedObserver((msg, targets) => closingTime.onRouted(msg, targets));` with:

```ts
// ─── Control page (devices phase 2, item 8) ─────────────────────────────────
// The phone-first page remoteFloor.ts serves over Tailscale. Off by default;
// Settings → Devices → Control page turns it on. Everything it shows and does
// goes through the floor's own state and handlers (remoteFloorSource.ts).
const floorSource = createFloorSource({
  registry: () => hive.registry(),
  tasks: () => hive.tasks(),
  patchTask: (id, patch) => hive.patchTask(id, patch as Partial<Omit<HiveTask, 'id'>>),
  send: (msg, from) => hive.send(msg, from),
  messages: (limit) => hive.voiceMessages({ limit }),
  isGod: (id) => hive.isGod(id),
  activity: (id) => floorActivity.get(id),
  paused: (id) => { const s = control.snapshot(id); return s.paused || s.halted; },
  deliveryPaused: (id) => controlSnapshotWithFloorHold(id).autoDeliveryPaused,
  // The hive:agentContext figure: the status line's tokens over its window.
  contextPct: (id) => { const c = hookServer.contextFor(id); return c && c.limit > 0 ? Math.round((c.tokens / c.limit) * 100) : null; },
  costToday: (id) => costTotals.usdTodayFor(id),
  devices: () => devices.statuses(),
  halt: (id) => control.halt(id),
  restart: (id) => restartFromPage(id),
  setAutoDelivery: (id, paused) => setAutoDeliveryPaused(id, paused),
  messageSent: () => analytics.trackMessageSent('hive')
});
devices.on('state', () => floorSource.changed());

let remoteFloor: RemoteFloor | null = null;
let remoteFloorPort = 0;
/** Start, stop or move the control page to match the config. */
function syncRemoteFloor(cfg: { remoteFloorEnabled?: boolean; remoteFloorPort?: number }): void {
  const want = cfg.remoteFloorEnabled === true && hive.enabled();
  const port = cfg.remoteFloorPort ?? DEFAULT_REMOTE_FLOOR_PORT;
  if (remoteFloor && (!want || port !== remoteFloorPort)) { void remoteFloor.stop(); remoteFloor = null; }
  if (want && !remoteFloor) {
    remoteFloorPort = port;
    remoteFloor = new RemoteFloor({ source: floorSource, port });
    void remoteFloor.start().catch((e) => console.error('[remote-floor] start failed:', e));
  }
}
ipcMain.handle('remoteFloor:address', () => remoteFloor?.address() ?? null);

// Restart lives in the renderer (restartAgentProcess), so the page asks the
// floor window and waits for its answer, at most two minutes.
let restartSeq = 0;
const pendingRestarts = new Map<number, (r: FloorActionResult) => void>();
ipcMain.on('remoteFloor:restartDone', (_evt, reqId: unknown, result: unknown) => {
  const done = typeof reqId === 'number' ? pendingRestarts.get(reqId) : undefined;
  const r = result as { ok?: unknown; error?: unknown } | null;
  done?.({ ok: r?.ok === true, ...(typeof r?.error === 'string' ? { error: r.error } : {}) });
});
function restartFromPage(agentId: string): Promise<FloorActionResult> {
  // A halted agent's flag would stop the new process at its first hook.
  control.resume(agentId);
  const wc = liveWebContents();
  if (!wc) return Promise.resolve({ ok: false, error: 'The floor window is closed.' });
  const reqId = ++restartSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingRestarts.delete(reqId); resolve({ ok: false, error: 'The floor did not answer.' }); }, 120_000);
    pendingRestarts.set(reqId, (r) => { clearTimeout(timer); pendingRestarts.delete(reqId); resolve(r); });
    wc.send('remoteFloor:restart', { reqId, agentId });
  });
}

hive.setRoutedObserver((msg, targets) => { closingTime.onRouted(msg, targets); floorSource.changed(); });
```

(e) In `writeFleetSnapshot`, replace `    hive.writeFleetSnapshot({ ts: now, agents, hooks: hookServer.health() });` with

```ts
    hive.writeFleetSnapshot({ ts: now, agents, hooks: hookServer.health() });
    // The same beat refreshes the control page.
    floorSource.changed();
```

(f) In `bootstrapHiveServices`, replace `  hive.setOrchestratorMaySpawn(readConfig().orchestratorMaySpawn === true);` with

```ts
  hive.setOrchestratorMaySpawn(readConfig().orchestratorMaySpawn === true);
  syncRemoteFloor(readConfig());
```

(g) In `onConfigWritten`, replace

```ts
    w.webContents.send('config:changed', config);
  }
});
```
with
```ts
    w.webContents.send('config:changed', config);
  }
  // Settings → Devices → Control page.
  syncRemoteFloor(config);
});
```

(h) In the quit teardown, replace `  try { stopWebhookServer(); } catch (e) { console.error('[quit] webhook.stop:', e); }` with

```ts
  try { stopWebhookServer(); } catch (e) { console.error('[quit] webhook.stop:', e); }
  try { void remoteFloor?.stop(); } catch (e) { console.error('[quit] remoteFloor.stop:', e); }
```

- [ ] **Step 7: Preload (`src/preload/index.ts`)**

Insert before the line `  // ─── Dialog ──────────────────────────────────────────────────────────────`:

```ts
  // ─── Control page (devices phase 2) ───────────────────────────────────────
  /** Where the control page listens, or null while it is off or waiting for Tailscale. */
  remoteFloorAddress: (): Promise<{ ip: string; port: number } | null> => ipcRenderer.invoke('remoteFloor:address'),
  /** The control page asked to restart an agent. `cb` runs the floor's own
   *  restart; its result goes back to main. */
  onRemoteRestart: (cb: (agentId: string) => Promise<{ ok: boolean; error?: string }>): (() => void) => {
    const listener = (_e: IpcRendererEvent, req: { reqId: number; agentId: string }) => {
      void cb(req.agentId)
        .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
        .then((r) => ipcRenderer.send('remoteFloor:restartDone', req.reqId, r));
    };
    ipcRenderer.on('remoteFloor:restart', listener);
    return () => ipcRenderer.removeListener('remoteFloor:restart', listener);
  },

```

- [ ] **Step 8: The renderer listener (`useRemoteRestart.ts`, `App.tsx`)**

Create `src/renderer/src/hooks/useRemoteRestart.ts`:

```ts
/**
 * The control page's Restart (devices phase 2, item 8). Restart lives in
 * the renderer, so main asks this window and waits for the answer. It is the
 * floor's own Restart & Continue: resume when the engine can, else fresh.
 */
import { useEffect } from 'react';
import { restartAgentProcess } from '@/workspace/agents/restartAgent';

export function useRemoteRestart(): void {
  useEffect(() => window.cth.onRemoteRestart(async (agentId) => {
    const r = await restartAgentProcess(agentId, { resume: true, resumeOptional: true });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }), []);
}
```

`src/renderer/src/App.tsx`: after `import { useHive } from '@/hooks/useHive';` add `import { useRemoteRestart } from '@/hooks/useRemoteRestart';`, and replace `  useHive(hiveOpened ? config : null);` with

```tsx
  useHive(hiveOpened ? config : null);
  useRemoteRestart();
```

- [ ] **Step 9: The Settings toggle (`RemoteFloorSettings.tsx`, `DevicesSettings.tsx`)**

Create `src/renderer/src/components/RemoteFloorSettings.tsx`:

```tsx
/**
 * Settings → Devices → Control page (devices phase 2, item 8): turn the
 * phone-first control page on or off, and see where to open it. The page
 * binds only to this laptop's Tailscale address and lets in only this node's
 * Tailscale login (src/main/remoteFloor.ts). With Tailscale down it retries
 * every 30 s, so the address is polled while the toggle is on.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';

export function RemoteFloorSettings({ config }: { config: HarnessConfig }) {
  const { t } = useTranslation();
  const [on, setOn] = useState(config.remoteFloorEnabled === true);
  const [addr, setAddr] = useState<{ ip: string; port: number } | null>(null);

  useEffect(() => {
    if (!on) { setAddr(null); return; }
    let live = true;
    const poll = (): void => {
      void window.cth.remoteFloorAddress().then((a) => { if (live) setAddr(a); }).catch(() => { /* app closing */ });
    };
    poll();
    const timer = setInterval(poll, 5_000);
    return () => { live = false; clearInterval(timer); };
  }, [on]);

  const toggle = async (next: boolean): Promise<void> => {
    setOn(next);
    await window.cth.updateConfig({ remoteFloorEnabled: next });
  };
  const url = addr ? `http://${addr.ip}:${addr.port}` : null;

  return (
    <div style={{ marginTop: 16 }}>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--cth-ink-900)', cursor: 'pointer' }}>
        <input type="checkbox" checked={on} onChange={(e) => void toggle(e.target.checked)} />
        {t('remoteFloor.toggle')}
      </label>
      <p style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)', margin: '4px 0 0', marginInlineStart: 24 }}>
        {t('remoteFloor.hint')}
      </p>
      {on && (
        <div style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 12, marginTop: 4, marginInlineStart: 24, color: 'var(--cth-ink-700)', userSelect: 'text' }}>
          {url ? t('remoteFloor.address', { url }) : t('remoteFloor.waiting')}
        </div>
      )}
    </div>
  );
}
```

`DevicesSettings.tsx`: add `import { RemoteFloorSettings } from './RemoteFloorSettings';` after its `./PixelButton` import, and replace (phase 1 Task 10)

```tsx
      {error && <div style={{ fontSize: 12, color: 'var(--cth-coral)', marginTop: 4 }}>{error}</div>}
    </div>
  );
}
```
with
```tsx
      {error && <div style={{ fontSize: 12, color: 'var(--cth-coral)', marginTop: 4 }}>{error}</div>}
      <RemoteFloorSettings config={config} />
    </div>
  );
}
```

- [ ] **Step 10: Type-check**

Run: `cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock npm run typecheck`
Expected: exits 0.

- [ ] **Step 11: Re-run the tests this touches, one line at a time**

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/remote-floor.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/remote-floor-source.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/control.test.cjs; fi`

`cd /home/royal/Pro/Zensible/munder-difflin-wt/devices && if [ -n "$(ps -eo args | awk '$1 ~ /(python[0-9.]*|node)$/ && /(bin\/pytest|-m pytest|vitest)/')" ]; then echo BUSY; else flock /tmp/claude-1000/-home-royal-Pro-Zensible-munder-difflin/1ad64edb-e68f-4928-8b67-652af3d9f204/scratchpad/md-heavy.lock node --test test/arabic-ui.test.cjs; fi`

Expected: all PASS.

- [ ] **Step 12: Look at it**

Use `/run` (Electron) to open Settings → Devices and turn on Control page. The address line shows "Waiting for Tailscale…" until `tailscale ip -4` answers, and then shows `Open http://100.x.y.z:47980`. Turn it off: the line goes away and `ss -ltn` no longer lists the port. Do not test the page from the phone here; that is Task 10.

- [ ] **Step 13: Commit**

```bash
git -C /home/royal/Pro/Zensible/munder-difflin-wt/devices add -- src/main/config.ts src/main/index.ts src/preload/index.ts src/renderer/src/store/config.ts src/renderer/src/components/RemoteFloorSettings.tsx src/renderer/src/components/DevicesSettings.tsx src/renderer/src/hooks/useRemoteRestart.ts src/renderer/src/App.tsx src/renderer/src/i18n/locales/en.json src/renderer/src/i18n/locales/ar.json src/renderer/src/i18n/locales/zh-CN.json test/remote-floor-config.test.cjs
git -C /home/royal/Pro/Zensible/munder-difflin-wt/devices commit -m 'remoteFloor: wire the control page into the app' -m 'Settings → Devices → Control page turns it on (remoteFloorEnabled, remoteFloorPort, default 47980) and shows the address. Main feeds it the floor state, refreshes it on the fleet beat, routed mail and device changes, and asks the floor window to restart an agent. Auto-delivery pause is one function shared with the floor switch.' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G3wAo6k5J6tkH89c7qqJnG'
```

---

### Task 10: Acceptance on the real machines, with Royal (manual)

**Files:** none changed, unless a step fails. A failure gets a fix in the task that owns the code, with a test that pins it first.

**Interfaces:**
- Consumes: everything above, merged on `feat/devices`, plus phase 1's acceptance setup (my-lap, Tailscale SSH `accept`).
- Produces: a pass/fail record of each line below, reported in the hand-off. Nothing is pushed.

Before each step, check that :4200 and the app are free for you (several sessions share this machine), and that no other session is running a suite on my-lap.

- [ ] **Step 1: Move an agent from my-lap to this laptop and back (spec §1).** Hire an agent on my-lap and give it a two-turn conversation. Edit → Runs on: This laptop. It restarts here and its next answer shows it remembers the earlier turns. Move it back to my-lap: the same. Then turn my-lap's Wi-Fi off and move an agent off it: the card says `conversation stayed on my-lap (offline); started fresh`.
- [ ] **Step 2: Auto lands on the quieter machine (spec §2).** Run the LFW team's suite on my-lap (load1/cores ≥ 1.5). Hire an agent with Runs on: Auto. It lands on this laptop if this laptop is calm; the card says `This laptop (auto)`. Stop the suite and run one here instead. A fresh Auto start now lands on my-lap (`MY-LAP (AUTO)`). Restart & Continue keeps it on my-lap.
- [ ] **Step 3: The base-folder check (spec §3).** On my-lap, temporarily rename `/home/royal/Pro/Zensible` (with no agents there). Check shows "Base folder" failed with the `sudo mkdir -p … && sudo ln -s <their folder> …` fix. Restore it, and Check passes.
- [ ] **Step 4: god on my-lap (spec §4).** Edit god → Runs on: my-lap. The warning shows, and there is no Auto option. god restarts there and answers a heartbeat. Cut my-lap's Wi-Fi for 12 minutes: god pauses, its mail waits, and it is nudged on return. Move god back.
- [ ] **Step 5: WSL2 (spec §6).** On the Windows `server`, follow `docs/devices-wsl2.md`. Add it, then press Check: systemd and `/dev/fuse` pass, and the two reminders show. Hire one Claude agent there and run one turn.
- [ ] **Step 6: Each engine on my-lap (spec §5).** For codex, agy, grok, qwen, crush and one custom engine: hire it on my-lap, run one turn, see one hook event on the floor (the card goes working, then idle), and stop it. For qwen and crush, `ss -ltn` on my-lap shows `127.0.0.1:47993` while the agent runs and not after it stops. A non-Claude agent's gauge tooltip says "usage not available on a device" (except qwen and crush). Hire gemini on my-lap: it is refused with a clear error.
- [ ] **Step 7: The control page (spec §8).** Turn it on. On the Pixel over Tailscale, open the address: the floor shows every agent with its device and status. Answer a god question there: the card on the floor shows the answer, and god gets the same mail as from Ask Me. Send a message, pause and resume delivery, stop an agent, and restart one (it resumes).
- [ ] **Step 8: The control page refuses strangers (spec §8).** Open the page from a phone on mobile data with Tailscale off: no connection. Open it from another tailnet user's device: 403.
- [ ] **Step 9: Hand-off.** Record pass/fail per step, the worktree, the branch, the last hash, and anything uncommitted. Push nothing.

---

## Spec coverage

| Spec item | Task |
|---|---|
| §1 Copy the conversation (local↔remote, remote→remote through this laptop, `--resume`, offline/missing → fresh with the message) | 1 |
| §2 Auto: `lastDevice`, candidates (this laptop + online devices whose last Check passed), the load commands, 1.5 rule, most MemAvailable, ties to this laptop, resume stays on lastDevice if online else re-pick and copy, never moved while running, god spawn `"device": "auto"`, prompt recommends auto, default this laptop, card "my-lap (auto)" | 2 (and 1 for the copy) |
| §3 Path check following symlinks, the two fixes, `user` unchanged | 3 |
| §4 god: This laptop or a device, no Auto, hive home on the mount, hive work stays here, offline pause, Settings warning, never auto-placed or moved | 4 (and phase 1 for the mechanics) |
| §5 Other engines: CLI via login shell with install command; per-agent hive bridges as-is; home-config bridges written via `link.exec`; port mode; proxy ports base+3…; usage line | 6, 7 |
| §6 WSL detection, systemd and `/dev/fuse` items, two reminders, `docs/devices-wsl2.md` | 5 |
| §7 Voice | nothing to build (spec) |
| §8 Control page: config keys, off by default, Settings toggle, 47980, today's cost, status (paused, offline, needs you), open questions, mail, actions incl. restart | 8, 9 (server, access check, origin check and page are merged in `remoteFloor.ts` with `test/remote-floor.test.cjs`) |
| Testing: auto-placement scoring, copy routing, WSL parsing, access check and origin check, humanQA writes the same task file | 2, 1, 5, merged `remote-floor.test.cjs`, 8 |
| Testing: real machines, each engine's acceptance, WSL2 run | 10 |
