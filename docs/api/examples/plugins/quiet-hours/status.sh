#!/bin/sh
# One line for the note the window shows after the command runs.
. ./quiet.sh
if [ "$quiet" = yes ]; then echo "Quiet time until $end; $working agents still working."; else echo "Not quiet time (quiet from $start to $end)."; fi
