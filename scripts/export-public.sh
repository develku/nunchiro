#!/bin/sh
# Writes the public snapshot of this repository into an empty folder: `git archive` of REF (default HEAD) minus the
# paths in scripts/public-exclude.txt (read from REF, so the list and the tree always match). Changes nothing in the
# repository; refuses an out-dir that exists and is not empty. Same REF, same files (mtimes are REF's commit time).
# --scrub then runs scripts/scrub-owner.py --apply on OUT_DIR: the owner's handle and private project names are replaced
# in the export only (main keeps its text).
# Usage: scripts/export-public.sh [--scrub] OUT_DIR [REF]
set -eu
scrub=
[ "${1:-}" = --scrub ] && { scrub=1; shift; }
[ $# -ge 1 ] || { echo "usage: $0 [--scrub] OUT_DIR [REF]" >&2; exit 2; }
out=$1 ref=${2:-HEAD}
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
export GIT_OPTIONAL_LOCKS=0
commit=$(git -C "$repo" rev-parse --verify -q "$ref^{commit}") || { echo "export-public: no such ref: $ref" >&2; exit 2; }
if [ -e "$out" ]; then
  [ -d "$out" ] && [ -z "$(ls -A "$out")" ] || { echo "export-public: not an empty folder: $out" >&2; exit 2; }
else
  mkdir -p "$out"
fi
list=$(git -C "$repo" show "$commit:scripts/public-exclude.txt")
# pattern = first field of each non-comment line; "+path" puts a path back after the excludes
pats=$(printf '%s\n' "$list" | sed -e 's/[[:space:]]#.*//' -e 's/^#.*//' -e 's/[[:space:]]*$//' | grep -v '^$' || true)
set --
for p in $(printf '%s\n' "$pats" | grep -v '^+' || true); do set -- "$@" ":(exclude)$p"; done
# Archived into a file first: in `git archive | tar -x` the status is tar's, so a failed archive read as a good export.
tarball=$(mktemp "${TMPDIR:-/tmp}/export-public.XXXXXX")
trap 'rm -f "$tarball"' EXIT
unpack() {
  git -C "$repo" archive --format=tar "$commit" -- "$@" > "$tarball"
  tar -x -C "$out" -f "$tarball"
}
unpack . "$@"
keep=$(printf '%s\n' "$pats" | sed -n 's/^+//p')
if [ -n "$keep" ]; then
  # shellcheck disable=SC2086 # one word per path on purpose
  unpack $keep
fi
[ -z "$scrub" ] || python3 "$(dirname "$0")/scrub-owner.py" --apply "$out"
echo "export-public: $(find "$out" -type f | wc -l | tr -d ' ') files from ${commit%"${commit#????????????}"} -> $out"
