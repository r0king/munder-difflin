# Devices phase 2: everything left out of v1

Status: decisions taken 2026-10-29, spec awaiting Royal's review. Builds on
`2026-10-29-devices-design.md` (phase 1), on branch `feat/devices`, after
phase 1 is accepted.

## Decisions (2026-10-29)

| Item | Decision |
|---|---|
| Reach the floor from my-lap or the Pixel | A phone-first control page served by the app over Tailscale |
| Windows devices | Through WSL2: a Linux device that happens to run on Windows |
| macOS devices | Skipped: no Mac on the tailnet |
| Automatic placement | A "Runs on: Auto" option that picks the least-loaded device at start; agents never move by themselves |
| Path mapping, moving god, other engines, copying conversations, voice | Specified below with the simplest design that works; no decision was needed from Royal |

## 1. Copy the conversation when an agent moves

Today a moved agent starts fresh (phase 1). Instead:

1. When an agent's device changes, and the agent has a last session id
   (`hive.lastSession(id)`), the app copies
   `~/.claude/projects/<projectKey(cwd)>/<sid>.jsonl` from the old device to
   the same path on the new one.
   - Local → remote: write it with `link.exec('mkdir -p … && cat > …')`,
     feeding the file on stdin.
   - Remote → local: read it with `link.exec('cat …')`.
   - Remote → remote: read from the old device, then write to the new one.
     The file passes through this laptop.
2. Then it starts the agent on the new device with `--resume <sid>`, as phase
   1 already does when the file is present.
3. If the old device is offline or the file is missing, the agent starts
   fresh and the floor shows "conversation stayed on my-lap (offline);
   started fresh".

Transcripts are a few MB; copying them over Tailscale takes seconds.

## 2. Automatic placement

- **The Auto choice.** "Runs on" gets **Auto**. An Auto agent records the
  device it last ran on (`lastDevice` on the roster entry).
- **On a fresh start** (hire, or a restart without resume), the app picks a
  device from this laptop plus every online device whose last Check passed:
  1. It reads the load. On a device that is `link.exec('cat /proc/loadavg; nproc; grep MemAvailable /proc/meminfo')`;
     on this laptop it is `os.loadavg()`, `os.cpus().length` and
     `os.freemem()`.
  2. Candidates must have load1 / cores below 1.5. Among them, pick the most
     MemAvailable. If none qualifies, pick the most MemAvailable overall.
  3. Ties go to this laptop.
- **On a restart with resume,** the agent stays on `lastDevice` if it is
  online. Otherwise the app picks again and copies the conversation (item 1).
- **Running agents are never moved.**
- **god:** spawn requests may say `"device": "auto"`. The god prompt line
  from phase 1 recommends `auto` for heavy work. The default stays this
  laptop.
- **The agent card** shows "my-lap (auto)" so you can see where Auto put it.

## 3. Different usernames and layouts ("path mapping")

The hive's own files hold absolute paths that agents read and act on:
`PROTOCOL.md`, `fleet.json`, task cards and mail. Translating only the paths
the app sends would leave every path inside those files wrong. So the device
must make the same paths exist. A symlink does that with no translation
anywhere:

- **The check.** Check verifies that this laptop's base folder (the parent of
  the hive home, `/home/royal/Pro/Zensible`) exists on the device, following
  symlinks.
- **The fix it shows,** when the folder is missing:
  - same layout, different user: `sudo ln -s /home/<user> /home/royal`;
  - different layout:
    `sudo mkdir -p /home/royal/Pro && sudo ln -s <their folder> /home/royal/Pro/Zensible`.
- **The `user` field** already exists from phase 1. Nothing else changes.

## 4. god on a device

- god gets the same "Runs on" choice: This laptop or a device. Auto is not
  offered.
- It runs in the hive home, which is mounted at the same path on the device.
  The floor's own hive work stays on this laptop: memory condensing, fleet
  beats and processing spawn and compact requests.
- While god's device is offline, the floor has no god. Its mail waits, and
  the 10-minute pause applies to god too. Settings warns about this when you
  move god.
- god is never auto-placed and never moved by the app.

## 5. Other engines on devices

The engines are listed in `src/shared/agentProvider.ts`: codex, agy, grok,
qwen, crush and custom. Each one needs:

1. **Its CLI on the device.** Check looks for the binary through a login
   shell and shows the install command when it's missing.
2. **Its hook bridge.**
   - Bridges that use per-agent files in the hive work as they are, through
     the mount.
   - Bridges that install into the user's home config (the codex and agy
     shims, `installAgyHooks`, the grok shim) get the same files written on
     the device through `link.exec`. The app builds the file content here, as
     it does today, and only the write is remote.
   - In port mode (phase 1) each shim connects to `HIVE_HOOK_PORT`.
3. **Its proxy, for proxy-tier engines** (qwen, and any engine whose upstream
   is a proxy on this laptop). The proxy port is forwarded to the device's
   loopback as `base+3`, `base+4` and so on, in the order engines need them.
   The agent's base-URL env points there.
4. **Usage.** Engines without OTLP telemetry fall back to reading
   conversation files on this laptop. Remote agents have none there, so their
   card shows "usage not available on a device" instead of a wrong zero.

Each engine gets one acceptance run on my-lap: hire, one turn, one hook event
seen on the floor, stop.

## 6. Windows machines through WSL2

The Windows machine runs Ubuntu in WSL2 with Tailscale installed inside it.
From the floor's side it is an ordinary Linux device, so the only code is in
Check, which detects WSL (`/proc/version` contains `microsoft`) and adds these
items:

- `systemd` is on in WSL (`/etc/wsl.conf`, `[boot] systemd=true`), so
  `tailscaled` and the user's tmux keep running.
- `/dev/fuse` exists, which the hive mount needs.

Two Windows-side settings can't be checked from inside WSL, so Check prints
them as reminders:

- `%UserProfile%\.wslconfig` with `vmIdleTimeout=-1`, so Windows doesn't stop
  the WSL VM when no window is open;
- Windows power settings that never sleep.

A setup guide, `docs/devices-wsl2.md`, lists these steps in order.

## 7. Voice

- **On the floor:** dictation types into the floor on this laptop, which then
  types into the agent's terminal, so it already works for agents on devices.
  There's nothing to build.
- **On the control page:** use the phone keyboard's microphone in the text
  boxes. Nothing to build either.

## 8. The phone-first control page

Claude Code's Remote Control already lets Royal open any agent's session from
the Claude phone app: chat, approve prompts and read the screen. The app
already names those sessions after the agents. So the control page covers
only what the Claude app can't show: the floor itself.

**Serving**

- New file `src/main/remoteFloor.ts`, a Node `http` server.
- It is off by default and turned on in Settings → Devices → "Control page".
- It binds only to this laptop's Tailscale IPv4 (`tailscale ip -4`), on
  config `remoteFloorPort`, default 47980. It never binds to `0.0.0.0` or the
  LAN.
- If Tailscale isn't up when the app starts, the server tries to bind again
  every 30 s.
- The page is one static HTML file with inline JS, phone-first, light and
  dark. It is served from the app, with no CDN.
- Live updates come over Server-Sent Events (`/events`) from the same state
  the floor renders.

**Access**

- Each request's peer address is checked with
  `tailscale whois --json <ip>`, and the result is cached for 60 s.
- A request is allowed only if the login name matches the owner of this
  machine's Tailscale node. Anything else gets 403.
- There are no passwords and no tokens in URLs.
- Requests that change something (POST) also need a same-origin
  `Origin`/`Referer` header.

**Screens**

1. **Floor.** Every agent with its name, role, device, and status (working,
   idle, needs you, paused, offline), plus context %, today's cost, and an
   "Open in Claude app" link when the agent has a Remote Control session.
   Each device's dot is shown too.
2. **Needs you.**
   - god's open questions: task cards with an unanswered `humanQA` entry,
     each with a text box. Answering writes `a`/`answeredAt` exactly as the
     floor does.
   - Agents waiting on a permission prompt, each with a link to open it in
     the Claude app.
3. **Mail.** The latest messages to and from you and god, and a box to send
   a message to an agent's inbox from "human", the same as the floor's send.
4. **Agent actions.** Stop, restart, and pause/resume auto-delivery, each
   behind an in-page confirmation step.

Not on the page: settings, hiring, editing agents, terminals. The Claude app
covers terminals.

## Testing

- **Unit tests:** auto-placement scoring with fixed load inputs; transcript
  copy routing (local↔remote, remote↔remote, offline → fresh); WSL Check
  parsing; the control page's access check (whois match, mismatch, failure →
  403) and its POST origin check; answering `humanQA` from the page writes
  the same task file as the floor.
- **Real machines:** move an agent from my-lap to this laptop and back, and
  check its conversation continues; run an Auto start while my-lap runs a
  suite and see it land here; open the control page on the Pixel over
  Tailscale and answer a god question; open the page from a non-tailnet
  network (expect no connection) and from another tailnet user (expect 403).
- **Each engine's acceptance run** (item 5).
- **WSL2:** one run on the Windows `server` once WSL2 is set up there.

## Order and size (after phase 1 is accepted)

1. Copying conversations: 1 day.
2. Automatic placement, which uses item 1: 1 day.
3. The path check and fix: half a day.
4. god on a device: 1 day.
5. WSL2 Check and guide: 1 day.
6. Other engines: 3 days.
7. The control page: 5–6 days. It is the most independent item, so it can
   run in parallel with items 1–6.

That's about 12–14 working days in total.
