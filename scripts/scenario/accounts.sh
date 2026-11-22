#!/bin/sh
# V2-2a account_add_login_visible_tab, end to end through the built `nunchiro`: a core started with a planted test
# HOME (its own ~/.claude and ~/.codex trees) and fake `claude` / `codex` programs on PATH. Adds one account per agent
# over the owner socket, then checks: each login runs as a visible shell tab with the fixed argv; the login's env names
# the account folder for its agent and neither the other agent's variable nor ~/.claude / ~/.codex; the folders are
# 0700 under accounts/<agent>/; `nunchiro account list --json` shows both signed in; the planted trees' checksums are
# equal before and after. The real-agent run (the owner's own login) is manual: see the ticket.
# Prints one JSON receipt line; exits 1 on the first failed check. The run folder is removed on success.
set -eu
cd "$(dirname "$0")/../.."
unset CARGO_TARGET_DIR
cargo build -q -j 2 -p nunchiro
exec python3 -B - "$@" <<'PY'
import hashlib, json, os, pathlib, shutil, socket, stat, subprocess, sys, tempfile, time
sys.path.insert(0, 'scripts/scenario')
from lib import clean_env
root = pathlib.Path.cwd()
built = str(root / 'target/debug/nunchiro')
# A short home: core.sock must fit macOS sun_path (103 bytes).
run = pathlib.Path(tempfile.mkdtemp(prefix='ns-acct-')).resolve()
FAKE = r'''#!/bin/sh
NAME=$(basename "$0")
if [ "$NAME" = claude ]; then D="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; STATUS="auth status"; LOGIN="auth login"
else D="${CODEX_HOME:-$HOME/.codex}"; STATUS="login status"; LOGIN="login"; fi
case "$1" in --version) echo "$NAME 0.0.0 (fake)"; exit 0;; esac
if [ "$1 $2" = "$STATUS" ]; then
  if [ -e "$D/.logged-in" ]; then [ "$NAME" = claude ] && echo '{"loggedIn": true}' || echo 'Logged in using ChatGPT' >&2; exit 0; fi
  [ "$NAME" = claude ] && echo '{"loggedIn": false}' || echo 'Not logged in' >&2; exit 1
fi
if [ "$*" = "$LOGIN" ]; then
  env > "$NUNCHIRO_HOME/$NAME.env.tmp" && mv "$NUNCHIRO_HOME/$NAME.env.tmp" "$NUNCHIRO_HOME/$NAME.env"
  for a in "$@"; do printf '%s\n' "$a"; done > "$NUNCHIRO_HOME/$NAME.argv.tmp" && mv "$NUNCHIRO_HOME/$NAME.argv.tmp" "$NUNCHIRO_HOME/$NAME.argv"
  touch "$D/.logged-in"; echo "fake login done"; exec sleep 600
fi
exit 2
'''

def fail(msg):
    print(json.dumps({'scenario': 'account_add_login_visible_tab', 'ok': False, 'error': msg, 'run': str(run)}))
    sys.exit(1)

def tree_sum(d):
    h = hashlib.sha256()
    for p in sorted(d.rglob('*')):
        st = p.lstat()
        h.update(f'{p.relative_to(d)} {stat.filemode(st.st_mode)} {st.st_size} {st.st_mtime_ns}\n'.encode())
        if p.is_file() and not p.is_symlink() and st.st_mode & 0o400:
            h.update(p.read_bytes())
    return h.hexdigest()

user = run / 'u'
for d in ('.claude', '.codex'):
    (user / d / 'skills/mine').mkdir(parents=True)
    (user / d / 'skills/mine/SKILL.md').write_text('own skill')
    (user / d / 'settings.json').write_text('{}')
(run / 'bin').mkdir()
for name in ('claude', 'codex'):
    (run / 'bin' / name).write_text(FAKE)
    (run / 'bin' / name).chmod(0o700)
before = {d: tree_sum(user / d) for d in ('.claude', '.codex')}
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

def wait(path, timeout=15):
    until = time.monotonic() + timeout
    while not path.exists():
        if time.monotonic() > until: fail(f'{path.name} never appeared')
        time.sleep(.05)
    return path.read_text()

try:
    until = time.monotonic() + 30
    while not (run / 'window.json').exists():
        if time.monotonic() > until or core.poll() is not None: fail('core did not start')
        time.sleep(.05)
    receipt = {}
    for agent, var, other, words in (('claude', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', ['auth', 'login']),
                                     ('codex', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', ['login'])):
        reply = owner({'op': 'account_add', 'agent': agent, 'label': f'{agent} work 회사'})
        if 'Ok' not in reply: fail(f'{agent} add: {reply}')
        account, session = reply['Ok']['account'], reply['Ok']['session']
        folder = pathlib.Path(account['folder'])
        if folder.parent != run / 'accounts' / agent: fail(f'{agent} folder outside accounts/{agent}: {folder}')
        if stat.S_IMODE(folder.lstat().st_mode) != 0o700: fail(f'{agent} folder mode')
        if (session['kind'], session['state'], session['cwd']) != ('shell', 'running', str(folder)):
            fail(f'{agent} login tab: {session}')
        seen = dict(l.split('=', 1) for l in wait(run / f'{agent}.env').splitlines() if '=' in l)
        if seen.get(var) != str(folder): fail(f'{agent} {var}={seen.get(var)}')
        if other in seen: fail(f'{agent} login sees {other}')
        if any(str(user / d) in v for v in seen.values() for d in ('.claude', '.codex')):
            fail(f'{agent} login env names the user tree')
        if wait(run / f'{agent}.argv').split() != words: fail(f'{agent} argv')
        wait(folder / '.logged-in')
        receipt[agent] = {'folder_mode': '0700', 'env': f'{var}=<account folder>', 'argv': [agent, *words]}
    listed = json.loads(subprocess.run([built, 'account', 'list', '--json'], env=env, capture_output=True, text=True,
                                       timeout=30, check=True).stdout)['accounts']
    signed = [(a['agent'], a['signed_in']) for a in listed if not a['default']]
    if signed != [('claude', 'yes'), ('codex', 'yes')]: fail(f'list: {signed}')
    after = {d: tree_sum(user / d) for d in ('.claude', '.codex')}
    if after != before: fail('the planted ~/.claude or ~/.codex changed')
    receipt.update({'scenario': 'account_add_login_visible_tab', 'ok': True, 'checksums_equal': True,
                    'listed_signed_in': signed})
    print(json.dumps(receipt, ensure_ascii=False))
finally:
    subprocess.run([built, 'serve', 'stop', '--yes'], env=env, capture_output=True, timeout=30)
    if core.poll() is None:
        core.kill()
    core.wait(timeout=10)
shutil.rmtree(run)
PY
