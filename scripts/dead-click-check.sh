#!/bin/sh
# needs 172 dead-click ratchet: prints each offender in FOUND (one `<state>|<css path>|<text>` per line) that BASELINE does not
# list, and exits 1 if there is one. web/tests/dead-click.spec.ts calls it; a baseline line that no longer offends is fine
# (the lane that fixed it deletes the line, and web-smoke.sh refuses a baseline that gained a line).
set -u
[ $# = 2 ] && [ -f "$1" ] && [ -f "$2" ] || { echo "usage: dead-click-check.sh BASELINE FOUND" >&2; exit 2; }
new=$(grep -vxFf "$1" "$2")
[ -z "$new" ] && exit 0
printf '%s\n' "$new" | sed 's/^/dead click: /' >&2
echo "dead click: a pointer-looking element is not a control (make it a button, or give it a role, a tabindex and a click handler)" >&2
exit 1
