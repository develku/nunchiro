#!/bin/sh
# V2-1b: agents survive a core restart or update, with real `claude` (Haiku) and `codex` through the ticket-01 guard.
# Phases (PHASES, space separated; default all):
#   core_kill9_30x_reattach   3 agents (Claude, Codex, shell) + one pending Claude permission, KILLS core kill -9s:
#                             same pids, reattach < 2 s, scrollback intact, waiting count 1 in every snapshot, the
#                             permission answerable only after fresh proof and answered once, 0 replays; the agent's
#                             CLI call and hook post work after each restart and fail after close.
#   serve_restart_new_build   a newer build installed over the core's executable, `serve restart`: same pids, ids,
#                             tokens.
#   full_quit_leaves_nothing  after a restart, `serve stop --yes` leaves no holder, core, claude or codex of this run.
#   holder_kill9_30x_no_ghost KILLS holder kill -9s: never a running ghost; each Claude session becomes resumable.
# Load rule: each phase starts only under a 1-min load of 15 (one retry after 60 s, then "not run: load"); a phase
# whose load passes 20 stops. KILLS defaults to 30. REATTACH_PROJECT: an already trusted project (default: this repo).
set -eu
cd "$(dirname "$0")/../.."
export CARGO_HOME="${CARGO_HOME:-$PWD/.scratch/cargo-home}"
unset CARGO_TARGET_DIR
cargo build -q -j 2 -p nunchiro
exec python3 -B - "$@" <<'PY'
import json, os, pathlib, re, shutil, socket, subprocess, sys, time, uuid
sys.path.insert(0, 'scripts/scenario')
from lib import clean_env, snapshot, guard_check, visible
root = pathlib.Path.cwd()
built = str(root / 'target/debug/nunchiro')
kills = int(os.environ.get('KILLS', '30'))
project = os.environ.get('REATTACH_PROJECT', str(root))
phases = os.environ.get('PHASES', 'core_kill9_30x_reattach serve_restart_new_build full_quit_leaves_nothing holder_kill9_30x_no_ghost').split()
PROMPT = r'❯\s+Try|(?:manual|auto) mode on|for shortcuts'

def load(): return float(subprocess.run(['sysctl', '-n', 'vm.loadavg'], capture_output=True, text=True).stdout.split()[1])
def alive(pid):
    try: os.kill(pid, 0)
    except ProcessLookupError: return False
    st = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(st) and not st.startswith('Z')
def tagged(run):
    out = subprocess.run(['ps', '-Eww', '-A', '-o', 'pid=,command='], capture_output=True, text=True).stdout
    return sorted(int(l.split()[0]) for l in out.splitlines() if 'NUNCHIRO_HOME=' + str(run) + ' ' in l + ' ')

class Run:
    def __init__(self, name, binary=built):
        self.dir = root / '.scratch' / ('ra' + uuid.uuid4().hex[:5])
        self.dir.mkdir(parents=True)
        assert len(str(self.dir / 'core.sock').encode()) < 104
        self.binary = binary
        self.env = clean_env({'NUNCHIRO_HOME': str(self.dir), 'NUNCHIRO_BIN': built})
        for key in ('NUNCHIRO_TOKEN', 'NUNCHIRO_SESSION'): self.env.pop(key, None)
        self.core = None
        self.name = name
    def cli(self, *args, env=None, check=True, binary=None):
        p = subprocess.run([binary or self.binary, *args], env=env or self.env, capture_output=True, text=True, timeout=30)
        if check and p.returncode: raise RuntimeError(f'{args}: ' + (p.stderr.strip() or p.stdout.strip()))
        return p
    def json(self, *args): return json.loads(self.cli(*args).stdout)
    def start_core(self):
        log = open(self.dir / 'core.out', 'ab')
        self.core = subprocess.Popen([self.binary, 'serve'], env=self.env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        until = time.monotonic() + 10
        while True:
            try:
                with socket.socket(socket.AF_UNIX) as s: s.connect(str(self.dir / 'core.sock'))
                return time.monotonic()
            except OSError: pass
            if self.core.poll() is not None or time.monotonic() > until: raise RuntimeError('core did not start')
            time.sleep(.02)
    def kill_core(self):
        self.core.kill(); self.core.wait(timeout=10)
    def sessions(self): return {s['id']: s for s in self.json('snapshot', '--json')['sessions']}
    def screen(self, sid): return visible(bytes(self.json('session', 'read', sid)['data']))
    def wait_for(self, sid, pattern, timeout=100):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            text = self.screen(sid)
            if re.search(r'Is this a project you created or one you trust|Allow external CLAUDE.md file imports', text):
                raise RuntimeError('startup trust dialog: use an already trusted project via REATTACH_PROJECT')
            if re.search(pattern, text, re.I | re.S): return text
            time.sleep(.2)
        raise RuntimeError(f'timed out waiting for {pattern}')
    def start(self, kind, *extra, label='ra'):
        return self.json('session', 'start', '--kind', kind, '--project', project, '--label', label, *extra)['session']
    def owner(self, request):
        token = (self.dir / 'core.token').read_text()
        with socket.socket(socket.AF_UNIX) as s:
            s.connect(str(self.dir / 'core.sock'))
            s.sendall(json.dumps({'token': token, 'request': request}).encode() + b'\n')
            return json.loads(s.makefile().readline())
    def holders(self):
        live = json.loads((self.dir / 'sessions.json').read_text()).get('live', {})
        return {sid: l['holder']['pid'] for sid, l in live.items() if l.get('holder')}
    def finish(self, rec):
        try:
            if self.core and self.core.poll() is None: self.cli('serve', 'stop', '--yes', check=False); self.core.wait(timeout=15)
        except Exception: pass
        left = tagged(self.dir)
        rec['tagged_after'] = left
        for pid in left:
            rec['pass'] = False
            try: os.kill(pid, 9)
            except ProcessLookupError: pass
        (self.dir / 'result.json').write_text(json.dumps(rec, indent=2, ensure_ascii=False))

def gated(fn):
    def phase():
        if load() >= 15:
            time.sleep(60)
            if load() >= 15: return {'phase': fn.__name__, 'pass': None, 'error': f'not run: load {load():.1f}'}
        rec = {'phase': fn.__name__, 'pass': False, 'load_start': load()}
        guard_before = snapshot()
        try:
            fn(rec); rec['pass'] = True
        except Exception as error:
            rec['error'] = str(error)
        rec['load_end'] = load()
        problems, _ = guard_check(guard_before, snapshot(), [str(root / '.scratch'), project, str(root / 'scripts/scenario')])
        rec['guard_problems'] = problems
        if problems: rec['pass'] = False
        return rec
    phase.__name__ = fn.__name__
    return phase

def shell_probe(r):
    # A shell agent that prints its token (test only) and, per line it reads, runs the CLI and a hook post as itself.
    script = ('printf "tok:%s\\n" "$NUNCHIRO_TOKEN"; while read l; do '
              '"$NUNCHIRO_BIN" session list >/dev/null 2>&1; c=$?; '
              'echo "{}" | "$NUNCHIRO_BIN" hook Notification 2>"$NUNCHIRO_HOME/hook.err"; '
              'printf "ran %s cli=%s hookerr=%s\\n" "$l" "$c" "$(wc -c < "$NUNCHIRO_HOME/hook.err" | tr -d " ")"; done')
    s = r.start('shell', '--', '/bin/sh', '-c', script, label='probe')
    text = r.wait_for(s['id'], r'tok:\S+')
    return s, re.search(r'tok:(\S+)', text).group(1)

@gated
def core_kill9_30x_reattach(rec):
    r = Run('kill9')
    try:
        r.start_core()
        claude = r.start('claude', '--model', 'haiku', label='claude')
        codex = r.start('codex', label='codex')
        probe, token = shell_probe(r)
        r.wait_for(claude['id'], PROMPT)
        r.wait_for(codex['id'], r'›|codex|OpenAI', timeout=60)
        probe_file = pathlib.Path(project) / f'.nunchiro-reattach-{r.dir.name}'
        r.cli('session', 'send-text', claude['id'], f'\x1b[200~Use the Bash tool to run exactly: touch {probe_file}\x1b[201~')
        time.sleep(.8); r.cli('session', 'send-keys', claude['id'], 'enter')
        until = time.monotonic() + 90
        while sum(len(s['pending']) for s in r.sessions().values()) != 1:
            if time.monotonic() > until: raise RuntimeError('no pending Claude permission')
            time.sleep(.3)
        ids = [claude['id'], codex['id'], probe['id']]
        pids = {sid: r.sessions()[sid]['pid'] for sid in ids}
        marks = {sid: r.screen(sid)[-200:] for sid in ids}
        rec['reattach_s'] = []
        rec['waiting_counts'] = set()
        for n in range(kills):
            if load() > 20: raise RuntimeError(f'load {load():.1f} past 20 at kill {n}')
            r.kill_core()
            started = r.start_core()
            while True:
                snap = r.sessions()
                rec['waiting_counts'].add(sum(len(s['pending']) for s in snap.values()))
                if all(snap[sid]['state'] == 'running' for sid in ids): break
                if time.monotonic() - started > 10: raise RuntimeError(f'kill {n}: not reattached')
            rec['reattach_s'].append(round(time.monotonic() - started, 3))
            for sid in ids:
                assert snap[sid]['pid'] == pids[sid], f'kill {n}: pid changed for {sid}'
                assert marks[sid][-60:] in r.screen(sid), f'kill {n}: scrollback lost for {sid}'
            item = [d for s in snap.values() for d in s['pending']]
            assert len(item) == 1 and not item[0]['actionable'], f'kill {n}: restored item {item}'
            r.cli('session', 'send-text', probe['id'], f'k{n}\r')
            r.wait_for(probe['id'], rf'ran k{n} cli=0 hookerr=0\b', timeout=20)
        rec['waiting_counts'] = sorted(rec['waiting_counts'])
        assert rec['waiting_counts'] == [1], f'waiting count {rec["waiting_counts"]}'
        assert max(rec['reattach_s']) < 2, f'slowest reattach {max(rec["reattach_s"])} s'
        # Fresh proof after the last restart: a resize makes Claude redraw its prompt; the item comes back answerable.
        r.cli('session', 'resize', claude['id'], '150', '45')
        until = time.monotonic() + 30
        while True:
            item = [d for s in r.sessions().values() for d in s['pending']]
            if item and item[0]['actionable']: break
            if time.monotonic() > until: raise RuntimeError('the restored permission was never proved again')
            time.sleep(.3)
        reply = r.owner({'op': 'answer', 'item': item[0]['id'], 'answer': {'type': 'allow_once'}})
        assert 'Ok' in reply, reply
        until = time.monotonic() + 60
        while not probe_file.exists():
            if time.monotonic() > until: raise RuntimeError('the answered command never ran')
            time.sleep(.3)
        # 0 replays: with the file gone, one more restart must not run the answered command again.
        probe_file.unlink()
        r.kill_core(); r.start_core(); time.sleep(3)
        rec['replays'] = int(probe_file.exists())
        assert rec['replays'] == 0, 'a saved answer was replayed'
        r.cli('session', 'close', probe['id'])
        out = r.cli('session', 'list', env={**r.env, 'NUNCHIRO_TOKEN': token, 'NUNCHIRO_SESSION': probe['id']}, check=False)
        assert out.returncode != 0, 'the closed session token still works'
        hook = subprocess.run([built, 'hook', 'Notification'], input='{}', env={**r.env, 'NUNCHIRO_TOKEN': token, 'NUNCHIRO_SESSION': probe['id']}, capture_output=True, text=True)
        assert 'unauthorized' in hook.stderr, 'the closed session hook still posts'
    finally:
        r.finish(rec)

@gated
def serve_restart_new_build(rec):
    r = Run('restart')
    installed = r.dir / 'bin' / 'nunchiro'
    installed.parent.mkdir()
    shutil.copy2(built, installed)
    r.binary = str(installed)
    try:
        r.start_core()
        claude = r.start('claude', '--model', 'haiku', label='claude')
        probe, token = shell_probe(r)
        r.wait_for(claude['id'], PROMPT)
        before = {sid: s['pid'] for sid, s in r.sessions().items()}
        fresh = installed.with_suffix('.new'); shutil.copy2(built, fresh); os.replace(fresh, installed)
        r.cli('serve', 'restart')
        r.core.wait(timeout=15)
        after = {sid: s['pid'] for sid, s in r.sessions().items() if s['state'] == 'running'}
        assert after == before, f'{before} -> {after}'
        r.cli('session', 'send-text', probe['id'], 'r1\r')
        r.wait_for(probe['id'], r'ran r1 cli=0 hookerr=0\b', timeout=20)
        r.core = None  # the new core is not our child; finish stops it through the CLI
    finally:
        r.finish(rec)

@gated
def full_quit_leaves_nothing(rec):
    r = Run('quit')
    try:
        r.start_core()
        claude = r.start('claude', '--model', 'haiku', label='claude')
        codex = r.start('codex', label='codex')
        r.wait_for(claude['id'], PROMPT)
        r.wait_for(codex['id'], r'›|codex|OpenAI', timeout=60)
        r.kill_core(); r.start_core()
        assert all(s['state'] == 'running' for s in r.sessions().values())
        owned = set(tagged(r.dir))
        rec['owned'] = sorted(owned)
        r.cli('serve', 'stop', '--yes'); r.core.wait(timeout=15)
        until = time.monotonic() + 15
        while any(alive(p) for p in owned) and time.monotonic() < until: time.sleep(.1)
        rec['survivors'] = [p for p in owned if alive(p)]
        assert not rec['survivors'], 'processes survived the full quit'
        names = subprocess.run(['ps', '-Eww', '-A', '-o', 'pid=,comm=,command='], capture_output=True, text=True).stdout
        assert 'NUNCHIRO_HOME=' + str(r.dir) + ' ' not in names, 'a process of this run is still running'
        assert not list((r.dir / 'holders').glob('*.sock')), 'holder sockets left'
    finally:
        r.finish(rec)

@gated
def holder_kill9_30x_no_ghost(rec):
    r = Run('holder')
    try:
        r.start_core()
        rec['states'] = []
        for n in range(kills):
            if load() > 20: raise RuntimeError(f'load {load():.1f} past 20 at kill {n}')
            s = r.start('claude', '--model', 'haiku', label=f'h{n}')
            r.wait_for(s['id'], PROMPT)
            holder = r.holders()[s['id']]
            agent = r.sessions()[s['id']]['pid']
            os.kill(holder, 9)
            until = time.monotonic() + 10
            while r.sessions()[s['id']]['state'] == 'running':
                if time.monotonic() > until: raise RuntimeError(f'kill {n}: ghost running session')
                time.sleep(.1)
            state = r.sessions()[s['id']]['state']
            rec['states'].append(state)
            assert state == 'resumable', f'kill {n}: {state}'
            until = time.monotonic() + 5
            while alive(agent) and time.monotonic() < until: time.sleep(.1)
            assert not alive(agent), f'kill {n}: agent outlived its holder'
            r.cli('session', 'close', s['id'])
    finally:
        r.finish(rec)

results = []
for phase in [globals()[p] for p in phases]:
    rec = phase(); results.append(rec)
    print(json.dumps(rec, default=list), flush=True)
print(json.dumps({'check': 'reattach', 'kills': kills, 'phases': {r['phase']: r['pass'] for r in results}}))
sys.exit(0 if all(r['pass'] for r in results) else 1)
PY
