#!/bin/sh
# Ticket v1b-12: the chat diff card's Accept/Reject answer a real Claude edit's pending permission through the
# decision queue (rows accept, reject, finished), driven in the window by web/tests/chat-diff-card.real.spec.ts.
# Real Haiku through the ticket-01 guard (lib.py snapshot/guard_check around the whole run). RUNS=5 per row by
# default. The scratch project sits under this checkout's .scratch, as in queue.real.spec.ts, so Claude shows no
# folder-trust dialog; the scenario never answers one.
set -eu
cd "$(dirname "$0")/../.."
unset CARGO_TARGET_DIR
cargo build -j 2 -p nunchiro
# Codex row: Nunchiro starts Codex with no -a/-s flags (crates/nunchiro-core/src/sessions.rs, AgentKind::Codex),
# so the user's own approval policy applies; with on-request + workspace-write an apply_patch inside the project
# never asks. Any explicit flag passed through also turns off Nunchiro's Codex hooks (start.args must be empty),
# leaving screen-only items with no tool input to match. Printed with the evidence; no Codex quota is spent.
python3 -I -B - <<'PY'
import os, re
p = os.path.expanduser('~/.codex/config.toml')
try:
    text = open(p, encoding='utf-8', errors='replace').read()
except OSError as e:
    print(f'codex: not applicable (no readable config: {e.strerror}; Codex defaults to on-request + workspace-write)')
    raise SystemExit
get = lambda k: (re.search(rf'^{k}\s*=\s*"([^"]*)"', text, re.M) or [None, 'default'])[1]
policy, sandbox = get('approval_policy'), get('sandbox_mode')
asks = policy in ('untrusted',) or sandbox == 'read-only'
print(f"codex: {'applicable, not run (edits ask under this config)' if asks else 'not applicable'} "
      f'(approval_policy={policy}, sandbox_mode={sandbox}; Nunchiro passes no approval flags)')
PY
cd web
PW_OPT_IN=live NUNCHIRO_REAL=1 NUNCHIRO_WEB_PORT="${NUNCHIRO_WEB_PORT:-4192}" exec pnpm exec playwright test chat-diff-card.real.spec.ts --project live --workers 1
