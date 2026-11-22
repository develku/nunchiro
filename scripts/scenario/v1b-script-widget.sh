#!/bin/sh
# Ticket v1b-19: script widgets end to end against a real core (`nunchiro serve`) with fake widgets and a
# `/bin/cat` shell session; no agent runs. Covers: `widget new` scaffold, nothing runs before approval, grant,
# output and context.json, cached early calls, ask-again after a change, session-token refusal, setting off.
# The ticket-01 guard checksums the user's agent config before and after (spec Acceptance 15).
set -eu
cd "$(dirname "$0")/../.."
unset CARGO_TARGET_DIR
cargo build -q -j 4 -p nunchiro
exec python3 -B - "$@" <<'PY'
import json, os, pathlib, shutil, socket, subprocess, sys, time, uuid
sys.path.insert(0, 'scripts/scenario')
from lib import clean_env, snapshot, guard_check, GUARDED
root = pathlib.Path.cwd()
binary = str(root / 'target/debug/nunchiro')
before = snapshot()
tag = uuid.uuid4().hex[:5]
home = root / '.scratch' / ('w' + tag)
home.mkdir(mode=0o700, parents=True)
assert len(str(home / 'core.sock').encode()) < 104, 'socket path too long'
project = home / 'p' / 'demo-proj'
project.mkdir(parents=True)
env = clean_env({'NUNCHIRO_HOME': str(home)})
for key in ('NUNCHIRO_TOKEN', 'NUNCHIRO_SESSION'):
    env.pop(key, None)
rows, core = [], None

def check(name, ok, detail=''):
    rows.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  ({detail})' if detail and not ok else ''))

def cli(*args, extra=None, ok=True):
    p = subprocess.run([binary, *args], env={**env, **(extra or {})}, capture_output=True, text=True, timeout=25)
    if ok and p.returncode:
        raise RuntimeError(f'{args}: {p.stderr.strip()}')
    return p

def call(request, token=None):
    token = token or (home / 'core.token').read_text()
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(20)
    s.connect(str(home / 'core.sock'))
    s.sendall(json.dumps({'token': token, 'request': request}).encode() + b'\n')
    data = b''
    while not data.endswith(b'\n'):
        chunk = s.recv(65536)
        if not chunk:
            break
        data += chunk
    s.close()
    return json.loads(data)

def serve(settings):
    (home / 'settings.json').write_text(json.dumps(settings))
    (home / 'window.json').unlink(missing_ok=True)
    log = open(home / 'core.log', 'ab')
    c = subprocess.Popen([binary, 'serve'], env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    until = time.monotonic() + 10
    while not (home / 'window.json').exists():
        if c.poll() is not None or time.monotonic() > until:
            raise RuntimeError('core did not start')
        time.sleep(.05)
    return c

def stop(c):
    cli('serve', 'stop', '--yes', ok=False)
    try:
        c.wait(10)
    except subprocess.TimeoutExpired:
        c.kill()
        c.wait()

def run(session=None):
    # widget_run answers within 250 ms; a longer run reports `running` and is cached for the next call.
    until = time.monotonic() + 15
    while True:
        r = call({'op': 'widget_run', 'name': 'demo', 'session': session})
        if 'Err' in r or not r['Ok']['run']['running'] or time.monotonic() > until:
            return r
        time.sleep(.1)

def listed(name):
    r = call({'op': 'widget_list'})['Ok']['list']
    return r, next((w for w in r['widgets'] if w['name'] == name), None)

try:
    core = serve({'script_widgets': True})
    # A session whose environment token is copied into the scratch project, to call as that session.
    s = json.loads(cli('session', 'start', '--kind', 'shell', '--project', str(project), '--label', '데모-세션',
                       '--', '/bin/sh', '-c', 'printf %s "$NUNCHIRO_TOKEN" > .token; exec /bin/cat').stdout)['session']
    until = time.monotonic() + 5
    while not (project / '.token').exists() and time.monotonic() < until:
        time.sleep(.05)
    session_token = (project / '.token').read_text()

    # widget new: from a session (token in env) it still creates files; allow there raises an owner item (v1a-23).
    p = cli('widget', 'new', 'demo', extra={'NUNCHIRO_TOKEN': session_token}, ok=False)
    check('widget new works from a session', p.returncode == 0 and (home / 'widgets/demo/widget.toml').is_file(), p.stderr)
    p = cli('widget', 'new', 'demo', ok=False)
    check('widget new refuses an existing folder', p.returncode != 0 and 'exists' in p.stderr, p.stderr)
    p = cli('widget', 'new', 'Bad Name', ok=False)
    check('widget new refuses an invalid name', p.returncode != 0, p.stderr)
    r, w = listed('demo')
    check('scaffold listed and unapproved', w and w['state'] == 'unapproved' and not w.get('error'), json.dumps(w))
    check('setting on', r['enabled'] is True, json.dumps(r))

    # The fake widget: marker in its cache, then a JSON array with what it saw.
    (home / 'widgets/demo/widget.sh').write_text(
        '#!/bin/sh\necho ran > "$NUNCHIRO_CACHE/marker"\n'
        'printf \'[{"project_dir":"%s","context":%s,"token":"%s"}]\' "$NUNCHIRO_PROJECT_DIR" "$(/bin/cat "$NUNCHIRO_CONTEXT")" "${NUNCHIRO_TOKEN:-none}"\n')
    marker = home / 'widgets/demo/cache/marker'
    r = call({'op': 'widget_run', 'name': 'demo', 'session': s['id']})
    check('unapproved widget refused', 'Err' in r and 'approv' in r['Err'], json.dumps(r))
    check('unapproved widget never spawned', not marker.exists())
    p = cli('widget', 'allow', 'demo', '--read', extra={'NUNCHIRO_TOKEN': session_token}, ok=False)
    # v1a-23 (needs 47): inside a session the core does not approve; it raises one waiting item for the owner.
    asks = [i['owner'] for i in call({'op': 'snapshot'})['Ok'].get('owner_decisions', []) if i.get('owner', {}).get('name') == 'demo']
    check('widget allow inside a session waits for the owner', p.returncode == 0 and 'waiting for the owner' in p.stdout, p.stdout + p.stderr)
    check('allow from a session raised one owner approval item',
          len(asks) == 1 and asks[0].get('type') == 'approval' and asks[0].get('subject') == 'widget' and asks[0].get('level') == 'read', json.dumps(asks))
    check('allow from a session left it unapproved', listed('demo')[1]['state'] == 'unapproved')

    cli('widget', 'allow', 'demo', '--read')
    r = run(s['id'])
    out = r.get('Ok', {}).get('run', {}).get('output') or {}
    row = json.loads(out['text'])[0] if out.get('format') == 'json' else {}
    check('approved widget ran', marker.exists() and out.get('format') == 'json', json.dumps(r)[:400])
    check('NUNCHIRO_PROJECT_DIR is the session project', row.get('project_dir') == str(project.resolve()), json.dumps(row)[:300])
    ctx = row.get('context', {})
    check('context.json has only project names and session label/project/state',
          ctx == {'projects': [{'name': 'demo-proj'}], 'sessions': [{'label': '데모-세션', 'project': 'demo-proj', 'state': 'running'}]}, json.dumps(ctx))
    check('no session token in the widget environment', row.get('token') == 'none' and session_token not in json.dumps(r))
    context_file = home / 'widgets/demo/cache/context.json'
    check('context.json is 0600', context_file.exists() and (context_file.stat().st_mode & 0o777) == 0o600)
    first = r['Ok']['run']['ran_at_ms']
    r2 = call({'op': 'widget_run', 'name': 'demo', 'session': s['id']})
    check('early call returns the cached run', r2.get('Ok', {}).get('run', {}).get('ran_at_ms') == first, json.dumps(r2)[:200])

    r = call({'op': 'widget_run', 'name': 'demo', 'session': s['id']}, token=session_token)
    check('widget_run with a session token refused', r.get('Err') == 'operation not granted', json.dumps(r))
    r = call({'op': 'widget_list'}, token=session_token)
    check('widget_list with a session token refused', r.get('Err') == 'operation not granted', json.dumps(r))

    marker.unlink()
    (home / 'widgets/demo/widget.sh').write_text('#!/bin/sh\necho ran > "$NUNCHIRO_CACHE/marker"\necho changed\n')
    check('edited widget shows changed', listed('demo')[1]['state'] == 'changed')
    r = call({'op': 'widget_run', 'name': 'demo', 'session': s['id']})
    check('changed widget refused and not run', 'Err' in r and not marker.exists(), json.dumps(r))

    # Hot reload: a new folder is listed on the next call; a removed one is gone.
    shutil.copytree(home / 'widgets/demo', home / 'widgets/second', ignore=shutil.ignore_patterns('cache'))
    check('new folder listed', listed('second')[1] is not None)
    shutil.rmtree(home / 'widgets/second')
    check('deleted folder unlisted', listed('second')[1] is None)

    stop(core)
    core = serve({})
    r, w = listed('demo')
    check('setting off: still listed, marked off', r['enabled'] is False and w is not None, json.dumps(r))
    cli('widget', 'allow', 'demo', '--read')
    r = call({'op': 'widget_run', 'name': 'demo'})
    check('setting off: run refused, nothing spawned', 'script_widgets' in r.get('Err', '') and not marker.exists(), json.dumps(r))
finally:
    if core:
        stop(core)
after = snapshot()
problems, foreign = guard_check(before, after, ours=[str(home)])
for p in GUARDED:
    check(f'unchanged {p}', before.get(p) == after.get(p) or not any(p in x for x in problems), f'{before.get(p)} -> {after.get(p)}')
check('guard: no agent config change by this run', not problems, '; '.join(problems))
for f in foreign:
    print('foreign change (not this run):', f)
shutil.rmtree(home, ignore_errors=True)
failed = [r for r in rows if not r[1]]
print(f'{len(rows) - len(failed)}/{len(rows)} passed')
sys.exit(1 if failed else 0)
PY
