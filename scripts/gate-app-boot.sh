#!/bin/sh
# Gate stage S2 (ticket 464, owner decision 2026-11-12 option a): the built app boots, draws its window, its core answers
# and one shell session prints a line, before a merge lands. The app is built with the RC bundle id
# (dev.nunchiro.app.rc), started without activation on a temp NUNCHIRO_HOME under this worktree's .scratch, and only
# what this run started is stopped, by recorded PID. Nothing is installed; the owner's home and app are never used.
#
# No owner step (gate-app-boot-ssh): the stage needs no macOS grant, so it passes the same from a terminal or over ssh.
# - No Screen Recording: the RC, in a gate run only, writes its own page's picture into the temp home
#   (app/src-tauri/src/gate_shot.rs) and the stage checks that picture.
# - No signing identity: with "Nunchiro Local Code Signing" the build is signed with it; without, ad hoc, and the stage
#   prints `gate-app-boot: note: ad hoc signature (no local signing identity)` (no grant has to hold across builds).
# - No prompt can block the window: the home is a temp folder in the worktree, the core keeps no start secrets in a
#   keychain (NUNCHIRO_KEYCHAIN empty, checked in core.start.json), and a worktree on a removable or external volume,
#   or in a folder macOS asks about (Desktop, Documents, Downloads, iCloud Drive), exits 4 before the launch.
#
#   gate-app-boot.sh            build, then run the stage on that build
#   gate-app-boot.sh build      build only: .scratch/gate-app-boot/Nunchiro RC.app (prints the path)
#   gate-app-boot.sh run [APP]  the stage only, on APP (default: the last build)
# Every failure prints `gate-app-boot: <step>: <cause>`. Exit: 0 pass (or skipped: a locked screen, sleeping display
# or session off the console prints `gate-app-boot: skipped: ...` and logs it in .scratch/gate-app-boot/skips.log),
# 1 a step failed, 2 usage, 3 refused (a home or path that is not this worktree's own), 4 the machine is not ready,
# not the build: a screen state it cannot read, a worktree where the RC would raise a Files & Folders prompt, or a
# front app that changed while the RC was never front nor active (the person at the machine switched apps).
# The worktree path may be at most 60 bytes: the temp home is <worktree>/.scratch/gXXXXXX (see HOME_MAX).
# Env: GATE_APP_BOOT_WAIT (seconds per wait, default 60); GATE_APP_BOOT_BLANK=1 (the red check: the RC hides its page,
# so the stage must fail at the window step); GATE_APP_BOOT_TARGET_DIR, GATE_APP_BOOT_LOCK_WAIT (seconds, default 600)
# and GATE_APP_BOOT_TARGET_MAX_MB (default 8192) (see build below).
# Failure name (ticket 487): every exit 1 writes .scratch/gate-app-boot/failed, one line: the failing step, which
# scripts/gate-failures.sh turns into `stage:gate-app-boot`. Every run removes it first, whatever the mode, so a pass,
# a skip, a usage error, a refusal (3) or exit 4 leaves none; a marker it cannot remove (a planted immutable file)
# exits 75 (infra, unnamed) before anything else. It is written only once own_dir checked the folder (an exit 1
# before that, or a shell error that is not a `fail`, is unnamed). It names this stage, never a test or a lane.
# Ticket 495: own_dir also writes .scratch/gate-app-boot/started (empty) in every run, and gate-failures.sh counts
# `failed` only when `started` is newer than the earlier reports and `failed` is not older than `started`, so a
# `failed` written late by a leftover run that began before this gate's earlier stages never names this gate.
set -u
# What stop_run reads and may run or remove: never a value from the environment (a stray `app=` or `home=` there
# would get its CLI run, lsregister -u, or rm -rf when a run fails before setting them).
run= home= app= app_pid= session= stop_failed= out= target=
cd "$(dirname "$0")/.." || exit 2
root=$(pwd -P)
RC_ID=dev.nunchiro.app.rc
NAME="Nunchiro RC.app"
OUT_REL=.scratch/gate-app-boot
WAIT=${GATE_APP_BOOT_WAIT:-60}
case $WAIT in '' | *[!0-9]* | 0) WAIT=60 ;; esac
# A holder socket is $home/holders/<12 hex>.sock (26 bytes more); past 103 bytes the core puts it in /tmp/nunchiro-<uid>
# instead, outside the worktree and shared with every other core of this user. So the home is refused past 77 bytes
# rather than relying on that fallback, and kept short (.scratch/gXXXXXX, 17 bytes after the worktree path).
HOME_MAX=77

say() { echo "gate-app-boot: $*" >&2; }
fail() {
  say "$1: $2"
  [ "${3:-1}" != 1 ] || mark_failed "$1"
  exit "${3:-1}"
}
# Written by this script from its own exit path, never from what a build or the app prints. `out` is set only by
# own_dir, after it checked that the folder is this worktree's own (no link).
mark_failed() {
  [ -n "${out:-}" ] || return 0
  { printf '%s\n' "$1" >"$out/failed.$$" && mv -f "$out/failed.$$" "$out/failed"; } 2>/dev/null ||
    say "marker: cannot write $OUT_REL/failed (this failure stays unnamed)"
}
# At the start of every run: an earlier run's marker must never name this one. Through a linked .scratch nothing is
# removed (own_dir refuses that run, exit 3).
clear_marker() {
  [ ! -L "$root/.scratch" ] && [ ! -L "$root/$OUT_REL" ] || return 0
  rm -f "$root/$OUT_REL/failed" "$root/$OUT_REL/started" 2>/dev/null
  [ ! -e "$root/$OUT_REL/failed" ] && [ ! -L "$root/$OUT_REL/failed" ] ||
    fail marker "cannot remove $OUT_REL/failed (an earlier run's failure marker)" 75
}

# --- where things may live -------------------------------------------------------------------------------------------
# The owner's data: ~/.nunchiro and every ~/.nunchiro-* (an RC's default home), in any case, for $HOME and the passwd
# home, before and after links are resolved. A path is refused when any of its parts is such a folder.
passwd_home=$(python3 -I -c 'import os, pwd; print(pwd.getpwuid(os.getuid()).pw_dir)' 2>/dev/null) || passwd_home=
owner_path() {
  for p in "$1" "$(cd "$1" 2>/dev/null && pwd -P)"; do
    [ -n "$p" ] || continue
    lower=$(printf '%s' "$p" | tr '[:upper:]' '[:lower:]')
    case "/$lower/" in */.nunchiro/* | */.nunchiro-*/*) return 0 ;; esac
    for h in "${HOME:-}" "$passwd_home"; do
      [ -n "$h" ] || continue
      for o in "$h/.nunchiro" "$(cd "$h/.nunchiro" 2>/dev/null && pwd -P)"; do
        [ -n "$o" ] || continue
        case "$p/" in "$o"/*) return 0 ;; esac
      done
    done
  done
  return 1
}
# .scratch and our folder must be real folders of this worktree: a link could lead to ~/.nunchiro or ~/Applications.
own_dir() {
  [ ! -L "$root/.scratch" ] || fail "$1" "refused: .scratch is a symlink (to $(readlink "$root/.scratch"))" 3
  [ ! -L "$root/$OUT_REL" ] || fail "$1" "refused: $OUT_REL is a symlink (to $(readlink "$root/$OUT_REL"))" 3
  owner_path "$root" && fail "$1" "refused: this worktree $root is inside the owner's Nunchiro home" 3
  mkdir -p "$root/$OUT_REL" || fail "$1" "cannot make $OUT_REL"
  out=$(cd "$root/$OUT_REL" && pwd -P)
  [ "$out" = "$root/$OUT_REL" ] || fail "$1" "refused: $OUT_REL resolves to $out, not $root/$OUT_REL" 3
  { : >"$out/started.$$" && mv -f "$out/started.$$" "$out/started"; } 2>/dev/null ||
    say "marker: cannot write $OUT_REL/started (a failure of this run stays unnamed)"
}

# Ad hoc (no local signing identity) is fine: the stage needs no grant to hold across builds. Said once per stage.
ad_hoc() {
  if codesign -dv "$1" 2>&1 | grep -q '^Signature=adhoc'; then
    say "note: ad hoc signature (no local signing identity)"
  fi
}

# A Files & Folders prompt would block the window with nobody to answer it over ssh: the worktree must be on an
# internal, fixed volume and outside the folders macOS asks about. Exit 4 (the machine, not the build) otherwise.
prompt_free() {
  for h in "${HOME:-}" "$passwd_home"; do
    [ -n "$h" ] || continue
    for d in Desktop Documents Downloads "Library/Mobile Documents"; do
      for g in "$h/$d" "$(cd "$h/$d" 2>/dev/null && pwd -P)"; do
        [ -n "$g" ] || continue # a folder that does not exist resolves to nothing, which would match every path
        case "$root/" in "$g"/*)
          fail volume "this worktree $root is in ~/$d, which macOS guards with a Files & Folders prompt" 4 ;;
        esac
      done
    done
  done
  mnt=$(df -P "$root" 2>/dev/null | awk 'NR == 2 { sub(/^([^ ]+ +){5}/, ""); print }')
  [ -n "$mnt" ] || fail volume "cannot tell the volume of $root (df)" 4
  plist=$(diskutil info -plist "$mnt" 2>/dev/null) || fail volume "cannot tell whether $mnt is removable (diskutil)" 4
  key() { printf '%s' "$plist" | plutil -extract "$1" raw -o - - 2>/dev/null; }
  internal=$(key Internal) removable=$(key RemovableMedia) ejectable=$(key Ejectable)
  [ "$internal" = true ] && [ "$removable" != true ] && [ "$ejectable" != true ] ||
    fail volume "this worktree is on $mnt, a removable or external volume (internal ${internal:-unknown}, \
removable ${removable:-unknown}, ejectable ${ejectable:-unknown}): the RC would raise a Removable Volumes prompt" 4
}

# --- build ------------------------------------------------------------------------------------------------------------
# GATE_APP_BOOT_TARGET_DIR (ticket 487, opt-in): the cargo target for this stage's build, an absolute folder outside
# every worktree, so a gate worktree emptied by `git clean -ffdx` before each gate still finds a warm build (about 35 s
# instead of about 3 min). Unset or empty: $OUT_REL/target, as before. Refused (exit 3, nothing built): a relative path,
# one inside this worktree, the worktree or a folder above it, $HOME itself, the owner's ~/.nunchiro or any
# ~/.nunchiro-*, before and after links are resolved. Made when missing.
# Shared by two gates (or a gate and a lane's own run): cargo locks the target while it compiles, but tauri bundles
# into the fixed debug/bundle/macos/<NAME> after cargo let go, so build() holds its own lock (flock on
# <target>/.gate-app-boot.lock) from the web build until both binaries are copied into this worktree; a second run waits
# there. What the stage runs is always that copy in $OUT_REL. A build left by another commit is only a cache: cargo
# rebuilds what changed (its fingerprints), dependencies stay; the web bundle is built per worktree and embedded.
# Ticket 495: the lock wait is bounded (GATE_APP_BOOT_LOCK_WAIT seconds, default 600): past it the run exits 75 (infra,
# unnamed), since a build that holds the folder that long is hung, not this commit's fault. After a build, a target over
# GATE_APP_BOOT_TARGET_MAX_MB (default 8192) loses debug/incremental, then all of debug/ if still over, so the next
# build is colder but the folder never grows without end. Both are removed under the lock, inside the checked target.
target_dir() {
  t=${GATE_APP_BOOT_TARGET_DIR:-}
  if [ -z "$t" ]; then
    target=$out/target
    mkdir -p "$target" || fail build "cannot make $OUT_REL/target"
    return 0
  fi
  refuse() { fail build "refused: GATE_APP_BOOT_TARGET_DIR $1" 3; }
  case $t in /*) ;; *) refuse "is not an absolute path: $t" ;; esac
  case $t in *"
"*) refuse "holds a newline" ;; esac
  real=$(python3 -I -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$t") && [ -n "$real" ] ||
    refuse "cannot be resolved: $t"
  lroot=$(printf '%s' "$root" | tr '[:upper:]' '[:lower:]')
  for cand in "$t" "$real"; do # not `p` or `h`: owner_path's loops set those
    owner_path "$cand" && refuse "is in the owner's Nunchiro home: $cand"
    lp=$(printf '%s' "${cand%/}" | tr '[:upper:]' '[:lower:]')
    case "$lp/" in "$lroot"/*) refuse "is inside this worktree: $cand" ;; esac
    case "$lroot/" in "$lp"/*) refuse "is this worktree or a folder above it: $cand" ;; esac
    for hd in "${HOME:-}" "$passwd_home"; do
      [ -n "$hd" ] || continue
      [ "$lp" != "$(printf '%s' "${hd%/}" | tr '[:upper:]' '[:lower:]')" ] || refuse "is the home folder: $cand"
    done
  done
  mkdir -p "$real" || fail build "cannot make $real (GATE_APP_BOOT_TARGET_DIR)"
  target=$(cd "$real" && pwd -P) && [ "$target" = "$real" ] || refuse "resolves to ${target:-nothing}, not $real"
  owner_path "$target" && refuse "is in the owner's Nunchiro home: $target"
  return 0
}
# Holds an exclusive flock on fd 9 for the rest of this shell (released when it exits or closes fd 9): the lock
# belongs to the open file, which python locks and leaves open in this shell. Children get fd 9 closed (9>&-).
build_lock() {
  lock_wait=${GATE_APP_BOOT_LOCK_WAIT:-600}
  case $lock_wait in '' | *[!0-9]*) lock_wait=600 ;; esac
  exec 9>>"$target/.gate-app-boot.lock" || fail build "cannot open $target/.gate-app-boot.lock"
  python3 -I -c 'import fcntl, sys, time
end = time.monotonic() + int(sys.argv[2])
said = False
while True:
    try:
        fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if not said:
            print("gate-app-boot: build: waiting for another build in " + sys.argv[1], file=sys.stderr, flush=True)
            said = True
        if time.monotonic() >= end:
            sys.exit(75)
        time.sleep(1)' "$target" "$lock_wait"
  case $? in
    0) ;;
    75) fail build "another build held $target for over ${lock_wait}s (GATE_APP_BOOT_LOCK_WAIT): gave up, not this build" 75 ;;
    *) fail build "cannot lock $target/.gate-app-boot.lock" ;;
  esac
}
# Called under the lock, after both binaries were copied out. Only names inside $target are removed; rm -rf on a link
# removes the link, not what it points to.
cap_target() {
  max=${GATE_APP_BOOT_TARGET_MAX_MB:-8192}
  case $max in '' | *[!0-9]*) max=8192 ;; esac
  for part in debug/incremental debug; do
    kb=$(du -sk "$target" 2>/dev/null | awk '{ print $1 }')
    [ -n "$kb" ] && [ "$kb" -gt $((max * 1024)) ] || return 0
    # Checked again just before each rm: rm follows a link in the middle of a path, so a linked debug/ (or a target
    # swapped since target_dir) would make debug/incremental a folder outside the target.
    [ "$(cd "$target" 2>/dev/null && pwd -P)" = "$target" ] || { say "build: $target moved: not trimmed"; return 0; }
    [ ! -L "$target/debug" ] || { say "build: $target/debug is a link: not trimmed"; return 0; }
    say "build: target $target is $((kb / 1024)) MB, over ${max} MB: removing $part"
    rm -rf "${target:?}/$part" || say "build: cannot remove $target/$part"
  done
}
# A debug bundle with the RC config (not the release build of build-rc.sh): the stage looks for a window that does not
# draw, a core that does not answer and a shell that does not print, which the debug build shows as well, at a fraction
# of the compile time. Own cargo target under .scratch/gate-app-boot: the gate's other cargo runs keep theirs, and the
# RC identifier compiled into the app crate never flips their build. NUNCHIRO_BUILD makes the CLI an RC CLI, which
# refuses to start a core on the owner's home (crates/nunchiro main.rs refuse_rc_core_start); fixed, so it stays cached.
build() {
  own_dir build
  target_dir
  say "build: target $target"
  started=$(date +%s)
  build_lock
  export CARGO_TARGET_DIR="$target"
  export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
  pnpm --filter nunchiro-web build >&2 9>&- || fail build "web build failed"
  web=$(date +%s)
  (cd app && pnpm exec tauri build --debug --bundles app --config src-tauri/tauri.rc.conf.json) >&2 9>&- ||
    fail build "tauri build failed"
  tauri=$(date +%s)
  NUNCHIRO_BUILD=1 cargo build --locked -p nunchiro >&2 9>&- || fail build "cargo build -p nunchiro failed"
  cli=$(date +%s)
  built="$CARGO_TARGET_DIR/debug/bundle/macos/$NAME"
  [ -f "$built/Contents/Info.plist" ] || fail build "tauri made no $built"
  id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$built/Contents/Info.plist")
  [ "$id" = "$RC_ID" ] || fail build "refused: the bundle id is $id, not $RC_ID" 3
  app="$out/$NAME"
  rm -rf "$app"
  cp -R "$built" "$app" || fail build "cannot copy the bundle"
  # The window prefers the CLI next to it; one found on PATH would be the owner's install.
  cp "$CARGO_TARGET_DIR/debug/nunchiro" "$app/Contents/MacOS/nunchiro" || fail build "cannot copy the CLI"
  cap_target
  exec 9>&- # both binaries are this worktree's copies now: another build may use the target
  # The local identity keeps the designated requirement stable, so a permission granted once to Nunchiro RC holds.
  scripts/local-signing.sh sign "$app" >&2 9>&- || fail build "signing failed"
  say "build: web $((web - started))s, tauri $((tauri - web))s, cli $((cli - tauri))s, total $(($(date +%s) - started))s"
  echo "$app"
}

# --- processes --------------------------------------------------------------------------------------------------------
# A process is ours when its executable lies in this run's folder (the per-run copy of the app and its CLI, in a
# folder mktemp named at random just before the launch), or it descends from one that does. `ps comm` is argv[0],
# which any process can set, so it only picks candidates: the kernel's executable path (proc_pidpath) must lie in the
# run folder too. Each is recorded as "pid start-time comm" and signalled only while all three still match, so a PID
# the system reused is never hit. Only this user's processes are looked at.
# `ps` in the C locale, so the start time is always "Dow Mon DD HH:MM:SS YYYY"; comm last, so it may hold spaces.
ps_all() { LC_ALL=C ps -axww -o pid=,ppid=,uid=,lstart=,comm= 2>/dev/null; }
PS_AWK='{ pid = $1; ppid = $2; u = $3; start = $4 " " $5 " " $6 " " $7 " " $8; exe = $0
  sub(/^ *[0-9]+ +[0-9]+ +[0-9]+ +[A-Za-z]+ +[A-Za-z]+ +[0-9]+ +[0-9:]+ +[0-9]+ +/, "", exe); key = pid "\t" start "\t" exe }'
OURS_PY='import ctypes, sys
run, want = sys.argv[1], sys.argv[2:]
lib = ctypes.CDLL("/usr/lib/libproc.dylib")
buf = ctypes.create_string_buffer(4096)
def real(pid):
    return buf.value.decode("utf-8", "replace") if lib.proc_pidpath(int(pid), buf, 4096) > 0 else ""
parent, line, mine = {}, {}, set()
for l in sys.stdin:
    pid, ppid, start, exe = l.rstrip("\n").split("\t", 3)
    parent[pid], line[pid] = ppid, pid + "\t" + start + "\t" + exe
    if exe.startswith(run) and real(pid).startswith(run) and (not want or exe in want and real(pid) in want):
        mine.add(pid)
if want:
    print(*sorted(mine, key=int)[:1])
    sys.exit()
more = True
while more:
    more = False
    for p, pp in parent.items():
        if p not in mine and pp in mine:
            mine.add(p)
            more = True
for p in mine:
    print(line[p])'
ours_ps() { ps_all | awk -v uid="$(id -u)" "$PS_AWK"' u == uid { print pid "\t" ppid "\t" start "\t" exe }'; }
ours_now() { ours_ps | python3 -I -c "$OURS_PY" "$run/"; }
record() {
  ours_now >>"$run/pids" 2>/dev/null
  sort -u "$run/pids" -o "$run/pids" 2>/dev/null
}
alive_lines() { # [PID] -> the recorded processes (or the one PID) whose pid, start time and executable still match
  [ -s "$run/pids" ] || return 0
  ps_all | awk -v f="$run/pids" -v only="${1:-}" 'BEGIN { while ((getline l < f) > 0) want[l] = 1 }'"$PS_AWK"'
    (key in want) && (only == "" || pid == only) { print key }'
}
signal_ours() { # SIG -> sends SIG to every recorded process still alive; prints how many it signalled
  n=0
  for p in $(alive_lines | cut -f1); do kill "-$1" "$p" 2>/dev/null && n=$((n + 1)); done
  echo "$n"
}
wait_gone() { # seconds [PID]
  i=0
  while [ -n "$(alive_lines "${2:-}")" ]; do
    [ "$i" -lt "$(($1 * 5))" ] || return 1
    sleep 0.2
    i=$((i + 1))
  done
}

# Stops what this run started, by recorded PID, then removes the run folder (the temp home with it).
stop_run() {
  [ -n "${run:-}" ] && [ -d "$run" ] || return 0
  record
  if [ -n "${session:-}" ]; then cli session close "$session" >/dev/null 2>&1; fi
  # The window first: a running app restarts a core that stops under it.
  if [ -n "${app_pid:-}" ]; then
    for p in $(alive_lines "$app_pid" | cut -f1); do kill -TERM "$p" 2>/dev/null; done
    wait_gone 10 "$app_pid"
  fi
  record
  [ -n "${home:-}" ] && [ -S "$home/core.sock" ] && cli serve stop --yes >/dev/null 2>&1
  if ! wait_gone 10; then
    say "stop: $(signal_ours TERM) process(es) still running after serve stop; sent TERM"
    wait_gone 5 || say "stop: $(signal_ours KILL) process(es) ignored TERM; sent KILL"
    wait_gone 5 || stop_failed=1
  fi
  # What the window recorded up to its end, kept past the home's removal for the stage's last check.
  [ -z "${home:-}" ] || [ ! -f "$home/gate-active.log" ] || cp -f "$home/gate-active.log" "$out/active.log" 2>/dev/null
  # Unregister the per-run bundle from Launch Services: it is about to be deleted.
  lsreg=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  [ -n "${app:-}" ] && [ -x "$lsreg" ] && "$lsreg" -u "$app" >/dev/null 2>&1
  if [ -z "${stop_failed:-}" ]; then
    rm -rf "$run"
    [ -z "${home:-}" ] || rm -rf "$home"
  else
    say "stop: a process of this run is still alive; $run and ${home:-its home} are kept (pids in $run/pids)"
  fi
}

# --- the stage --------------------------------------------------------------------------------------------------------
ax_bin() { # the window helper, compiled once per source change (scripts/app-click/ax.swift)
  src=$root/scripts/app-click/ax.swift
  sum=$(shasum -a 256 "$src" | cut -c1-16) || fail ax "cannot read $src"
  ax=$out/ax-$sum
  if [ ! -x "$ax" ]; then
    swiftc -O "$src" -o "$ax.tmp" >&2 || fail ax "swiftc could not build $src"
    mv -f "$ax.tmp" "$ax"
  fi
}
# This bundle's CLI on this home, with nothing inherited from a Nunchiro session the gate may run in (a NUNCHIRO_TOKEN
# would make it a session's client of whichever core).
cli() { env -i HOME="$HOME" PATH="$PATH" LANG="${LANG:-en_US.UTF-8}" NUNCHIRO_HOME="$home" NUNCHIRO_KEYCHAIN= \
  NUNCHIRO_BIN="$app/Contents/MacOS/nunchiro" "$app/Contents/MacOS/nunchiro" "$@" </dev/null; }
# Empty when the screen can show a window; else why not (a locked screen, a sleeping display or a session switched
# away gives a black picture, a machine state that must never read as a blank window). Asked without a prompt.
screen_state() {
  st=$("$ax" screen 2>/dev/null) || { echo "the screen state is unknown (ax screen failed)"; return; }
  case " $st " in
    *" locked yes "*) echo "the screen is locked" ;;
    *" asleep yes "*) echo "the display is asleep" ;;
    *" console no "*) echo "this user's session is not on the console" ;;
  esac
}
# Coordinator decision (round 3): a screen that cannot show a window is a machine state, not this build. The stage
# says so loudly, logs it with the candidate sha and time in .scratch/gate-app-boot/skips.log, stops what it started
# and passes (exit 0), so a night gate still lands. A state it cannot read is exit 4 (infra), never a skip.
screen_ok() { # step
  why=$(screen_state)
  [ -n "$why" ] || return 0
  case $why in *unknown*) fail screen "$why" 4 ;; esac
  line="gate-app-boot: skipped: $why at the $1 step (a machine state; the coordinator's RC check covers this build)"
  echo "$line" >&2
  printf '%s sha=%s time=%s\n' "$line" "$(git -C "$root" rev-parse HEAD 2>/dev/null || echo unknown)" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$out/skips.log" || say "skipped: cannot append to $OUT_REL/skips.log"
  if [ -n "$run" ]; then
    trap - EXIT
    stop_run
    [ -z "$stop_failed" ] || fail stop "a process this run started did not stop"
  fi
  exit 0
}
front() { lsappinfo front 2>/dev/null; }
# lsappinfo prints `"Name" ASN:...` on the first line and `pid = N` further down.
front_name() { lsappinfo info -only name "$1" 2>/dev/null | sed -n '1s/^"\(.*\)" ASN:.*/\1/p'; }
front_pid() { lsappinfo info -only pid "$1" 2>/dev/null | sed -n 's/.*pid = \([0-9][0-9]*\).*/\1/p'; }
# The RC must never take the front; checked at every poll, so a steal that was undone by the time the stage ends is
# still caught. Two signs: the RC is the front app now, or the RC wrote $home/gate-active.log (gate_shot.rs
# `watch_active`: one line per NSApplicationDidBecomeActiveNotification, so a steal between two polls is caught and
# is told apart from the person at the machine switching apps themselves).
became_active() { # FILE
  [ -s "$1" ] || return 0
  fail frontmost "Nunchiro RC (pid ${app_pid:-?}) became the active app ($(wc -l <"$1" | tr -d ' ') time(s), \
first at $(head -n 1 "$1" | cut -d' ' -f2)); it must never take the front"
}
check_front() {
  [ -z "${home:-}" ] || became_active "$home/gate-active.log"
  now=$(front)
  if [ -n "${app_pid:-}" ] && [ -n "$now" ] && [ "$(front_pid "$now")" = "$app_pid" ]; then
    fail frontmost "Nunchiro RC (pid $app_pid) became the frontmost app; it must open without activation"
  fi
}
poll() { # step cause test... : retries the test until it passes or WAIT seconds pass
  step=$1 cause=$2
  shift 2
  i=0
  until "$@"; do
    check_front
    [ "$i" -lt "$((WAIT * 2))" ] || fail "$step" "$cause after ${WAIT}s"
    sleep 0.5
    i=$((i + 1))
  done
}

stage() {
  own_dir run
  app_src=${1:-$out/$NAME}
  [ ! -L "$app_src" ] || fail app "refused: $app_src is a symlink" 3
  [ -f "$app_src/Contents/Info.plist" ] || fail app "no app at $app_src; run scripts/gate-app-boot.sh build"
  id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_src/Contents/Info.plist" 2>/dev/null)
  [ "$id" = "$RC_ID" ] || fail app "refused: the bundle id is ${id:-missing}, not $RC_ID" 3
  case "$(printf '%s' "$app_src" | tr '[:upper:]' '[:lower:]')" in
    */applications/*) fail app "refused: $app_src is an installed app" 3 ;;
  esac
  [ -x "$app_src/Contents/MacOS/nunchiro" ] || fail app "$app_src has no CLI next to the window"
  prompt_free
  ad_hoc "$app_src"
  started=$(date +%s)

  ax_bin
  screen_ok launch

  run=$(mktemp -d "$out/r.XXXXXX") || fail home "cannot make a run folder in $OUT_REL"
  trap 'stop_run' EXIT
  trap 'exit 130' INT TERM HUP
  home=$(mktemp -d "$root/.scratch/gXXXXXX") || fail home "cannot make a temp home in .scratch"
  real=$(cd "$home" && pwd -P)
  [ ! -L "$run" ] && [ ! -L "$home" ] && [ "$real" = "$home" ] || fail home "refused: $home resolves to $real" 3
  owner_path "$home" && fail home "refused: $home is the owner's Nunchiro home" 3
  [ "${#home}" -le "$HOME_MAX" ] || fail home "$home is ${#home} bytes, over $HOME_MAX (this worktree path is \
${#root} bytes, over 60): a holder socket would not fit and the core would put it in /tmp"
  mkdir "$run/project" || fail home "cannot make $run/project"
  # A copy per run: its path is unique, so the processes running from it are this run's and nobody else's.
  app=$run/$NAME
  cp -Rc "$app_src" "$app" 2>/dev/null || cp -R "$app_src" "$app" || fail app "cannot copy the app into $run"
  exe=$app/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")

  before=$(front)
  before_name=$(front_name "$before")
  # -g: no activation; -n: a new instance, never the owner's running RC. Not -F: it deletes the saved state of the
  # bundle id, which is the owner's RC's too. The environment is this home and this bundle's CLI, nothing inherited
  # from a session (NUNCHIRO_TOKEN would make the app a client).
  # NUNCHIRO_GATE_RUN=1: an RC build then can never be the active app (activation policy Prohibited, set before its
  # event loop: no keyboard focus, no front, and so no front handed to Finder when it quits), keeps its window behind
  # the person's, keeps its pages in a WebKit store of its own, not the owner's RC's, writes its page's picture to
  # $home/gate-shot.png and records any activation in $home/gate-active.log (app/src-tauri/src/main.rs `gate_run`,
  # gate_shot.rs). NUNCHIRO_GATE_BLANK=1 (only with GATE_APP_BOOT_BLANK=1) hides the page: the red check.
  blank=0
  [ "${GATE_APP_BOOT_BLANK:-}" != 1 ] || blank=1
  # NUNCHIRO_KEYCHAIN empty: the core it starts keeps no start secrets in a keychain (no keychain prompt).
  # No NUNCHIRO_LOGIN_PATH=off, on purpose (ticket 596): the stage boots the app as Finder does, and the core reading the
  # login shell's PATH (ticket 575) is part of that boot. `open` hands the app only the --env values below, not this
  # PATH, so the caller's PATH does not change what the core sees; the machine's login shell does. No step checks an agent.
  env -i HOME="$HOME" PATH="$PATH" open -g -n --env NUNCHIRO_HOME="$home" --env NUNCHIRO_GATE_RUN=1 \
    --env NUNCHIRO_GATE_BLANK="$blank" --env NUNCHIRO_KEYCHAIN= \
    --env NUNCHIRO_BIN="$app/Contents/MacOS/nunchiro" --stdout "$run/app.log" --stderr "$run/app.log" "$app" ||
    fail launch "open could not start $app"
  app_pid=
  find_app() { # the process whose argv[0] and kernel executable path are both this copy's
    app_pid=$(ours_ps | python3 -I -c "$OURS_PY" "$run/" "$exe")
    [ -n "$app_pid" ]
  }
  poll launch "no process runs $exe" find_app
  record
  launched=$(date +%s)

  # The core: the window starts it with this home (nothing else knows the path), so a socket here proves the app
  # took the temp home; core.start.json must name this run's CLI as the core's executable, and `serve status` from
  # this bundle's CLI must answer that the core is up.
  core_up() {
    kill -0 "$app_pid" 2>/dev/null || fail launch "the app exited (log: $(tail -c 400 "$run/app.log" 2>/dev/null))"
    [ -S "$home/core.sock" ] && [ -f "$home/core.start.json" ] || return 1
    core_exe=$(python3 -I -c 'import json, os, sys; print(os.path.realpath(json.load(open(sys.argv[1]))["exe"]))' \
      "$home/core.start.json" 2>/dev/null) || return 1
    case "$core_exe" in "$run"/*) ;; *) fail core "the core on $home runs $core_exe, not this run's CLI" ;; esac
    python3 -I -c 'import json, sys; sys.exit(json.load(open(sys.argv[1])).get("env", {}).get("NUNCHIRO_KEYCHAIN") != "")' \
      "$home/core.start.json" 2>/dev/null ||
      fail core "the core on $home started without an empty NUNCHIRO_KEYCHAIN (it could ask for the keychain)"
    cli serve status 2>/dev/null | grep -q '"core":true'
  }
  poll core "no core answered on $home/core.sock" core_up
  record
  core=$(date +%s)

  # The window: found by the app's PID (ax window), and its page blank when every pixel of the page's own picture is
  # within 40 of the corner colour (ax bbox). A picture, not an AX check: the 11-11 alarm was a window with nothing
  # drawn, which is what a picture shows; the AX tree of a page can exist while nothing paints. The picture is the
  # page's WKWebView snapshot, which the gate run writes to $home/gate-shot.png every second (gate_shot.rs): what the
  # page painted, with no Screen Recording grant, so the stage passes over ssh. The traffic lights are the window's,
  # not the page's, so the whole picture is checked.
  page_shot=$home/gate-shot.png
  shot=$run/shot.png
  drawn() {
    screen_ok window
    "$ax" window "$app_pid" >/dev/null 2>&1 || return 1
    rm -f "$shot"
    cp -f "$page_shot" "$shot" 2>/dev/null && [ -s "$shot" ] || return 1
    size=$("$ax" pixel "$shot" 0 0 2>/dev/null) || return 1
    set -- $size # "#rrggbb" width height (picture pixels)
    [ "${2:-0}" -gt 0 ] && [ "${3:-0}" -gt 0 ] || return 1
    if [ "$("$ax" bbox "$shot" 0 0 "$2" "$3" 2>/dev/null)" = none ]; then
      cp -f "$shot" "$out/window-blank.png" 2>/dev/null
      return 1
    fi
    cp -f "$shot" "$out/window-last.png" 2>/dev/null
    return 0
  }
  rm -f "$out/window-blank.png" "$out/window-last.png"
  poll window "the window did not draw (blank or missing; last blank picture: $OUT_REL/window-blank.png)" drawn
  window=$(date +%s)

  # One shell session through the core: zsh without startup files (no rc file read, no history written), printing a
  # line the typed command does not contain.
  mark=gateok$$x$(date +%s)
  started_out=$(cd "$run/project" && cli session start --kind shell --project "$run/project" --label gate-app-boot \
    -- /bin/zsh -f 2>&1) || fail session "session start failed: $started_out"
  session=$(printf '%s' "$started_out" | python3 -I -c 'import json, sys
r = json.load(sys.stdin)
print(r["session"]["id"])' 2>/dev/null)
  [ -n "$session" ] || fail session "no session id in: $started_out"
  record
  # zsh drops what is typed before its line editor is up: wait for its first output, then type, and type again
  # every 5 s while the line has not come back.
  output() { cli session read "$session" 2>/dev/null | python3 -I -c 'import json, sys
d = bytes(json.load(sys.stdin)["data"])
sys.exit(0 if (d.find(sys.argv[1].encode()) >= 0 if sys.argv[1] else d) else 1)' "${1:-}"; }
  poll session "the shell printed nothing (no prompt)" output
  typed=0
  printed() {
    if [ $((typed % 10)) -eq 0 ]; then
      cli session send-text "$session" "printf '%s%s\\n' ${mark%%x*} x${mark#*x}" >/dev/null 2>&1 ||
        fail session "send-text failed"
      cli session send-keys "$session" enter >/dev/null 2>&1 || fail session "send-keys failed"
    fi
    typed=$((typed + 1))
    output "$mark"
  }
  poll session "the shell did not print $mark" printed
  shell=$(date +%s)

  check_front
  after=$(front)
  if [ "$after" != "$before" ]; then
    fail frontmost "the frontmost app changed during the stage: ${before_name:-none} before, $(front_name "$after") \
after, and the RC never was the front or active app (someone at the machine switched apps): not this build" 4
  fi
  record
  trap - EXIT
  rm -f "$out/active.log"
  stop_run
  [ -z "${stop_failed:-}" ] || fail stop "a process this run started did not stop"
  became_active "$out/active.log"
  after=$(front)
  [ "$after" = "$before" ] ||
    fail frontmost "the frontmost app changed when the RC quit: ${before_name:-none} before, $(front_name "$after") \
after, and the RC never was the front or active app (someone at the machine switched apps): not this build" 4
  say "pass: launch $((launched - started))s, core $((core - launched))s, window $((window - core))s, shell $((shell - window))s, total $(($(date +%s) - started))s"
}

clear_marker
case "${1:-}" in
  "") [ $# -eq 0 ] || fail usage "gate-app-boot.sh [build | run [APP]]" 2
    t0=$(date +%s)
    built=$(build) || exit $?
    say "build took $(($(date +%s) - t0))s"
    stage "$built" ;;
  build) [ $# -eq 1 ] || fail usage "gate-app-boot.sh build" 2
    build ;;
  run) [ $# -le 2 ] || fail usage "gate-app-boot.sh run [APP]" 2
    shift
    stage "${1:-}" ;;
  *) fail usage "gate-app-boot.sh [build | run [APP]]" 2 ;;
esac
