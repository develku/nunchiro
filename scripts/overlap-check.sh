#!/bin/sh
# ticket 291 overlap ratchet: prints each offender in FOUND (one `<state>|<width>|<css path A>|<css path B>` per line) that
# BASELINE does not list, and exits 1 if there is one. web/tests/overlap-check.spec.ts calls it; a baseline line that no
# longer offends is fine (the lane that fixed it deletes the line, and web-smoke.sh refuses a baseline that gained a line).
set -u
[ $# = 2 ] && [ -f "$1" ] && [ -f "$2" ] || { echo "usage: overlap-check.sh BASELINE FOUND" >&2; exit 2; }
new=$(grep -vxFf "$1" "$2")
[ -z "$new" ] && exit 0
printf '%s\n' "$new" | sed 's/^/overlap: /' >&2
echo "overlap: visible text or controls overlap (move one, or fix the layout; an overlap by design goes on the allow-list in web/tests/overlap-check.spec.ts)" >&2
exit 1
