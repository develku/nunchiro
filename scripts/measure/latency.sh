#!/bin/sh
# Ticket 11 / spec Acceptance 10: keystroke-to-echo p95 with 3 busy sessions (row nunchiro-busy3, n >= 300),
# paired with herdr-busy3 (interleaved), plus the ticket-01 relay floor; records docs/v1/figures.md. Args pass through to release.py latency
# (--compare [--reason TEXT], --n 300, --no-record). Needs scripts/measure/build.sh first.
set -eu
cd "$(dirname "$0")/../.."
exec python3 -B scripts/measure/release.py latency "$@"
