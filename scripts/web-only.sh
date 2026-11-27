#!/bin/sh
# Exit 0 when every file a pull request adds or edits since its merge base with <ref> is window code or a window test
# that no Rust file reads, so CI may skip the Rust build and test jobs (the web job still compiles the core and runs the
# window and scenario tests); exit 1 for anything else (another path, a delete or rename, no change); any other exit is
# an error. CI skips only on 0 (tests/scenario/test_web_only.py).
# Safe: web/src/** and web/tests/** whose path no file under crates/ or app/src-tauri/ names (include_str! of
# web/src/settings.ts, providers.tsx, onboarding/state.ts, webwidgets/bridge.ts and the like are found by that search,
# comments too, which only makes the rule stricter). Not safe: web/index.html (the embedded bundle's page is checked by
# browser_serves_only_embedded_assets), package files, build and TypeScript config, anything outside web/src and
# web/tests. Main runs every job, so a miss here still shows on main right after the merge.
set -u
ref=${1:?usage: web-only.sh <ref>}
base=$(git merge-base "$ref" HEAD) || exit 2
all=$(git diff --no-renames --name-only "$base" HEAD) || exit 2
other=$(git diff --no-renames --name-only --diff-filter=am "$base" HEAD) || exit 2
[ -n "$all" ] && [ -z "$other" ] || exit 1
printf '%s\n' "$all" | while IFS= read -r f; do
  case $f in
    web/src/* | web/tests/*) ;;
    *) exit 1 ;;
  esac
  # A Rust file that names this path may read it at build or test time.
  if git grep -q -F -e "$f" HEAD -- crates app/src-tauri; then exit 1; fi
done
