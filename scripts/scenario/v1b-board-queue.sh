#!/bin/sh
# Ticket v1b-18, spec Acceptance 12: needs-decision board cards reach `nunchiro snapshot --json` and the window's
# strip and tree row within 1 s, 0 misses over RUNS (default 30) runs per row. No real agent: card files, an
# approved fake integration command, the board API over the owner socket, and a shell session (/bin/cat) whose
# project gives the tree a slot. Rows: column-card, needs-decision-card, reraise (ROWS to pick some).
# The window is this build in Playwright (web/tests/board-queue-live.spec.ts) against each row's core;
# BOARD_WINDOW=0 measures the snapshot only. NUNCHIRO_WEB_PORT names the preview port (default 4184).
set -eu
cd "$(dirname "$0")/../.."
export CARGO_HOME="${CARGO_HOME:-$PWD/.scratch/cargo-home}"
unset CARGO_TARGET_DIR
cargo build -q -p nunchiro
exec python3 -B - "$@" <<'PY'
import json, os, pathlib, shutil, signal, socket, subprocess, sys, time, uuid
sys.path.insert(0, 'scripts/scenario')
from lib import clean_env
root = pathlib.Path.cwd()
binary = str(root / 'target/debug/nunchiro')
runs = int(os.environ.get('RUNS', '30'))
rows = os.environ.get('ROWS', 'column-card,needs-decision-card,reraise').split(',')
window = os.environ.get('BOARD_WINDOW', '1') != '0'
port = os.environ.get('NUNCHIRO_WEB_PORT', '4184')
out = root / '.scratch' / ('board-queue-' + time.strftime('%Y%m%d-%H%M%S'))
out.mkdir(parents=True)
now = lambda: time.time() * 1000
BOUND = 1000

def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))] if xs else None

class Core:
    def __init__(self, row):
        self.home = root / '.scratch' / ('bq' + uuid.uuid4().hex[:5])
        self.home.mkdir(mode=0o700)
        assert len(str(self.home / 'core.sock').encode()) < 104, 'socket path too long'
        self.project = self.home / 'project'
        self.project.mkdir()
        self.env = clean_env({'NUNCHIRO_HOME': str(self.home), 'NUNCHIRO_WINDOW_ORIGINS': 'http://127.0.0.1:' + port, 'PATH': '/usr/bin:/bin'})
        for key in ('NUNCHIRO_TOKEN', 'NUNCHIRO_SESSION', 'NUNCHIRO_MACHINE'):
            self.env.pop(key, None)
        (self.home / 'board.toml').write_text(
            "version = 1\n[[columns]]\nid = 'working'\ntitle = 'Working'\nstates = ['working']\n"
            "[[columns]]\nid = 'ask'\ntitle = 'Needs decision'\nneeds_decision = true\nstates = ['needs_decision']\n"
            "[[columns]]\nid = 'done'\ntitle = 'Done'\nstates = ['done', 'review']\n"
            "[sources]\nversion = 1\n[[sources.entries]]\nname = 'roadmap'\nkind = 'file'\npath = " + json.dumps(str(self.home / 'cards.json')) + "\n"
            # One command source per run: a re-approved command waits for its interval (30 s floor) to run again.
            + ''.join(f"[[sources.entries]]\nname = 'cmd-{n}'\nkind = 'command'\nsubject = 'cmd-{n}'\n" for n in range(runs)))
        self.cards([])
        with open(self.home / 'core.log', 'wb') as log:
            self.proc = subprocess.Popen([binary, 'serve'], env=self.env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        until = time.monotonic() + 10
        while not (self.home / 'window.json').exists():
            if self.proc.poll() is not None or time.monotonic() > until:
                raise RuntimeError('core did not start')
            time.sleep(.05)
        try:
            self.token = (self.home / 'core.token').read_text().strip()
            self.session = self.cli('session', 'start', '--kind', 'shell', '--project', str(self.project), '--label', 'bq-' + row, '--', '/bin/cat')['session']
        except BaseException:
            # Never leave this core (and the shell it may have started) behind.
            self.session = None
            self.stop()
            raise
    def cli(self, *args):
        p = subprocess.run([binary, *args], env=self.env, capture_output=True, text=True, timeout=25)
        if p.returncode:
            raise RuntimeError(p.stderr.strip())
        return json.loads(p.stdout)
    def call(self, request):
        s = socket.socket(socket.AF_UNIX)
        s.settimeout(10)
        s.connect(str(self.home / 'core.sock'))
        s.sendall((json.dumps({'token': self.token, 'request': request}) + '\n').encode())
        data = b''
        while not data.endswith(b'\n'):
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
        s.close()
        reply = json.loads(data)
        if 'Err' in reply:
            raise RuntimeError(reply['Err'])
        return reply['Ok']
    def cards(self, cards):
        tmp = self.home / 'cards.tmp'
        tmp.write_text(json.dumps({'cards': cards}))
        os.replace(tmp, self.home / 'cards.json')
    def items(self):
        return self.cli('snapshot', '--json').get('board_decisions', [])
    def wait(self, key, present=True):
        """Polls `nunchiro snapshot --json` until the item `identity@updated_at` is (or is no longer) listed."""
        start = now()
        while now() - start < 3000:
            got = {f"{d['identity']}@{d['updated_at']}" for d in self.items()}
            if (key in got) == present:
                return now()
            time.sleep(.005)
        return None
    def stop(self):
        try:
            if self.session:
                self.cli('session', 'close', self.session['id'])
        except Exception:
            pass
        try:
            self.cli('serve', 'stop', '--yes')
        except Exception:
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.send_signal(signal.SIGTERM)
            self.proc.wait(timeout=5)

class Window:
    """The Playwright spec records when each board item first shows in the strip and in a tree row."""
    def __init__(self, core, row):
        self.seen_path = out / f'{row}.seen.json'
        self.done = out / f'{row}.done'
        live = {'home': str(core.home), 'seen': str(self.seen_path), 'done': str(self.done), 'ready': str(out / f'{row}.ready')}
        self.log = open(out / f'{row}.playwright.log', 'w')
        self.proc = subprocess.Popen(['pnpm', 'exec', 'playwright', 'test', 'board-queue-live', '--project', 'live', '--reporter', 'line'],
                                     cwd=root / 'web', env={**os.environ, 'PW_OPT_IN': 'live', 'NUNCHIRO_WEB_PORT': port, 'BOARD_LIVE': json.dumps(live)},
                                     stdout=self.log, stderr=subprocess.STDOUT)
        until = time.monotonic() + 240
        while not pathlib.Path(live['ready']).exists():
            if self.proc.poll() is not None or time.monotonic() > until:
                raise RuntimeError('window did not start; see ' + self.log.name)
            time.sleep(.2)
    def seen(self):
        try:
            return json.loads(self.seen_path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return {}
    def wait(self, key):
        """Both places, or 1.5 s: an item must not be resolved before the window could draw it."""
        until = time.monotonic() + 1.5
        while time.monotonic() < until:
            s = self.seen()
            if key in s.get('strip', {}) and key in s.get('tree', {}):
                return
            time.sleep(.02)
    def finish(self):
        self.done.write_text('done')
        try:
            self.proc.wait(timeout=120)
        except subprocess.TimeoutExpired:
            self.proc.terminate()
            self.proc.wait(timeout=10)
        self.log.close()
        return self.seen(), self.proc.returncode

def approve_command(core, n):
    d = core.home / 'sources' / f'cmd-{n}'
    d.mkdir(parents=True)
    (d / 'widget.toml').write_text("version = 1\nkind = 'integration'\ncommand = ['/bin/sh', 'run.sh']\n")
    card = {'id': f'cmd-{n}', 'title': f'Command card {n}', 'updated_at': n + 1, 'project': str(core.project), 'needs_decision': {'question': f'Approve command card {n}?'}}
    (d / 'run.sh').write_text("cat <<'EOF'\n" + json.dumps({'cards': [card]}) + "\nEOF\n")
    view = core.call({'op': 'board_source_status', 'name': f'cmd-{n}'})['view']
    core.call({'op': 'board_source_grant', 'name': f'cmd-{n}', 'level': 'read', 'hash': view['hash']})
    return f"integration:cmd-{n}:cmd-{n}@{n + 1}"

def run_row(row):
    core = Core(row)
    win = None
    marks = []  # (kind, key, t0, cli_at)
    errors = []
    try:
        if window:
            win = Window(core, row)
        def measure(kind, key, t0):
            at = core.wait(key)
            marks.append({'kind': kind, 'key': key, 't0': t0, 'cli': None if at is None else at - t0})
            if win:
                win.wait(key)
        def resolve(key):
            identity, updated = key.rsplit('@', 1)
            core.call({'op': 'board_resolve', 'identity': identity, 'updated_at': int(updated)})
            if core.wait(key, present=False) is None:
                errors.append(f'{key} still listed after resolve')
        for n in range(runs):
            if row == 'column-card':
                put = core.call({'op': 'board_put', 'id': None, 'title': f'Manual card {n}', 'session_id': core.session['id'], 'column': 'working'})
                card = next(c for c in put['board']['cards'] if c['source'] == 'manual')
                t0 = now()
                moved = core.call({'op': 'board_move', 'source': 'manual', 'id': card['id'], 'column': 'ask'})
                t0 = now()  # the ack
                updated = next(c for c in moved['board']['cards'] if c['id'] == card['id'])['updated_at']
                manual = f"manual:{card['id']}@{updated}"
                measure('manual', manual, t0)
                core.cards([{'id': f'col-{n}', 'title': f'Column card {n}', 'updated_at': n + 1, 'column': 'ask', 'project': str(core.project)}])
                file = f'integration:roadmap:col-{n}@{n + 1}'
                measure('file', file, now())
                resolve(manual)
                resolve(file)
                core.call({'op': 'board_delete', 'id': card['id']})
            elif row == 'needs-decision-card':
                core.cards([{'id': f'flag-{n}', 'title': f'Flag card {n}', 'updated_at': n + 1, 'project': str(core.project), 'needs_decision': {'question': f'결정할까요 {n}?'}}])
                file = f'integration:roadmap:flag-{n}@{n + 1}'
                measure('file', file, now())
                resolve(file)
                key = approve_command(core, n)
                measure('command', key, now())  # from the grant ack: includes the sandboxed run
                resolve(key)
            elif row == 'reraise':
                first = {'id': f're-{n}', 'title': f'Re-raise {n}', 'updated_at': 1, 'project': str(core.project), 'needs_decision': {'question': 'First?'}}
                core.cards([first])
                key = f'integration:roadmap:re-{n}@1'
                if core.wait(key) is None:
                    errors.append(f'{key} never raised')
                if win:
                    win.wait(key)
                resolve(key)
                core.cards([{**first, 'needs_decision': {'question': 'Same updated_at?'}}])
                time.sleep(.3)
                if any(d['identity'] == f'integration:roadmap:re-{n}' for d in core.items()):
                    errors.append(f're-{n}: same updated_at re-raised')
                core.cards([{**first, 'updated_at': 2, 'needs_decision': {'question': 'Again?'}}])
                again = f'integration:roadmap:re-{n}@2'
                measure('reraise', again, now())
                resolve(again)
    except Exception as e:
        errors.append(repr(e))
    finally:
        seen, code = win.finish() if win else ({}, None)
        core.stop()
    result = {'row': row, 'runs': runs, 'home': str(core.home), 'errors': errors, 'playwright': code, 'kinds': {}}
    for kind in sorted({m['kind'] for m in marks}):
        ms = [m for m in marks if m['kind'] == kind]
        entry = {'n': len(ms)}
        for where in ['cli'] + (['strip', 'tree'] if window else []):
            lat = [m['cli'] if where == 'cli' else (seen.get(where, {}).get(m['key'], None) and seen[where][m['key']] - m['t0']) for m in ms]
            ok = [x for x in lat if x is not None and x <= BOUND]
            entry[where] = {'miss': len(lat) - len(ok), 'p50': pct(ok, 50), 'p95': pct(ok, 95), 'max': max(ok) if ok else None}
        result['kinds'][kind] = entry
    result['pass'] = not errors and code in (0, None) and all(v['miss'] == 0 for k in result['kinds'].values() for w, v in k.items() if w != 'n') and len(marks) > 0
    if result['pass']:
        shutil.rmtree(core.home, ignore_errors=True)
    return result

receipt = {'check': 'v1b-board-queue', 'runs': runs, 'window': window, 'port': port, 'rows': [run_row(r) for r in rows]}
receipt['pass'] = all(r['pass'] for r in receipt['rows'])
(out / 'receipt.json').write_text(json.dumps(receipt, indent=1))
print(f"{'row':22} {'kind':8} {'where':6} {'n':>3} {'miss':>4} {'p50':>6} {'p95':>6} {'max':>6}")
for r in receipt['rows']:
    for kind, e in r['kinds'].items():
        for where, v in e.items():
            if where != 'n':
                fmt = lambda x: '-' if x is None else f'{x:.0f}'
                print(f"{r['row']:22} {kind:8} {where:6} {e['n']:>3} {v['miss']:>4} {fmt(v['p50']):>6} {fmt(v['p95']):>6} {fmt(v['max']):>6}")
    for e in r['errors']:
        print(f"{r['row']}: ERROR {e}")
print('receipt', out / 'receipt.json')
print('PASS' if receipt['pass'] else 'FAIL')
sys.exit(0 if receipt['pass'] else 1)
PY
