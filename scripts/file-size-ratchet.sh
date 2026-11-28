#!/bin/sh
# File size ratchet (ticket 1147, scorecard p26 "files over 2,000 lines"): a source file listed in
# scripts/file-sizes.baseline may shrink, never grow, and an unlisted one may not pass 2,000 lines. "Source" and
# "lines" are the scorecard judge's own (scripts/measure/scorecard.py SOURCE/NOT_SOURCE over `git ls-files`, wc -l),
# so moving tests to a sibling tests.rs counts the way the judge counts it. Peer: Orca's max-lines baseline.
# The CI lint job checks the same rule (.github/scripts/ratchets.py). Exit 0 pass, 1 a file grew or is new, 2 usage.
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
base=$root/scripts/file-sizes.baseline
[ -f "$base" ] || { echo "file-size ratchet: $base missing" >&2; exit 2; }
cd "$root" && exec python3 - "$base" <<'PY'
import subprocess, sys
sys.path.insert(0, "scripts/measure")
from scorecard import SOURCE, NOT_SOURCE

LIMIT = 2000
base = {}
for line in open(sys.argv[1]):
    if line.strip() and not line.startswith("#"):
        n, p = line.split(None, 1)
        base[p.strip()] = int(n)
files = subprocess.run(["git", "ls-files", "-z"], capture_output=True, check=True).stdout.decode().split("\0")
bad, lower = [], []
for p in files:
    if not p or not SOURCE.search(p) or NOT_SOURCE.search(p):
        continue
    try:
        with open(p, "rb") as f:
            n = f.read().count(b"\n")
    except FileNotFoundError:  # deleted in the work tree, not yet in the index
        continue
    if p in base:
        if n > base[p]:
            bad.append(f"{p}: grew from {base[p]} to {n} lines")
        elif n < base[p]:
            lower.append(f"{p}: {n} (baseline {base[p]})")
    elif n > LIMIT:
        bad.append(f"{p}: {n} lines, over {LIMIT} and not in the baseline")
for l in lower:
    print(f"file-size ratchet: lower the baseline: {l}")
if not bad:
    print("file-size ratchet: ok")
    sys.exit(0)
for b in bad:
    print(f"file size: {b}", file=sys.stderr)
print("file-size ratchet failed: split the file or move its tests to a sibling tests.rs (scripts/file-sizes.baseline)", file=sys.stderr)
sys.exit(1)
PY
