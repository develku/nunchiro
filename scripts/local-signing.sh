#!/bin/sh
# Local code signing for the Nunchiro app (needs 213, ticket 295; docs/first-run.md "Signing identity").
#   local-signing.sh create        once per Mac: self-signed code-signing identity in the login keychain (skips if listed)
#   local-signing.sh sign <app>    sign the bundle with the identity; ad hoc (and says so) when it is not listed
# A stable identity keeps the app's designated requirement the same across installs, so the macOS Files and Folders grant
# (Removable Volumes) survives a reinstall. Nothing is uploaded or notarized.
set -eu

# Fixed on purpose: never taken from input (it is also what the designated requirement and the doc name).
ID="Nunchiro Local Code Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

die() { echo "local-signing: $*" >&2; exit 1; }

# 0 when the identity is listed. A failing lookup stops the script: guessing "absent" would sign ad hoc by mistake.
# `find-identity` without -v also lists untrusted identities, which is what this self-signed one is (expected).
listed() {
  out=$(security find-identity -p codesigning) || die "'security find-identity' failed; not guessing"
  printf '%s\n' "$out" | grep -qF "\"$ID\""
}

create() {
  if listed; then
    echo "local-signing: \"$ID\" is already in the keychain; nothing to do"
    return 0
  fi
  # Key material lives only in this 0700 folder, removed on every exit path (error, Ctrl-C, hangup), never printed.
  umask 077
  # Explicit template: macOS mktemp -d alone ignores TMPDIR.
  d=$(mktemp -d "${TMPDIR:-/tmp}/nunchiro-signing.XXXXXX") || die "cannot make a temp folder"
  trap 'rm -rf "$d"' EXIT
  trap 'exit 1' HUP INT TERM
  # Scoped to code signing only: no CA, signature-only key usage, and no trust-settings change anywhere below.
  printf '%s\n' '[req]' 'distinguished_name=dn' 'x509_extensions=ext' 'prompt=no' '[dn]' "CN=$ID" '[ext]' \
    'basicConstraints=critical,CA:false' 'keyUsage=critical,digitalSignature' 'extendedKeyUsage=critical,codeSigning' > "$d/c.cnf"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$d/k.pem" -out "$d/c.pem" -days 3650 -config "$d/c.cnf" 2>/dev/null || die "openssl could not make the key"
  # PEM straight into the keychain: no p12, so no password exists to leak on a command line (`ps`). No -f on purpose: the
  # importer detects the PKCS#8 PEM key that OpenSSL 3 and LibreSSL both write; `-f openssl` and `-f pkcs8` refuse it.
  # -x: the private key cannot be exported again. -T: codesign may use it without a prompt (trade-off in first-run.md).
  # The keychain pairs the key with the certificate it matches, which makes the identity.
  security import "$d/k.pem" -k "$KEYCHAIN" -t priv -x -T /usr/bin/codesign >/dev/null || die "security import of the key failed"
  security import "$d/c.pem" -k "$KEYCHAIN" >/dev/null || die "security import of the certificate failed"
  listed || die "imported, but \"$ID\" is not listed; see 'security find-identity -p codesigning'"
  echo "local-signing: created \"$ID\" in the login keychain"
}

# Ticket 1009 round 5: --options runtime (hardened runtime) on every signature, so DYLD_INSERT_LIBRARIES and a debugger
# cannot run code inside the binary the start-secrets keychain item trusts; the core keeps no item without it. No
# entitlement is added: the WebKit content runs in Apple's own processes, and the app loads no third-party library.
sign() {
  [ $# -eq 1 ] || die "usage: local-signing.sh sign <app>"
  app=$1
  [ -d "$app" ] || die "not an app folder: $app"
  # A wrong path must not sign some other folder with the Nunchiro identity.
  [ -f "$app/Contents/Info.plist" ] || die "not an app bundle (no Contents/Info.plist): $app"
  case "$app" in -*) app=./$app ;; esac
  if listed; then
    # Identity present: a codesign failure stops the install; it never falls back to ad hoc or to unsigned.
    codesign --force --deep --options runtime -s "$ID" "$app" || die "codesign with \"$ID\" failed; the install must not continue unsigned"
    echo "local-signing: signed $app with \"$ID\""
  else
    codesign --force --deep --options runtime -s - "$app" || die "ad hoc codesign failed"
    echo "local-signing: signed $app ad hoc (\"$ID\" is not in the keychain; run 'scripts/local-signing.sh create' once to keep macOS permissions across installs)"
  fi
}

case "${1:-}" in
  create) [ $# -eq 1 ] || die "usage: local-signing.sh create"; create ;;
  sign) shift; sign "$@" ;;
  *) die "usage: local-signing.sh create | sign <app>" ;;
esac
