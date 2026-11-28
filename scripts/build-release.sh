#!/bin/sh
# Official release build of Nunchiro.app (bundle id dev.nunchiro.app): Developer ID signed, notarized, stapled, as a DMG
# (also notarized and stapled) and as the updater archive and latest.json the installed app updates itself from (app/src-tauri/src/rc_update.rs).
#   build-release.sh prerelease|release            build from a clean tree, sign, notarize, staple, verify; everything stays in
#                                                  .scratch/release/<channel>/, with the CycloneDX SBOMs (sbom-*.cdx.json,
#                                                  scripts/supply-chain.sh --sbom). Nothing is uploaded or installed.
#   build-release.sh prerelease|release --local    then also put the archive and latest.json in the local feed
#                                                  (${NUNCHIRO_HOME:-~/.nunchiro}/update), which the installed app reads
#                                                  while the repository is private
#   build-release.sh prerelease|release --publish  then also upload them, the DMG and the SBOMs to GitHub Releases of nunchiro/nunchiro (gh)
#   build-release.sh <channel> --finish [--local|--publish]
#                                                  no build: waits for the notarization already sent for the app in
#                                                  .scratch/release/<channel>/ and goes on from there. For a run that
#                                                  ended while Apple was still working (a first submission can take hours).
# Needs on this Mac: the "Developer ID Application" identity in the login keychain and the notarytool keychain profile
# "nunchiro-notary". No key, password or token is read into a variable, printed or copied.
# The CLI is built without NUNCHIRO_BUILD (that stamp marks an RC, which refuses ~/.nunchiro); NUNCHIRO_RELEASE orders
# cores instead, so the updated app's first page load replaces the older core (F24).
# No entitlement is added, as in scripts/local-signing.sh: web content runs in Apple's own processes and the app loads
# no third-party library.
set -eu
cd "$(dirname "$0")/.."
root=$(pwd -P)
REPO=nunchiro/nunchiro
APP_ID=dev.nunchiro.app
IDENTITY="Developer ID Application"
PROFILE=nunchiro-notary
ARCHIVE=Nunchiro.app.tar.gz
DMG=Nunchiro.dmg
KEY_DIR=$HOME/.config/nunchiro-release
KEY=$KEY_DIR/updater.key
die() { echo "build-release: $*" >&2; exit 1; }
usage() { die "usage: build-release.sh prerelease|release [--finish] [--local|--publish]"; }

channel=${1:-}
case "$channel" in prerelease|release) shift ;; *) usage ;; esac
finish=
after=
for arg in "$@"; do
  case "$arg" in
    --finish) finish=1 ;;
    --local|--publish) [ -z "$after" ] || usage; after=$arg ;;
    *) usage ;;
  esac
done

for d in .scratch .scratch/release; do
  if [ -L "$d" ]; then die "refused: $d is a symlink (to $(readlink "$d")); a release builds only into $root/.scratch/release"; fi
done
mkdir -p .scratch/release
out=$(cd .scratch/release && pwd -P)
[ "$out" = "$root/.scratch/release" ] || die "refused: .scratch/release resolves to $out, not $root/.scratch/release"

# The sandbox profile of the SBOM step (ticket 1130 security review). Denied: reading or writing the update key folder
# and the keychains, the keychain service, and writing anywhere in the checkout (the build output is inside it), except
# the stage folder $1 and the file cargo cyclonedx writes beside each tracked Cargo.toml. A later allow wins in SBPL.
sbom_profile() {
  keys=$(cd "$KEY_DIR" && pwd -P) || die "no $KEY_DIR"
  home=$(cd "$HOME" && pwd -P) || die "no HOME"
  for p in "$root" "$keys" "$home" "$1"; do
    case $p in *[\"\\]*) die "refused: $p has a quote or backslash, which the sandbox profile cannot hold" ;; esac
  done
  printf '(version 1)\n(allow default)\n'
  printf '(deny file-read* file-write* (subpath "%s") (subpath "%s/Library/Keychains"))\n' "$keys" "$home"
  printf '(deny mach-lookup (global-name "com.apple.SecurityServer"))\n'
  printf '(deny file-write* (subpath "%s"))\n(allow file-write* (subpath "%s"))\n' "$root" "$1"
  # A pipeline would hide a git failure (sh has no pipefail): read the inventory first and stop on failure or nothing.
  manifests=$(git ls-files Cargo.toml '*/Cargo.toml') || die "git ls-files Cargo.toml failed"
  [ -n "$manifests" ] || die "git ls-files Cargo.toml: no tracked manifest"
  printf '%s\n' "$manifests" | while read -r m; do
    d=$(dirname "$m")
    case $d in .) f=$root/supply-chain-sbom.json ;; *) f=$root/$d/supply-chain-sbom.json ;; esac
    printf '(allow file-write* (literal "%s"))\n' "$f"
  done
}

# The signer alone, as in build-rc.sh: a key in the environment would win over the file, and nothing it prints is passed on.
signer() { (cd app && env -u TAURI_SIGNING_PRIVATE_KEY -u TAURI_SIGNING_PRIVATE_KEY_PATH TAURI_SIGNING_PRIVATE_KEY_PASSWORD= pnpm exec tauri signer "$@") >/dev/null 2>&1; }

# The release update key. Every installed app trusts only this pair: a release signed with another key is refused.
[ ! -L "$KEY" ] || die "refused: $KEY is a symlink"
[ -z "$finish" ] || [ -f "$KEY" ] || die "$KEY is missing; the app waiting in .scratch/release/$channel was built with it"
if [ ! -f "$KEY" ]; then
  (umask 077 && mkdir -p "$KEY_DIR") || die "cannot make $KEY_DIR"
  (umask 077 && signer generate --ci -p "" -w "$KEY") || die "could not generate the update key"
  echo "build-release: made a new update key in $KEY_DIR. Keep a copy somewhere safe: without it no installed app can be updated." >&2
fi
chmod 600 "$KEY"
[ -f "$KEY.pub" ] || die "$KEY.pub is missing"
pub=$(cat "$KEY.pub")

case $(uname -m) in
  arm64) arch=aarch64 ;;
  x86_64) arch=x86_64 ;;
  *) die "no updater platform for $(uname -m)" ;;
esac
dest=$out/$channel
app="$dest/Nunchiro.app"

if [ -z "$finish" ]; then
  # A prerelease is <version>-pre.<UTC stamp>, strictly greater on every build and lower than the release <version>.
  base=$(python3 -I -c 'import json; print(json.load(open("app/src-tauri/tauri.conf.json"))["version"])')
  stamp=$(date -u +%Y%m%d%H%M%S)
  last=$(cat "$out/last-build" 2>/dev/null || echo 0)
  [ "$stamp" -gt "$last" ] || stamp=$((last + 1))
  echo "$stamp" > "$out/last-build"
  case "$channel" in
    prerelease) version=$base-pre.$stamp ;;
    release) version=$base ;;
  esac

  # Ticket 1107: the archive's stamp names this commit and build.rs compiles the same one into the CLI
  # (NUNCHIRO_GIT_SHA); install checks the stamp's commit on main. So the tree must be exactly that commit.
  [ -z "$(git status --porcelain)" ] || die "refused: the tree has uncommitted or untracked changes; a release is built from one commit"
  commit=$(git rev-parse HEAD)

  export CARGO_TARGET_DIR="$out/target"
  export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
  # Tauri signs and notarizes by itself when these are set; this script signs the finished bundle, with the CLI inside.
  unset NUNCHIRO_BUILD APPLE_SIGNING_IDENTITY APPLE_CERTIFICATE APPLE_ID APPLE_API_KEY APPLE_API_ISSUER || true
  pnpm install --frozen-lockfile --prefer-offline >&2
  pnpm --filter nunchiro-web build >&2
  (cd app && pnpm exec tauri build --bundles app --config src-tauri/tauri.release.conf.json --config "{\"version\":\"$version\",\"plugins\":{\"updater\":{\"pubkey\":\"$pub\"}}}") >&2
  # Ticket 1117: the repository whose main orders installs (update.rs); a build without it refuses every install.
  NUNCHIRO_RELEASE=$stamp NUNCHIRO_UPDATE_REPO=https://github.com/$REPO.git cargo build --release --locked -p nunchiro >&2

  built="$CARGO_TARGET_DIR/release/bundle/macos/Nunchiro.app"
  [ -f "$built/Contents/Info.plist" ] || die "tauri made no $built"
  id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$built/Contents/Info.plist")
  [ "$id" = "$APP_ID" ] || die "refused: the bundle id is $id, not $APP_ID"
  [ "$(git rev-parse HEAD)" = "$commit" ] && [ -z "$(git status --porcelain)" ] || die "refused: the tree changed during the build"
  rm -rf "$dest"
  mkdir "$dest"
  echo "$commit" > "$dest/commit"
  # Ticket 1130 (p29 SC4): a release carries its SBOM (CycloneDX), made from the commit just built and checked clean.
  # The tools are installed ones (cargo-cyclonedx, pnpm; nothing is fetched) and run sandboxed (sbom_profile): they
  # cannot read the update key or the keychain, nor change the built binaries. No full SBOM set, no release.
  sbom_stage=$out/sbom-$channel
  rm -rf "${sbom_stage:?}"
  mkdir "$sbom_stage"
  profile=$(sbom_profile "$sbom_stage") || exit 1
  sandbox-exec -p "$profile" sh scripts/supply-chain.sh --sbom "$sbom_stage" >&2 || die "could not make the SBOM (scripts/supply-chain.sh --sbom)"
  mv "$sbom_stage"/sbom-*.cdx.json "$dest"/ || die "could not move the SBOMs into $dest"
  rm -rf "${sbom_stage:?}"
  cp -R "$built" "$app"
  cp "$CARGO_TARGET_DIR/release/nunchiro" "$app/Contents/MacOS/nunchiro"
  # owner 11-21: a release ships its licence texts (tauri.conf.json bundle.resources puts them there); never signed without.
  for f in LICENSE THIRD_PARTY_NOTICES.md; do
    [ -s "$app/Contents/Resources/$f" ] || die "refused: $f is missing or empty in $app/Contents/Resources"
  done

  # Inside out: each executable, then the bundle. Hardened runtime and a secure timestamp are what notarization asks for.
  for exe in "$app"/Contents/MacOS/*; do
    codesign --force --options runtime --timestamp -s "$IDENTITY" "$exe" >&2 || die "codesign of $exe failed"
  done
  codesign --force --options runtime --timestamp -s "$IDENTITY" "$app" >&2 || die "codesign of $app failed"
  codesign --verify --deep --strict "$app" >&2 || die "the signed app does not verify"

  ditto -c -k --keepParent "$app" "$dest/notarize.zip"
  xcrun notarytool submit "$dest/notarize.zip" --keychain-profile "$PROFILE" > "$dest/notarize.log" 2>&1 || { cat "$dest/notarize.log" >&2; die "notarytool submit failed"; }
fi

# From here on --finish does the same: the app and the submission it waits for are the ones the build step left.
[ -f "$app/Contents/Info.plist" ] && [ -f "$dest/notarize.log" ] || die "nothing to finish in $dest: run without --finish"
# Ticket 1130: nothing is notarized, signed or published without the full SBOM set beside the app.
sh scripts/supply-chain.sh --sbom-check "$dest" >&2 || die "the SBOMs in $dest are missing or invalid: run without --finish"
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")
submission=$(sed -n 's/^ *id: //p' "$dest/notarize.log" | head -1)
[ -n "$submission" ] || die "no submission id in $dest/notarize.log"
echo "build-release: waiting for Apple on notarization $submission of $version" >&2
xcrun notarytool wait "$submission" --keychain-profile "$PROFILE" > "$dest/notarize-wait.log" 2>&1 || { cat "$dest/notarize-wait.log" >&2; die "notarytool wait failed; when Apple is done, run: build-release.sh $channel --finish"; }
tail -n 3 "$dest/notarize-wait.log" >&2
grep -q 'status: Accepted' "$dest/notarize-wait.log" || die "Apple did not accept the app; see: xcrun notarytool log $submission --keychain-profile $PROFILE"
rm -f "$dest/notarize.zip"
xcrun stapler staple "$app" >&2 || die "stapler failed"
spctl -a -vv "$app" >&2 || die "Gatekeeper (spctl) does not accept the app"
codesign --verify --deep --strict "$app" >&2 || die "the stapled app does not verify"

# Ticket 1107: the build stamp (update.rs parse_stamp) rides inside the signed archive beside the app, so the minisign
# signature covers it; the app installs the archive through its CLI (update install --archive), which checks every
# executable against it. Hashed after stapling: these are the bytes that ship.
commit=$(cat "$dest/commit" 2>/dev/null) || die "no $dest/commit: run without --finish"
python3 -I - "$app/Contents/MacOS" "$commit" > "$dest/nunchiro-build.json" <<'EOF' || die "could not write the build stamp"
import datetime, hashlib, json, os, re, sys
macos, commit = sys.argv[1:]
if not re.fullmatch("[0-9a-f]{40}", commit):
    sys.exit("bad commit " + commit)
sha = {}
for name in sorted(os.listdir(macos)):
    with open(os.path.join(macos, name), "rb") as f:
        sha[name] = hashlib.sha256(f.read()).hexdigest()
built = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
print(json.dumps({"commit": commit, "built": built, "sha256": sha}))
EOF

# The archive is made here, from the stapled app: Tauri's own artifact has no CLI inside and no Developer ID signature.
COPYFILE_DISABLE=1 tar --no-mac-metadata -C "$dest" -czf "$dest/$ARCHIVE" Nunchiro.app nunchiro-build.json
signer sign -f "$KEY" -p "" --app-version "$version" "$dest/$ARCHIVE" || die "could not sign the archive"
tag=v$version
printf '{\n  "version": "%s",\n  "pub_date": "%s",\n  "platforms": {\n    "darwin-%s": {\n      "signature": "%s",\n      "url": "https://github.com/%s/releases/download/%s/%s"\n    }\n  }\n}\n' \
  "$version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$arch" "$(cat "$dest/$ARCHIVE.sig")" "$REPO" "$tag" "$ARCHIVE" > "$dest/latest.json"
# Ticket 1130 (p02): the DMG a person downloads, made from the stapled app with an Applications link to drag it to.
# Apple checks the DMG on its own, so it is signed, notarized and stapled too; ditto keeps the app's signature.
stage=$dest/dmg
rm -rf "${stage:?}" "${dest:?}/${DMG:?}"
mkdir "$stage"
ditto "$app" "$stage/Nunchiro.app"
ln -s /Applications "$stage/Applications"
hdiutil create -volname Nunchiro -srcfolder "$stage" -format UDZO -ov "$dest/$DMG" >&2 || die "hdiutil could not make $DMG"
rm -rf "${stage:?}"
codesign --force --timestamp -s "$IDENTITY" "$dest/$DMG" >&2 || die "codesign of $DMG failed"
xcrun notarytool submit "$dest/$DMG" --keychain-profile "$PROFILE" --wait > "$dest/notarize-dmg.log" 2>&1 ||
  { cat "$dest/notarize-dmg.log" >&2; die "notarization of $DMG failed; when Apple is reachable, run: build-release.sh $channel --finish"; }
grep -q 'status: Accepted' "$dest/notarize-dmg.log" || { cat "$dest/notarize-dmg.log" >&2; die "Apple did not accept $DMG"; }
xcrun stapler staple "$dest/$DMG" >&2 || die "stapler failed on $DMG"
spctl -a -t open --context context:primary-signature -vv "$dest/$DMG" >&2 || die "Gatekeeper (spctl) does not accept $DMG"
echo "build-release: $version is notarized and stapled; the app, $DMG, $ARCHIVE and latest.json are in $dest" >&2

case "$after" in
  --local)
    # The manifest last: until it moves, a check still sees the previous complete feed.
    feed=${NUNCHIRO_HOME:-$HOME/.nunchiro}/update
    mkdir -p "$feed"
    cp "$dest/$ARCHIVE" "$feed/.$ARCHIVE" && mv -f "$feed/.$ARCHIVE" "$feed/$ARCHIVE"
    cp "$dest/latest.json" "$feed/.latest.json" && mv -f "$feed/.latest.json" "$feed/latest.json"
    echo "build-release: $version is in the local feed $feed" >&2
    ;;
  --publish)
    # A release is GitHub's "latest", where the release feed reads latest.json. The prerelease feed is the latest.json
    # of the fixed tag "prerelease"; a release goes there too, so prerelease builds move on to it.
    # The tag is put on the commit that was built; gh refuses a commit GitHub does not have.
    built_from=$(git rev-parse HEAD)
    if [ "$channel" = release ]; then
      gh release create "$tag" --repo "$REPO" --target "$built_from" --title "Nunchiro $version" --generate-notes --latest "$dest/$DMG" "$dest/$ARCHIVE" "$dest/latest.json" "$dest"/sbom-*.cdx.json >&2
    else
      gh release create "$tag" --repo "$REPO" --target "$built_from" --title "Nunchiro $version" --generate-notes --prerelease "$dest/$DMG" "$dest/$ARCHIVE" "$dest"/sbom-*.cdx.json >&2
    fi
    gh release view prerelease --repo "$REPO" >/dev/null 2>&1 ||
      gh release create prerelease --repo "$REPO" --prerelease --title "Prerelease feed" --notes "latest.json here is the update feed of prerelease builds." >&2
    gh release upload prerelease --repo "$REPO" --clobber "$dest/latest.json" >&2
    echo "build-release: published $tag to $REPO" >&2
    ;;
esac
echo "$app"
echo "$dest/latest.json"
