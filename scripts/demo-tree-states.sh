#!/bin/sh
# Ticket 462: every tree-strip state in one Nunchiro home, for the real-app check of the colour bars against the approved
# mockup (docs/design/m3-1110/388.html). No agent CLI and no network: each session is a shell whose program reports its
# state through the core's own hook bridge (`nunchiro hook`), as an agent's hooks do, or exits. Failed is a claude session
# whose program is the tests' fake agent (web/tests/fixtures.ts FAKE_CLAUDE, here exiting 3), found first on the core's
# PATH: so run this BEFORE the app or core starts for that home (the CLI starts the core with this PATH). While that core
# runs, every claude session in the home is the fake; `nunchiro serve stop` ends it.
#   usage: scripts/demo-tree-states.sh <NUNCHIRO_HOME> [nunchiro binary]
# Refuses the owner's ~/.nunchiro and any other *.nunchiro folder but the RC's .nunchiro-dev.nunchiro.app.rc.
set -eu
home=${1:?usage: scripts/demo-tree-states.sh <NUNCHIRO_HOME> [nunchiro binary]}
root=$(cd "$(dirname "$0")/.." && pwd)
bin=${2:-$root/target/debug/nunchiro}
[ -x "$bin" ] || { echo "demo-tree-states: no nunchiro binary at $bin" >&2; exit 2; }
# Checked before anything is created: as given, through its nearest existing folder (symlinks and case resolved), and
# once more after mkdir (a home that is itself a symlink). A refused path is left exactly as it was.
refuse() {
  case "$1" in
    */../* | */.. | ../* | ..)
      echo "demo-tree-states: refusing $1 (no .. in the path)" >&2; exit 2 ;;
    # the RC's home, but only where nothing above it is an owner-like folder
    */.nunchiro-dev.nunchiro.app.rc | */.nunchiro-dev.nunchiro.app.rc/*) refuse "${1%%/.nunchiro-dev.nunchiro.app.rc*}" ;;
    */.nunchiro | */.nunchiro/* | */.nunchiro-* | */.nunchiro-*/* | *.nunchiro | *.nunchiro/* | .nunchiro | .nunchiro-* | .nunchiro/*)
      echo "demo-tree-states: refusing $1 (only the RC's .nunchiro-dev.nunchiro.app.rc or a scratch folder)" >&2; exit 2 ;;
  esac
}
refuse "$home"
up=$home rest=
while [ ! -d "$up" ]; do rest=/$(basename "$up")$rest; up=$(dirname "$up"); done
refuse "$(cd "$up" && pwd -P)$rest"
mkdir -p "$home"
home=$(cd "$home" && pwd -P)
refuse "$home"
export NUNCHIRO_HOME="$home"
proj="$home/demo-projects/rcdemo-bars"
done_proj="$home/demo-projects/rcdemo-done"
mkdir -p "$proj" "$done_proj"
# The worktree rows need a repository with one commit.
[ -d "$proj/.git" ] || (cd "$proj" && git init -q && git -c user.name=demo -c user.email=demo commit -q --allow-empty -m demo)
fake="$home/demo-bin"
mkdir -p "$fake"
cat > "$fake/claude" <<'FAKE'
#!/bin/sh
if [ "$1" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi
if [ "$1 $2" = "auth status" ]; then exit 2; fi
printf 'demo agent: failing on purpose\r\n'
exit 3
FAKE
chmod 700 "$fake/claude"
# The login PATH stays on, on purpose (ticket 596): the demo's shells look as they do in the app. The core keeps its own
# PATH first and appends only the login entries it lacks (crates/nunchiro-core/src/login_path.rs), so the fake claude
# stays first even on a machine with a real claude installed.
nun() { PATH="$fake:$PATH" "$bin" "$@"; }
start() { # label, worktree flag, program...
  label=$1 wt=$2; shift 2
  set -- session start --kind shell --project "$proj" --label "$label" ${wt:+--worktree} -- "$@"
  nun "$@" >/dev/null && echo "  $label"
}
echo "demo-tree-states: home $home"
echo "rcdemo-bars:"
start working '' /bin/sh -c "printf '{\"turn_id\":\"demo\"}' | '$bin' hook UserPromptSubmit; exec cat"
start your-turn '' /bin/sh -c "printf '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}' | '$bin' hook PermissionRequest; exec cat"
nun session start --kind claude --project "$proj" --label failed >/dev/null && echo "  failed"
start idle '' /bin/cat
start resting 1 /bin/sh -c 'exit 0'
# 3 or more of one colour: one bar and the number
for n in 1 2 3; do start "busy-$n" '' /bin/sh -c "printf '{\"turn_id\":\"b$n\"}' | '$bin' hook UserPromptSubmit; exec cat"; done
echo "rcdemo-done (finished only, folded into N done):"
proj=$done_proj
for n in 1 2; do start "done-$n" '' /bin/sh -c 'exit 0'; done
sleep 2
if nun snapshot --json | grep -q '"case":"unexpected"'; then echo "failed: made"; else echo "failed: NOT made (a core was already running for this home: stop it, run again, then open the app)"; fi
echo "made: rcdemo-bars = failed 1, your turn 1, working 4 (one bar + 4), idle 1, resting 1 (worktree row, grey); rcdemo-done = 2 done, no bar"
