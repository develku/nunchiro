#!/bin/sh
# V2-2b account_session_reports_login, end to end through the built `nunchiro`: fake `claude` and `codex` on PATH
# whose "status line" prints the config folder they were started with, and whose resume prints the transcript it
# found under that folder. Adds a second account per agent (label in Hangul), starts each agent on it by label, then
# checks: the agent reports the account's folder, never ~/.claude or ~/.codex; its argv never carries the label; a
# resume finds the transcript under the account folder; a label with an escape sequence is refused at add. The
# real-agent run (the owner's own second login) is manual: see the ticket.
# Prints one JSON receipt line; exits 1 on the first failed check. The run folder is removed on success.
set -eu
cd "$(dirname "$0")/../.."
unset CARGO_TARGET_DIR
cargo build -q -j 2 -p nunchiro
exec python3 -B - "$@" <<'PY'
import json, os, pathlib, shutil, socket, subprocess, sys, tempfile, time
sys.path.insert(0, 'scripts/scenario')
from lib import clean_env
root = pathlib.Path.cwd()
built = str(root / 'target/debug/nunchiro')
# A short home: core.sock must fit macOS sun_path (103 bytes).
run = pathlib.Path(tempfile.mkdtemp(prefix='ns-acss-')).resolve()
LABEL = '두번째 work'
FAKE = r'''#!/bin/sh
NAME=$(basename "$0")
if [ "$NAME" = claude ]; then D="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; else D="${CODEX_HOME:-$HOME/.codex}"; fi
case "$1" in --version) echo "$NAME 0.0.0 (fake)"; exit 0;; esac
case "$*" in "auth login"|login) touch "$D/.logged-in"; exit 0;; esac
for a in "$@"; do printf '%s\n' "$a"; done > "$NUNCHIRO_HOME/argv-$NUNCHIRO_SESSION"
printf 'LOGIN %s\n' "$D"
# Resume: Claude `--resume <id>`, Codex `resume <id>`; the transcript is looked up only under D.
ID=""; prev=""
for a in "$@"; do case "$prev" in --resume|resume) ID="$a";; esac; prev="$a"; done
if [ -n "$ID" ]; then
  F=$(find "$D/projects" "$D/sessions" -name "*$ID.jsonl" 2>/dev/null | head -n 1)
  if [ -n "$F" ]; then printf 'RESUMED %s\n' "$F"; else echo MISSING; fi
fi
read line
'''

def fail(msg):
    print(json.dumps({'scenario': 'account_session_reports_login', 'ok': False, 'error': msg, 'run': str(run)},
                     ensure_ascii=False))
    sys.exit(1)

user = run / 'u'
for d in ('.claude/projects', '.codex/sessions'):
    (user / d).mkdir(parents=True)
(run / 'bin').mkdir()
project = run / 'proj'
project.mkdir()
for name in ('claude', 'codex'):
    (run / 'bin' / name).write_text(FAKE)
    (run / 'bin' / name).chmod(0o700)
env = clean_env({'NUNCHIRO_HOME': str(run), 'HOME': str(user), 'PATH': f'{run}/bin:/usr/bin:/bin'})
for key in ('NUNCHIRO_TOKEN', 'NUNCHIRO_SESSION', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'):
    env.pop(key, None)
core = subprocess.Popen([built, 'serve'], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                        stderr=open(run / 'core.log', 'ab'))

def owner(request):
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(20)
        s.connect(str(run / 'core.sock'))
        s.sendall((json.dumps({'token': (run / 'core.token').read_text().strip(), 'request': request}) + '\n').encode())
        return json.loads(s.makefile().readline())

def screen_line(sid, prefix, timeout=15):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        out = owner({'op': 'read', 'id': sid, 'after': 0})
        text = bytes(out['Ok']['data']).decode(errors='replace') if 'Ok' in out else ''
        for line in text.splitlines():
            if line.startswith(prefix):
                return line[len(prefix):].strip()
        time.sleep(.05)
    fail(f'{sid} never printed {prefix!r}')

def start(kind, account=None, resume=None):
    session = {'kind': kind, 'project': str(project), 'model': None, 'effort': None, 'resume': resume}
    if account is not None:
        session['account'] = account
    reply = owner({'op': 'start', 'session': session})
    if 'Ok' not in reply: fail(f'{kind} start: {reply}')
    return reply['Ok']['session']

def end(sid):
    owner({'op': 'send_text', 'id': sid, 'text': '\r'})
    until = time.monotonic() + 15
    while True:
        sessions = owner({'op': 'snapshot'})['Ok']['sessions']
        if next(s for s in sessions if s['id'] == sid)['state'] != 'running':
            return
        if time.monotonic() > until: fail(f'{sid} never ended')
        time.sleep(.05)

try:
    until = time.monotonic() + 30
    while not (run / 'window.json').exists():
        if time.monotonic() > until or core.poll() is not None: fail('core did not start')
        time.sleep(.05)
    refused = owner({'op': 'account_add', 'agent': 'claude', 'label': 'x\x1b[2Jy'})
    if 'Err' not in refused: fail(f'escape label accepted: {refused}')
    receipt = {'escape_label_refused': True}
    for agent in ('claude', 'codex'):
        reply = owner({'op': 'account_add', 'agent': agent, 'label': LABEL})
        if 'Ok' not in reply: fail(f'{agent} add: {reply}')
        folder = reply['Ok']['account']['folder']
        s = start(agent, LABEL)
        if (s.get('account'), s.get('config_dir')) != (LABEL, folder): fail(f'{agent} record: {s}')
        login = screen_line(s['id'], 'LOGIN ')
        if login != folder: fail(f'{agent} reported {login}, not {folder}')
        if LABEL in (run / f"argv-{s['id']}").read_text(): fail(f'{agent} argv carries the label')
        # A transcript of this conversation under the account folder, and a decoy under the user's own tree.
        conv = s.get('agent_session_id') or '0123456789abcdef0123456789abcdef'
        if agent == 'claude':
            rel = pathlib.Path('projects') / ''.join(c if c.isalnum() and c.isascii() else '-' for c in s['cwd'])
        else:
            rel = pathlib.Path('sessions/2026/10/27')
        name = f'{conv}.jsonl' if agent == 'claude' else f'rollout-x-{conv}.jsonl'
        for base in (pathlib.Path(folder), user / f'.{agent}'):
            (base / rel).mkdir(parents=True, exist_ok=True)
            (base / rel / name).write_text('{}\n')
        end(s['id'])
        # Claude resumes its own conversation (the core keeps the account); Codex resumes an id it never ran here,
        # so the account is named again.
        r = start(agent, None if agent == 'claude' else LABEL, conv)
        if r.get('config_dir') != folder: fail(f'{agent} resume record: {r}')
        found = screen_line(r['id'], 'RESUMED ')
        if found != str(pathlib.Path(folder) / rel / name): fail(f'{agent} resumed {found}')
        receipt[agent] = {'reported': '<account folder>', 'resume_found': '<account folder>/' + str(rel / name)}
        end(r['id'])
    receipt.update({'scenario': 'account_session_reports_login', 'ok': True, 'label': LABEL})
    print(json.dumps(receipt, ensure_ascii=False))
finally:
    subprocess.run([built, 'serve', 'stop', '--yes'], env=env, capture_output=True, timeout=30)
    if core.poll() is None:
        core.kill()
    core.wait(timeout=10)
shutil.rmtree(run)
PY
