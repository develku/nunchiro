#!/bin/sh
# ticket 291 no-op click ratchet: prints each offender in FOUND (one `<state>|<css path>|<text>` per line) that BASELINE does
# not list, and exits 1 if there is one. web/tests/noop-click-check.spec.ts calls it; a baseline line that no longer offends
# is fine (the change that fixed it deletes the line; the CI lint job, .github/scripts/ratchets.py, refuses a baseline that gained one).
set -u
[ $# = 2 ] && [ -f "$1" ] && [ -f "$2" ] || { echo "usage: noop-click-check.sh BASELINE FOUND" >&2; exit 2; }
new=$(grep -vxFf "$1" "$2")
[ -z "$new" ] && exit 0
printf '%s\n' "$new" | sed 's/^/no-op click: /' >&2
echo "no-op click: a clickable whose click changes no DOM, focus, route or request (make it do its job, or remove it)" >&2
exit 1
