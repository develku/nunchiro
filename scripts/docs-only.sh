#!/bin/sh
# Exit 0 when every file a pull request adds or edits since its merge base with <ref> is on the safe list below, so CI
# may skip the Rust and web jobs; exit 1 for anything else (another path, a delete or rename, no change); any other exit
# is an error. CI skips only on 0 (tests/scenario/test_docs_only.py).
# The safe list is an allowlist of files no build, CI job or Rust or web test reads (checked with git grep for the path and the
# file name, include_str!/include_bytes!, build.rs and the tree walkers). Not safe, for example: docs/cli.md
# (check-cli-docs, board_cli.rs), docs/first-run.md and docs/design/ (include_str!, test_export_public.py), docs/remote.md
# and docs/i18n-terms.md (web tests), docs/reuse-ledger.md and licences (app check), PRIVACY.md (test_outbound_hosts.py),
# docs/measure/ (measure tests). Two scenario tests read the safe files too, and both still hold on a skip:
# test_export_links.py (every exported *.md) also runs in ci.yml's lint job, and test_export_public.py needs README.md
# to exist, which a delete (exit 1 below) would break. check-reuse-ledger.sh scans root *.md but has no CI caller.
# docs/design/design-book/ is safe as a folder: checked 2026-11-27 (git grep, include_str!, test_outbound_hosts walks only
# crates, app, web/src, plugin; public-exclude drops docs/design/ from the export).
# Add a file only after the same check.
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
    docs/design/design-book/*) ;; # the design book: no build, test or tree walker reads it (only test_export_links.py, in lint)
    *) exit 1 ;;
  esac
done
