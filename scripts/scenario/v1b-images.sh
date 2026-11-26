#!/bin/sh
# Ticket v1b-05, spec Acceptance 5 with real agents. Rows:
#   claude-image  Claude Haiku: a generated PNG pasted in the window composer, sent with the user's Enter as a saved
#                 path; the transcript carries an image block and the chat user block renders it
#                 (web/tests/thumbnails-live.spec.ts).
#   codex-image   the same with Codex (cheapest model); not run when ~/.agents/policies/usage.sh shows no headroom.
#   clipboard     every pasteboard type hashed (and the change count read) before the paste and after the send of
#                 each run above: byte-identical, never written (scripts/scenario/images.py, read-only).
# RUNS (default 5) runs per agent row, each with its own core, home and scratch project; the ticket-01 guard fails
# the run on any change to the user's agent settings, hooks or trust. ROWS picks agent rows (default both).
# IMAGES_PROJECT_ROOT: a folder Claude already trusts (no trust dialog is ever answered); default .scratch.
set -eu
cd "$(dirname "$0")/../.."
export CARGO_HOME="${CARGO_HOME:-$PWD/.scratch/cargo-home}"
unset CARGO_TARGET_DIR
cargo build -q -p nunchiro
exec python3 -B - "$@" <<'PY'
import base64, json, os, pathlib, re, shutil, subprocess, sys, time, uuid
sys.path.insert(0, 'scripts/scenario')
from lib import CODEX_MODEL, clean_env, snapshot, guard_check, descendants, visible, GUARDED
from images import pasteboard, png
root = pathlib.Path.cwd()
binary = str(root / 'target/debug/nunchiro')
runs = int(os.environ.get('RUNS', '5'))
rows = os.environ.get('ROWS', 'claude-image codex-image').split()
project_root = pathlib.Path(os.environ.get('IMAGES_PROJECT_ROOT', str(root / '.scratch')))
port = os.environ.get('NUNCHIRO_WEB_PORT', '4173')
out = root / '.scratch' / ('images-' + time.strftime('%Y%m%d-%H%M%S'))
out.mkdir(parents=True)
before = snapshot()
receipt = {'check': 'v1b-images', 'claude': subprocess.run(['claude', '--version'], capture_output=True, text=True).stdout.strip(),
           'codex': subprocess.run(['codex', '--version'], capture_output=True, text=True).stdout.strip(),
           'rows': {}, 'pass': False, 'config_before': {k: before[k] for k in GUARDED}}
ours = [str(out), str(root / 'scripts/scenario')]
READY = {'claude': r'❯\s+Try|(?:manual|auto|accept edits) (?:mode )?on|for shortcuts', 'codex': r'Ask Codex to do anything|% context left|context left'}
FIXTURE = png(64, 64, (0, 160, 0))  # solid green: one word, cheap to describe

def headroom():
    """Codex 5h usage below 95% on the default home, from the shared usage script; unknown counts as none."""
    try:
        text = subprocess.run(['bash', os.path.expanduser('~/.agents/policies/usage.sh')], capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return False, 'usage.sh failed'
    line = next((l for l in text.splitlines() if l.startswith('codex .codex')), '')
    m = re.search(r'5h (\d+)%', line)
    # the weekly window empties too: a 7d at 100 % fails every turn even with 5h at 0 %
    used = [int(p) for p in re.findall(r'(?:5h|7d) (\d+)%', line)]
    return (bool(m) and all(p < 95 for p in used)), line.strip() or 'no codex line'

def codex_image(conversation, path):
    """Where the Codex rollout carries the sent image: an input_image in the output of the view_image call on it."""
    if not conversation:
        return 'no conversation id'
    day = pathlib.Path.home() / '.codex/sessions' / time.strftime('%Y/%m/%d')
    for f in day.glob(f'rollout-*{conversation}.jsonl'):
        calls = set()
        for line in f.read_text().splitlines():
            pl = json.loads(line).get('payload', {})
            if pl.get('type') in ('custom_tool_call', 'function_call') and 'view_image' in str(pl.get('input') or pl.get('arguments')) and path in str(pl.get('input') or pl.get('arguments')):
                calls.add(pl.get('call_id'))
            if pl.get('type') in ('custom_tool_call_output', 'function_call_output') and pl.get('call_id') in calls and 'input_image' in json.dumps(pl.get('output')):
                return 'view_image output'
        return 'no image in rollout'
    return 'rollout not found'

def one(agent, n):
    tag = uuid.uuid4().hex[:5]
    home = root / '.scratch' / ('i' + tag)
    home.mkdir(mode=0o700)
    assert len(str(home / 'core.sock').encode()) < 104, 'socket path too long'
    project = project_root / ('img-proj-' + tag)
    project.mkdir(parents=True)
    ours.append(str(project))
    env = clean_env({'NUNCHIRO_HOME': str(home), 'NUNCHIRO_WINDOW_ORIGINS': 'http://127.0.0.1:' + port})
    for key in ('NUNCHIRO_TOKEN', 'NUNCHIRO_SESSION'):
        env.pop(key, None)
    def cli(*args):
        p = subprocess.run([binary, *args], env=env, capture_output=True, text=True, timeout=25)
        if p.returncode:
            raise RuntimeError(p.stderr.strip())
        return json.loads(p.stdout)
    row = {'run': n, 'agent': agent, 'home': str(home), 'pass': False}
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
        if agent == 'claude':
            s = cli('session', 'start', '--kind', 'claude', '--project', str(project), '--model', 'haiku', '--label', f'img-{n}')['session']
        else:
            # Trust for this run only, as a -c override: nothing is written to ~/.codex and no dialog is answered.
            s = cli('session', 'start', '--kind', 'codex', '--project', str(project), '--model', CODEX_MODEL, '--label', f'img-{n}', '--',
                    '-c', 'model_reasoning_effort="low"', '-c', f'projects."{project}".trust_level="trusted"')['session']
        row['session'], row['agent_pid'] = s['id'], s['pid']
        until = time.monotonic() + 100
        while True:
            text = visible(bytes(cli('session', 'read', s['id'])['data']))
            # Never answer a startup/trust dialog; stop rather than persist a trust grant.
            if re.search(r'Is this a project you created or one you trust|Do you trust the files|Allow external CLAUDE.md file imports|Trust this folder\?', text):
                raise RuntimeError('trust dialog: set IMAGES_PROJECT_ROOT to a folder the agent already trusts')
            if re.search(READY[agent], text, re.I):
                break
            if time.monotonic() > until:
                raise RuntimeError('agent not ready')
            time.sleep(.2)
        time.sleep(1 if agent == 'claude' else 4)
        result = out / f'{agent}-{n}.json'
        live = {'home': str(home), 'session': s['id'], 'agent': agent, 'png': base64.b64encode(FIXTURE).decode(),
                'prompt': 'describe this image in one word', 'out': str(result)}
        board_before = pasteboard()
        p = subprocess.run(['pnpm', 'exec', 'playwright', 'test', 'thumbnails-live', '--project', 'live', '--reporter', 'line'],
                           cwd=root / 'web', env={**os.environ, 'PW_OPT_IN': 'live', 'IMAGES_LIVE': json.dumps(live)}, capture_output=True, text=True, timeout=400)
        board_after = pasteboard()
        row['clipboard'] = {'same': board_before == board_after, 'changeCount': [board_before['changeCount'], board_after['changeCount']],
                            'types': len(board_before['types'])}
        (out / f'{agent}-{n}.playwright.log').write_text(p.stdout + p.stderr)
        if result.exists():
            row.update(json.loads(result.read_text()))
        row['pass'] = p.returncode == 0
        if agent == 'codex' and row.get('path'):
            row['transcript_image'] = codex_image(next(x for x in cli('snapshot', '--json')['sessions'] if x['id'] == s['id']).get('agent_session_id'), row['path'])
            row['pass'] = row['pass'] and row['transcript_image'] == 'view_image output'
        if p.returncode:
            row['error'] = (p.stdout + p.stderr).strip().splitlines()[-12:]
    except Exception as error:
        row['error'] = str(error)
        row['pass'] = False
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
    return row

try:
    clip = []
    for name in rows:
        agent = name.split('-')[0]
        if agent == 'codex':
            ok, why = headroom()
            if not ok:
                receipt['rows'][name] = {'status': 'not run', 'why': 'no Codex headroom: ' + why}
                print(json.dumps({'row': name, 'status': 'not run', 'why': why}), flush=True)
                continue
        results = []
        for n in range(1, runs + 1):
            r = one(agent, n)
            results.append(r)
            if 'clipboard' in r: clip.append(r['clipboard'])
            print(json.dumps({'row': name, **{k: r.get(k) for k in ('run', 'pass', 'image_events', 'thumb', 'reply', 'clipboard', 'error')}}, ensure_ascii=False), flush=True)
        receipt['rows'][name] = {'status': 'pass' if all(r['pass'] for r in results) else 'FAIL', 'runs': results}
    receipt['rows']['clipboard'] = {'status': 'pass' if clip and all(c['same'] for c in clip) else ('not run' if not clip else 'FAIL'), 'runs': clip}
    print(json.dumps({'row': 'clipboard', 'status': receipt['rows']['clipboard']['status'], 'runs': len(clip)}), flush=True)
    receipt['pass'] = all(r['status'] in ('pass', 'not run') for r in receipt['rows'].values()) and any(r['status'] == 'pass' for r in receipt['rows'].values())
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
