#!/bin/sh
# V2-1b: memory with session holders, 3 and 10 idle sessions, before and after a core restart (reattached holders).
# Prints figures rows: per idle holder (median, max), all holders, core, total (core + holders) against Orca's
# 1,091 MB RSS reference. phys_footprint via `footprint`, max of 3 samples 2 s apart per process.
# Load rule: starts only under a 1-min load of 15 (one retry after 60 s), else prints "not run: load" and exits 3.
# Usage: scripts/scenario/holders-footprint.sh [BIN]   (default: target/release/nunchiro, built first)
set -u
root=$(cd "$(dirname "$0")/../.." && pwd)
bin=${1:-}
if [ -z "$bin" ]; then
  (cd "$root" && unset CARGO_TARGET_DIR && cargo build -q -j 2 --release -p nunchiro) || exit 2
  bin=$root/target/release/nunchiro
fi
load() { sysctl -n vm.loadavg | awk '{print $2}'; }
under() { awk -v l="$(load)" 'BEGIN { exit !(l < 15) }'; }
if ! under; then
  sleep 60
  under || { echo "not run: load $(load)"; exit 3; }
fi
echo "start load $(load), $(git -C "$root" rev-parse --short HEAD), $($bin --version)"
mib() { awk '{ printf "%.2f", $1 / 1048576 }'; }
# The largest of 3 phys_footprint samples of one pid, in bytes.
sample() {
  max=0
  for _ in 1 2 3; do
    b=$(footprint -f bytes --noCategories "$1" 2>/dev/null | awk '/phys_footprint:/ { print $2; exit }')
    [ -n "$b" ] && [ "$b" -gt "$max" ] && max=$b
    sleep 2
  done
  echo "$max"
}
measure() { # label, home
  core=$(cat "$2/core.pid")
  holders=$(sed -n 's/.*"pid": \([0-9]*\),*$/\1/p' "$2/sessions.json" | sort -u | while read -r p; do
    ps -o comm= -p "$p" 2>/dev/null | grep -q nunchiro && [ "$p" != "$core" ] && echo "$p"
  done)
  all=0; list=""
  for p in $holders; do b=$(sample "$p"); all=$((all + b)); list="$list $b"; done
  n=$(echo "$holders" | grep -c .)
  c=$(sample "$core")
  med=$(echo "$list" | tr ' ' '\n' | grep . | sort -n | awk '{ a[NR] = $1 } END { print a[int((NR + 1) / 2)] }')
  mx=$(echo "$list" | tr ' ' '\n' | grep . | sort -n | tail -1)
  total=$((all + c))
  below=$(awk -v t="$total" 'BEGIN { print (t / 1000000 < 1091) ? "below" : "NOT below" }')
  echo "| \`$1\` | $n | $(echo "$med" | mib) ($(echo "$mx" | mib)) MiB | $(echo "$all" | mib) MiB | $(echo "$c" | mib) MiB | $(echo "$total" | mib) MiB, $below Orca |"
}
# Ticket 457: these cores keep the real HOME; empty means no keychain, so no start secrets reach the login keychain.
export NUNCHIRO_KEYCHAIN=
export NUNCHIRO_LOGIN_PATH=off # ticket 576: a test core keeps the PATH it is given
for n in 3 10; do
  home=$root/.scratch/hf-$$-$n; mkdir -p "$home"
  export NUNCHIRO_HOME=$home
  start_core() {
    "$bin" serve & echo $! > "$home/core.pid"
    until "$bin" session list >/dev/null 2>&1; do sleep 0.1; done
  }
  start_core
  i=0
  while [ "$i" -lt "$n" ]; do
    "$bin" session start --kind shell --project "$home" -- /bin/cat >/dev/null || exit 1
    i=$((i + 1))
  done
  sleep 5
  measure "holders-idle-$n" "$home"
  kill -9 "$(cat "$home/core.pid")"
  start_core
  sleep 5
  measure "holders-reattached-$n" "$home"
  "$bin" serve stop --yes >/dev/null
  sleep 1
  rm -rf "$home"
done
echo "end load $(load)"
