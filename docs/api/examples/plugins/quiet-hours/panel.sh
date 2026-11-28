#!/bin/sh
# A table: one row. Runs in the sandbox every 60 s while the panel is shown.
. ./quiet.sh
printf '[{"now":"%s","quiet from":"%s","until":"%s","quiet":"%s","agents working":%s}]\n' "$now" "$start" "$end" "$quiet" "$working"
