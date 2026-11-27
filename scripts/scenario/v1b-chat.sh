#!/bin/sh
# Ticket v1b-03, spec Acceptance 2: real Claude Haiku reads 3 files and edits one; the window (Playwright,
# web/tests/chat-live.spec.ts) must show the turn within 1 s of each transcript write, one grouped read row and
# one diff card with +1 −1. RUNS (default 5) runs, each with its own core, home and scratch project; the
# ticket-01 guard fails the run on any change to the user's agent settings, hooks or trust.
# CHAT_PROJECT_ROOT: a folder Claude already trusts (no trust dialog is ever answered); default a fresh folder
# under lib.TRUSTED_CWD. Each run's NUNCHIRO_HOME is under lib.SCENARIO_HOMES (outside any repo) and removed after it.
set -eu
cd "$(dirname "$0")/../.."
export CARGO_HOME="${CARGO_HOME:-$PWD/.scratch/cargo-home}"
unset CARGO_TARGET_DIR
cargo build -q -p nunchiro
exec python3 -B - "$@" <<'PY'
import json, os, pathlib, re, shutil, socket, subprocess, sys, time, uuid
sys.path.insert(0, 'scripts/scenario')
from lib import TRUSTED_CWD, clean_env, scenario_home, snapshot, guard_check, descendants, visible, GUARDED
root = pathlib.Path.cwd()
binary = str(root / 'target/debug/nunchiro')
runs = int(os.environ.get('RUNS', '5'))
project_root = pathlib.Path(os.environ.get('CHAT_PROJECT_ROOT', TRUSTED_CWD))
out = root / '.scratch' / ('chat-' + time.strftime('%Y%m%d-%H%M%S'))
out.mkdir(parents=True)
before = snapshot()
receipt = {'check': 'v1b-chat', 'agent': 'claude', 'model': 'haiku', 'claude': subprocess.run(['claude', '--version'], capture_output=True, text=True).stdout.strip(),
           'runs': [], 'pass': False, 'config_before': {k: before[k] for k in GUARDED}}
ours = [str(out), str(root / 'scripts/scenario')]

def one(n):
    tag = uuid.uuid4().hex[:5]
    home = scenario_home('c' + tag)
    ours.append(str(home))
    project = project_root / ('chat-proj-' + tag)
    project.mkdir(parents=True)
    ours.append(str(project))
    for name, word in (('a.txt', 'alpha'), ('b.txt', 'beta'), ('c.txt', 'gamma')):
        (project / name).write_text(f'{word}\nline two of {name}\n')
    # The window's origin follows the Playwright port (NUNCHIRO_WEB_PORT, default 4173).
    env = clean_env({'NUNCHIRO_HOME': str(home), 'NUNCHIRO_WINDOW_ORIGINS': 'http://127.0.0.1:' + os.environ.get('NUNCHIRO_WEB_PORT', '4173')})
    for key in ('NUNCHIRO_TOKEN', 'NUNCHIRO_SESSION'):
        env.pop(key, None)
    def cli(*args):
        p = subprocess.run([binary, *args], env=env, capture_output=True, text=True, timeout=25)
        if p.returncode:
            raise RuntimeError(p.stderr.strip())
        return json.loads(p.stdout)
    row = {'run': n, 'home': str(home), 'pass': False}
    core = None
    try:
        with open(home / 'core.log', 'wb') as log:
            core = subprocess.Popen([binary, 'serve'], env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        row['core_pid'] = core.pid
        until = time.monotonic() + 10
        while not (home / 'window.json').exists():
            if core.poll() is not None or time.monotonic() > until:
                raise RuntimeError('core did not start')
            time.sleep(.05)
        # acceptEdits is a flag for this session only: nothing is persisted and no dialog is answered.
        s = cli('session', 'start', '--kind', 'claude', '--project', str(project), '--model', 'haiku', '--label', 'chat-' + str(n), '--', '--permission-mode', 'acceptEdits')['session']
        row['session'], row['agent_pid'] = s['id'], s['pid']
        until = time.monotonic() + 100
        while True:
            text = visible(bytes(cli('session', 'read', s['id'])['data']))
            # Never answer a startup/trust dialog; stop rather than persist a trust grant.
            if re.search(r'Is this a (?:project|directory) you created or one you trust|Do you trust the files|Allow external CLAUDE.md file imports', text):
                raise RuntimeError('trust dialog: set CHAT_PROJECT_ROOT to a folder Claude already trusts')
            if re.search(r'❯\s+Try|(?:manual|auto|accept edits) (?:mode )?on|for shortcuts', text, re.I):
                break
            if time.monotonic() > until:
                raise RuntimeError('agent not ready')
            time.sleep(.2)
        enc = re.sub(r'[^A-Za-z0-9]', '-', s['cwd'])
        transcript = pathlib.Path.home() / '.claude/projects' / enc / (s['agent_session_id'] + '.jsonl')
        result = out / f'run-{n}.json'
        live = {'home': str(home), 'bin': binary, 'session': s['id'], 'transcript': str(transcript), 'out': str(result)}
        p = subprocess.run(['pnpm', 'exec', 'playwright', 'test', 'chat-live', '--project', 'live', '--reporter', 'line'],
                           cwd=root / 'web', env={**os.environ, 'PW_OPT_IN': 'live', 'CHAT_LIVE': json.dumps(live)}, capture_output=True, text=True, timeout=400)
        (out / f'run-{n}.playwright.log').write_text(p.stdout + p.stderr)
        if result.exists():
            row.update(json.loads(result.read_text()))
        row['edited'] = (project / 'a.txt').read_text().startswith('ALPHA')
        row['pass'] = p.returncode == 0 and row['edited']
        if p.returncode:
            row['error'] = (p.stdout + p.stderr).strip().splitlines()[-12:]
    except Exception as error:
        row['error'] = str(error)
    finally:
        if core is not None:
            owned = descendants(core.pid)
            try:
                cli('serve', 'stop')
                core.wait(timeout=10)
            except Exception as error:
                row['cleanup_error'] = str(error)
                row['pass'] = False
                for pid in reversed(owned):
                    try: os.kill(pid, 9)
                    except ProcessLookupError: pass
                if core.poll() is None: core.kill()
                core.wait()
            survivors = []
            for pid in owned:
                try: os.kill(pid, 0); survivors.append(pid)
                except ProcessLookupError: pass
            row['surviving_owned_pids'] = survivors
            if survivors: row['pass'] = False
        shutil.rmtree(project, ignore_errors=True)
        if (home / 'core.log').exists(): shutil.copy(home / 'core.log', out / f'run-{n}.core.log')
        shutil.rmtree(home, ignore_errors=True)
    return row

try:
    for n in range(1, runs + 1):
        row = one(n)
        receipt['runs'].append(row)
        print(json.dumps({k: row.get(k) for k in ('run', 'pass', 'latency', 'groups', 'cards', 'counts', 'error')}, ensure_ascii=False), flush=True)
    receipt['pass'] = all(r['pass'] for r in receipt['runs'])
finally:
    after = snapshot()
    problems, foreign = guard_check(before, after, ours)
    receipt['config_after'] = {k: after[k] for k in GUARDED}
    receipt['guard_problems'], receipt['guard_foreign'] = problems, foreign
    if problems: receipt['pass'] = False
    (out / 'result.json').write_text(json.dumps(receipt, indent=2, ensure_ascii=False))
    print('pass' if receipt['pass'] else 'FAIL', 'guard problems:', problems)
    print('receipt:', out / 'result.json')
sys.exit(0 if receipt['pass'] else 1)
PY
