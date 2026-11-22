#!/bin/sh
# Baselines (ticket 01): footprint of bare claude/codex idle and in a turn, and keystroke echo
# latency through a PTY relay (cat; claude composer idle and with 3 busy claude sessions).
set -eu
cd "$(dirname "$0")/../.."
python3 scripts/measure/footprint.py claude
python3 scripts/measure/footprint.py codex
python3 scripts/measure/echo_latency.py --target cat --n 300
python3 scripts/measure/echo_latency.py --target claude --n 100
python3 scripts/measure/echo_latency.py --target claude --n 100 --busy 3
