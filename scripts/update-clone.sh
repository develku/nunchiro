#!/bin/sh
# Ticket 1082 part B, round 2 (option 0): a fresh clone of main for the build that goes into the update folder, with no
# system or user git config and no hooks (an existing checkout and ~/.gitconfig may have been changed, and git runs
# programs they name, such as core.fsmonitor, during ordinary commands). Clone into a new folder no seat is told to use.
#   update-clone.sh <new folder>     prints the commit it checked out
# Env: NUNCHIRO_UPDATE_REPO, the repository (default: the GitHub one the app's releases come from).
set -eu
REPO=${NUNCHIRO_UPDATE_REPO:-https://github.com/nunchiro/nunchiro.git}

die() { echo "update-clone: $*" >&2; exit 1; }

# /usr/bin/git with nothing from the caller's environment: an empty HOME, no system or global config, no hooks, no prompt.
# The GitHub sign-in comes from the fixed osxkeychain helper, not from a configured one.
git_clean() {
  h=$1
  shift
  env -i PATH=/usr/bin:/bin HOME="$h" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
    /usr/bin/git -c core.hooksPath=/dev/null -c credential.helper=osxkeychain "$@"
}

clone() {
  [ $# -eq 1 ] || die "usage: update-clone.sh <new folder>"
  [ ! -e "$1" ] && [ ! -L "$1" ] || die "refused: $1 exists; clone into a new folder"
  h=$(mktemp -d "${TMPDIR:-/tmp}/nunchiro-clone-home.XXXXXX") || die "cannot make a temp folder"
  trap 'rm -rf "$h"' EXIT
  git_clean "$h" clone -q --no-tags --single-branch --branch main "$REPO" "$1" || die "cannot clone main from $REPO"
  git_clean "$h" -C "$1" rev-parse HEAD
}

clone "$@"
