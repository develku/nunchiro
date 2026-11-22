#!/bin/sh
# Fails when `nunchiro --help` lists a command docs/cli.md lacks, or docs/cli.md documents a command
# the help does not list. Docs-only entries need `<!-- pending: help -->` (a command another ticket adds to
# --help later); the marker itself fails once --help lists the command, so it cannot go stale.
# Builds the binary first (default target/debug/nunchiro, under CARGO_TARGET_DIR if set).
# Env: NUNCHIRO_BIN (use this prebuilt binary, no build), CLI_DOCS.
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "${NUNCHIRO_BIN:-}" ]; then  # build so a stale binary cannot pass; NUNCHIRO_BIN opts out (self-test)
  (cd "$root" && cargo build -q -p nunchiro) || { echo "check-cli-docs: cargo build -p nunchiro failed" >&2; exit 2; }
fi
bin=${NUNCHIRO_BIN:-${CARGO_TARGET_DIR:-$root/target}/debug/nunchiro}
docs=${CLI_DOCS:-$root/docs/cli.md}
[ -x "$bin" ] || { echo "check-cli-docs: no binary at $bin; run 'cargo build -p nunchiro' first" >&2; exit 2; }
[ -f "$docs" ] || { echo "check-cli-docs: $docs not found" >&2; exit 2; }
tmp=$(mktemp -d) || exit 2
trap 'rm -rf "$tmp"' EXIT

# Reads command phrases on stdin ("session list|read --json ..."); prints one command per line.
words='
{ gsub(/`/, ""); n = split($0, w, " "); out = ""
  for (i = 1; i <= n; i++) {
    if (w[i] ~ /^[\[<A-Z.]/ || (i > 1 && w[i] ~ /^-/)) break
    out = out (out == "" ? "" : " ") w[i]
    if (i == 1 && w[i] ~ /^-/) break
  }
  if (out == "") next
  k = split(out, p, " "); last = p[k]; prefix = substr(out, 1, length(out) - length(last))
  m = split(last, alt, "|")
  for (j = 1; j <= m; j++) print prefix alt[j] }'

"$bin" --help 2>&1 | sed -n 's/^nunchiro //p' | awk "$words" | sort -u > "$tmp/help"
[ -s "$tmp/help" ] || { echo "check-cli-docs: '$bin --help' lists no commands" >&2; exit 2; }
sed -n 's/^### `nunchiro \(.*\)$/\1/p' "$docs" | grep -v 'pending: help' | awk "$words" | sort -u > "$tmp/docs"
sed -n 's/^### `nunchiro \(.*\)$/\1/p' "$docs" | grep 'pending: help' | awk "$words" | sort -u > "$tmp/pending"

status=0
comm -23 "$tmp/help" "$tmp/docs" | comm -23 - "$tmp/pending" | sed 's/^/missing from docs\/cli.md: nunchiro /' >&2
comm -13 "$tmp/help" "$tmp/docs" | sed 's/^/documented but not in --help: nunchiro /' >&2
comm -12 "$tmp/help" "$tmp/pending" | sed 's/^/pending marker on a listed command (remove it): nunchiro /' >&2
{ comm -23 "$tmp/help" "$tmp/docs" | comm -23 - "$tmp/pending"; comm -13 "$tmp/help" "$tmp/docs"; comm -12 "$tmp/help" "$tmp/pending"; } | grep -q . && status=1
[ "$status" = 0 ] && echo "cli docs cover $(wc -l < "$tmp/help" | tr -d ' ') help commands"
exit "$status"
