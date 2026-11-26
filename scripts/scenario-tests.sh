#!/bin/sh
# Gate stage 6: the Python scenario suite, one unittest process per tests/scenario/test_*.py, N at a time.
# A file over 20 kB (test_web_smoke.py) is split one process per TestCase class, so one file is not the whole run.
# Same exit semantics as `python3 -m unittest discover -s tests/scenario`: any failing or erroring unit fails the run
# (exit 1), and each failing unit's full unittest output (its tracebacks) is printed after the summary.
# Env: SCENARIO_DIR (test dir, default tests/scenario), SCENARIO_JOBS (default half the cores, min 1).
# Biggest files start first so the longest one is not left for the end. Output goes to .scratch/ (removed on exit).
# Cross-check: the units' test total must equal what `unittest discover` would load (it matches test*.py and recurses into
# packages, this runner lists test_*.py only), else the run fails naming both numbers. Skips print as skipped=N per unit and in the last line.
# Every unit runs from the repo root; a class unit finds its module through PYTHONPATH=$dir.
set -u
# Ticket 457: a core started under this run keeps no start secrets in the owner's login keychain (hand-run scenario
# scripts give a core the real HOME). Empty means no keychain; a value set by the caller wins, as in lib.py and cargo.
export NUNCHIRO_KEYCHAIN="${NUNCHIRO_KEYCHAIN-}"
root=$(cd "$(dirname "$0")/.." && pwd)
dir=${SCENARIO_DIR:-$root/tests/scenario}
cores=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 2)
jobs=${SCENARIO_JOBS:-$((cores / 2))}
case $jobs in ''|*[!0-9]*|0) jobs=1 ;; esac
# Gate provenance for scripts/gate-failures.sh (review v25-gate-name-failures r1 MUST 1): a scenario test may run
# web-smoke.sh and leave a fresh report or stage file, then fail. So the runner removes .scratch/web-smoke/ and its own
# .scratch/scenario-passed at start and again on any non-zero exit; only a pass writes the marker, as its last step.
# gate-failures.sh reads web files only when the marker exists and they are newer. .scratch/scenario-failed, also
# removed at start, lists one failing unit per line; the runner writes it only when every unit's exit status came back
# and the discover count matched; the exit trap removes one it did not write (a test may plant it, then the run fails
# another way), so any other red leaves it absent: unnamed. The statuses come back on the xargs pipe,
# which no test process holds (their stdout and stderr go to the unit's log), never from a file or text a test can
# write. SCENARIO_STATE (tests) moves all three.
# Round 2 security MUST: a test can plant any of these files with a future mtime and make it immutable (chflags uchg),
# so neither a removal nor the write can replace it. So when a state file the runner did not write is still there
# after a removal (at start, or in the exit trap), or the write of scenario-failed fails, the runner exits 75 (infra):
# the [gate] wrapper then leaves the failure list empty and names nobody.
st=${SCENARIO_STATE:-$root/.scratch}; passed=0; named=0
gone() { for f; do { [ ! -e "$st/$f" ] && [ ! -L "$st/$f" ]; } || { echo "scenario: cannot remove $st/$f (infra)" >&2; return 1; }; done; }
rm -rf "$st/web-smoke" "$st/scenario-passed" "$st/scenario-failed"
gone web-smoke scenario-passed scenario-failed || exit 75
files=$(ls -S "$dir"/test_*.py 2>/dev/null) || files=""
[ -n "$files" ] || { echo "scenario: no test_*.py in $dir" >&2; exit 2; }
mkdir -p "$root/.scratch" || exit 2
out=$(mktemp -d "$root/.scratch/scenario.XXXXXX") || exit 2
trap 'rm -rf "$out"; [ $passed = 1 ] || rm -rf "$st/web-smoke" "$st/scenario-passed"; [ $named = 1 ] || rm -f "$st/scenario-failed"
  { [ $passed = 1 ] || gone web-smoke scenario-passed; } && { [ $named = 1 ] || gone scenario-failed; } || exit 75' EXIT
trap 'exit 130' INT TERM
export out dir root
(cd "$root" && python3 -B -c 'import sys, unittest; print(unittest.defaultTestLoader.discover(sys.argv[1]).countTestCases())' "$dir" >"$out/discover.count" 2>"$out/discover.err") &
discover_pid=$!
# units: "test_x.py" (whole file) or "test_x.py:Class" (a big file's classes, listed by importing it, so none is missed)
units=""
for p in $files; do
  f=$(basename "$p")
  if [ "$(wc -c <"$p")" -gt 20000 ]; then
    cls=$(cd "$root" && PYTHONPATH=$dir python3 -B -c '
import sys, unittest
def walk(s):
    for t in s:
        yield from walk(t) if isinstance(t, unittest.TestSuite) else [t]
names = sorted({type(t).__name__ for t in walk(unittest.defaultTestLoader.loadTestsFromName(sys.argv[1][:-3]))})
print(*names)' "$f") || cls=""
    for c in $cls; do units="$units $f:$c"; done
    [ -n "$cls" ] && continue
  fi
  units="$units $f"
done
start=$(date +%s)
results=$(printf '%s\n' $units | xargs -P "$jobs" -I{} sh -c '
  u=$1; f=${u%%:*}; s=$(date +%s)
  if [ "$f" = "$u" ]; then
    PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s "$dir" -p "$f" >"$out/$u.log" 2>&1
  else
    (cd "$root" && PYTHONPATH=$dir PYTHONDONTWRITEBYTECODE=1 python3 -m unittest "${f%.py}.${u#*:}" >"$out/$u.log" 2>&1)
  fi
  rc=$?; echo $(( $(date +%s) - s )) >"$out/$u.secs"; echo "$u $rc"' _ {}); xargs_rc=$?
wait "$discover_pid"
bad=0; total=0; n=0; skipped=0; failed=""; lost=0
for u in $units; do
  n=$((n + 1))
  rc=$(printf '%s\n' "$results" | awk -v u="$u" '$1 == u { print $2; exit }')
  [ -n "$rc" ] || { rc=99; lost=1; }
  [ "$rc" = 0 ] || failed="$failed $u"
  ran=$(sed -n 's/^Ran \([0-9]*\) test.*/\1/p' "$out/$u.log" 2>/dev/null | tail -1); ran=${ran:-0}
  total=$((total + ran))
  sk=$(grep -E '^(OK|FAILED) ' "$out/$u.log" 2>/dev/null | sed -n 's/.*skipped=\([0-9]*\).*/\1/p' | tail -1); sk=${sk:-0}
  skipped=$((skipped + sk)); skinfo=""; [ "$sk" = 0 ] || skinfo=" skipped=$sk,"
  if [ "$rc" = 0 ]; then echo "scenario: ok   $u ($ran tests,$skinfo $(cat "$out/$u.secs")s)"
  else echo "scenario: FAIL $u (exit $rc, $ran tests,$skinfo $(cat "$out/$u.secs" 2>/dev/null || echo 0)s)"; bad=$((bad + 1)); fi
done
for u in $failed; do
  echo; echo "=== $u ==="; cat "$out/$u.log" 2>/dev/null
done
echo "scenario: $n units, $total tests, $bad failing, skipped=$skipped, $jobs at a time, $(( $(date +%s) - start ))s"
want=$(cat "$out/discover.count" 2>/dev/null)
if [ "$want" != "$total" ]; then
  [ -s "$out/discover.err" ] && cat "$out/discover.err"
  echo "scenario: count mismatch: discover loads ${want:-?} tests, units ran $total (a test*.py or a package test the runner does not list?)" >&2
  exit 1
fi
if [ "$bad" != 0 ]; then
  if [ "$xargs_rc" = 0 ] && [ "$lost" = 0 ]; then
    # a test may have planted a link here: remove it, then create exclusively (noclobber never follows a link)
    rm -rf "$st/scenario-failed"; gone scenario-failed && (set -C; printf '%s\n' $failed >"$st/scenario-failed") && named=1 || { echo "scenario: cannot write $st/scenario-failed (infra)" >&2; exit 75; }
  fi
  exit 1
fi
rm -rf "$st/web-smoke" "$st/scenario-passed"; gone web-smoke scenario-passed || exit 75
(set -C; : >"$st/scenario-passed") || exit 75
passed=1
