#!/bin/sh
# Ticket 751: the ticket-621 CLI soak, committed so a stability lane can run it again with one command.
# Keeps RUNNING shell sessions; each cycle starts 2 and closes the 2 oldest while they run; `serve restart` every
# RESTART_EVERY cycles. Every SAMPLE_SEC it prints one table row: core RSS, sessions.json, queue.json, one snapshot.
#   scripts/soak/soak.sh            60 minutes, home .scratch/soak/<time>
#   MINUTES=10 SOAK_HOME=.scratch/soak/a scripts/soak/soak.sh
# SOAK_HOME must resolve under this worktree's .scratch, or nothing runs (exit 2). HOME, NUNCHIRO_HOME and
# NUNCHIRO_TEST_OPENER=record are set on every call by `n` below, never exported: ticket 621's lane lost an exported
# HOME between shell calls and reached the owner's core twice.
set -eu
cd "$(dirname "$0")/../.."
root=$(pwd -P)
MINUTES=${MINUTES:-60}
SAMPLE_SEC=${SAMPLE_SEC:-300}
RUNNING=${RUNNING:-8}
RESTART_EVERY=${RESTART_EVERY:-30}
BIN=${BIN:-$root/target/debug/nunchiro}

want=${SOAK_HOME:-.scratch/soak/$(date +%m%d%H%M%S)}
case $want in /*) ;; *) want=$root/$want ;; esac
# Resolve the folder that exists (symlinks included) before judging it; a new leaf is then made inside it.
parent=$(dirname "$want")
while [ ! -d "$parent" ]; do parent=$(dirname "$parent"); done
resolved=$(cd "$parent" && pwd -P)${want#"$parent"}
case $resolved in
"$root"/.scratch/?*) ;;
*) echo "soak: refused: home $resolved is not under $root/.scratch" >&2; exit 2 ;;
esac
case $resolved in */../* | */.. | */./* | *.nunchiro*) echo "soak: refused: home $resolved" >&2; exit 2 ;; esac
H=$resolved
mkdir -p "$H/home"
H=$(cd "$H" && pwd -P) # a symlinked leaf made meanwhile would show here
case $H in "$root"/.scratch/?*) ;; *) echo "soak: refused: home $H is not under $root/.scratch" >&2; exit 2 ;; esac
[ ${#H} -lt 90 ] || { echo "soak: home path too long for core.sock: $H" >&2; exit 2; }

if [ "${SOAK_BUILD:-1}" = 1 ]; then
    CARGO_HOME=${CARGO_HOME:-$root/.scratch/cargo-home} cargo build -q -p nunchiro
fi
[ -x "$BIN" ] || { echo "soak: no binary at $BIN" >&2; exit 2; }

n() {
    env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin TERM=xterm-256color LANG=en_US.UTF-8 \
        HOME="$H/home" NUNCHIRO_HOME="$H" NUNCHIRO_TEST_OPENER=record \
        NUNCHIRO_LOGIN_PATH=off NUNCHIRO_KEYCHAIN= "$BIN" "$@"
}
# Only a `serve` of this binary whose environment carries this home is ours (ps -E prints the environment).
core_pid() {
    ps -Eww -A -o pid=,command= | awk -v c="$BIN serve " -v h="NUNCHIRO_HOME=$H " \
        'index($0, c) && index($0 " ", h) { print $1; exit }'
}
kb() { if [ -f "$1" ]; then echo $(($(wc -c <"$1") / 1024)); else echo 0; fi; }
ids=$H/running.ids
start2() {
    for _ in 1 2; do
        n session start --kind shell --project "$H/home" -- /bin/sh -c 'while :; do echo soak; sleep 2; done' |
            sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' | head -1 >>"$ids"
    done
}
sample() {
    n snapshot --json >"$H/snap.json"
    pid=$(core_pid)
    rss=$(ps -o rss= -p "${pid:-0}" 2>/dev/null || echo 0)
    rows=$(grep -o '"state": *"[A-Za-z]*"' "$H/snap.json" | wc -l | tr -d ' ')
    printf '| %s | %s | %s | %s | %s | %s | %s |\n' "$1" "$(echo "$rss" | awk '{printf "%.1f", $1/1024}')" \
        "$rows" "$(kb "$H/snap.json")" "$(kb "$H/sessions.json")" "$(kb "$H/queue.json")" "$cycles" | tee -a "$H/table.md"
}
stop() {
    [ -s "$ids" ] && while read -r id; do n session close "$id" >/dev/null 2>&1 || true; done <"$ids"
    n serve stop >/dev/null 2>&1 || true
    # `serve stop` can return while the core still winds down; leave only once it is gone.
    i=0
    while n serve status 2>/dev/null | grep -q '"core": *true' && [ $i -lt 150 ]; do i=$((i + 1)); sleep 0.1; done
}
trap stop EXIT
trap 'exit 130' INT TERM

: >"$ids"
n serve >>"$H/serve.out" 2>&1 &
i=0
until n serve status 2>/dev/null | grep -q '"core": *true'; do
    i=$((i + 1)); [ $i -lt 100 ] || { echo "soak: core did not start, see $H/serve.out" >&2; exit 1; }
    sleep 0.1
done
cycles=0
while [ "$(wc -l <"$ids")" -lt "$RUNNING" ]; do start2; done
echo "soak: home $H, $MINUTES min, sample every $SAMPLE_SEC s"
echo '| min | core RSS MB | snapshot rows | snapshot KB | sessions.json KB | queue.json KB | cycles |' | tee "$H/table.md"
echo '|---|---|---|---|---|---|---|' | tee -a "$H/table.md"
t0=$(date +%s)
sample 0
next=$SAMPLE_SEC
end=$((MINUTES * 60))
while :; do
    now=$(($(date +%s) - t0))
    if [ "$now" -ge "$next" ]; then
        sample $((next / 60))
        next=$((next + SAMPLE_SEC))
    fi
    [ "$now" -lt "$end" ] || break
    start2
    for id in $(head -2 "$ids"); do n session close "$id" >/dev/null; done
    sed -i '' 1,2d "$ids"
    cycles=$((cycles + 1))
    if [ $((cycles % RESTART_EVERY)) -eq 0 ]; then n serve restart >/dev/null; fi
done
bad=$(cat "$H"/logs/core.log* 2>/dev/null | grep -ciE 'error|warn|panic' || true)
echo "soak: $cycles cycles, $bad error/warn/panic lines in logs/core.log, table in $H/table.md"
