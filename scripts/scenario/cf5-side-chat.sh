#!/bin/sh
# Deterministic launch/PTY and same-user authority probe. Fake agents, real core and agent CLI.
set -eu
cd "$(dirname "$0")/../.."
exec python3 -B - <<'PY'
import json, os, shutil, socket, subprocess, sys, tempfile, time
from pathlib import Path

root = Path.cwd()
out = root / '.scratch/side-chat/scenario'
out.mkdir(parents=True, exist_ok=True)
home = Path(tempfile.mkdtemp(prefix='ns-cf5-'))  # core.sock's macOS length exception
project = out / ('project-' + str(os.getpid()))
project.mkdir(exist_ok=True)
sentinel = out / 'home'
sentinel.mkdir(exist_ok=True)
binary = root / 'target/debug/nunchiro'
bin_dir = home / 'bin'
bin_dir.mkdir()
(home/'codex-home').mkdir()
(home/'claude-home').mkdir()
fake = '''#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path
if '--version' in sys.argv:
    print('2.1.310 (Claude Code)'); raise SystemExit
h = Path(os.environ['NUNCHIRO_HOME'])
sid = os.environ['NUNCHIRO_SESSION']
(h / ('launch-' + sid)).write_text(json.dumps(sys.argv[1:]))
(h / ('token-' + sid)).write_text(os.environ['NUNCHIRO_TOKEN'])
print('─' * 80 + '\\r\\n❯ \\r\\n' + '─' * 80, flush=True)
for line in sys.stdin:
    (h / ('input-' + sid)).write_text(line)
    if line.strip() == 'PROBE':
        Path('direct-edit').write_text('allowed')
        shell = subprocess.run(['/bin/sh', '-c', 'printf allowed > shell-write'], check=False)
        delegated = subprocess.run([os.environ['CF5_BINARY'], 'session', 'start', '--kind', 'shell', '--project', os.getcwd(), '--label', 'delegated', '--', '/bin/sh', '-c', 'printf allowed > delegated-write'], capture_output=True, text=True)
        Path('authority.json').write_text(json.dumps({'direct_edit':'allowed','shell_write_exit':shell.returncode,'delegation_exit':delegated.returncode,'delegation_reply':delegated.stdout}))
'''
agent = bin_dir / 'claude'
agent.write_text(fake)
agent.chmod(0o700)
env = {k: v for k, v in os.environ.items() if not k.startswith(('NUNCHIRO_', 'CLAUDE', 'CODEX_', 'ANTHROPIC_'))}
env.update(HOME=str(sentinel), NUNCHIRO_HOME=str(home), NUNCHIRO_LOGIN_PATH='off', CLAUDE_CONFIG_DIR=str(home/'claude-home'), CODEX_HOME=str(home/'codex-home'), PATH=str(bin_dir)+':/usr/bin:/bin', CF5_BINARY=str(binary))
proc = subprocess.Popen([str(binary), 'serve'], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
def wait(f, label):
    end = time.monotonic() + 20
    while time.monotonic() < end:
        if f(): return
        time.sleep(.05)
    raise AssertionError(label)
def call(request):
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(20)
        s.connect(str(home/'core.sock'))
        s.sendall((json.dumps({'token':(home/'core.token').read_text().strip(),'request':request})+'\n').encode())
        data = b''
        while not data.endswith(b'\n'):
            part = s.recv(65536)
            assert part, 'core disconnected'
            data += part
    reply = json.loads(data)
    assert 'Ok' in reply, reply
    return reply['Ok']
passed = False
try:
    wait(lambda: (home/'core.sock').exists(), 'core ready')
    start = {'kind':'claude','project':str(project),'resume':None,'model':None,'effort':None}
    main = call({'op':'start','session':start})['session']
    side = call({'op':'start','session':{**start,'label':'Side chat','args':['--permission-mode','plan']}})['session']
    wait(lambda: (home/('launch-'+side['id'])).exists(), 'plan launch')
    assert side['id'] != main['id'] and side['cwd'] == main['cwd']
    args = json.loads((home/('launch-'+side['id'])).read_text())
    assert args[-2:] == ['--permission-mode','plan'], args
    assert not (home/('input-'+side['id'])).exists(), 'launch typed input'
    print('side_chat_starts_in_plan_mode PASS; nothing_auto_sends PASS')
    call({'op':'send_text','id':side['id'],'text':'PROBE'})
    call({'op':'send_keys','id':side['id'],'keys':['enter']})
    wait(lambda: (project/'authority.json').exists() and (project/'delegated-write').exists(), 'authority results')
    results = json.loads((project/'authority.json').read_text())
    assert results['direct_edit'] == 'allowed' and results['shell_write_exit'] == 0 and results['delegation_exit'] == 0, results
    assert all((project/p).read_text() == 'allowed' for p in ['direct-edit','shell-write','delegated-write'])
    (out/'authority.json').write_text(json.dumps(results, indent=2)+'\n')
    print('side_chat_authority_boundary PASS: direct edit ALLOWED; shell write ALLOWED; agent CLI delegation ALLOWED')
    print('LIMIT: deterministic Claude fixture, not a live Claude tool-policy enforcement measurement. Needs 47 remains in force.')
    codex = shutil.which('codex')
    if codex:
        probe_env = {**env, 'NUNCHIRO_SESSION': side['id'], 'NUNCHIRO_TOKEN': (home/('token-'+side['id'])).read_text()}
        commands = {
            'direct_edit': [sys.executable, '-c', "from pathlib import Path; Path('codex-direct').write_text('probe')"],
            'shell_write': ['/bin/sh', '-c', 'printf probe > codex-shell'],
            'delegation': [str(binary), 'session', 'start', '--kind', 'shell', '--project', str(project), '--label', 'codex-delegation', '--', '/bin/sh', '-c', 'printf delegated > codex-delegated'],
        }
        probes = {}
        for name, command in commands.items():
            run = subprocess.run([codex, 'sandbox', '-c', 'sandbox_mode="read-only"', '--', *command], cwd=project, env=probe_env, capture_output=True, text=True, timeout=30)
            probes[name] = {'exit': run.returncode, 'stdout': run.stdout, 'stderr': run.stderr}
            print('installed_codex_read_only', name, 'ALLOWED' if run.returncode == 0 else 'REFUSED', 'exit', run.returncode)
        assert 'Operation not permitted' in probes['direct_edit']['stderr'], probes
        assert 'Operation not permitted' in probes['shell_write']['stderr'], probes
        assert probes['direct_edit']['exit'] != 0 and not (project/'codex-direct').exists(), probes
        assert probes['shell_write']['exit'] != 0 and not (project/'codex-shell').exists(), probes
        (out/'installed-codex.json').write_text(json.dumps(probes, indent=2)+'\n')
    else:
        print('installed_codex_read_only NOT RUN: codex is not installed')
    passed = True
finally:
    try:
        for session in call({'op':'snapshot'})['sessions']:
            call({'op':'close','id':session['id']})
    except (OSError, AssertionError): pass
    try: call({'op':'stop'})
    except (OSError, AssertionError): pass
    try: proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill(); proc.wait()
    if passed: shutil.rmtree(home)
PY
