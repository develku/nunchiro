#!/usr/bin/env bash
# Ticket 484: rerun one nunchiro-core test binary under CPU load and count failures per test.
#
#   scripts/load-flake.sh <test-binary> [runs=20] [burners=CPU count] [threads=4] [-- test filters...]
#   e.g. scripts/load-flake.sh pr_live 20 10 4 -- created_on_an_older_page pr_branch_found_pr
#
# Load is `yes > /dev/null` per burner, stopped by recorded PID on exit (never pkill). burners=0 runs without load.
# The binary runs whole (or with the filters) at `threads` test threads, as the gate does, so the tests compete.
set -u
bin=$1; runs=${2:-20}; burners=${3:-$(sysctl -n hw.ncpu)}; threads=${4:-4}
shift $(( $# < 4 ? $# : 4 )); [ "${1:-}" = -- ] && shift
cd "$(dirname "$0")/.." || exit 1
cargo build -q -p nunchiro || exit 1
exe=$(cargo test -q -p nunchiro-core --test "$bin" --no-run --message-format=json 2>/dev/null |
  sed -n 's/.*"executable":"\([^"]*\)".*/\1/p' | tail -1)
[ -x "$exe" ] || { echo "no test binary for $bin" >&2; exit 1; }
pids=()
# ${pids[@]+...}: macOS bash 3.2 under `set -u` calls an empty array unbound.
stop() { for p in ${pids[@]+"${pids[@]}"}; do kill "$p" 2>/dev/null; done; }
trap stop EXIT
# An interrupted run must not go on without its load and report clean counts.
trap 'stop; echo "interrupted: burners stopped, no counts" >&2; exit 130' INT TERM
# A counting loop: macOS `seq 1 0` prints "1 0", which started two burners for burners=0.
n=0; while [ "$n" -lt "$burners" ]; do yes > /dev/null & pids+=($!); n=$((n + 1)); done
echo "load: $burners burners (pids ${pids[*]+${pids[*]}}), uptime: $(uptime | sed 's/.*load/load/')"
log=$(mktemp -d)/runs
fails=0
i=0; while [ "$i" -lt "$runs" ]; do i=$((i + 1))
  if "$exe" --test-threads "$threads" "$@" > "$log.$i" 2>&1; then r=ok; else r=FAIL; fails=$((fails + 1)); fi
  echo "run $i: $r $(grep -o '[0-9]* passed; [0-9]* failed' "$log.$i")"
done
echo "== $bin: $fails of $runs runs failed (logs $log.*)"
echo "== failures per test:"
cat "$log".* | sed -n 's/^test \(.*\) \.\.\. FAILED$/\1/p' | sort | uniq -c
