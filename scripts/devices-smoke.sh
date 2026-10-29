#!/usr/bin/env bash
# Devices smoke test. Re-runs, against one real device, the checks in the
# "What was tested on the real machines" table of
# docs/superpowers/specs/2026-10-29-devices-design.md. Everything it creates,
# on both machines, is removed on exit, pass or fail.
#
#   scripts/devices-smoke.sh royal@my-lap [port-base]
#
# Run by hand only (unit tests never SSH). port-base defaults to 48090, away
# from a live link's 47990, so it can run while the app is connected.
set -uo pipefail

TARGET=${1:?usage: scripts/devices-smoke.sh user@host [port-base]}
BASE=${2:-48090}
RUN=/run/user/$(id -u); [ -d "$RUN" ] || RUN=${TMPDIR:-/tmp}
CTL=$RUN/md-smoke-$$.ctl
LTMP=$(mktemp -d)            # on this laptop
RTMP=/tmp/md-smoke-$$        # on the device
PASS=0
FAIL=0
HELPER_PIDS=''

pass() { echo "PASS  $*"; PASS=$((PASS + 1)); }
fail() { echo "FAIL  $*"; FAIL=$((FAIL + 1)); }
check() { local name=$1; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
# One command on the device, over the master, through a login shell.
r() { ssh -S "$CTL" -o BatchMode=yes "$TARGET" -- "bash -lc $(q "$1")"; }
# The same without the master, for when the link is deliberately cut.
r_direct() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" -- "bash -lc $(q "$1")"; }
master() {
  ssh -M -S "$CTL" -N -f -o BatchMode=yes -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -R "127.0.0.1:$BASE:127.0.0.1:$SFTP_PORT" \
    -R "127.0.0.1:$((BASE + 1)):$LTMP/hooks.sock" \
    -R "127.0.0.1:$((BASE + 2)):127.0.0.1:$ECHO_PORT" \
    "$TARGET"
}
# A one-line TCP client on the device: send "ping", print the echo.
tcp() {
  r "node -e \"const c=require('net').connect($1,'127.0.0.1',()=>c.end('ping'));let d='';c.on('data',x=>d+=x);c.on('close',()=>process.stdout.write(d))\""
}
cleanup() {
  r_direct "{ fusermount3 -u $RTMP/mnt || fusermount -u $RTMP/mnt; } 2>/dev/null; tmux -L md-smoke kill-server 2>/dev/null; rm -rf $RTMP" >/dev/null 2>&1
  ssh -S "$CTL" -O exit "$TARGET" >/dev/null 2>&1
  for p in $HELPER_PIDS; do kill "$p" 2>/dev/null; done
  rm -rf "$LTMP" "$CTL"
}
trap cleanup EXIT

# Helpers on this laptop: the SFTP bridge (what sftpServer.ts does), a TCP
# echo server, and a Unix-socket echo server standing in for hooks.sock.
cat > "$LTMP/helpers.cjs" <<'JS'
const net = require('net'), fs = require('fs'), { spawn } = require('child_process');
const [kind, where] = process.argv.slice(2);
const sftp = ['/usr/lib/ssh/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/libexec/openssh/sftp-server', '/usr/libexec/sftp-server'].find((p) => fs.existsSync(p));
const srv = net.createServer((s) => {
  if (kind !== 'sftp') { s.pipe(s); return; }
  const c = spawn(sftp, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  s.pipe(c.stdin); c.stdout.pipe(s);
  s.on('close', () => c.kill()); s.on('error', () => c.kill()); c.stdin.on('error', () => {});
});
if (kind === 'sock') srv.listen(where);
else srv.listen(0, '127.0.0.1', () => fs.writeFileSync(where, String(srv.address().port)));
JS
node "$LTMP/helpers.cjs" sftp "$LTMP/sftp.port" & HELPER_PIDS="$HELPER_PIDS $!"
node "$LTMP/helpers.cjs" echo "$LTMP/echo.port" & HELPER_PIDS="$HELPER_PIDS $!"
node "$LTMP/helpers.cjs" sock "$LTMP/hooks.sock" & HELPER_PIDS="$HELPER_PIDS $!"
for _ in $(seq 50); do
  [ -s "$LTMP/sftp.port" ] && [ -s "$LTMP/echo.port" ] && [ -S "$LTMP/hooks.sock" ] && break
  sleep 0.1
done
SFTP_PORT=$(cat "$LTMP/sftp.port")
ECHO_PORT=$(cat "$LTMP/echo.port")
echo marker > "$LTMP/marker"

echo "Devices smoke: $TARGET, device ports $BASE..$((BASE + 2))"
check "login: BatchMode, no prompt" ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" true
check "ControlPath under 108 bytes ($CTL)" [ "${#CTL}" -lt 108 ]
check "master up with the three forwards" master
check "several sessions over one connection" [ "$(r 'echo shared')" = shared ]
check "-R device TCP port -> TCP port here" [ "$(tcp $((BASE + 2)))" = ping ]
check "-R device TCP port -> Unix socket here" [ "$(tcp $((BASE + 1)))" = ping ]
check "SFTP: directport mount through the forward" \
  r "mkdir -p $RTMP/mnt && sshfs -o directport=$BASE,reconnect,ServerAliveInterval=15 127.0.0.1:$LTMP $RTMP/mnt && test -f $RTMP/mnt/marker"
check "tmux: a session started over ssh" r "tmux -L md-smoke new-session -d -s md-smoke 'sleep 600'"
check "tmux: the session outlives the ssh session that made it" r "tmux -L md-smoke has-session -t =md-smoke"

# Cut the link: the master, and every forward with it, goes away.
ssh -S "$CTL" -O exit "$TARGET" >/dev/null 2>&1
sleep 1
check "cut: the mount stays" r_direct "mountpoint -q $RTMP/mnt"
check "cut: reads fail at once (under 2 s)" \
  r_direct "s=\$(date +%s%N); ! ls $RTMP/mnt >/dev/null 2>&1; rc=\$?; e=\$(date +%s%N); [ \$rc = 0 ] && [ \$(( (e - s) / 1000000 )) -lt 2000 ]"
check "cut: writes fail" r_direct "! sh -c 'echo x > $RTMP/mnt/written-while-cut' 2>/dev/null"

# Restore the link: the same forwards, and nothing done to the mount.
check "restore: master back" master
check "restore: reads work again with no action (within 30 s)" \
  r "for i in \$(seq 30); do test -f $RTMP/mnt/marker && exit 0; sleep 1; done; exit 1"
check "nothing was written here while cut" [ ! -e "$LTMP/written-while-cut" ]
check "nothing was written under the mountpoint while cut" \
  r "{ fusermount3 -u $RTMP/mnt 2>/dev/null || fusermount -u $RTMP/mnt; } && ! test -e $RTMP/mnt/written-while-cut"
echo "INFO  -R device Unix socket: known broken under Tailscale SSH (spec); not checked."

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
