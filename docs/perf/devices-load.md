# Devices: load on this laptop, before and after

Status: method written 2026-10-29. **The numbers are filled at acceptance (plan Task 13).**

Why: on 2026-10-28, `company-lap` sat at load 14 with 1.3 GB free. The 15 `claude`
processes took about 4 GB and half a core; the rest was what agents run (two
`tsc --noEmit` at 1.4 and 1.6 GB, vitest, pytest, vite). Devices v1 moves agents,
and everything they run, to another machine. This page records whether that
shows on this laptop. (Spec: `docs/superpowers/specs/2026-10-29-devices-design.md`,
Testing.)

## What is measured

- This laptop's 1-minute load average (`/proc/loadavg`) and `MemAvailable`
  (`/proc/meminfo`), sampled every 30 s for 30 min (60 samples).
- Reported: p50 and p95 of load1 (nearest rank), and the minimum MemAvailable.
- Workload: the LFW team running its normal suite cycle (type-check, vitest,
  pytest, vite), the same tasks in both runs.
- Run A: every LFW agent on this laptop. Run B: the same agents on `my-lap`
  (Settings → Devices, "Runs on"), with god and the rest of the floor unchanged.
- One run each.

## Machines

| | company-lap (this laptop, the floor) | my-lap (the device) |
|---|---|---|
| OS | Arch Linux | Arch Linux |
| Cores / RAM | 8 / 15 GB | 8 / 15 GB |
| CPU model | _fill from `lscpu` at acceptance_ | _fill from `lscpu` at acceptance_ |
| Link | Tailscale | Tailscale SSH, lid close ignored, sleep masked |

## How to reproduce

```bash
scripts/devices-load.sh all-local 60 30     # Run A: LFW agents on this laptop
scripts/devices-load.sh on-my-lap 60 30     # Run B: LFW agents on my-lap
```

Each run writes `docs/perf/devices-load-<label>.csv` and prints the summary
below. Keep both CSVs next to this page.

## Results (to fill at acceptance, Task 13)

| Run | Samples | load1 p50 | load1 p95 | MemAvailable min | Date |
|---|---|---|---|---|---|
| A: all on this laptop | | | | | |
| B: LFW agents on my-lap | | | | | |
