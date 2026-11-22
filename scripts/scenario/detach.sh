#!/bin/sh
# Ticket 02: three real Haiku agents, twenty client disconnect/reconnect cycles.
set -eu
cd "$(dirname "$0")/../.."
export CARGO_HOME="${CARGO_HOME:-$PWD/.scratch/cargo-home}"
export CARGO_TARGET_DIR="$PWD/target"
cargo build -p nunchiro
exec python3 -B - "$@" <<'PY'
import json, os, pathlib, re, subprocess, sys, time, uuid, socket
sys.path.insert(0, 'scripts/scenario')
from lib import clean_env, snapshot, guard_check, descendants, visible, GUARDED
root = pathlib.Path.cwd()
run = root / '.scratch' / ('d' + uuid.uuid4().hex[:5])
run.mkdir(parents=True)
assert len(str(run / 'core.sock').encode()) < 104, 'scenario socket path too long'
env = clean_env({'NUNCHIRO_HOME': str(run)})
for key in ('NUNCHIRO_TOKEN', 'NUNCHIRO_SESSION'):
    env.pop(key, None)
binary = str(root / 'target/debug/nunchiro')
project = os.environ.get('DETACH_PROJECT', str(root))
before = snapshot()
core = None
sessions = []
receipt = {'check': 'detach', 'agent': 'claude', 'model': 'haiku', 'cycles': 0,
           'sessions': [], 'pass': False, 'config_before': {k:before[k] for k in GUARDED}}
def cli(*args):
    p = subprocess.run([binary, *args], env=env, capture_output=True, text=True, timeout=25)
    if p.returncode:
        raise RuntimeError(p.stderr.strip())
    return json.loads(p.stdout)
def read(session):
    out = cli('session', 'read', session['id'])
    (run / (session['id'] + '.pty')).write_bytes(bytes(out['data']))
    return out, visible(bytes(out['data']))
def wait_for(session, pattern, timeout=100):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        out, text = read(session)
        # Never answer a startup/trust dialog; stop rather than persist a trust grant.
        if re.search(r'Is this a project you created or one you trust|Allow external CLAUDE.md file imports', text):
            raise RuntimeError('startup trust dialog: use an already trusted project via DETACH_PROJECT')
        if re.search(pattern, text, re.I | re.S):
            return out, text
        time.sleep(.2)
    raise RuntimeError('timed out waiting for ' + pattern)
try:
    with open(run / 'core.log', 'wb') as log:
        core = subprocess.Popen([binary, 'serve'], env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    until = time.monotonic() + 10
    while True:
        try:
            with socket.socket(socket.AF_UNIX) as connection:
                connection.connect(str(run / 'core.sock'))
            break
        except OSError:
            pass
        if core.poll() is not None or time.monotonic() > until:
            raise RuntimeError('core did not start')
        time.sleep(.05)
    for i in range(3):
        session = cli('session', 'start', '--kind', 'claude', '--project', project, '--model', 'haiku', '--label', 'detach-'+str(i))['session']
        sessions.append(session)
        wait_for(session, r'❯\s+Try|(?:manual|auto) mode on|for shortcuts')
    anchors = {}
    for i, session in enumerate(sessions):
        # Sending and submitting are explicit, distinct user actions. No automatic retry.
        cli('session', 'send-text', session['id'], '\x1b[200~Reply exactly NUNCHIRO_OK_'+str(i)+'. Do not use tools.\x1b[201~')
        time.sleep(.8)
        cli('session', 'send-keys', session['id'], 'enter')
        anchors[session['id']] = read(session)[0]
    for cycle in range(20):
        for session in sessions:
            # Each CLI read opens a new socket and exits, detaching its client completely.
            out, _ = read(session)
            anchor = anchors[session['id']]
            assert not out['truncated'], 'unexpected replay truncation in trivial scenario'
            assert out['data'][:len(anchor['data'])] == anchor['data'], 'scrollback prefix changed'
        current = cli('snapshot', '--json')['sessions']
        assert len(current) == 3 and all(s['state'] == 'running' for s in current), 'an agent stopped'
        receipt['cycles'] = cycle + 1
        time.sleep(.1)
    for i, session in enumerate(sessions):
        # Verify the assistant transcript, not the marker echoed in the user's prompt.
        until = time.monotonic() + 100
        matched = False
        while time.monotonic() < until and not matched:
            paths = (pathlib.Path.home() / '.claude/projects').glob('*/' + session['agent_session_id'] + '.jsonl')
            for path in paths:
                for line in path.read_text().splitlines():
                    try: record = json.loads(line)
                    except ValueError: continue
                    if record.get('type') == 'assistant':
                        blocks = record.get('message', {}).get('content', [])
                        matched |= any(b.get('type') == 'text' and 'NUNCHIRO_OK_'+str(i) in b.get('text', '') for b in blocks if isinstance(b, dict))
            if not matched: time.sleep(.2)
        assert matched, 'no verified assistant response from agent ' + str(i)
        out, text = read(session)
        receipt['sessions'].append({'id':session['id'], 'pid':session['pid'], 'agent_session_id':session['agent_session_id'], 'output_bytes':out['end'], 'assistant_verified':matched})
    receipt['pass'] = True
except Exception as error:
    receipt['error'] = str(error)
finally:
    if core is not None:
        owned = descendants(core.pid)
        try:
            cli('serve', 'stop')
            core.wait(timeout=10)
        except Exception as error:
            receipt['cleanup_error'] = str(error)
            receipt['pass'] = False
            for pid in reversed(owned):
                try: os.kill(pid, 9)
                except ProcessLookupError: pass
            if core.poll() is None: core.kill()
            core.wait()
        survivors = []
        for pid in owned:
            try: os.kill(pid, 0); survivors.append(pid)
            except ProcessLookupError: pass
        receipt['surviving_owned_pids'] = survivors
        if survivors: receipt['pass'] = False
    after = snapshot()
    problems, foreign = guard_check(before, after, [str(run), project, str(root / 'scripts/scenario')])
    receipt['config_after'] = {k:after[k] for k in GUARDED}
    receipt['guard_problems'], receipt['guard_foreign'] = problems, foreign
    if problems: receipt['pass'] = False
    (run / 'result.json').write_text(json.dumps(receipt, indent=2, ensure_ascii=False))
    print(json.dumps(receipt, ensure_ascii=False))
    print('receipt:', run / 'result.json')
sys.exit(0 if receipt['pass'] else 1)
PY
