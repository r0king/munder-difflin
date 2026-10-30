# Devices: agents on other machines

Status: design approved in conversation 2026-10-29, spec awaiting Royal's review.
Branch `feat/devices`, based on `integ/hive-2026-10-28` (3fe8786d).

## Goal

One floor, running on this laptop (`company-lap`), starts and controls agents
that run on other Linux machines over Tailscale. The agent, its worktree, and
everything it runs (type-checks, test suites, dev servers) use the other
machine's CPU and RAM. The floor keeps working when a link drops, and so do the
agents.

Why: on 2026-10-28, `company-lap` (8 cores, 15 GB) sat at load 14 with 1.3 GB
free. The 15 `claude` processes took about 4 GB and half a core. The rest came
from what agents run: two `tsc --noEmit` at 1.4 and 1.6 GB, vitest, pytest,
and vite.

## Decisions (from the 2026-10-29 conversation)

| Question | Decision |
|---|---|
| Scope | Two features. This spec is feature 1, Devices. Feature 2, reaching the floor from another device, gets its own spec later. |
| Paths | Every device has the same folder layout (`/home/royal/Pro/Zensible/...`). The username may differ (`user` per device). |
| Placement | Per agent: a `device` setting, empty = this laptop. Set when hiring, changeable later; a change restarts the agent there. |
| Approach | SSH + tmux + hive mounted over SFTP. One connection per device, always opened from this laptop. |
| Cut off from the floor | Keep working; after 10 minutes, stop the turn ("pause"), and carry on when the link returns. |
| Device-side open ports | Accepted: only Royal logs in to the devices. |

## What was tested on the real machines (2026-10-29, company-lap → my-lap)

my-lap: Arch, user `royal`, `/home/royal`, 8 cores, 15 GB. Tailscale SSH on.
`claude` 2.1.312 is logged in, at `~/.local/bin` (not on a non-login PATH).
`node`, `tmux` and `sshfs` are installed. Lid close is ignored (logind drop-ins
and KDE), and the sleep and suspend targets are masked.

| Check | Result |
|---|---|
| Tailscale SSH login, `BatchMode=yes`, no keys | works, no browser check prompted |
| SFTP | works |
| Several sessions over one connection (`-M -S`) | works. The ControlPath must be under 108 bytes, so use `/run/user/<uid>`. |
| `-R` remote **Unix socket** forward | **broken under Tailscale SSH**: the socket appears, but `royal` gets EACCES connecting to it and cannot delete it |
| `-R` remote TCP port → TCP port here | works |
| `-R` remote TCP port → Unix socket here (`hooks.sock`) | works |
| tmux session outlives the SSH session that created it | works |
| `sshfs -o passive` over the SSH pipe | works, but when the link drops the mount **vanishes**, leaving a plain writable folder (mail written there would be lost) |
| Mountpoint `chmod 000` as a guard | fusermount refuses to mount on it |
| `sshfs -o directport=P,reconnect` through a forwarded port to an SFTP server here | works. When the link is cut, the mount stays, and reads and writes fail at once with EIO (0–1 ms), with nothing written locally. When the link returns, reads work again with no action. |

`scripts/devices-smoke.sh` re-runs these checks (see Testing).

## Architecture

### Device registry (config)

`config.json` gets `devices?: DeviceConfig[]`:

```ts
interface DeviceConfig {
  id: string;        // 'my-lap'; also the label on agent cards
  host: string;      // Tailscale IP or name ('100.65.189.1')
  user?: string;     // default: this laptop's username
  portBase?: number; // device loopback ports: base = SFTP, +1 = hooks, +2 = telemetry. Default 47990; each device has its own loopback, so every device can use the same base
}
```

It also gets `deviceOfflinePauseMin?: number`, default 10, where 0 means never
pause. This laptop is the implicit device `local` and is never stored.

### Agent device (roster)

The roster entry gets an optional `device` (a device id). Empty or `local` means
this laptop. The unused `tmuxTarget` field stays untouched. god always runs on
this laptop.

### Device link (`src/main/devices.ts`, new)

There is one `DeviceLink` per configured device, with states `offline`,
`connecting` and `online`. It owns:

1. **The SSH connection.** A `ControlMaster` process:
   `ssh -M -S /run/user/<uid>/md-<id>.ctl -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=8 <forwards> <user>@<host>`
   It carries three forwards:
   - `-R 127.0.0.1:<base>:127.0.0.1:<sftpPort>` for the hive SFTP;
   - `-R 127.0.0.1:<base+1>:<hive>/hooks.sock` for hooks;
   - `-R 127.0.0.1:<base+2>:127.0.0.1:<telemetryPort>` for OTLP.
2. **The SFTP server here.** A loopback-only `net` server on an ephemeral port.
   For each connection it spawns this machine's `sftp-server`, the first
   existing path among `/usr/lib/ssh/sftp-server`,
   `/usr/lib/openssh/sftp-server`, `/usr/libexec/openssh/sftp-server` and
   `/usr/libexec/sftp-server`, and pipes the socket through it. It is shared by
   all devices, so there is no socat dependency.
3. **The hive mount.** Once the connection is up, the link runs over it:
   `mountpoint -q <hive> || { mkdir -p <hive> && sshfs -o directport=<base>,reconnect,ServerAliveInterval=15,dir_cache=no,entry_timeout=0,attr_timeout=0,negative_timeout=0 127.0.0.1:<hive> <hive>; }`
   No caching (`dir_cache=no` and the three timeouts at 0): with sshfs's default
   20 s cache an agent woken for new mail can list its inbox and not see the
   file yet, and a `launch.sh` rewritten at another length can be read at its
   stale size.
   `<hive>` is the same absolute path on both machines. The mount reconnects by
   itself, so the link only re-runs this when `mountpoint` says it is gone.
4. **Reconnects.** When the master exits, the device goes `offline` and
   reconnects after backoff of 2s, 5s, 15s, 30s, then every 60s. A dead link is
   detected in about 2 min (ServerAlive 15 × 8). A port left LISTENing by Tailscale SSH after a dead session is freed by restarting tailscaled on the device (needs the `md-tailscaled` sudo rule; at most once per 10 min; reconnect after 15 s).
5. **`exec(cmd)`.** One-shot remote commands over the master
   (`ssh -S ctl host -- bash -lc '<cmd>'`) for the setup check, `test -d`,
   git, `tmux` reconcile and stop. It has a timeout and fails at once when the
   device is offline.

The renderer gets device states pushed to it, the same way it gets other live
state.

### Starting a remote agent (`src/main/pty.ts`, `spawnAgentCore` in `src/main/index.ts`)

`pty.ts:spawn` stays the only place a terminal starts. For an agent with a
device:

- **Folder check.** The local `existsSync(cwd)` check (`pty.ts:561`) becomes
  `link.exec('test -d <cwd>')`.
- **Launch script.** The app writes `<hive>/agents/<id>/launch.sh`, which the
  device sees through the mount. It exports the agent's env and `exec`s
  `claude` with its args, every value POSIX-shell-quoted once. This avoids
  quoting the long, multi-line hive prompt through ssh, then the login shell,
  then tmux. Differences from a local agent:
  - `HIVE_HOOK_PORT=<base+1>` replaces `HIVE_SOCK`;
  - `OTEL_EXPORTER_OTLP_ENDPOINT` points at `127.0.0.1:<base+2>`;
  - `HIVE_OFFLINE_PAUSE_MIN` is set from config.

  PATH comes from the device's login shell, so `~/.local/bin/claude` is found.
- **The terminal.** It is `ssh -tt -S <ctl> <user>@<host> -- bash -lc 'tmux -L md -f <hive>/devices/tmux.conf new-session -A -s md-<id> -c <cwd> "bash <hive>/agents/<id>/launch.sh"'`.
  - `-L md` keeps it apart from Royal's own tmux server.
  - `tmux.conf` sets `status off`, `escape-time 0` and a generous
    `history-limit`.
  - `new-session -A` attaches if the session already exists, which is how
    reattach works.
- **Above the terminal, nothing changes.** Typing, inbox nudges, idle pings,
  compaction and resize all go through the ssh pty unchanged.
- **Worktrees.** `runGit(cwd, args)` (`git.ts`) gains an optional device and
  runs `git -C <cwd> …` through `link.exec`. `addWorktree` and
  `removeWorktree` get the device through it. `linkWorktreeDeps` on a device
  is `[ -d base/node_modules ] && [ ! -e wt/node_modules ] && ln -s …` over
  `exec`.
- **Resume.** `--resume <sid>` is added only if
  `test -f ~/.claude/projects/<projectKey(cwd)>/<sid>.jsonl` passes on the
  device. `projectKey` is reused from `transcript.ts`. Otherwise the agent
  starts fresh. Copying a transcript from another folder
  (`seedSessionTranscript`) is skipped on devices.
- **Offline device.** Spawning on it fails at once with "my-lap is offline".
- **Providers.** Claude only. Other providers are refused on a device with a
  clear error.

### Hook script (`HOOK_SHIM` in `src/main/hive.ts`)

1. **Port mode.** When `HIVE_HOOK_PORT` is set, the shim connects to
   `127.0.0.1:<port>` instead of `HIVE_SOCK`. Everything else is unchanged:
   it still gives up quietly (exit 0) on error.
2. **Pause when cut off,** in port mode only. On a failed connection, the shim
   writes the time of the first failure to
   `~/.cache/munder-difflin/md-<agent>.unreachable` (on the device's disk: `/run/user` can vanish on a device with no desktop login while tmux keeps running) if that file is absent. On success
   it deletes the file. If the file is older than `HIVE_OFFLINE_PAUSE_MIN`
   minutes (and that value is above 0), the shim prints
   `{"continue": false, "stopReason": "Munder Difflin floor unreachable for N min; paused until the link is back."}`.
   The turn ends cleanly, the same way a halt does today. The shim also writes
   `~/.cache/munder-difflin/md-<agent>.paused`.
3. **Resume after a pause.** On reattach, the link checks each agent's
   `.paused` file. If present, it deletes the file and sends one nudge: "The
   link to the floor is back. Carry on where you left off."

The status-line mode (`--status`) gets port mode only. It never pauses.

## Lifecycle

| Event | What happens |
|---|---|
| Hire / start on a device | The link must be `online` and the hive mounted. Then the folder check, the worktree if `isolate`, the launch script, and the tmux session. |
| Stop agent | `exec('tmux -L md kill-session -t md-<id>')`, then the local pty is killed. |
| Local pty dies, but not because the agent stopped (link drop, window closed) | Detach only. The tmux session keeps running. |
| Link drops | Device `offline`. Its agents' cards show "offline · reconnecting", and their terminals keep the last screen. Mail to them still lands in the hive on this disk. |
| Link returns | The forwards come back with the master, `mountpoint` is checked, every agent of that device is reattached (`new-session -A`), and paused agents are nudged. The wake beat then nudges agents with unread mail, as today. |
| This laptop sleeps | The same as a link drop, for every device at once. |
| App quits | Device agents keep running in their tmux sessions; only the local ssh terminals end. Cut off that long, they pause like any link drop. (Until 30 Oct 2026 a quit ended them, so every restart cut agents off mid-task.) |
| App starts again, crashed, or quit | On the next connect, the link lists `tmux -L md ls`. Sessions whose agent the restore flow is bringing back are reattached instead of respawned. Every other `md-*` session is killed. `archiveOrphanedAgents` at startup is unaffected: the restore flow clears `archived`, as it does for local agents. |
| Agent moved to another device | Stop it on the old device, then start it on the new one with a fresh session. `memory.md` is in the shared hive, so it carries over. |

## While a device is offline, what still works

- **Floor control.** The floor can't pause, steer or halt the device's agents,
  because hooks give up quietly. The 10-minute pause bounds this.
- **Cost breaker.** It sees nothing until telemetry reconnects. OTLP counters
  are cumulative, so the totals catch up.
- **Hive files.** Agents get EIO at once on hive reads and writes. Their tools
  report the error and carry on with worktree work.
- **Usage and context fallbacks.** The app's fallbacks that read conversation
  files on this laptop (`readAgentUsage`, `readContextTokens`) find nothing
  for a remote agent, online or not. Remote agents rely on OTLP and the status
  line. The plan must check every consumer: the breaker, the compact latch and
  context rules.

## UI

- **Settings → Devices** (`DevicesSettings.tsx`, a new section in `SettingsModal.tsx`):
  - Each device shows a status dot: online, connecting or offline.
  - **Add:** id, host, optional user.
  - **Check:** runs over the link and lists pass or fail per item, each
    failure with its fix command. The items are: login, `claude` found by a
    login shell and logged in, `node`, `tmux`, `sshfs`, the hive mount, and
    each agent folder on that device.
  - **Remove:** only allowed when no agent uses the device.
- **Hire and Edit agent → Workspace:** a "Runs on" choice (This laptop /
  devices). The folder is checked on that device on save.
- **Agent card:** a device tag for remote agents. When the device is offline,
  the card is greyed with "offline · reconnecting".
- **i18n.** New strings go through the existing i18n keys, in every locale
  the app ships.

## god

- `fleet.json` gets `device` per agent.
- A spawn request (`spawn-requests/<id>.json`) may carry `device`. The default
  is this laptop. An unknown or offline device fails the request into
  `.failed` with the reason.
- The god prompt gets one line: heavy work (type-checks, suites, builds) is
  best placed on a device.

## Security

- Every connection is opened from this laptop to a device, using Tailscale
  SSH. The device never logs in here.
- On a device, three loopback ports (SFTP, hooks, telemetry) are reachable by
  any local user there. The SFTP port gives `royal`'s access to this laptop's
  whole filesystem, because `sftp-server` cannot be chrooted as a non-root
  user. This is accepted because only Royal logs in to the devices
  (2026-10-29). If that changes, add a path-restricted SFTP proxy.
- Tailscale's SSH access rule should use `"action": "accept"` for Royal's own
  devices. `"check"` needs a browser confirmation every 12 h, and the link's
  reconnect would stall waiting for it.
- Company repos, `.env` files and git credentials live on each device. This
  is Royal's call per device.

## Testing

- **Unit tests** (`node:test`, `test/*.test.cjs`):
  - building the ssh, tmux and launch-script commands, including quoting the
    multi-line prompt and the env;
  - `DeviceLink` states and backoff, against a fake `ssh` (the same pattern as
    `test/hidden-claude.test.cjs`);
  - hook-shim port mode and the 10-minute pause: run the shim against a dead
    port, with a back-dated `.unreachable` file;
  - reconcile parsing of `tmux ls`: reattach, kill or leave;
  - the roster and config `device` round-trip;
  - spawn-request `device` validation.
- **Real-machine smoke:** `scripts/devices-smoke.sh <user@host>` covers login,
  SFTP, port and socket forwards, connection sharing, tmux surviving its
  session, and the directport mount through a cut and restore. It cleans up
  everything it creates. The in-app Check runs the same steps.
- **Acceptance on my-lap:**
  1. Hire an agent there and run its test suite.
  2. Typed input, a bracketed-paste nudge and `/compact` work through tmux.
  3. Turn Wi-Fi off for 2 min: offline, then reattached, and its mail is
     delivered.
  4. Keep it off for 12 min: paused, then nudged on return.
  5. Sleep this laptop.
  6. Kill the app: the agent is reattached, not respawned.
  7. Quit the app and start it again: every agent is reattached mid-conversation, not respawned.
- **Before and after load numbers** (Royal's rule for performance changes):
  - What to measure: this laptop's load average and MemAvailable, sampled
    every 30 s for 30 min while the LFW team runs its normal suite cycle.
    Run it once all-local, and once with those agents on my-lap.
  - Reported: p50 and p95 of load1, and the minimum MemAvailable.
  - Saved in `docs/perf/devices-load.md`, with `scripts/devices-load.sh`
    (the sampler) and the hardware of both machines.

## Out of scope (v1)

- Reaching the floor from another device (feature 2).
- Windows or macOS devices, and path mapping.
- Moving god to a device.
- Automatic placement.
- Non-Claude providers on devices.
- Voice and dictation for remote agents.
- Copying a conversation when an agent moves devices.

## Size

About 6–8 working days:

- link and SFTP server: 2;
- remote spawn, worktrees and resume: 1.5;
- hook shim and reconcile: 1;
- UI and i18n: 1.5;
- tests, smoke script and load numbers: 1–2.
