#!/bin/sh
# A check before a new agent session: in quiet time, a start by an agent, a schedule or a token is refused with a
# reason; your own starts go ahead. Prints the one answer the core reads.
. ./quiet.sh
asker=$(/usr/bin/sed -n 's/.*"asker":"\([a-z]*\)".*/\1/p' "$NUNCHIRO_CONTEXT")
if [ "$quiet" = yes ] && [ "$asker" != owner ]; then
  printf '{"allow": false, "reason": "Quiet hours until %s."}\n' "$end"
else
  printf '{"allow": true}\n'
fi
