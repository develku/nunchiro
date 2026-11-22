#!/bin/sh
# Ticket v1b-20: script widget act end to end against a real core (`nunchiro serve`) with fake widgets, a recording
# fake `claude` target (raw PTY bytes into a file) and the synthetic claude/codex fixtures
# (crates/nunchiro/tests/fixtures/agent-cli); no real agent runs. Covers: no send without the act grant, one click sends once, the widget sender in the snapshot,
# stale rows, session-token refusal, leading command characters, template errors, label resolution, start acts,
# ask-again after a change and the setting off. The ticket-01 guard checksums the user's agent config.
set -eu
cd "$(dirname "$0")/../.."
unset CARGO_TARGET_DIR
cargo build -q -j 2 -p nunchiro
exec python3 -B - "$@" <<'PY'
import json, os, pathlib, shutil, socket, subprocess, sys, time, uuid
sys.path.insert(0, 'scripts/scenario')
from lib import clean_env, snapshot, guard_check, GUARDED
root = pathlib.Path.cwd()
binary = str(root / 'target/debug/nunchiro')
fixtures = root / 'crates/nunchiro/tests/fixtures/agent-cli'
before = snapshot()
tag = uuid.uuid4().hex[:5]
home = root / '.scratch' / ('a' + tag)
home.mkdir(mode=0o700, parents=True)
assert len(str(home / 'core.sock').encode()) < 104, 'socket path too long'
project = home / 'p' / 'act-proj'
project.mkdir(parents=True)
other = home / 'p' / 'other-proj'
other.mkdir(parents=True)
# `claude --record FILE` records raw PTY input into FILE (token into .token-FILE) behind a ready prompt; otherwise
# the shared fixture runs. Shell sessions are not act targets (round 2), so the byte-exact target is this agent.
(home / 'bin').mkdir()
(home / 'bin/claude').write_text(f'''#!/usr/bin/env python3
import os, sys, tty
fixture = {str(fixtures / 'claude')!r}
if '--record' not in sys.argv:
    os.execv(fixture, [fixture] + sys.argv[1:])
name = sys.argv[sys.argv.index('--record') + 1]
tty.setraw(0)
open('.token-' + name, 'w').write(os.environ.get('NUNCHIRO_TOKEN', ''))
os.write(1, '\\u276f '.encode())
out = open(name, 'wb')
while True:
    data = os.read(0, 4096)
    if not data:
        break
    out.write(data)
    out.flush()
''')
(home / 'bin/claude').chmod(0o700)
env = clean_env({'NUNCHIRO_HOME': str(home), 'PATH': f"{home / 'bin'}:{fixtures}:{os.environ['PATH']}",
                 'CLAUDE_CONFIG_DIR': str(home / 'claude-data'), 'CODEX_HOME': str(home / 'codex-data')})
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

def shell(label, cwd, script):
    return json.loads(cli('session', 'start', '--kind', 'shell', '--project', str(cwd), '--label', label,
                          '--', '/bin/sh', '-c', script).stdout)['session']

def sessions():
    return json.loads(cli('snapshot', '--json').stdout)['sessions']

def by_id(i):
    return next(s for s in sessions() if s['id'] == i)

def widget(name, rows_json, act):
    d = home / 'widgets' / name
    d.mkdir(parents=True, exist_ok=True)
    (d / 'widget.toml').write_text(
        "version = 1\nkind = \"script\"\ncommand = [\"/bin/sh\", \"w.sh\"]\ninterval = 10\n"
        "permissions = [\"read\", \"act\"]\n" + act)
    (d / 'w.sh').write_text("#!/bin/sh\n/bin/cat rows.json\n")
    (d / 'rows.json').write_text(json.dumps(rows_json, ensure_ascii=False))

def run(name, session):
    until = time.monotonic() + 15
    while True:
        r = call({'op': 'widget_run', 'name': name, 'session': session})
        if 'Err' in r or not r['Ok']['run']['running'] or time.monotonic() > until:
            return r
        time.sleep(.1)

def act(name, session, row, ran_at_ms, token=None):
    return call({'op': 'widget_act', 'name': name, 'session': session, 'row': row, 'ran_at_ms': ran_at_ms}, token)

def wait(pred, timeout=5):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if pred():
            return True
        time.sleep(.05)
    return pred()

try:
    core = serve({'script_widgets': True})
    received = project / 'received.bin'
    # Raw, no echo: every byte the PTY gets lands in the file, so "exactly once" is a byte comparison.
    target = json.loads(cli('session', 'start', '--kind', 'claude', '--project', str(project), '--label', 'target',
                            '--', '--record', 'received.bin').stdout)['session']
    wait(lambda: received.exists(), 10)
    wait(lambda: '\u276f' in bytes(json.loads(cli('session', 'read', target['id']).stdout)['data']).decode('utf-8', 'replace'), 10)
    session_token = (project / '.token-received.bin').read_text()
    rows_json = [{'title': '리뷰 🎉 PR', 'n': 12}, {'title': '/model opus', 'n': 2}, {'title': 'two\nlines', 'n': 3},
                 {'title': {'x': 1}, 'n': 4}, {'n': 5}, {'title': 'bad\u0007bell', 'n': 6}]
    widget('pick', rows_json, '[act]\ntemplate = "look at {title} #{n}"\nsession = "target"\n')

    # 1. Read grant only: nothing is sent, not by a click and not by a direct request.
    cli('widget', 'allow', 'pick', '--read')
    r = run('pick', target['id'])
    ran = r['Ok']['run']['ran_at_ms']
    check('pick ran (json)', r['Ok']['run']['output']['format'] == 'json', json.dumps(r)[:300])
    r = act('pick', target['id'], 0, ran)
    check('widgets_act_without_grant_sends_nothing: refused', 'act' in r.get('Err', ''), json.dumps(r))
    time.sleep(.3)
    check('widgets_act_without_grant_sends_nothing: send_log and PTY unchanged',
          not by_id(target['id'])['send_log'] and received.read_bytes() == b'', json.dumps(by_id(target['id'])['send_log']))
    p = cli('widget', 'allow', 'pick', '--act', extra={'NUNCHIRO_TOKEN': session_token}, ok=False)
    # v1a-23 (needs 47): inside a session the core does not approve; it raises one waiting item for the owner.
    asks = [i['owner'] for i in call({'op': 'snapshot'})['Ok'].get('owner_decisions', []) if i.get('owner', {}).get('name') == 'pick']
    check('widget allow --act from a session waits for the owner', p.returncode == 0 and 'waiting for the owner' in p.stdout, p.stdout + p.stderr)
    check('allow --act from a session raised one owner approval item',
          len(asks) == 1 and asks[0].get('type') == 'approval' and asks[0].get('subject') == 'widget' and asks[0].get('level') == 'act', json.dumps(asks))
    r = act('pick', target['id'], 0, ran)
    check('allow --act from a session left act ungranted', 'act' in r.get('Err', ''), json.dumps(r))

    # 2. Act grant: one click sends exactly the rendered text once; a double click inside 1 s sends once.
    cli('widget', 'allow', 'pick', '--act')
    r = act('pick', target['id'], 0, ran, token=session_token)
    check('session token widget_act refused', r.get('Err') == 'operation not granted', json.dumps(r))
    r1 = act('pick', target['id'], 0, ran)
    r2 = act('pick', target['id'], 0, ran)
    want = 'look at 리뷰 🎉 PR #12'.encode()
    check('one click delivered', r1.get('Ok', {}).get('send', {}).get('status') == 'delivered', json.dumps(r1))
    wait(lambda: received.read_bytes() == want)
    time.sleep(.3)
    check('widgets_act_one_click_sends_once: PTY bytes exact (Hangul, emoji)', received.read_bytes() == want, repr(received.read_bytes()))
    log = by_id(target['id'])['send_log']
    check('double click inside 1 s sends once', len(log) == 1 and 'Ok' in r2, json.dumps(log))
    check('widgets_act_logged_and_marked: sender widget:pick in snapshot --json',
          log and log[-1]['sender'] == 'widget:pick' and log[-1]['content'] == want.decode(), json.dumps(log))

    # 3. Refusals: nothing sent for any of them.
    def refused(label, r, needle):
        check(label, needle in r.get('Err', ''), json.dumps(r))
    widget('val', [{'t': '/model opus'}, {'t': ' !ls'}, {'t': '\u200b#memory'}], '[act]\ntemplate = "{t} please"\nsession = "target"\n')
    cli('widget', 'allow', 'val', '--act')
    rv = run('val', target['id'])['Ok']['run']['ran_at_ms']
    for i, v in enumerate(('/model opus', ' !ls', 'zero-width #memory')):
        refused(f'leading command character from a value refused: {v}', act('val', target['id'], i, rv), '/')
    refused('newline in a value refused', act('pick', target['id'], 2, ran), 'newline')
    refused('non-scalar value refused', act('pick', target['id'], 3, ran), 'title')
    refused('missing field refused', act('pick', target['id'], 4, ran), 'title')
    refused('control character refused by check_text', act('pick', target['id'], 5, ran), 'invalid send text')
    refused('stale ran_at_ms refused', act('pick', target['id'], 0, ran - 1), 'output changed')
    refused('row past the output refused', act('pick', target['id'], 99, ran), 'output changed')
    for lead in ('!', '#', '  /'):
        widget('lead', [{'t': 'x'}], f'[act]\ntemplate = "{lead}{{t}}"\nsession = "target"\n')
        cli('widget', 'allow', 'lead', '--act')
        rr = run('lead', target['id'])['Ok']['run']['ran_at_ms']
        refused(f'leading {lead!r} in the template refused', act('lead', target['id'], 0, rr), '/')
    time.sleep(.3)
    check('refusals sent nothing', len(by_id(target['id'])['send_log']) == 1 and received.read_bytes() == want)

    # 4. Labels: two running sessions named target -> refused; none -> refused; another project's label never counts.
    twin = shell('target', project, 'exec /bin/cat')
    refused('two sessions named target', act('pick', target['id'], 0, ran), '2 sessions named target')
    cli('session', 'close', twin['id'])
    shell('target2', other, 'exec /bin/cat')
    widget('miss', [{'t': 'x'}], '[act]\ntemplate = "{t}"\nsession = "target2"\n')
    cli('widget', 'allow', 'miss', '--act')
    rr = run('miss', target['id'])['Ok']['run']['ran_at_ms']
    refused('no session named target2 in this project', act('miss', target['id'], 0, rr), 'no session named target2')
    shell('sh-target', project, 'stty raw -echo; exec /bin/cat > shell.bin')
    widget('sh', [{'t': '$(touch pwned)'}], '[act]\ntemplate = "{t}\\n"\nsession = "sh-target"\n')
    cli('widget', 'allow', 'sh', '--act')
    rr = run('sh', target['id'])['Ok']['run']['ran_at_ms']
    refused('a shell session is not an act target', act('sh', target['id'], 0, rr), 'Claude or Codex')
    widget('bidi', [{'t': 'fix \u202ecod.exe'}, {'t': 'x\u200by'}], '[act]\ntemplate = "{t}"\nsession = "target"\n')
    cli('widget', 'allow', 'bidi', '--act')
    rr = run('bidi', target['id'])['Ok']['run']['ran_at_ms']
    refused('bidi value refused', act('bidi', target['id'], 0, rr), 'U+202E')
    refused('zero-width value refused', act('bidi', target['id'], 1, rr), 'U+200B')
    time.sleep(.3)
    check('shell and invisible refusals sent nothing', not (project / 'pwned').exists() and received.read_bytes() == want
          and (project / 'shell.bin').read_bytes() == b'')

    # 5. Start acts: one fixture agent in the placement's project, first prompt through the queue as the widget.
    for kind in ('claude', 'codex'):
        name = 'start-' + kind
        widget(name, [{'t': f'hello {kind} 안녕'}], f'[act]\ntemplate = "{{t}}"\nstart = "{kind}"\n')
        cli('widget', 'allow', name, '--act')
        rr = run(name, target['id'])['Ok']['run']['ran_at_ms']
        r = act(name, target['id'], 0, rr)
        sid = r.get('Ok', {}).get('session')
        check(f'start {kind}: a session started', bool(sid), json.dumps(r)[:300])
        if not sid:
            continue
        s = by_id(sid)
        check(f'start {kind}: kind and project', s['kind'] == kind and s['project'] == str(project.resolve()), json.dumps(s)[:300])
        def acked():
            out = json.loads(cli('session', 'read', sid).stdout)
            return f'ACK:hello {kind} 안녕' in bytes(out['data']).decode('utf-8', 'replace')
        check(f'start {kind}: first prompt delivered once', wait(acked, 10), cli('session', 'read', sid).stdout[-300:])
        log = by_id(sid)['send_log']
        check(f'start {kind}: logged as widget:{name}', len(log) == 1 and log[0]['sender'] == f'widget:{name}' and log[0]['submit'], json.dumps(log))
        cli('session', 'close', sid)

    # 6. A change after the act grant: changed, act refused until regranted.
    (home / 'widgets/pick/w.sh').write_text("#!/bin/sh\n/bin/cat rows.json\n# edited\n")
    r = act('pick', target['id'], 0, ran)
    refused('changed widget act refused', r, 'changed')
    cli('session', 'close', target['id'])

    # 7. Setting off: act refused like widget_run.
    stop(core)
    core = serve({})
    t2 = shell('target', project, 'exec /bin/cat')
    r = act('pick', t2['id'], 0, ran)
    refused('setting off: act refused', r, 'script_widgets')
    check('setting off: nothing logged', not by_id(t2['id'])['send_log'])
except Exception as e:
    check('scenario ran to the end', False, repr(e))
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
