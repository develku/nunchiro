#!/bin/sh
# Ticket v1b-07, spec Acceptance 8 with real agents. Rows:
#   claude-chart  Claude Haiku given only the artifact skill (through --plugin-dir) and "make an HTML bar chart of these
#                 numbers" writes an .html file into $NUNCHIRO_HOME/artifacts/<session>/; no permission item in
#                 `snapshot --json` and no permission prompt on screen at any poll; the chat page carries its
#                 `artifact` event (root "data") and 06's card renders it inline (web/tests/artifacts-live.spec.ts).
#                 Runs with `--permission-mode default` (session-only flag) so a user's own auto or accept-edits mode
#                 cannot hide a prompt.
#   codex-chart   the same with Codex (cheapest model). Codex has no --plugin-dir and ruling 17:36 forbids writing
#                 ~/.codex, so the skill reaches it by prompt: "skill by prompt (ruling 17:36 limit)". Not run when
#                 ~/.agents/policies/usage.sh shows no headroom.
#   repo-clean    after both rows the project folder holds exactly the same files with the same bytes (hidden and
#                 ignored ones included). Claude keys folder trust on the git root, so a fresh scratch repo would always
#                 show the trust dialog, which is never answered; the project is therefore a plain folder inside a
#                 trusted checkout, and this tree comparison stands in for (and is stricter than) `git status --porcelain`.
#   guard-claude, guard-codex  the ticket-01 guard (settings, hooks, trust) plus the bytes of ~/.claude/skills and
#                 ~/.codex/skills: unchanged.
# ROWS picks agent rows (default both). ARTIFACT_PROJECT_ROOT: a folder inside a repo Claude already trusts (no trust
# dialog is ever answered); default .scratch.
set -eu
cd "$(dirname "$0")/../.."
export CARGO_HOME="${CARGO_HOME:-$PWD/.scratch/cargo-home}"
unset CARGO_TARGET_DIR
cargo build -q -j 2 -p nunchiro
exec python3 -B - "$@" <<'PY'
import hashlib, json, os, pathlib, re, shutil, subprocess, sys, threading, time, uuid
sys.path.insert(0, 'scripts/scenario')
from lib import CODEX_MODEL, clean_env, snapshot, guard_check, descendants, visible, GUARDED
root = pathlib.Path.cwd()
binary = str(root / 'target/debug/nunchiro')
rows = os.environ.get('ROWS', 'claude-chart codex-chart').split()
project_root = pathlib.Path(os.environ.get('ARTIFACT_PROJECT_ROOT', str(root / '.scratch')))
port = os.environ.get('NUNCHIRO_WEB_PORT', '4194')
out = root / '.scratch' / ('artifact-skill-' + time.strftime('%Y%m%d-%H%M%S'))
out.mkdir(parents=True)
SKILL = root / 'plugin/skills/artifacts/SKILL.md'
NUMBERS = 'Mon 3, Tue 5, Wed 2, Thu 6'
PROMPT = f'make an HTML bar chart of these numbers: {NUMBERS}'
READY = {'claude': r'❯\s+Try|(?:manual|auto|accept edits) (?:mode )?on|for shortcuts|\? for shortcuts', 'codex': r'Ask Codex to do anything|% context left|context left'}
# Claude's and Codex's approval dialogs (Codex: "Would you like to run the following command?", "... make the following
# edits?"); the screen is the whole replay, so any dialog shown during the turn stays matched.
PROMPTED = re.compile(r'Do you want to (?:create|make this edit|proceed)|Would you like to (?:run|make|allow)|Esc to cancel · Tab to amend')
TRUST = re.compile(r'Is this a project you created or one you trust|Do you trust the files|Allow external CLAUDE.md file imports|Trust this folder\?')

def tree(path):
    """sha256 over every file name and its bytes under `path` (no symlinks followed); None when absent."""
    p = pathlib.Path(path)
    if not p.exists():
        return None
    h = hashlib.sha256()
    for f in sorted(x for x in p.rglob('*') if not x.is_symlink()):
        h.update(str(f.relative_to(p)).encode() + b'\0')
        if f.is_file():
            h.update(f.read_bytes())
    return h.hexdigest()

SKILL_DIRS = [os.path.expanduser(p) for p in ('~/.claude/skills', '~/.codex/skills')]
def guard_state():
    return snapshot(), {d: tree(d) for d in SKILL_DIRS}

before, skills_before = guard_state()
receipt = {'check': 'v1b-artifact-skill', 'claude': subprocess.run(['claude', '--version'], capture_output=True, text=True).stdout.strip(),
           'codex': subprocess.run(['codex', '--version'], capture_output=True, text=True).stdout.strip(),
           'rows': {}, 'pass': False, 'config_before': {k: before[k] for k in GUARDED}, 'skills_before': skills_before}
ours = [str(out), str(root / 'scripts/scenario')]

def headroom():
    """Codex 5h usage below 95% on the default home, from the shared usage script; unknown counts as none."""
    try:
        text = subprocess.run(['bash', os.path.expanduser('~/.agents/policies/usage.sh')], capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return False, 'usage.sh failed'
    line = next((l for l in text.splitlines() if l.startswith('codex .codex')), '')
    m = re.search(r'5h (\d+)%', line)
    return (bool(m) and int(m.group(1)) < 95), line.strip() or 'no codex line'

def files(project):
    return {str(p.relative_to(project)): (hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else 'dir') for p in project.rglob('*')}

tag = uuid.uuid4().hex[:5]
project = project_root / ('art-proj-' + tag)
project.mkdir(parents=True)
ours.append(str(project))
(project / 'README.md').write_text('artifact skill scenario project\n')
(project / 'src').mkdir()
(project / 'src' / 'main.py').write_text('print("hi")\n')
project_before = files(project)

def one(agent):
    home = root / '.scratch' / ('a' + uuid.uuid4().hex[:5])
    home.mkdir(mode=0o700)
    assert len(str(home / 'core.sock').encode()) < 104, 'socket path too long'
    env = clean_env({'NUNCHIRO_HOME': str(home), 'NUNCHIRO_WINDOW_ORIGINS': 'http://127.0.0.1:' + port})
    for key in ('NUNCHIRO_TOKEN', 'NUNCHIRO_SESSION'):
        env.pop(key, None)
    def cli(*args, timeout=25):
        p = subprocess.run([binary, *args], env=env, capture_output=True, text=True, timeout=timeout)
        if p.returncode:
            raise RuntimeError(p.stderr.strip() or p.stdout.strip())
        return json.loads(p.stdout)
    row = {'agent': agent, 'home': str(home), 'pass': False, 'skill': 'plugin-dir' if agent == 'claude' else 'skill by prompt (ruling 17:36 limit)'}
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
            s = cli('session', 'start', '--kind', 'claude', '--project', str(project), '--model', 'haiku', '--label', 'chart', '--',
                    '--permission-mode', 'default')['session']
            prompt = PROMPT
        else:
            # Trust for this run only, as a -c override: nothing is written to ~/.codex and no dialog is answered.
            s = cli('session', 'start', '--kind', 'codex', '--project', str(project), '--model', CODEX_MODEL, '--label', 'chart', '--',
                    '-c', 'model_reasoning_effort="low"', '-c', f'projects."{project}".trust_level="trusted"')['session']
            prompt = f'Read the skill file {SKILL} and follow it. Then {PROMPT}'
        row['session'], row['agent_pid'] = s['id'], s['pid']
        folder = home / 'artifacts' / s['id']
        row['folder_mode'] = oct(folder.stat().st_mode & 0o777) if folder.exists() else None
        until = time.monotonic() + 100
        while True:
            text = visible(bytes(cli('session', 'read', s['id'])['data']))
            if TRUST.search(text):
                raise RuntimeError('trust dialog (never answered): ' + text[-800:])
            if re.search(READY[agent], text, re.I):
                break
            if time.monotonic() > until:
                raise RuntimeError('agent not ready')
            time.sleep(.2)
        time.sleep(1 if agent == 'claude' else 4)
        seen = {'pending': [], 'prompts': []}
        done = threading.Event()
        def watch():
            last = False
            while not last:
                last = done.is_set()  # one more sample after the turn ends, so a final dialog is always seen
                try:
                    me = next(x for x in cli('snapshot', '--json')['sessions'] if x['id'] == s['id'])
                    if me.get('pending'):
                        seen['pending'].append(me['pending'])
                    screen = visible(bytes(cli('session', 'read', s['id'])['data']))[-3000:]
                    if PROMPTED.search(screen):
                        seen['prompts'].append(screen[-600:])
                except Exception as e:
                    seen.setdefault('watch_errors', []).append(str(e))
                done.wait(1)
        w = threading.Thread(target=watch, daemon=True)
        w.start()
        try:
            # `agent prompt` writes text and Enter in one burst, which Claude takes as a paste (general-parity.sh): paste,
            # pause, then Enter, as quit.sh does.
            cli('session', 'send-text', s['id'], '\x1b[200~' + prompt + '\x1b[201~')
            time.sleep(.8)
            cli('session', 'send-keys', s['id'], 'enter')
            turn = os.environ.get('TURN_MS', '300000')
            r = cli('agent', 'wait', s['id'], '--until', 'done', '--until', 'blocked', '--timeout', turn, timeout=int(turn) // 1000 + 20)
        finally:
            done.set()
            w.join()
        row['status'] = r.get('status') or r.get('agent', {}).get('status')
        row['pending_seen'], row['prompts_seen'] = seen['pending'], seen['prompts']
        html = sorted(str(p.relative_to(folder)) for p in folder.rglob('*.htm*')) if folder.exists() else []
        row['html'] = html
        result = out / f'{agent}.json'
        live = {'home': str(home), 'session': s['id'], 'paths': [f'artifacts/{s["id"]}/{h}' for h in html], 'out': str(result)}
        p = subprocess.run(['pnpm', 'exec', 'playwright', 'test', 'artifacts-live', '--project', 'live', '--reporter', 'line'],
                           cwd=root / 'web', env={**os.environ, 'PW_OPT_IN': 'live', 'NUNCHIRO_WEB_PORT': port, 'ARTIFACT_LIVE': json.dumps(live)},
                           capture_output=True, text=True, timeout=300)
        (out / f'{agent}.playwright.log').write_text(p.stdout + p.stderr)
        if result.exists():
            row.update(json.loads(result.read_text()))
        row['pass'] = (p.returncode == 0 and bool(html) and row['folder_mode'] == '0o700'
                       and not seen['pending'] and not seen['prompts'] and row['status'] in ('done', 'idle'))
        if p.returncode:
            row['error'] = (p.stdout + p.stderr).strip().splitlines()[-12:]
    except Exception as error:
        row['error'] = str(error)
        row['pass'] = False
    finally:
        if core is not None and 'session' in row:
            try: row['screen'] = visible(bytes(cli('session', 'read', row['session'])['data']))[-1500:]
            except Exception as e: row['screen'] = f'unreadable: {e}'
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
    return row

try:
    ran = []
    for name in rows:
        agent = name.split('-')[0]
        if agent == 'codex':
            ok, why = headroom()
            if not ok:
                receipt['rows'][name] = {'status': 'not run', 'why': 'no Codex headroom: ' + why}
                print(json.dumps({'row': name, 'status': 'not run', 'why': why}), flush=True)
                continue
        r = one(agent)
        ran.append(agent)
        receipt['rows'][name] = {'status': 'pass' if r['pass'] else 'FAIL', 'run': r}
        print(json.dumps({'row': name, **{k: r.get(k) for k in ('pass', 'skill', 'status', 'html', 'event', 'card', 'pending_seen', 'prompts_seen', 'error')}}, ensure_ascii=False), flush=True)
    now = files(project)
    clean = {'new_files': sorted(set(now) - set(project_before)), 'changed': sorted(k for k in project_before if now.get(k) != project_before[k]), 'after': ran}
    receipt['rows']['repo-clean'] = {'status': 'pass' if ran and not clean['new_files'] and not clean['changed'] else ('not run' if not ran else 'FAIL'), **clean}
    print(json.dumps({'row': 'repo-clean', 'status': receipt['rows']['repo-clean']['status'], **clean}), flush=True)
finally:
    after, skills_after = guard_state()
    problems, foreign = guard_check(before, after, ours)
    for d in SKILL_DIRS:
        if skills_before[d] != skills_after[d]:
            problems.append(f'{d}: bytes changed')
    for name, prefix in (('guard-claude', os.path.expanduser('~/.claude')), ('guard-codex', os.path.expanduser('~/.codex'))):
        mine = [p for p in problems if p.startswith(prefix) or (prefix.endswith('.claude') and '.claude.json' in p)]
        receipt['rows'][name] = {'status': 'FAIL' if mine else 'pass', 'problems': mine}
        print(json.dumps({'row': name, 'status': receipt['rows'][name]['status'], 'problems': mine}), flush=True)
    receipt['config_after'], receipt['skills_after'] = {k: after[k] for k in GUARDED}, skills_after
    receipt['guard_problems'], receipt['guard_foreign'] = problems, foreign
    receipt['pass'] = (not problems and all(r['status'] in ('pass', 'not run') for r in receipt['rows'].values())
                       and receipt['rows'].get('claude-chart', {}).get('status') == 'pass')
    shutil.rmtree(project, ignore_errors=True)
    (out / 'result.json').write_text(json.dumps(receipt, indent=2, ensure_ascii=False))
    print('pass' if receipt['pass'] else 'FAIL', 'guard problems:', problems)
    print('receipt:', out / 'result.json')
sys.exit(0 if receipt['pass'] else 1)
PY
