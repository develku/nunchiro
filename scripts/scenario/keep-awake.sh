#!/bin/sh
# V2-CF5 keep_awake_while_any_session_works, end to end through the built `nunchiro`: a core whose settings.json has
# keep_awake true, one shell session, and a real UserPromptSubmit hook. Checks, on macOS only (else a skip receipt):
#   1. nothing held before any session works (no caffeinate child of the core, no assertion for it);
#   2. a working session gets one `caffeinate -i -w <core pid>` child: `pmset -g assertions` shows its
#      PreventUserIdleSystemSleep "on behalf of" the core's pid, and no PreventUserIdleDisplaySleep from it;
#   3. the snapshot reply says keep_awake_held (the menu bar's cup);
#   4. the recording pty fake (`cat > rec.txt`) got zero bytes across enabling, holding and releasing;
#   5. `serve stop` releases: the child is gone and no assertion names the core.
# The two-minute grace release is the unit test keep_awake_release_two_minutes_after_last_turn (keep_awake.rs).
# Prints one JSON receipt line; exits 1 on the first failed check. The run folder is removed on success.
set -eu
cd "$(dirname "$0")/../.."
unset CARGO_TARGET_DIR
cargo build -q -j 2 -p nunchiro
exec python3 -B - "$@" <<'PY'
import json, os, pathlib, re, shutil, socket, subprocess, sys, tempfile, time
sys.path.insert(0, 'scripts/scenario')
from lib import clean_env
root = pathlib.Path.cwd()
built = str(root / 'target/debug/nunchiro')
SCENARIO = 'keep_awake_while_any_session_works'

if sys.platform != 'darwin':
    print(json.dumps({'scenario': SCENARIO, 'ok': True, 'skipped': 'macOS only (caffeinate)'}))
    sys.exit(0)

# A short home under the system temp dir: core.sock must fit macOS sun_path (103 bytes) whatever the checkout path.
run = pathlib.Path(tempfile.mkdtemp(prefix='ns-ka-')).resolve()
assert len(str(run / 'core.sock').encode()) < 104, 'home too long for sun_path'
rec = {'scenario': SCENARIO, 'checks': {}}

def fail(msg):
    print(json.dumps({**rec, 'ok': False, 'error': msg, 'run': str(run)}))
    sys.exit(1)

def check(name, ok, detail=''):
    rec['checks'][name] = {'ok': bool(ok), 'detail': detail}
    if not ok:
        fail(f'{name}: {detail}')

env = clean_env({'NUNCHIRO_HOME': str(run)})
for key in ('NUNCHIRO_TOKEN', 'NUNCHIRO_SESSION'):
    env.pop(key, None)

def cli(*args, check=True):
    p = subprocess.run([built, *args], env=env, capture_output=True, text=True, timeout=30)
    if check and p.returncode:
        fail(f'{args}: {p.stderr.strip() or p.stdout.strip()}')
    return p.stdout

def until(seconds, fn):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = fn()
        if value:
            return value
        time.sleep(0.2)
    return None

def caffeinate_blocks(core_pid):
    """`pmset -g assertions` blocks for a caffeinate child asserting for the core's pid (the `-w` form says so)."""
    blocks, cur = [], None
    for line in subprocess.run(['pmset', '-g', 'assertions'], capture_output=True, text=True).stdout.splitlines():
        if re.match(r'\s*pid \d+\(', line):
            cur = [line]
            blocks.append(cur)
        elif cur is not None and line.startswith('\t'):
            cur.append(line)
        else:
            cur = None
    return ['\n'.join(b) for b in blocks if '(caffeinate)' in b[0] and f'on behalf of Process ID {core_pid}' in '\n'.join(b)]

(run / 'settings.json').write_text(json.dumps({'keep_awake': True, 'worktrees_dir': str(run / 'wt')}))
log = open(run / 'core.log', 'ab')
core = subprocess.Popen([built, 'serve'], env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
try:
    if not until(10, lambda: os.path.exists(run / 'core.sock')):
        fail('core did not start')
    check('nothing_held_before_work', not caffeinate_blocks(core.pid), 'a caffeinate child was already asserting')

    # A recording pty fake: prints its token (test only), then everything the PTY receives lands in rec.txt.
    script = 'printf "tok:%s\\n" "$NUNCHIRO_TOKEN"; exec cat > "$NUNCHIRO_HOME/rec.txt"'
    started = json.loads(cli('session', 'start', '--kind', 'shell', '--project', str(root), '--label', 'rec', '--', '/bin/sh', '-c', script))
    sid = started['session']['id']
    screen = until(20, lambda: re.search(r'tok:(\S+)', bytes(json.loads(cli('session', 'read', sid))['data']).decode('utf8', 'replace')))
    if not screen:
        fail('the recording shell never printed its token')
    token = screen.group(1)
    hook_env = {**env, 'NUNCHIRO_TOKEN': token, 'NUNCHIRO_SESSION': sid}

    # The session works: its UserPromptSubmit hook is the only thing that says so.
    subprocess.run([built, 'hook', 'UserPromptSubmit'], input='{"prompt_id":"ka1"}', env=hook_env, capture_output=True, text=True, timeout=20)
    blocks = until(10, lambda: caffeinate_blocks(core.pid))
    check('assertion_while_working', bool(blocks), 'no caffeinate assertion named the core pid')
    joined = '\n'.join(blocks)
    check('blocks_idle_system_sleep', 'PreventUserIdleSystemSleep' in joined, joined)
    check('display_may_sleep', 'PreventUserIdleDisplaySleep' not in joined, joined)
    check('one_child', len(blocks) == 1, f'{len(blocks)} caffeinate children for the core')
    snapshot = json.loads(cli('snapshot', '--json'))
    check('snapshot_says_held', snapshot.get('keep_awake_held') is True, json.dumps(snapshot.get('keep_awake_held')))

    # Holding wrote nothing to any PTY: the recording fake saw zero bytes.
    time.sleep(1.5)
    rec_file = run / 'rec.txt'
    check('nothing_auto_sends', rec_file.exists() and rec_file.stat().st_size == 0,
          f'{rec_file.stat().st_size if rec_file.exists() else "no"} bytes in the recording pty fake')

    # The turn ends and the core stops: the child and its assertion go with it.
    subprocess.run([built, 'hook', 'Stop'], input='{"turn_id":"ka1"}', env=hook_env, capture_output=True, text=True, timeout=20)
    child = int(re.search(r'pid (\d+)\(caffeinate\)', blocks[0]).group(1))
    cli('serve', 'stop', '--yes', check=False)
    core.wait(timeout=15)
    check('released_on_stop', until(5, lambda: not caffeinate_blocks(core.pid)), 'the assertion outlived the core')
    check('child_gone', until(5, lambda: subprocess.run(['kill', '-0', str(child)], capture_output=True).returncode != 0),
          f'caffeinate {child} still runs')
except subprocess.TimeoutExpired as e:
    fail(f'timed out: {e}')
finally:
    if core.poll() is None:
        core.kill()
        core.wait(timeout=10)

print(json.dumps({**rec, 'ok': True}))
shutil.rmtree(run)
PY
