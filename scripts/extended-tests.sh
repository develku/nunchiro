#!/bin/sh
# Weekly extended Rust run (ticket 1130 A2, TR1): the tests that leave the default suite through a Cargo feature instead
# of #[ignore]. Runs outside the merge gate, on a quiet host, beside scripts/supply-chain.sh. Each group runs with its
# own budget (the tests assert their own bounds) and the run appends one dated line to
# .scratch/extended-tests/log.txt: date, commit, 1-minute load, then pass, FAIL or skipped per group.
#   measure  6 measurements (idle_cpu x3, chat_performance, search_sessions_perf_500mb, observe_lock measure_), release
#   floods   2 socket floods (owner_hardening refill); skipped when the 1-minute load is 15 or more (V1A-17 host rule)
#   live     3 real-agent and real-gh tests (agent_canary real_fresh_start, pr real_gh, artifact_skill deny rules):
#            need a signed-in claude, codex and gh and the network; one cheap Haiku call. Skipped when one is missing.
#            search_sessions_perf_500mb serves the cargo-built nunchiro (cli::path) unless NUNCHIRO_BIN is set. This
#            script does not set it, so its result is pass/fail only; for the shipped figure, point NUNCHIRO_BIN at a
#            release nunchiro build.
# Exit 1 when a group failed, else 0. EXTENDED_DRY=1 prints the commands and runs nothing (the scenario test reads it).
# Schedule (the lead installs it; this script installs nothing): a LaunchAgent made like the supply-chain one,
#   Label com.me.nunchiro-extended-tests, ProgramArguments /bin/sh __REPO__/scripts/extended-tests.sh,
#   StartCalendarInterval Weekday 1, Hour 5, Minute 30 (after the 04:30 supply-chain run).
set -u
cd "$(dirname "$0")/.."
# The tests start their own cores on their own homes; no session or owner home may leak into them.
unset NUNCHIRO_SESSION NUNCHIRO_TOKEN NUNCHIRO_ARTIFACTS NUNCHIRO_HOME
out=.scratch/extended-tests
line="$(date '+%Y-%m-%d %H:%M') $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
load=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')
line="$line load=${load:-unknown}"
failed=0

group() { # name, then one command per argument (each a whole shell command)
  name=$1; shift
  result=pass
  for cmd in "$@"; do
    if [ -n "${EXTENDED_DRY:-}" ]; then echo "$name: $cmd"; continue; fi
    echo "== $name: $cmd"
    sh -c "$cmd" || result=FAIL
  done
  [ "$result" = FAIL ] && failed=1
  line="$line $name=$result"
}

core='cargo test --release -p nunchiro-core --features measure'
# search_sessions_perf_500mb starts the nunchiro CLI (tests/fixtures/cli.rs: next to the test binary, so the release
# one); `cargo test -p nunchiro-core` never builds another package's binary, so a fresh checkout needs it built first.
group measure \
  'cargo build --release --locked -p nunchiro' \
  'cargo test --release -p nunchiro --features measure --test idle_cpu -- --nocapture --test-threads=1' \
  "$core --test chat_performance -- --nocapture" \
  "$core --test search_sessions search_sessions_perf_500mb -- --nocapture" \
  "$core --test observe_lock measure_snapshot_latency_during_a_bounded_firehose -- --nocapture"

flood="$core --test owner_hardening -- --exact owner_hardening_handshake_refill_16 owner_hardening_handshake_refill_40 --test-threads=1"
if [ -z "${EXTENDED_DRY:-}" ] && ! awk -v l="${load:-99}" 'BEGIN { exit !(l < 15) }'; then
  line="$line floods=skipped"
else
  group floods "$flood"
fi

missing=
for tool in claude codex gh; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
live='cargo test -p nunchiro-core --features live'
if [ -z "${EXTENDED_DRY:-}" ] && [ -n "$missing" ]; then
  line="$line live=skipped(no$missing)"
else
  group live "$live --lib -- --exact agent_canary::tests::real_fresh_start pr::tests::real_gh_output_parses" \
    "$live --test artifact_skill deny_rules_enforced_by_current_claude -- --nocapture"
fi

if [ -n "${EXTENDED_DRY:-}" ]; then exit 0; fi
mkdir -p "$out"
echo "$line" >> "$out/log.txt"
echo "$line"
exit $failed
