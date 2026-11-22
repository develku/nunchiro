#!/bin/sh
# V1A-44: xterm.js speed and stability figures (echo to paint, stream throughput, memory per terminal, soak, WebGL
# comparison); records docs/v1/figures.md. Args pass through to paint.py (--quick, --only PHASES, --no-record).
# Needs the release core (scripts/measure/build.sh) and the Playwright browsers (`pnpm -C web exec playwright install webkit chromium`).
set -eu
cd "$(dirname "$0")/../.."
exec python3 -B scripts/measure/paint.py "$@"
