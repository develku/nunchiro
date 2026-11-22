#!/bin/sh
# Ticket 09: full quit leaves nothing running; a restarted core offers each session for explicit resume.
# Real Haiku agents through the ticket-01 guard. RUNS=5 by default (go to 30 only on a failure or flake).
# QUIT_APP=path/to/nunchiro-app also launches the window app, which must exit with the core (no icon left).
set -eu
cd "$(dirname "$0")/../.."
export CARGO_HOME="${CARGO_HOME:-$PWD/.scratch/cargo-home}"
unset CARGO_TARGET_DIR
cargo build -p nunchiro
exec python3 -B - "$@" <<'PY'
import json, os, pathlib, re, subprocess, sys, time, uuid, socket
sys.path.insert(0, 'scripts/scenario')
from lib import clean_env, snapshot, guard_check, descendants, visible, GUARDED
root = pathlib.Path.cwd()
binary = str(root / 'target/debug/nunchiro')
app_bin = os.environ.get('QUIT_APP') or ''
if app_bin and not os.path.isfile(app_bin):
    sys.exit('QUIT_APP is not a file: ' + app_bin)
runs = int(os.environ.get('RUNS', '5'))
project = os.environ.get('QUIT_PROJECT', str(root))
NAMES = ('nunchiro', 'nunchiro-app', 'claude', 'codex')

def pgrep():
    out = {}
    for n in NAMES:
        p = subprocess.run(['pgrep', '-x', n], capture_output=True, text=True)
        out[n] = sorted(int(x) for x in p.stdout.split())
    return out

def tagged(run):
    # Other lanes run their own nunchiro and agents on this host; only a process whose environment
    # carries this run's NUNCHIRO_HOME is ours. (ps -E prints the environment after the command.)
    out = subprocess.run(['ps', '-Eww', '-A', '-o', 'pid=,command='], capture_output=True, text=True).stdout
    return sorted(int(l.split()[0]) for l in out.splitlines() if 'NUNCHIRO_HOME=' + str(run) in l)

def alive(pid):
    try: os.kill(pid, 0); return True
    except ProcessLookupError: return False

def one(n):
    run = root / '.scratch' / ('q' + uuid.uuid4().hex[:5])
    run.mkdir(parents=True)
    assert len(str(run / 'core.sock').encode()) < 104, 'scenario socket path too long'
    env = clean_env({'NUNCHIRO_HOME': str(run), 'NUNCHIRO_BIN': binary})
    for key in ('NUNCHIRO_TOKEN', 'NUNCHIRO_SESSION'): env.pop(key, None)
    before, guard_before = pgrep(), snapshot()
    rec = {'run': n, 'pgrep_before': before, 'pass': False, 'restart': 'simulated: core stopped and started again, not a machine restart'}
    core = app = None
    owned = set()
    def cli(*args):
        p = subprocess.run([binary, *args], env=env, capture_output=True, text=True, timeout=25)
        if p.returncode: raise RuntimeError(p.stderr.strip() or p.stdout.strip())
        return json.loads(p.stdout)
    def start_core():
        log = open(run / 'core.log', 'ab')
        c = subprocess.Popen([binary, 'serve'], env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        until = time.monotonic() + 10
        while True:
            try:
                with socket.socket(socket.AF_UNIX) as s: s.connect(str(run / 'core.sock'))
                return c
            except OSError: pass
            if c.poll() is not None or time.monotonic() > until: raise RuntimeError('core did not start')
            time.sleep(.05)
    def screen(s):
        return visible(bytes(cli('session', 'read', s['id'])['data']))
    def wait_for(s, pattern, timeout=100):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            text = screen(s)
            if re.search(r'Is this a project you created or one you trust|Allow external CLAUDE.md file imports', text):
                raise RuntimeError('startup trust dialog: use an already trusted project via QUIT_PROJECT')
            if re.search(pattern, text, re.I | re.S): return text
            time.sleep(.2)
        raise RuntimeError('timed out waiting for ' + pattern)
    def stop_all():
        cli('serve', 'stop')
        core.wait(timeout=15)
        if app is not None:  # the window app leaves on its own once the core is gone; poll() reaps it (a zombie still answers kill 0)
            try: app.wait(timeout=15)
            except subprocess.TimeoutExpired: pass
        until = time.monotonic() + 15
        while time.monotonic() < until and any(alive(p) for p in owned): time.sleep(.1)
    try:
        core = start_core(); owned.add(core.pid)
        if app_bin:
            app = subprocess.Popen([app_bin], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=open(run / 'app.log', 'wb'))
            owned.add(app.pid)
        sessions = []
        for i in range(2):
            s = cli('session', 'start', '--kind', 'claude', '--project', project, '--model', 'haiku', '--label', f'quit-{i}')['session']
            sessions.append(s); wait_for(s, r'❯\s+Try|(?:manual|auto) mode on|for shortcuts')
        for i, s in enumerate(sessions):
            cli('session', 'send-text', s['id'], '\x1b[200~Reply exactly NUNCHIRO_OK_%d. Do not use tools.\x1b[201~' % i)
            time.sleep(.8); cli('session', 'send-keys', s['id'], 'enter')
        for i, s in enumerate(sessions):
            wait_for(s, r'NUNCHIRO_OK_%d(?!\.)' % i)
        time.sleep(1)
        owned.update(descendants(core.pid))
        rec['started_pids'] = sorted(owned)
        agent_ids = {s['id']: s['agent_session_id'] for s in sessions}
        stop_all()
        rec['survivors_after_stop'] = [p for p in owned if alive(p)]
        assert not rec['survivors_after_stop'], 'processes survived the full quit'
        assert not (run / 'core.sock').exists(), 'core socket left behind'
        # Simulated restart: a fresh core must offer each session for explicit resume, never run it.
        core = start_core(); owned.add(core.pid)
        listed = {s['id']: s for s in cli('snapshot', '--json')['sessions']}
        for sid, agent in agent_ids.items():
            assert listed[sid]['state'] == 'resumable' and listed[sid]['agent_session_id'] == agent, 'not offered for resume: ' + sid
            assert listed[sid]['pid'] is None, 'restored session is running without a resume'
        resumed = []
        for sid, agent in agent_ids.items():
            s = cli('session', 'start', '--kind', 'claude', '--project', project, '--model', 'haiku', '--resume', agent, '--label', 'resumed')['session']
            assert s['agent_session_id'] == agent, 'resume changed the agent session id'
            text = wait_for(s, r'❯\s+Try|(?:manual|auto) mode on|for shortcuts|NUNCHIRO_OK_')
            assert not re.search(r'No conversation found', text), 'agent could not resume ' + agent
            resumed.append(s)
        owned.update(descendants(core.pid))
        stop_all()
        rec['survivors_after_resume_stop'] = [p for p in owned if alive(p)]
        assert not rec['survivors_after_resume_stop'], 'processes survived the second full quit'
        rec['pass'] = True
    except Exception as error:
        rec['error'] = str(error)
    finally:
        if core is not None and core.poll() is None:
            try: cli('serve', 'stop'); core.wait(timeout=10)
            except Exception: pass
        for pid in owned:  # only PIDs this run started
            if alive(pid):
                rec['pass'] = False; rec.setdefault('forced_kill', []).append(pid)
                try: os.kill(pid, 9)
                except ProcessLookupError: pass
        rec['pgrep_after'] = pgrep()
        rec['tagged_after'] = tagged(run)  # pgrep lists are shared-host evidence; this is the verdict
        if rec['tagged_after']: rec['pass'] = False
        for pid in rec['tagged_after']:
            try: os.kill(pid, 9)
            except ProcessLookupError: pass
        problems, foreign = guard_check(guard_before, snapshot(), [str(run), project, str(root / 'scripts/scenario')])
        rec['guard_problems'] = problems
        if problems: rec['pass'] = False
        (run / 'result.json').write_text(json.dumps(rec, indent=2, ensure_ascii=False))
    return rec

results = []
for n in range(1, runs + 1):
    r = one(n); results.append(r)
    print(f"run {n}: {'PASS' if r['pass'] else 'FAIL'} before={r['pgrep_before']} after={r.get('pgrep_after')} {r.get('error', '')}", flush=True)
print(json.dumps({'check': 'quit', 'app': app_bin or 'not launched', 'runs': runs, 'passed': sum(r['pass'] for r in results)}))
sys.exit(0 if all(r['pass'] for r in results) else 1)
PY
