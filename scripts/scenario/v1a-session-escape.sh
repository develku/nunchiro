#!/bin/sh
# Ticket V1A-18 reproduction: a process inside a fixture shell session forks once, calls `setsid` while its
# parent exits, and regains owner authority with `core.token`; then the candidate boundaries are measured.
# Fixtures only (fake shell sessions, a scratch NUNCHIRO_HOME); no real agent starts. Prints one `row ...`
# line per test; exits non-zero when a row's recorded result no longer holds. Finding: docs/v1/owner-boundary-spike.md.
set -u
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root" || exit 2
unset CARGO_TARGET_DIR
cargo build -q -j 2 -p nunchiro || exit 2
sw_vers | tr '\n' ' '
echo
log=$(cargo test -q -j 2 -p nunchiro-core --test owner_boundary -- --nocapture --test-threads=1 2>&1)
status=$?
printf '%s\n' "$log" | grep -oE '(row .*|test result.*|thread .* panicked.*|  left.*|  right.*)'
exit $status
