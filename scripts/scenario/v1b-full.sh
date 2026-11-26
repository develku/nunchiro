#!/bin/sh
# Ticket v1b-25, spec Acceptance 15: every v1b path with real agents (Claude haiku, Codex cheapest), one row each:
# script-widget-act, web-widget-act, diff-card, chat-claude, chat-codex, images-claude, images-codex,
# artifact-skill (cheapest first), then `v1b-full: config unchanged`: lib.snapshot()/guard_check plus a manifest of
# config-like files under ~/.claude and ~/.codex, before and after the whole run (scripts/scenario/v1b_full.py).
# RUNS (default 1) is passed to every chained script; Codex rows are `not run` without headroom. Exit 0 only when every
# row that ran passed and the config is unchanged. V1B_FULL_ROWS picks rows; NUNCHIRO_WEB_PORT defaults to 4198.
set -eu
cd "$(dirname "$0")/../.."
export CARGO_HOME="${CARGO_HOME:-$PWD/.scratch/cargo-home}"
unset CARGO_TARGET_DIR
cargo build -q -j 2 -p nunchiro
exec python3 -B scripts/scenario/v1b_full.py "$@"
