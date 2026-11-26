#!/bin/sh
# Exit 0 when every file a pull request adds or edits since its merge base with <ref> is on the safe list below, so CI
# may skip the Rust and web jobs; exit 1 for anything else (another path, a delete or rename, no change); any other exit
# is an error. CI skips only on 0 (tests/scenario/test_docs_only.py).
# The safe list is an allowlist of files no build, test or script reads (checked with git grep for the path and the
# file name, include_str!/include_bytes!, build.rs and the tree walkers). Not safe, for example: docs/cli.md
# (check-cli-docs, board_cli.rs), docs/first-run.md and docs/design/ (include_str!, test_export_public.py), docs/remote.md
# and docs/i18n-terms.md (web tests), docs/reuse-ledger.md and licences (app check), PRIVACY.md (test_outbound_hosts.py),
# docs/measure/ (measure tests). Add a file only after the same check.
set -u
ref=${1:?usage: docs-only.sh <ref>}
base=$(git merge-base "$ref" HEAD) || exit 2
all=$(git diff --no-renames --name-only "$base" HEAD) || exit 2
other=$(git diff --no-renames --name-only --diff-filter=am "$base" HEAD) || exit 2
[ -n "$all" ] && [ -z "$other" ] || exit 1 # a deleted README.md fails test_export_public.py
# git quotes an unusual path ("..."), which matches no entry.
printf '%s\n' "$all" | while IFS= read -r f; do
  case $f in
    README.md | CHANGELOG.md | GLOSSARY.md | SECURITY.md | docs/product.md | docs/brand/trademark-search-2026-11.md) ;;
    *) exit 1 ;;
  esac
done
