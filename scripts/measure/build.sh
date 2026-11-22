#!/bin/sh
# Release builds the figures are taken from: the core CLI and the window app (web bundle embedded).
set -eu
cd "$(dirname "$0")/../.."
unset CARGO_TARGET_DIR
pnpm install --frozen-lockfile
CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" pnpm --dir app build
cargo build --release -j "${CARGO_BUILD_JOBS:-2}" -p nunchiro
