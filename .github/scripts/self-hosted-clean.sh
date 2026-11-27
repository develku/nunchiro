#!/bin/sh
# First step of a macOS job on the self-hosted runner, after checkout: removes what an earlier job left outside the
# workspace, so a run cannot see the last one's state. actions/checkout already cleans the workspace and the runner
# cleans RUNNER_TEMP. Kept on purpose: the toolchains and download caches (~/.rustup, ~/.cargo, the pnpm store,
# ~/Library/Caches/ms-playwright), which only hold what their lock files name.
set -eu
# Only as the runner's own user: anywhere else this would delete a real ~/.nunchiro.
[ "$(id -un)" = nunchiro-ci ] || { echo "self-hosted-clean: runs only as the nunchiro-ci runner user" >&2; exit 1; }
rm -f "$HOME/.gitconfig"
rm -rf "$HOME"/.nunchiro*
# Test homes and sockets in the user's temp folder; the runner's own .NET pipes stay.
find "${TMPDIR:?}" -mindepth 1 -maxdepth 1 -user "$(id -u)" ! -name 'dotnet-diagnostic-*' ! -name 'clr-debug-pipe-*' \
  -exec rm -rf {} +
