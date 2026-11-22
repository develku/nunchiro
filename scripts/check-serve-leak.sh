#!/bin/sh
# Fails (exit 1) when a `nunchiro serve` is still alive whose NUNCHIRO_HOME is an `ns-*` folder under the system
# temp dir: the home that crates/nunchiro-core/tests/fixtures/home.rs makes, and whose parent is gone (ppid 1 or dead).
# A serve with a live parent is a test still running (this lane's or another's), not an orphan. One line per process:
# pid, ppid, home. Never kills anything.
# Env: NS_LEAK_PS_FILE (read this file instead of `ps`, same format as `ps axeww -o pid=,ppid=,command=`).
set -u
tmp=${TMPDIR:-/tmp}
if [ -n "${NS_LEAK_PS_FILE:-}" ]; then
  cat "$NS_LEAK_PS_FILE"
else
  ps axeww -o pid=,ppid=,command=  # BSD style: macOS appends the environment only without the dash
fi | awk -v tmp="${tmp%/}" '
  { serve = 0; home = ""
    for (i = 1; i <= NF; i++) {
      if ($i ~ /nunchiro$/ && $(i + 1) == "serve") serve = 1
      if ($i ~ /^NUNCHIRO_HOME=/) home = substr($i, 15)
    }
    n = split(home, p, "/")
    temp = (index(home, tmp "/") == 1 || home ~ /^(\/private)?\/(tmp|var\/folders)\//)
    if (serve && temp && p[n] ~ /^ns-/) print $1, $2, home }' |
{
  found=0
  while read -r pid ppid home; do
    if [ "$ppid" -gt 1 ] && kill -0 "$ppid" 2>/dev/null; then continue; fi
    echo "$pid $ppid $home"
    found=1
  done
  exit $found
}
