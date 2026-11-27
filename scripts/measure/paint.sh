#!/bin/sh
# V1A-44: xterm.js speed and stability figures (echo to paint, stream throughput, memory per terminal, soak, WebGL
# comparison); records docs/v1/figures.md. Args pass through to paint.py (--quick, --only PHASES, --no-record).
# Needs the web build (scripts/measure/build.sh), the Playwright browsers (`pnpm -C web exec playwright install webkit chromium`)
# and, in NUNCHIRO_MEASURE_CORE, a core built with release optimisation and debug assertions on (`scorecard.py stream8`
# builds one): a plain release core gives the window token to the app only, so the page cannot open a terminal on it.
set -eu
cd "$(dirname "$0")/../.."
exec python3 -B scripts/measure/paint.py "$@"
