#!/bin/sh
# Merge check for changes under app/ (V1A-67): the app crate sits outside the root workspace, so the root cargo
# stages of the gate neither lint nor test it. Builds web/dist only when missing: tauri's generate_context needs it to
# exist, and an older build does not change these checks. Two cargo jobs; the caller still checks the host load first.
# --affected <ref>: run only when something the app check reads differs from <ref> (committed, staged, unstaged or
# untracked); a gate stage. The list covers the app crate, its toolchain, and the notice inputs gen-notices.sh checks.
set -eu
cd "$(dirname "$0")/.."
APP_INPUTS="app/ scripts/check-app.sh scripts/gen-notices.sh Cargo.toml Cargo.lock rust-toolchain.toml
licenses/ LICENSE THIRD_PARTY_NOTICES.md web/package.json pnpm-lock.yaml pnpm-workspace.yaml"
if [ "${1:-}" = --affected ]; then
  ref=${2:?usage: check-app.sh [--affected <ref>]}
  base=$(git merge-base "$ref" HEAD)
  # shellcheck disable=SC2086 # the list is word-split on purpose
  if git diff --quiet "$base" -- $APP_INPUTS && [ -z "$(git ls-files --others --exclude-standard -- $APP_INPUTS)" ]; then
    echo "check-app: no app input changed since $ref; skipped"
    exit 0
  fi
fi
unset CARGO_TARGET_DIR
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
[ -f web/dist/index.html ] || (cd web && pnpm exec vite build --logLevel error)
cd app/src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
# Shipped notices (tauri.conf.json bundle.resources) must match the lock files; needs web/node_modules for pnpm.
../../scripts/gen-notices.sh --check
