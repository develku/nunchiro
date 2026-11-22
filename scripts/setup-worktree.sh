#!/bin/sh
# Ticket 1013 (F5): what a fresh worktree of this repository needs before its tests run: its own node_modules (web and
# app, one pnpm workspace) and web/dist, which tauri's `generate_context!` reads at compile time. Nunchiro runs it as the
# worktree setup script (orca.yaml `scripts.setup`, approved once); by hand: `scripts/setup-worktree.sh` from the root.
# `--prefer-offline` takes packages from the pnpm store when it has them, so a second worktree needs no network.
set -eu
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile --prefer-offline
pnpm --filter nunchiro-web build
