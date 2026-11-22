#!/bin/sh
# Ticket v1b-11 (spec Acceptance 10): after a real agent edits a scratch repo, Diff lists exactly the changed
# and untracked files against the session's start commit, and no Diff request writes to git (index, refs,
# packed-refs, stash). Real Haiku agent through the ticket-01 guard. RUNS=5 by default (30 only on a fail or flake).
# The agent runs in print mode (`claude -p`) inside a Nunchiro session: a fresh scratch repo would otherwise show
# Claude's folder-trust dialog, which this scenario must never answer, and print mode persists no trust.
set -eu
cd "$(dirname "$0")/../.."
export CARGO_HOME="${CARGO_HOME:-$PWD/.scratch/cargo-home}"
unset CARGO_TARGET_DIR
cargo build -p nunchiro
exec python3 -B - "$@" <<'PY'
import hashlib, json, os, pathlib, re, socket, subprocess, sys, time, uuid
sys.path.insert(0, 'scripts/scenario')
from lib import clean_env, snapshot, guard_check, descendants, visible
root = pathlib.Path.cwd()
binary = str(root / 'target/debug/nunchiro')
runs = int(os.environ.get('RUNS', '5'))

def alive(pid):
    try: os.kill(pid, 0); return True
    except ProcessLookupError: return False

def git(repo, *args):
    p = subprocess.run(['git', '-C', str(repo), '-c', 'user.name=t', '-c', 'user.email=t@example.com',
                        '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', *args], capture_output=True, text=True)
    if p.returncode: raise RuntimeError(f'git {args}: {p.stderr}')
    return p.stdout

def sums(repo):
    """Checksums of everything a git write would change: index, refs (loose and packed), the stash ref."""
    def h(p):
        try: return hashlib.sha256((repo / p).read_bytes()).hexdigest()[:16]
        except FileNotFoundError: return None
    refs = sorted(str(p.relative_to(repo)) + ':' + p.read_text().strip() for p in (repo / '.git/refs').rglob('*') if p.is_file())
    return {'.git/index': h('.git/index'), '.git/refs': hashlib.sha256('\n'.join(refs).encode()).hexdigest()[:16],
            'packed-refs': h('.git/packed-refs'), 'refs/stash': h('.git/refs/stash') or git(repo, 'stash', 'list').strip() or None,
            'HEAD': git(repo, 'rev-parse', 'HEAD').strip()}

def one(n):
    run = root / '.scratch' / ('d' + uuid.uuid4().hex[:5])
    home, repo = run / 'h', run / 'repo'
    home.mkdir(parents=True); repo.mkdir(parents=True)
    assert len(str(home / 'core.sock').encode()) < 104, 'scenario socket path too long'
    env = clean_env({'NUNCHIRO_HOME': str(home), 'NUNCHIRO_BIN': binary})
    for key in ('NUNCHIRO_TOKEN', 'NUNCHIRO_SESSION'): env.pop(key, None)
    guard_before = snapshot()
    rec = {'run': n, 'pass': False}
    core = None
    owned = set()
    def cli(*args):
        p = subprocess.run([binary, *args], env=env, capture_output=True, text=True, timeout=25)
        if p.returncode: raise RuntimeError(p.stderr.strip() or p.stdout.strip())
        return json.loads(p.stdout)
    def ask(request):
        # Owner request over the unix socket, as the window's API would route it.
        with socket.socket(socket.AF_UNIX) as s:
            s.connect(str(home / 'core.sock')); s.settimeout(20)
            s.sendall((json.dumps({'token': (home / 'core.token').read_text().strip(), 'request': request}) + '\n').encode())
            buf = b''
            while not buf.endswith(b'\n'):
                chunk = s.recv(65536)
                if not chunk: break
                buf += chunk
        r = json.loads(buf)
        if 'Err' in r: raise RuntimeError(f"{request['op']}: {r['Err']}")
        return r['Ok']
    def wait_for(s, pattern, timeout=120):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            text = visible(bytes(cli('session', 'read', s['id'])['data']))
            dialog = re.search(r'Is this a project you created or one you trust|Allow external CLAUDE.md file imports', text)
            if dialog: raise RuntimeError(f'unexpected startup dialog "{dialog[0]}"')
            if re.search(pattern, text, re.I | re.S): return text
            time.sleep(.3)
        raise RuntimeError('timed out waiting for ' + pattern)
    try:
        for f in ('a.txt', 'b.txt', 'c.txt'): (repo / f).write_text(f + ' original\n')
        (repo / '.gitignore').write_text('*.log\n')
        git(repo, 'init', '-q'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init')
        start_sha = git(repo, 'rev-parse', 'HEAD').strip()
        log = open(run / 'core.log', 'ab')
        core = subprocess.Popen([binary, 'serve'], env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        owned.add(core.pid)
        until = time.monotonic() + 10
        while not (home / 'core.token').exists() or not (home / 'core.sock').exists():
            if core.poll() is not None or time.monotonic() > until: raise RuntimeError('core did not start')
            time.sleep(.05)
        time.sleep(.2)
        prompt = ('Use the Edit tool to change the only line of a.txt to "edited by agent". Then use the Write tool to '
                  'create notes/new.txt containing "hello from agent". Do not run shell commands. Then reply exactly DIFF_DONE.')
        s = cli('session', 'start', '--kind', 'claude', '--project', str(repo), '--model', 'haiku', '--label', 'diff',
                '--', '-p', prompt, '--permission-mode', 'acceptEdits', '--allowedTools', 'Edit,Write,Read')['session']
        owned.update(descendants(core.pid))
        # A commit after the start: Diff must still compare with the start commit, not today's HEAD. Made before the
        # agent's first tool call can land (it is still starting up), so the agent edits on top of it.
        (repo / 'b.txt').write_text('b committed after start\n'); git(repo, 'commit', '-q', '-am', 'after start')
        (repo / 'noise.log').write_text('ignored\n')
        wait_for(s, r'DIFF_DONE', timeout=180)
        time.sleep(1.2)
        # A stat-only touch: any index-refreshing git (porcelain `git diff`) would now rewrite .git/index.
        (repo / 'c.txt').write_text('c.txt original\n')
        before = sums(repo)
        listed = ask({'op': 'diff_list', 'session': s['id']})
        patches = {f['path']: ask({'op': 'diff_file', 'session': s['id'], 'path': f['path']}) for f in listed['files']}
        after = sums(repo)
        rec['base'] = listed['base']
        rec['files'] = sorted((f['path'], f['status']) for f in listed['files'])
        rec['git'] = {k: {'before': before[k], 'after': after[k], 'same': before[k] == after[k]} for k in before}
        assert listed['base'] == {'kind': 'commit', 'sha': start_sha}, 'base is not the start commit'
        assert rec['files'] == [('a.txt', 'M'), ('b.txt', 'M'), ('notes/new.txt', '?')], f"unexpected list {rec['files']}"
        assert '+edited by agent' in patches['a.txt']['patch'], 'a.txt patch lacks the edit'
        assert '+hello from agent' in patches['notes/new.txt']['patch'], 'new.txt patch lacks its content'
        assert all(v['same'] for v in rec['git'].values()), 'a Diff request wrote to git'
        cli('session', 'close', s['id'])
        rec['pass'] = True
    except Exception as error:
        rec['error'] = str(error)
    finally:
        if core is not None and core.poll() is None:
            try: cli('serve', 'stop'); core.wait(timeout=15)
            except Exception: pass
        until = time.monotonic() + 10
        while time.monotonic() < until and any(alive(p) for p in owned): time.sleep(.1)
        for pid in owned:  # only PIDs this run started
            if alive(pid):
                rec.setdefault('forced_kill', []).append(pid)
                try: os.kill(pid, 9)
                except ProcessLookupError: pass
        problems, foreign = guard_check(guard_before, snapshot(), [str(run), str(repo)])
        rec['guard_problems'], rec['guard_foreign'] = problems, foreign
        if problems: rec['pass'] = False
        (run / 'result.json').write_text(json.dumps(rec, indent=2, ensure_ascii=False))
        subprocess.run(['rm', '-rf', str(repo)])
    return rec

results = []
for n in range(1, runs + 1):
    r = one(n); results.append(r)
    git_rows = ' '.join(f"{k}={'same' if v['same'] else 'CHANGED'}" for k, v in r.get('git', {}).items())
    print(f"run {n}: {'PASS' if r['pass'] else 'FAIL'} files={r.get('files')} {git_rows} guard={r['guard_problems'] or 'ok'} {r.get('error', '')}", flush=True)
print(json.dumps({'check': 'v1b-diff', 'runs': runs, 'passed': sum(r['pass'] for r in results)}))
sys.exit(0 if all(r['pass'] for r in results) else 1)
PY
