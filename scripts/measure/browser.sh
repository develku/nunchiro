#!/bin/sh
# Browser table: Nunchiro's browser vs ego lite (V2.5-20 / WP5). Needs the release builds (scripts/measure/build.sh)
# and ego lite installed. Extra arguments go to browser.py (--runs N, --only nunchiro|ego, --out DIR).
set -eu
cd "$(dirname "$0")/../.."
APP="${NUNCHIRO_APP:-$(ls target/release/nunchiro-app app/src-tauri/target/release/nunchiro-app 2>/dev/null | head -1)}"
[ -n "$APP" ] || { echo "no release app: run scripts/measure/build.sh or set NUNCHIRO_APP" >&2; exit 2; }
exec python3 -B scripts/measure/browser.py --app "$APP" --cli "${NUNCHIRO_CLI:-target/release/nunchiro}" "$@"
