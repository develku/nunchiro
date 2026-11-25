#!/bin/sh
# Ticket 1130 B3 (scorecard p29 SC5): do two clean clones of main build the same web bundle, app binary and CLI?
#   repro-check.sh <folder> [<commit>]   two clones of <commit> (default origin/main) through scripts/update-clone.sh from a
#                                        local bare copy (no network), each built offline into its own target; then compares
#   repro-check.sh --compare <a> <b>     only the comparison, of two folders laid out as <folder>/a/out (the self-test uses it)
# Each clone runs: pnpm install --frozen-lockfile --offline, the web build, tauri build --bundles app with the release
# config (unsigned: no Developer ID, no notarization), cargo build --release --locked --offline -p nunchiro.
# Compared, before any signing (a signature and a notarization ticket differ by design): every file of web/dist, the
# app binary (Nunchiro.app/Contents/MacOS/nunchiro-app) and the CLI. The release build's NUNCHIRO_RELEASE stamp and
# version are left out on purpose: they name the build, so they differ from build to build by design.
# Exit: 0 the same, 1 a file differs (listed), 2 a clone or a build failed. Prints one line per compared item.
# <folder> must be new, or one this script made (it holds .repro-check-owned); the script empties only such a folder.
# Meant for a weekly run, not the gate (not wired to any job yet): the first real run (11-25, CARGO_BUILD_JOBS=2, load average 30-60) took 61 min.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MARK=.repro-check-owned
die() { echo "repro-check: $*" >&2; exit 2; }

# One line per item: "<sha256>  <path>", sorted, for every file under <side>/out. Any failed find or shasum fails the
# whole call: a manifest with a line missing on both sides would compare equal (Codex 1130 finding 2).
hashes() {
  (
    cd "$1/out" || exit 1
    files=$(find . -type f) || exit 1
    printf '%s\n' "$files" | LC_ALL=C sort | while IFS= read -r f; do shasum -a 256 "$f" || exit 1; done
  )
}

compare() {
  hashes "$1" > "$1/hashes.txt" || die "cannot hash $1/out"
  hashes "$2" > "$2/hashes.txt" || die "cannot hash $2/out"
  for item in web-dist nunchiro-app nunchiro; do
    a=$(grep "  ./$item\(/\|$\)" "$1/hashes.txt" | shasum -a 256 | cut -c1-16)
    b=$(grep "  ./$item\(/\|$\)" "$2/hashes.txt" | shasum -a 256 | cut -c1-16)
    [ "$a" = "$b" ] && echo "same $item $a" || echo "DIFFERENT $item a=$a b=$b"
  done
  if diff "$1/hashes.txt" "$2/hashes.txt" >/dev/null; then
    echo "repro-check: same build twice"
    return 0
  fi
  echo "repro-check: the builds differ in:"
  diff "$1/hashes.txt" "$2/hashes.txt" | sed -n 's/^[<>] [0-9a-f]*  /  /p' | LC_ALL=C sort -u
  return 1
}

if [ "${1:-}" = --compare ]; then
  [ $# -eq 3 ] || die "usage: repro-check.sh --compare <a> <b>"
  compare "$2" "$3"
  exit
fi
[ $# -ge 1 ] && [ $# -le 2 ] || die "usage: repro-check.sh <folder> [<commit>]"
# Trailing slashes off first: "alias/" passes -L by resolving the link, and rm -rf "alias/" empties its target.
base=$(printf '%s' "$1" | sed 's:/*$::')
case $base in ''|.|..|*/.|*/..) die "refused: unsafe folder '$1'" ;; esac
# The folder checks come before the commit lookup, so a refusal never depends on the checkout's refs.
[ ! -L "$base" ] || die "refused: $base is a link"
[ ! -e "$base" ] || [ -f "$base/$MARK" ] || die "refused: $base exists and was not made by repro-check.sh (no $MARK in it)"
commit=$(git -C "$ROOT" rev-parse --verify "${2:-origin/main}^{commit}") || die "no commit ${2:-origin/main}"
rm -rf "$base"
mkdir -p "$base"
base=$(cd "$base" && pwd -P)
echo "Made by scripts/repro-check.sh, which may empty this folder on its next run." > "$base/$MARK"

git init -q --bare "$base/main.git"
git -C "$ROOT" push -q --no-verify "$base/main.git" "$commit:refs/heads/main" || die "cannot copy $commit to $base/main.git"
# A stamped build (an RC or a release) and an inherited target would make the two clones differ for a known reason.
for v in $(env | sed -n 's/^\(NUNCHIRO_[A-Z0-9_]*\)=.*/\1/p'); do unset "$v"; done
unset CARGO_TARGET_DIR APPLE_SIGNING_IDENTITY APPLE_CERTIFICATE APPLE_ID APPLE_API_KEY APPLE_API_ISSUER TAURI_SIGNING_PRIVATE_KEY || true

for side in a b; do
  d=$base/$side
  NUNCHIRO_UPDATE_REPO=$base/main.git sh "$ROOT/scripts/update-clone.sh" "$d/src" >/dev/null || die "update-clone.sh failed for $side"
  (
    cd "$d/src"
    export CARGO_TARGET_DIR="$d/target"
    pnpm install --frozen-lockfile --offline
    pnpm --filter nunchiro-web build
    (cd app && pnpm exec tauri build --bundles app --config src-tauri/tauri.release.conf.json -- --locked --offline)
    cargo build --release --locked --offline -p nunchiro
  ) > "$d/build.log" 2>&1 || die "the build of clone $side failed; see $d/build.log"
  mkdir "$d/out"
  cp -R "$d/src/web/dist" "$d/out/web-dist"
  cp "$d/target/release/bundle/macos/Nunchiro.app/Contents/MacOS/nunchiro-app" "$d/out/nunchiro-app"
  cp "$d/target/release/nunchiro" "$d/out/nunchiro"
done
echo "commit $commit"
compare "$base/a" "$base/b"
