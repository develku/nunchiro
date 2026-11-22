#!/bin/sh
# Fails when a file carries an upstream-licence header or "adapted/lifted from" line that docs/reuse-ledger.md does not
# list, when a `code` row names a source that is neither MIT nor CC0, when a listed path is missing, or when a non-CC0
# `code` row's source has no line in NOTICES (CC0 asks for no notice; owner 2026-11-10). `--self-test` proves the failing cases on fixtures. Env: REUSE_ROOT (tree to check, default this repo).
set -u
here=$(cd "$(dirname "$0")/.." && pwd)

HEADER='^[[:space:]]*(//[/!]?|\*|/\*|#|<!--)[[:space:]].*(Permission is hereby granted|adapted from|lifted from|MIT.*Copyright \(c\)|Licensed under the Apache License|SPDX-License-Identifier: *\(?(Apache|GPL|AGPL|LGPL)|GNU (Affero )?General Public License)'

check() {  # $1 = root
  root=$1; ledger=$root/docs/reuse-ledger.md
  [ -f "$ledger" ] && [ -f "$root/NOTICES" ] || { echo "check-reuse-ledger: ledger or NOTICES missing under $root" >&2; return 2; }
  tmp=$(mktemp -d) || return 2
  # rows: path<TAB>kind<TAB>source<TAB>licence
  awk -F'|' '/^\| `/ { for (i = 2; i <= 7; i++) { gsub(/^ +| +$|`/, "", $i) } print $2 "\t" $3 "\t" $4 "\t" $7 }' "$ledger" > "$tmp/rows"
  [ -s "$tmp/rows" ] || { echo "check-reuse-ledger: no rows in $ledger" >&2; rm -rf "$tmp"; return 2; }
  status=0
  cut -f1 "$tmp/rows" | sort -u > "$tmp/listed"
  # Every tracked or new text file, comment lines only (licence text in strings, docs and data is not a header).
  # Skipped: the ledger/notice files, licence texts, lockfiles and themes/catalog/update.py (quotes a sample notice). Our own files are MIT, so the only SPDX line they may
  # carry is MIT, which the pattern does not match; any Apache/GPL/AGPL/LGPL header in a non-skipped file must be listed.
  (cd "$root" && git ls-files -z --cached --others --exclude-standard |
    grep -z -v -E '^(docs/|licenses/|NOTICES$|THIRD_PARTY_NOTICES\.md$|LICENSE|.*/LICENSE|.*/NOTICES\.md$|pnpm-lock\.yaml$|Cargo\.lock$|scripts/check-reuse-ledger\.sh$|web/src/themes/catalog/update\.py$)' |
    xargs -0 grep -I -l -i -E "$HEADER" 2>/dev/null) | sort -u > "$tmp/headers"
  comm -23 "$tmp/headers" "$tmp/listed" | sed 's/^/header not in docs\/reuse-ledger.md: /' > "$tmp/err"
  while IFS= read -r p; do [ -e "$root/$p" ] || echo "listed path missing: $p" >> "$tmp/err"; done < "$tmp/listed"
  awk -F'\t' '$2 == "code" && $4 !~ /^(MIT|CC0)/ { print "non-MIT source as copied code: " $3 " (" $1 ")" }
              $2 != "code" && $2 != "idea" { print "kind must be code or idea: " $1 }' "$tmp/rows" >> "$tmp/err"
  awk -F'\t' '$2 == "code" && $4 !~ /^CC0/ { print $3 }' "$tmp/rows" | sort -u | while IFS= read -r s; do
    awk -v s="$s" 'index($0, s) == 1 { f = 1 } END { exit !f }' "$root/NOTICES" || echo "no NOTICES line for source: $s" >> "$tmp/err"
  done
  [ -s "$tmp/err" ] && { cat "$tmp/err" >&2; status=1; }
  rm -rf "$tmp"; return $status
}

if [ "${1:-}" = "--self-test" ]; then
  d=$(mktemp -d) || exit 2; trap 'rm -rf "$d"' EXIT
  mkdir -p "$d/docs" "$d/web/src"
  cp "$here/NOTICES" "$d/NOTICES"; cp "$here/docs/reuse-ledger.md" "$d/docs/"
  grep '^| `' "$d/docs/reuse-ledger.md" | cut -d'`' -f2 | while IFS= read -r p; do mkdir -p "$d/$(dirname "$p")"; : > "$d/$p"; done
  git -C "$d" init -q && git -C "$d" add -A
  check "$d" >/dev/null 2>&1 || { echo "self-test: clean fixture failed" >&2; exit 1; }
  ok=0
  # ledger_lists_every_header, non_mit_header_detected, all_text_files_scanned: each unlisted header must fail alone.
  while IFS='|' read -r name line; do
    printf '%s\n' "$line" > "$d/web/src/$name"; git -C "$d" add -A
    check "$d" >/dev/null 2>&1 && { echo "self-test: unlisted header passed in $name" >&2; ok=1; }
    rm "$d/web/src/$name"; git -C "$d" add -A
  done <<'EOT'
new.rs|// Adapted from Foo bar.rs, commit abc. MIT License, Copyright (c) 2026 Foo.
a b.js|// Licensed under the Apache License, Version 2.0
x.css|/* SPDX-License-Identifier: GPL-3.0-only */
y.js|// GNU Affero General Public License
EOT
  printf '// SPDX-License-Identifier: MIT\n' > "$d/web/src/ours.ts"; git -C "$d" add -A
  check "$d" >/dev/null 2>&1 || { echo "self-test: our MIT SPDX line failed" >&2; ok=1; }
  rm "$d/web/src/ours.ts"
  # non_mit_code_refused
  printf '| `web/src/x.rs` | code | Foo | `a.rs` | `abc` | Apache-2.0 |\n' >> "$d/docs/reuse-ledger.md"
  : > "$d/web/src/x.rs"
  check "$d" 2>&1 | grep -q 'non-MIT source' || { echo "self-test: Apache-2.0 code row passed" >&2; ok=1; }
  # cc0_code_allowed: with the Apache row gone, a CC0 code row passes and needs no NOTICES line.
  grep -v 'Apache-2.0 |$' "$d/docs/reuse-ledger.md" > "$d/l" && mv "$d/l" "$d/docs/reuse-ledger.md"
  printf '| `web/src/x.rs` | code | NoNoticeSource | `a.svg` | `abc` | CC0-1.0 |\n' >> "$d/docs/reuse-ledger.md"
  check "$d" >/dev/null 2>&1 || { echo "self-test: CC0 code row failed" >&2; ok=1; }
  # notices_anchored: a source named only mid-line in NOTICES does not count.
  sed 's/^Zeron /see Zeron /' "$here/NOTICES" > "$d/NOTICES"
  check "$d" 2>&1 | grep -q 'no NOTICES line for source: Zeron' || { echo "self-test: unanchored NOTICES match passed" >&2; ok=1; }
  [ $ok = 0 ] && echo "check-reuse-ledger self-test: ok"; exit $ok
fi
check "${REUSE_ROOT:-$here}"
