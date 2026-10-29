#!/usr/bin/env bash
# Devices: before/after load numbers (docs/perf/devices-load.md).
#
# Samples this laptop's 1-minute load average and MemAvailable, then prints
# p50 and p95 of load1 and the minimum MemAvailable.
#
#   scripts/devices-load.sh <label> [samples=60] [interval-seconds=30]
#
# The default is 60 samples 30 s apart: 30 minutes. Writes
# ${DEVICES_LOAD_DIR:-docs/perf}/devices-load-<label>.csv.
set -euo pipefail

LABEL=${1:?usage: scripts/devices-load.sh <label> [samples] [interval-seconds]}
N=${2:-60}
IV=${3:-30}
DIR=${DEVICES_LOAD_DIR:-$(cd "$(dirname "$0")/.." && pwd)/docs/perf}
OUT="$DIR/devices-load-$LABEL.csv"
mkdir -p "$DIR"

echo 'epoch,load1,mem_available_mb' > "$OUT"
for i in $(seq "$N"); do
  read -r L1 _ < /proc/loadavg
  MA=$(awk '/^MemAvailable:/ { printf "%d", $2 / 1024 }' /proc/meminfo)
  echo "$(date +%s),$L1,$MA" >> "$OUT"
  if [ "$i" -lt "$N" ]; then sleep "$IV"; fi
done

# Nearest-rank percentiles: the value at rank ceil(p/100 * n) of the sorted samples.
tail -n +2 "$OUT" | cut -d, -f2 | sort -n | awk '
  { v[NR] = $1 }
  END {
    r50 = int((NR * 50 + 99) / 100); r95 = int((NR * 95 + 99) / 100)
    printf "samples=%d load1_p50=%s load1_p95=%s\n", NR, v[r50], v[r95]
  }'
tail -n +2 "$OUT" | cut -d, -f3 | sort -n | head -1 | awk '{ printf "mem_available_min_mb=%s\n", $1 }'
echo "csv=$OUT"
