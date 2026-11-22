#!/bin/sh
# V2-8a `worktree_create_open_remove_matches_cli_state`: create, open and remove one worktree through the window's
# path (the loopback WebSocket the web app uses) in one home, and through `nunchiro worktree ...` in another, from
# identical repos; both must leave the same `git worktree list --porcelain` and branch state (remove keeps the
# branch). NUNCHIRO_HOME and HOME live under .scratch/wtp; nothing touches ~/.nunchiro. Exit 1 on a difference.
set -eu
cd "$(dirname "$0")/../.."
[ -x target/debug/nunchiro ] || { echo "Build first: cargo build --workspace" >&2; exit 2; }
exec python3 -B - "$@" <<'PY'
import base64, json, os, shutil, socket, struct, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, str(Path("scripts/scenario").resolve()))
from lib import clean_env

root = Path.cwd()
binary = str(root / "target/debug/nunchiro")
top = root / ".scratch/wtp"
shutil.rmtree(top, ignore_errors=True)

def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), "-c", "user.name=F", "-c", "user.email=f@example.invalid", *args],
                          check=True, capture_output=True, text=True,
                          env={**os.environ, "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z", "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z"}).stdout

class Home:
    def __init__(self, tag):
        self.home = top / tag
        self.repo = self.home / "repo"
        self.repo.mkdir(parents=True)
        git(self.repo, "init", "-q", "-b", "main")
        (self.repo / "a.txt").write_text("a\n")
        git(self.repo, "add", "a.txt")
        git(self.repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "initial")
        self.env = clean_env({"NUNCHIRO_HOME": str(self.home), "HOME": str(self.home)})
        self.env.pop("NUNCHIRO_TOKEN", None)
        self.core = subprocess.Popen([binary, "serve"], env=self.env, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        until = time.time() + 30
        while not (self.home / "window.json").exists():
            if time.time() > until:
                raise SystemExit(f"{tag}: core did not start")
            time.sleep(0.05)

    def owner(self, request):
        s = socket.socket(socket.AF_UNIX)
        s.connect(str(self.home / "core.sock"))
        token = (self.home / "core.token").read_text()
        s.sendall((json.dumps({"token": token, "request": request}) + "\n").encode())
        data = b""
        while not data.endswith(b"\n"):
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
        s.close()
        return json.loads(data)

    def window(self, request):
        """One request over the window's WebSocket (stdlib only: the handshake, one masked text frame, the reply)."""
        auth = self.owner({"op": "window_auth"})["Ok"]
        s = socket.create_connection(("127.0.0.1", auth["port"]), timeout=20)
        key = base64.b64encode(os.urandom(16)).decode()
        s.sendall((f"GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{auth['port']}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: tauri://localhost\r\n"
                   f"Sec-WebSocket-Protocol: nunchiro.v1, nunchiro.token.{auth['token']}\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            head += s.recv(1)
        assert b" 101 " in head.split(b"\r\n")[0], head
        body = json.dumps({"id": 7, "request": request}).encode()
        mask = os.urandom(4)
        n = len(body)
        frame = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n))
        s.sendall(frame + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(body)))
        buf = b""
        def need(k):
            nonlocal buf
            while len(buf) < k:
                chunk = s.recv(65536)
                if not chunk:
                    raise SystemExit("window closed the socket")
                buf += chunk
        while True:
            need(2)
            op, ln = buf[0] & 0x0F, buf[1] & 0x7F
            at = 2
            if ln == 126:
                need(4); ln = struct.unpack(">H", buf[2:4])[0]; at = 4
            elif ln == 127:
                need(10); ln = struct.unpack(">Q", buf[2:10])[0]; at = 10
            need(at + ln)
            payload, buf = buf[at:at + ln], buf[at + ln:]
            if op == 1:
                msg = json.loads(payload)
                if msg.get("id") == 7:
                    s.close()
                    return msg["response"]

    def cli(self, *args):
        r = subprocess.run([binary, "worktree", *args], env=self.env, capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise SystemExit(f"cli {args}: {r.stderr}")
        return json.loads(r.stdout)

    def state(self):
        wt = git(self.repo, "worktree", "list", "--porcelain").replace(str(self.home.resolve()), "<home>")
        lines = [l for l in wt.splitlines() if not l.startswith("worktree <home>/worktrees/")]  # folder ids differ
        return lines, git(self.repo, "branch", "--list", "--format=%(refname:short)").split()

    def stop(self):
        self.owner({"op": "stop"})
        self.core.wait(timeout=20)

def req(op, **kw):
    r = {"op": "worktree", "operation": op, "project": None, "path": None, "branch": None, "base": "HEAD", "label": ""}
    r.update(kw)
    return r

w, c = Home("win"), Home("cli")
failures = []
try:
    # Window: create, open (a shell in it), close that session, remove.
    made = w.window(req("create", project=str(w.repo), branch="parity"))["Ok"]["worktrees"][0]
    opened = w.window(req("open", path=made["path"], label="parity"))["Ok"]["session"]
    w.owner({"op": "close", "id": opened["id"]})
    mid_w = w.state()
    w.window(req("remove", path=made["path"]))
    # CLI: the same three steps.
    made_c = c.cli("create", "--project", str(c.repo), "--branch", "parity", "--base", "HEAD", "--no-focus")["worktrees"][0]
    opened_c = c.cli("open", "--path", made_c["path"], "--label", "parity", "--no-focus")["session"]
    c.owner({"op": "close", "id": opened_c["id"]})
    mid_c = c.state()
    c.cli("remove", "--path", made_c["path"])
    if mid_w != mid_c:
        failures.append(f"after create and open: window {mid_w} != cli {mid_c}")
    if w.state() != c.state():
        failures.append(f"after remove: window {w.state()} != cli {c.state()}")
    if "parity" not in w.state()[1] or "parity" not in c.state()[1]:
        failures.append("remove did not keep the branch")
    if Path(made["path"]).exists() or Path(made_c["path"]).exists():
        failures.append("a removed folder is still there")
finally:
    for h in (w, c):
        try:
            h.stop()
        except Exception as e:
            print(f"stop: {e}", file=sys.stderr)
for f in failures:
    print("FAIL", f)
if failures:
    sys.exit(1)
shutil.rmtree(top, ignore_errors=True)
print("worktree_create_open_remove_matches_cli_state: ok")
PY
