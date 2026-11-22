#!/bin/sh
# Tests for scripts/local-signing.sh (needs 213, ticket 295). No real keychain, key or signature is touched: each case puts
# stub `security`, `codesign` and `openssl` first on PATH, uses a throwaway HOME and TMPDIR under .scratch/, and reads the
# stubs' call log. The stubs share one idea: `security find-identity` lists the identity only after a stub import (or when
# the case says it is already there).
# Usage: scripts/test-local-signing.sh [case ...]   (no case: all). Prints `ok <case>` / `FAIL <case>: why`; exit 1 on a FAIL.
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
script=$root/scripts/local-signing.sh
mkdir -p "$root/.scratch"
fails=0
ID="Nunchiro Local Code Signing"

fail() { echo "FAIL $case: $*"; fails=$((fails + 1)); }

mk() { # fresh sandbox $t: stubs in $t/bin, call log $log, HOME $t/h, TMPDIR $t/tmp, an app bundle $t/App.app
  t=$(mktemp -d "$root/.scratch/local-signing-XXXXXX")
  mkdir -p "$t/bin" "$t/h/Library/Keychains" "$t/tmp" "$t/state" "$t/App.app/Contents"
  : > "$t/App.app/Contents/Info.plist"
  log=$t/calls.log; : > "$log"
  cat > "$t/bin/security" <<'EOF'
#!/bin/sh
echo "security $*" >> "$STUB_LOG"
case "$1" in
find-identity)
  [ -n "${STUB_FIND_EXIT:-}" ] && exit "$STUB_FIND_EXIT"
  echo "Policy: Code Signing"
  if [ -n "${STUB_LISTED:-}" ] || [ -f "$STUB_STATE/imported" ]; then
    echo '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Nunchiro Local Code Signing" (CSSMERR_TP_NOT_TRUSTED)'
  fi
  echo "     1 identities found" ;;
import)
  [ -f "$2" ] && echo "import-file-present $(basename "$2")" >> "$STUB_LOG"
  touch "$STUB_STATE/imported" ;;
esac
exit 0
EOF
  cat > "$t/bin/codesign" <<'EOF'
#!/bin/sh
echo "codesign $*" >> "$STUB_LOG"
exit "${STUB_CODESIGN_EXIT:-0}"
EOF
  # openssl stub: writes a placeholder at every -keyout/-out path so the script has real temp files to clean up
  cat > "$t/bin/openssl" <<'EOF'
#!/bin/sh
echo "openssl $*" >> "$STUB_LOG"
[ "$1" = rand ] && { echo deadbeefdeadbeefdeadbeefdeadbeef; exit 0; }
prev=
for a in "$@"; do
  case "$prev" in -keyout|-out) echo "stub key material" > "$a" ;; esac
  prev=$a
done
exit "${STUB_OPENSSL_EXIT:-0}"
EOF
  chmod +x "$t/bin/security" "$t/bin/codesign" "$t/bin/openssl"
}

run() { # run the script in the sandbox; output to $t/out, exit code to $rc
  env PATH="$t/bin:/usr/bin:/bin" HOME="$t/h" TMPDIR="$t/tmp" STUB_LOG="$log" STUB_STATE="$t/state" "$@" > "$t/out" 2>&1
  rc=$?
}

done_case() { rm -rf "$t"; }

install_signs_with_local_identity_when_present() {
  mk
  run STUB_LISTED=1 sh "$script" sign "$t/App.app"
  [ $rc -eq 0 ] || fail "exit $rc: $(cat "$t/out")"
  grep -qF "codesign --force --deep --options runtime -s $ID $t/App.app" "$log" || fail "codesign not called with the identity: $(cat "$log")"
  grep -q 'codesign .* -s - ' "$log" && fail "also signed ad hoc"
  grep -qF "$ID" "$t/out" || fail "output does not say which identity signed: $(cat "$t/out")"
  done_case
}

install_signs_ad_hoc_without_identity() {
  mk
  run sh "$script" sign "$t/App.app"
  [ $rc -eq 0 ] || fail "exit $rc: $(cat "$t/out")"
  grep -qF "codesign --force --deep --options runtime -s - $t/App.app" "$log" || fail "codesign not called ad hoc: $(cat "$log")"
  grep -qi 'ad hoc' "$t/out" || fail "output does not say it signed ad hoc: $(cat "$t/out")"
  done_case
}

install_fails_when_identity_signing_fails() {
  mk
  run STUB_LISTED=1 STUB_CODESIGN_EXIT=1 sh "$script" sign "$t/App.app"
  [ $rc -ne 0 ] || fail "exit 0 although codesign failed with the identity present"
  grep -q 'codesign .* -s - ' "$log" && fail "fell back to ad hoc after the identity failed"
  grep -qi 'ad hoc' "$t/out" && fail "claims ad hoc signing: $(cat "$t/out")"
  done_case
}

install_fails_when_identity_lookup_fails() {
  mk
  run STUB_FIND_EXIT=1 sh "$script" sign "$t/App.app"
  [ $rc -ne 0 ] || fail "exit 0 although security find-identity failed"
  grep -q '^codesign' "$log" && fail "signed although the identity lookup failed: $(cat "$log")"
  done_case
}

sign_rejects_a_missing_app_folder() {
  mk
  run STUB_LISTED=1 sh "$script" sign "$t/Missing.app"
  [ $rc -ne 0 ] || fail "exit 0 for a missing app folder"
  grep -q '^codesign' "$log" && fail "codesign ran for a missing app folder"
  run sh "$script" sign
  [ $rc -ne 0 ] || fail "exit 0 without an app argument"
  done_case
}

create_script_idempotent_and_leaves_no_key_file() {
  mk
  run sh "$script" create
  [ $rc -eq 0 ] || fail "first create exit $rc: $(cat "$t/out")"
  [ "$(grep -c '^security import' "$log")" -eq 2 ] || fail "expected two imports (key, certificate): $(cat "$log")"
  grep -q '^import-file-present' "$log" || fail "stub import never saw a file, so the cleanup check below proves nothing"
  grep -qE -- 'security import .*k\.pem .*-x( |$)' "$log" || fail "key not imported non-exportable (-x)"
  grep -qE -- 'security import .*k\.pem .*-T /usr/bin/codesign' "$log" || fail "key import not scoped to codesign (-T)"
  grep -q 'add-trusted-cert\|trust-settings\|set-key-partition-list' "$log" && fail "touched trust settings: $(cat "$log")"
  [ -z "$(ls -A "$t/tmp")" ] || fail "key material left behind: $(ls -A "$t/tmp")"
  run sh "$script" create
  [ $rc -eq 0 ] || fail "second create exit $rc: $(cat "$t/out")"
  [ "$(grep -c '^security import' "$log")" -eq 2 ] || fail "second create imported again: $(cat "$log")"
  [ "$(grep -c '^openssl req' "$log")" -eq 1 ] || fail "second create made another key"
  [ -z "$(ls -A "$t/tmp")" ] || fail "key material left behind after second run: $(ls -A "$t/tmp")"
  grep -rqF 'stub key material' "$t/out" && fail "key material printed"
  grep -qE 'pass:|-P [0-9a-f]{32}' "$t/out" && fail "passphrase printed"
  done_case
}

create_passes_no_password_argv() {
  mk
  run sh "$script" create
  [ $rc -eq 0 ] || fail "create exit $rc: $(cat "$t/out")"
  grep -q '^security import' "$log" || fail "no import ran, so the argv check proves nothing"
  # no p12, no password: key and certificate go in as PEM, and nothing in any argv carries a secret
  grep -qE -- ' -P( |$)|pass:|-passout|-passin|pkcs12|-legacy|^openssl rand' "$log" && fail "password or p12 on a command line: $(grep -E -- ' -P( |$)|pass:|-passout|-passin|pkcs12|-legacy|^openssl rand' "$log")"
  grep -qE 'security import .*id\.p12' "$log" && fail "imported a p12"
  done_case
}

sign_refuses_non_bundle() {
  mk
  mkdir "$t/plain"
  run STUB_LISTED=1 sh "$script" sign "$t/plain"
  [ $rc -ne 0 ] || fail "exit 0 for a folder without Contents/Info.plist"
  grep -q 'Info.plist' "$t/out" || fail "message does not name Contents/Info.plist: $(cat "$t/out")"
  grep -q '^codesign' "$log" && fail "codesign ran on a non-bundle"
  done_case
}

create_cleans_up_when_a_step_fails() {
  mk
  run STUB_OPENSSL_EXIT=1 sh "$script" create
  [ $rc -ne 0 ] || fail "exit 0 although openssl failed"
  [ -z "$(ls -A "$t/tmp")" ] || fail "key material left behind after a failure: $(ls -A "$t/tmp")"
  grep -q '^security import' "$log" && fail "imported after openssl failed"
  done_case
}

all="install_signs_with_local_identity_when_present install_signs_ad_hoc_without_identity install_fails_when_identity_signing_fails install_fails_when_identity_lookup_fails sign_rejects_a_missing_app_folder create_script_idempotent_and_leaves_no_key_file create_passes_no_password_argv sign_refuses_non_bundle create_cleans_up_when_a_step_fails"
if [ $# -gt 0 ]; then list=$*; else list=$all; fi
for case in $list; do
  before=$fails
  "$case"
  [ $fails -eq $before ] && echo "ok $case"
done
[ $fails -eq 0 ]
