#!/bin/sh
# The raw-literal ratchet alone, in about a second: a count in scripts/raw-literals.baseline may fall, never rise,
# and a file outside the baseline may not gain a literal. Run it before opening a pull request that touches web/src.
# Exit 0 pass, 1 a count rose or is new, 2 usage.
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
base=$root/scripts/raw-literals.baseline
[ -f "$base" ] || { echo "raw-literal ratchet: $base missing" >&2; exit 2; }
# The scan's own failure must not read as "no literals": stop before any id is written.
counts=$(sh "$root/scripts/raw-literals.sh") || { echo "raw-literal ratchet: scripts/raw-literals.sh failed" >&2; exit 2; }
bad=$(printf '%s\n' "$counts" | awk -v base="$base" '
  BEGIN { while ((getline l < base) > 0) { split(l, a, " "); b[a[1] " " a[2]] = a[3] } }
  { k = $1 " " $2
    if (!(k in b)) printf "%s %s: %d, not in the baseline\n", $1, $2, $3
    else if ($3 > b[k]) printf "%s %s: rose from %d to %d\n", $1, $2, b[k], $3 }')
[ -z "$bad" ] && { echo "raw-literal ratchet: ok"; exit 0; }
printf '%s\n' "$bad" | sed 's/^/raw literals: /' >&2
echo "raw-literal ratchet failed: use a token from web/src/tokens.css (scripts/raw-literals.sh prints the counts)" >&2
exit 1
