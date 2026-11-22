#!/bin/sh
# V1A-06: local-only by default; real SSH requires the coordinator's explicit grant.
set -eu
cd "$(dirname "$0")/../.."
case "${1:-}" in
    --fake)
        unset CARGO_TARGET_DIR
        exec cargo test -j 4 -p nunchiro --test machine_transport -- --test-threads=2
        ;;
    '') echo 'usage: scripts/scenario/remote.sh --fake|<ssh-alias>' >&2; exit 2 ;;
    *)
        [ "${NUNCHIRO_REMOTE_APPROVED:-}" = 1 ] || {
            echo 'Real SSH refused: coordinator approval requires NUNCHIRO_REMOTE_APPROVED=1.' >&2
            exit 2
        }
        : "${NUNCHIRO_REMOTE_PROJECT:?set the existing project path on the remote Mac}"
        ;;
esac
# No install, pairing, Remote Login changes, or SSH configuration edits.
# Run only after reviewing usage headroom; a fake run never launches an installed agent.
"$HOME/.agents/policies/usage.sh"
[ "${NUNCHIRO_REMOTE_CODEX_HEADROOM:-}" = 1 ] || {
    echo 'Confirm Codex headroom from usage.sh with NUNCHIRO_REMOTE_CODEX_HEADROOM=1.' >&2; exit 2;
}
unset CARGO_TARGET_DIR
cargo build -j 4 -p nunchiro
exec python3 -B - "$1" <<'PY'
import json, os, pathlib, subprocess, sys
sys.path.insert(0, 'scripts/scenario')
from lib import snapshot, guard_check, CODEX_MODEL
binary = str(pathlib.Path('target/debug/nunchiro').resolve())
alias, project = sys.argv[1], os.environ['NUNCHIRO_REMOTE_PROJECT']
before, started = snapshot(), []
def cli(*args):
    p = subprocess.run([binary, '--machine', alias, *args], capture_output=True, text=True, timeout=30)
    if p.returncode: raise RuntimeError(p.stderr.strip())
    return json.loads(p.stdout)
try:
    for kind, model in [('claude', 'haiku'), ('codex', CODEX_MODEL)]:
        child = cli('session', 'start', '--kind', kind, '--project', project,
                    '--label', 'remote-scenario-' + kind, '--model', model)['session']
        started.append(child['id'])
        # Startup trust is never answered by this scenario. An open dialog fails the prompt.
        cli('agent', 'prompt', child['id'], 'Reply with OK only.', '--wait', '--until', 'done', '--timeout', '20000')
        cli('agent', 'wait', child['id'], '--until', 'done', '--timeout', '1000')
        print(cli('agent', 'get', child['id'], '--json'))
        p = subprocess.run([binary, '--machine', alias, 'agent', 'read', child['id']], capture_output=True, text=True, timeout=15)
        if p.returncode: raise RuntimeError(p.stderr.strip())
        print(p.stdout)
finally:
    cleanup_errors = []
    for session in started:
        try: cli('session', 'close', session)
        except Exception as error: cleanup_errors.append(f'{session}: {error}')
    problems, foreign = guard_check(before, snapshot())
    if foreign: print('Foreign local config changes:', foreign)
    if problems or cleanup_errors: raise RuntimeError(repr({'config_guard': problems, 'cleanup': cleanup_errors}))
print('REMOTE_SCENARIO PASS (real SSH; remote user config requires coordinator inspection)')
PY
