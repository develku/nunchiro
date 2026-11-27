#!/bin/sh
# Shared by the panel and the command: reads the two settings from $NUNCHIRO_CONTEXT and sets $quiet to yes or no.
setting() { /usr/bin/sed -n "s/.*\"$1\":\"\([0-9:]*\)\".*/\1/p" "$NUNCHIRO_CONTEXT"; }
start=$(setting start); end=$(setting end); now=$(/bin/date +%H:%M)
if [ "$start" \< "$end" ]; then
  if [ ! "$now" \< "$start" ] && [ "$now" \< "$end" ]; then quiet=yes; else quiet=no; fi
else
  if [ ! "$now" \< "$start" ] || [ "$now" \< "$end" ]; then quiet=yes; else quiet=no; fi
fi
working=$(/usr/bin/grep -o '"state":"working"' "$NUNCHIRO_CONTEXT" | /usr/bin/wc -l | /usr/bin/tr -d ' ')
