#!/bin/sh
# CI web stage: the Playwright core set (web/tests/core-set.txt) on Chromium, as `scripts/web-smoke.sh --core` runs it in
# the owner's gate (same --grep, workers and retries). web-smoke.sh is not in the public export: it also reads the gate
# quarantine, the area spec picker and origin/main, which stay private. Run from the repository root.
# shortcut: no quarantine list, a quarantined web test runs here; add one if a flaky test blocks the queue.
set -eu
esc() { printf '%s' "$1" | sed 's/[][(){}+*?^$|.\\]/\\&/g'; }
grep_re=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  f=${line%% | *}; re=""; [ "$f" = "$line" ] || re=${line#* | }
  [ -f "web/tests/$f" ] || { echo "web-core: core-set.txt names '$f', which is not a file in web/tests" >&2; exit 2; }
  if [ -z "$re" ]; then alt="(^| )$(esc "$f")( |\$)"; else alt="(^| )$(esc "$f") .*($re)"; fi
  grep_re="${grep_re:+$grep_re|}$alt"
done < web/tests/core-set.txt
[ -n "$grep_re" ] || { echo "web-core: web/tests/core-set.txt lists nothing" >&2; exit 2; }
cd web
exec pnpm exec playwright test --project=chromium --workers="${WEB_CORE_WORKERS:-2}" --retries=1 --grep "$grep_re" "$@"
