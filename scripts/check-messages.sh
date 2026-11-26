#!/bin/sh
# Refuses private work words in what a pull request publishes for good: its title, its body and every commit message.
# Three kinds: a ticket number, a personal path (/Users/<name>, /Volumes/<name>, /home/<name>) and an owner-decision
# date. Work records are kept outside this repository, so a pull request says what changes and why in words that
# stand alone.
# Usage: scripts/check-messages.sh FILE...   check text files (a draft, the tests)
#        scripts/check-messages.sh --pr N    read pull request N live with gh (CI: GH_TOKEN and GH_REPO); after fixing
#                                            a title or body, `gh run rerun --failed` reads it again
# Exit 0 clean; 1 with one line per hit on stderr; 2 on bad usage or when the pull request cannot be read.
set -eu
WORDS='tickets?[ #-]*[0-9]|/(Users|Volumes|home)/[[:alnum:]._-]|owner[^.]{0,24}[^[:alnum:]][0-9]{1,2}-[0-9]{2}([^[:alnum:]]|$)'
[ $# -ge 1 ] || { echo "usage: $0 FILE... | --pr N" >&2; exit 2; }
if [ "$1" = --pr ]; then
  n=${2:?--pr needs a number}
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/check-messages.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  gh api "repos/{owner}/{repo}/pulls/$n" --jq '.title, (.body // "")' >"$tmp/title-and-body" ||
    { echo "check-messages: cannot read pull request $n" >&2; exit 2; }
  gh api --paginate "repos/{owner}/{repo}/pulls/$n/commits" --jq '.[] | "commit \(.sha[0:9]): \(.commit.message)"' \
    >"$tmp/commit-messages" || { echo "check-messages: cannot read the commits of pull request $n" >&2; exit 2; }
  cd "$tmp"
  set -- title-and-body commit-messages
fi
status=0
for f; do
  [ -f "$f" ] || { echo "check-messages: no such file: $f" >&2; exit 2; }
  if hits=$(grep -inE "$WORDS" "$f"); then
    printf '%s\n' "$hits" | sed "s|^|check-messages: $f:|" >&2
    status=1
  fi
done
[ $status -eq 0 ] || echo "check-messages: a ticket number, a personal path or an owner-decision date; say it in words that stand alone" >&2
exit $status
