#!/bin/sh
# Ticket 11 / spec Acceptance 9: footprint of core + app + WebKit helpers, window open and closed, 3 and 10
# sessions, agents as a second number, paired with herdr (same workload, interleaved); records docs/v1/figures.md. Args pass through to release.py footprint
# (--v1b: V1B-24, chat view on a 5,000-event session + 3 artifacts + board; --compare [--reason TEXT], --sessions 3,10, --repeats 3, --no-record). Needs scripts/measure/build.sh first.
set -eu
cd "$(dirname "$0")/../.."
exec python3 -B scripts/measure/release.py footprint "$@"
