#!/bin/sh
# Tests for scripts/update-clone.sh (ticket 1082 part B, round 2): the clone takes main from the named repository and
# reads no git config or hook of the caller's. Throwaway repositories under .scratch/; no network, key or keychain.
# Usage: scripts/test-update-clone.sh. Prints `ok <case>` / `FAIL <case>: why`; exit 1 on a FAIL.
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
script=$root/scripts/update-clone.sh
mkdir -p "$root/.scratch"
fails=0
fail() { echo "FAIL $case: $*"; fails=$((fails + 1)); }
g() { d=$1; shift; git -C "$d" -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }

# Fresh sandbox $t: origin $t/origin.git with one main commit; an agent's repository $t/evil.git with another; a caller
# HOME $t/h whose ~/.gitconfig redirects the origin to evil and names a monitor that leaves a mark.
mk() {
  t=$(mktemp -d "$root/.scratch/update-clone-XXXXXX")
  for r in origin evil; do
    git init -q -b main "$t/$r"
    g "$t/$r" commit -q --allow-empty -m "$r"
    git clone -q --bare "$t/$r" "$t/$r.git"
  done
  mkdir -p "$t/h"
  printf '#!/bin/sh\ntouch %s/marked\n' "$t" > "$t/monitor"; chmod 755 "$t/monitor"
  printf '[url "file://%s/evil.git"]\n\tinsteadOf = file://%s/origin.git\n[core]\n\tfsmonitor = %s/monitor\n' "$t" "$t" "$t" > "$t/h/.gitconfig"
}
run() { out=$(HOME=$t/h GIT_CONFIG_GLOBAL=$t/h/.gitconfig NUNCHIRO_UPDATE_REPO=file://$t/origin.git sh "$script" "$@" 2>&1); code=$?; }

case=clone-ignores-caller-config; mk
run "$t/c"
want=$(git -C "$t/origin.git" rev-parse main)
[ $code = 0 ] || fail "exit $code: $out"
[ "$out" = "$want" ] || fail "printed $out, not origin main $want"
[ "$(git -C "$t/c" rev-parse HEAD)" = "$want" ] || fail "the clone is not origin's main"
git -C "$t/c" status --porcelain >/dev/null 2>&1
[ -e "$t/marked" ] && fail "the caller's core.fsmonitor ran during the clone"
[ $fails = 0 ] && echo "ok $case"; rm -rf "$t"

case=clone-into-existing-refused; f0=$fails; mk
mkdir "$t/c"
run "$t/c"
[ $code != 0 ] && echo "$out" | grep -q "clone into a new folder" || fail "not refused: $out"
[ $fails = $f0 ] && echo "ok $case"; rm -rf "$t"

[ $fails = 0 ] || exit 1