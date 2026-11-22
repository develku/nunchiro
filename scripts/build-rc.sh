#!/bin/sh
# Release-candidate build that runs next to the owner's own Nunchiro.app (V2.5-34, owner 2026-11-05, safety-cost ledger P3).
# app/src-tauri/tauri.rc.conf.json gives it bundle id dev.nunchiro.app.rc and the name "Nunchiro RC": WebKit storage is
# ~/Library/WebKit/dev.nunchiro.app.rc, the core home ~/.nunchiro-dev.nunchiro.app.rc (main.rs `home_for`).
# Builds into .scratch/rc/ only, with a cargo target of its own there (no binary compiled with the owner's identity is
# reused), and prints the app path. It never installs: (~)/Applications is the owner's.
#   build-rc.sh            builds .scratch/rc/Nunchiro RC.app, the app you start
#   build-rc.sh --publish  G2: leaves that app alone (it may be running) and puts a newer signed build in
#                          .scratch/rc/update/; the running RC offers it in its status bar (app/src-tauri/src/rc_update.rs)
set -eu
cd "$(dirname "$0")/.."
root=$(pwd -P)
RC_ID=dev.nunchiro.app.rc
RC_CONF=app/src-tauri/tauri.rc.conf.json
KEY_DIR=$HOME/.config/nunchiro-rc
KEY=$KEY_DIR/updater.key
die() { echo "build-rc: $*" >&2; exit 1; }

publish=
case "$*" in
  "") ;;
  --publish) publish=1 ;;
  *) die "usage: build-rc.sh [--publish]" ;;
esac

# Refused before anything is made: a link here could lead to (~)/Applications, where the owner's Nunchiro.app lives.
for d in .scratch .scratch/rc .scratch/rc/update .scratch/rc/publish; do
  if [ -L "$d" ]; then die "refused: $d is a symlink (to $(readlink "$d")); the RC builds only into $root/.scratch/rc"; fi
done
mkdir -p .scratch/rc
out=$(cd .scratch/rc && pwd -P)
[ "$out" = "$root/.scratch/rc" ] || die "refused: .scratch/rc resolves to $out, not $root/.scratch/rc"

# The signer alone: a key in the environment would win over the file, and nothing it prints is passed on.
signer() { (cd app && env -u TAURI_SIGNING_PRIVATE_KEY -u TAURI_SIGNING_PRIVATE_KEY_PATH TAURI_SIGNING_PRIVATE_KEY_PASSWORD= pnpm exec tauri signer "$@") >/dev/null 2>&1; }

# Every build needs this, not only a publish: the build being updated carries the public key it will trust.
# That key goes in through the --config overlay below, from this machine's own pair; no key is committed.
[ ! -L "$KEY" ] || die "refused: $KEY is a symlink"
if [ ! -f "$KEY" ]; then
  (umask 077 && mkdir -p "$KEY_DIR") || die "cannot make $KEY_DIR"
  (umask 077 && signer generate --ci -p "" -w "$KEY") || die "could not generate the update key"
fi
chmod 600 "$KEY"
[ -f "$KEY.pub" ] || die "$KEY.pub is missing; move $KEY away and build again to make a new pair"
pub=$(cat "$KEY.pub")

# Strictly greater on every build: the updater compares semver, and numeric prerelease fields compare as numbers.
base=$(python3 -I -c 'import json; print(json.load(open("app/src-tauri/tauri.conf.json"))["version"])')
stamp=$(date -u +%Y%m%d%H%M%S)
last=$(cat "$out/last-build" 2>/dev/null || echo 0)
[ "$stamp" -gt "$last" ] || stamp=$((last + 1))
echo "$stamp" > "$out/last-build"
version=$base-rc.$stamp

export CARGO_TARGET_DIR="$out/target"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
pnpm --filter nunchiro-web build >&2
(cd app && pnpm exec tauri build --bundles app --config src-tauri/tauri.rc.conf.json --config "{\"version\":\"$version\",\"plugins\":{\"updater\":{\"pubkey\":\"$pub\"}}}") >&2
# F24: the core records this stamp; `nunchiro serve update` replaces a core with a lower one.
NUNCHIRO_BUILD=$stamp cargo build --release --locked -p nunchiro >&2

built="$CARGO_TARGET_DIR/release/bundle/macos/Nunchiro RC.app"
[ -f "$built/Contents/Info.plist" ] || die "tauri made no $built"
id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$built/Contents/Info.plist")
[ "$id" = "$RC_ID" ] || die "refused: the bundle id is $id, not $RC_ID"
# A publish must not touch .scratch/rc/Nunchiro RC.app: that is the build about to be updated.
dest=$out
if [ -n "$publish" ]; then
  dest=$out/publish
  rm -rf "$dest"
  mkdir "$dest"
fi
app="$dest/Nunchiro RC.app"
rm -rf "$app"
cp -R "$built" "$app"
# The window prefers the CLI next to it; one found on PATH would be the owner's install.
cp "$CARGO_TARGET_DIR/release/nunchiro" "$app/Contents/MacOS/nunchiro"
scripts/local-signing.sh sign "$app" >&2
if [ -z "$publish" ]; then
  echo "$app"
  exit 0
fi

# The archive is made here, from the final app: Tauri's own artifact has no CLI inside and the wrong code signature.
update=$out/update
mkdir -p "$update"
case $(uname -m) in
  arm64) arch=aarch64 ;;
  x86_64) arch=x86_64 ;;
  *) die "no updater platform for $(uname -m)" ;;
esac
tmp=$update/.incoming
rm -rf "$tmp"
mkdir "$tmp"
COPYFILE_DISABLE=1 tar --no-mac-metadata -C "$dest" -czf "$tmp/Nunchiro-RC.app.tar.gz" "Nunchiro RC.app"
signer sign -f "$KEY" -p "" --app-version "$version" "$tmp/Nunchiro-RC.app.tar.gz" || die "could not sign the archive"
# Port 0 is a placeholder: the running RC serves this file and puts in the port it bound (rc_update.rs `answer`).
printf '{\n  "version": "%s",\n  "pub_date": "%s",\n  "platforms": {\n    "darwin-%s": {\n      "signature": "%s",\n      "url": "http://127.0.0.1:0/Nunchiro-RC.app.tar.gz"\n    }\n  }\n}\n' \
  "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$arch" "$(cat "$tmp/Nunchiro-RC.app.tar.gz.sig")" > "$tmp/latest.json"
# The manifest last: until it moves, a check still sees the previous complete publish.
mv -f "$tmp/Nunchiro-RC.app.tar.gz" "$tmp/Nunchiro-RC.app.tar.gz.sig" "$update/"
mv -f "$tmp/latest.json" "$update/latest.json"
rm -rf "$tmp" "$dest"
echo "build-rc: published $version" >&2
echo "$update/latest.json"
