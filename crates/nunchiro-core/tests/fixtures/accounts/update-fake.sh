#!/bin/sh
# Ticket 358: a fake agent (and fake npm) for the update tests. `--version` prints $HOME/fake-version-<name>, else
# $HOME/fake-version; an update's arguments are logged, then $HOME/fake-mode says what it does. No real installer runs.
# Ticket 474: `--version` first sleeps the seconds $HOME/fake-cold holds, once (the file goes), as a new binary's first
# run on macOS does; with $HOME/fake-version-hangs it never answers.
version="$HOME/fake-version-$(basename "$0")"
[ -e "$version" ] || version="$HOME/fake-version"
case "$1" in
  --version)
    [ -e "$HOME/fake-version-hangs" ] && exec sleep 120
    if [ -e "$HOME/fake-cold" ]; then
      cold=$(cat "$HOME/fake-cold")
      rm -f "$HOME/fake-cold"
      sleep "$cold"
    fi
    cat "$version"
    exit 0
    ;;
  auth) echo '{"loggedIn": true}'; exit 0 ;;
  login) echo 'Logged in using ChatGPT' >&2; exit 0 ;;
  update|install|i) ;;
  *) exit 0 ;;
esac
printf '%s %s\n' "$(basename "$0")" "$*" >> "$HOME/update.log"
case "$(cat "$HOME/fake-mode" 2>/dev/null)" in
  fail)
    echo 'could not reach the update server' >&2
    exit 3
    ;;
  new-binary)
    # A real update replaces the file; its next `--version` is that new file's first run.
    real=$(readlink "$0" || echo "$0")
    cp "$real" "$real.new" && mv "$real.new" "$real"
    cat "$HOME/fake-next-version" > "$version"
    cat "$HOME/fake-cold-after" > "$HOME/fake-cold"
    echo 'updated'
    exit 0
    ;;
  same)
    echo 'already up to date'
    exit 0
    ;;
  hang)
    sleep 120 &
    echo "$!" > "$HOME/child.pid"
    echo "$$" > "$HOME/leader.pid"
    echo 'waiting on the download'
    wait
    ;;
  *)
    steps="1 2 3 4 5 6"
    [ "$(cat "$HOME/fake-mode" 2>/dev/null)" = slow ] && steps="$steps 7 8 9 10 11 12 13 14 15 16"
    for step in $steps; do
      echo "downloading part $step"
      sleep 0.5
    done
    cat "$HOME/fake-next-version" > "$version"
    ;;
esac
