"""V1A-51 renderer check in the real Tauri window (WKWebView), DOM vs @xterm/addon-webgl, measure only. Usage:
  [NUNCHIRO_MEASURE_CORE=<core>] window.py [--repeats N] [--no-build]

Builds the measure page (web/measure/page, which runs the check itself inside Tauri) into .scratch/measure-page and a
debug app whose frontendDist is that page (`tauri build --debug --no-bundle --config`, no app file changed). Starts that
app with HOME and NUNCHIRO_HOME under .scratch (its own core), takes the page's results over a WebSocket sink on
127.0.0.1 (the window's CSP allows ws://127.0.0.1 only), screenshots the window after each run (screencapture -l, the
window found by this app's pid), and stops every process it started. Loads: full-screen truecolour TUI redraw, a
maximised pane scrolling 8 MiB, 8 panes redrawing; 5 repeats. Prints the rows; raw in .scratch/measure/<stamp>-window/."""
import argparse, base64, hashlib, json, os, socket, struct, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "scripts/scenario"))
import measurelib as ml  # noqa: E402
import release as rel  # noqa: E402
from lib import clean_env  # noqa: E402

PAGE = ROOT / ".scratch/measure-page"
APP_DIR = ROOT / "app/src-tauri"
# The window of a process, by pid: CGWindowID for screencapture -l (needs Screen Recording for the caller).
WINDOW_ID = """import CoreGraphics
let pid = Int32(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
  print(w[kCGWindowNumber as String] as! Int); break
}
"""


class Sink:
    """One WebSocket client (the page): text frames in, a one-byte text frame back as the go-ahead."""

    def __init__(self, port=0):
        self.srv = socket.socket()
        self.srv.bind(("127.0.0.1", port))
        self.srv.listen(1)
        self.port = self.srv.getsockname()[1]
        self.conn = None

    def accept(self, timeout):
        self.srv.settimeout(timeout)
        self.conn, _ = self.srv.accept()
        self.conn.settimeout(600)
        head = b""
        while b"\r\n\r\n" not in head:
            head += self.conn.recv(4096)
        key = next(line.split(b":", 1)[1].strip() for line in head.split(b"\r\n") if line.lower().startswith(b"sec-websocket-key:"))
        accept = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
        self.conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n")

    def _read(self, n):
        b = b""
        while len(b) < n:
            part = self.conn.recv(n - len(b))
            if not part:
                raise ConnectionError("page closed the sink")
            b += part
        return b

    def recv(self):
        """One text message (client frames are masked; a long one may be split into continuation frames)."""
        out = b""
        while True:
            b0, b1 = self._read(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            mask = self._read(4)
            data = self._read(n)
            out += bytes(c ^ mask[i % 4] for i, c in enumerate(data))
            if b0 & 0x80:
                return json.loads(out)

    def send(self, text):
        data = text.encode()
        n = len(data)
        head = bytes([0x81, n]) if n < 126 else bytes([0x81, 126]) + struct.pack(">H", n) if n < 65536 else bytes([0x81, 127]) + struct.pack(">Q", n)
        self.conn.sendall(head + data)


def build(repeats, port):
    pnpm = "pnpm"
    subprocess.run([pnpm, "-C", str(ROOT / "web"), "exec", "vite", "build", "--logLevel", "error", "-c", "measure/vite.config.ts"], check=True)
    (PAGE / "sink.json").write_text(json.dumps(dict(port=port, repeats=repeats)))
    cfg = json.dumps({"build": {"frontendDist": str(PAGE), "beforeBuildCommand": ""}})
    env = dict(os.environ, CARGO_BUILD_JOBS="2")
    env.pop("CARGO_TARGET_DIR", None)
    subprocess.run([pnpm, "--dir", str(ROOT / "app"), "exec", "tauri", "build", "--debug", "--no-bundle", "--config", cfg], check=True, env=env)


def app_binary():
    for p in (APP_DIR / "target/debug/nunchiro-app", ROOT / "target/debug/nunchiro-app"):
        if p.is_file():
            return p
    raise SystemExit("no debug nunchiro-app after the build")


def window_id(pid, swift):
    out = subprocess.run(["swift", str(swift), str(pid)], capture_output=True, text=True, timeout=120).stdout.strip()
    return out or None


def summary(runs):
    rows = {}
    for r in runs:
        key = f"{r['load']}-{r['renderer']}"
        g = rows.setdefault(key, dict(p50=[], p95=[], worst=[], stalls=[], busy=[], echo_p95=[], wall=[], lost=0, errors=[], size=None))
        if r.get("error") or r.get("errors"):
            g["errors"] += [r.get("error")] if r.get("error") else r["errors"]
        if not r.get("gaps"):
            continue
        gaps = r["gaps"]
        g["p50"].append(round(ml.pct(gaps, 50), 1))
        g["p95"].append(round(ml.pct(gaps, 95), 1))
        g["worst"].append(round(max(gaps)))
        g["stalls"].append(sum(x > ml.STALL_MS for x in gaps))
        g["busy"].append(round(r["busy_share"], 2))
        g["echo_p95"].append(round(ml.pct(r["echoes"], 95)) if r["echoes"] else None)
        g["wall"].append(round(r["wall_ms"] / 1000, 2))
        g["lost"] += r["context_lost"]
        g["size"] = f"{r['cols']}x{r['rows']}"
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repeats", type=int, default=5)
    ap.add_argument("--no-build", action="store_true")
    a = ap.parse_args()
    out = ROOT / ".scratch/measure" / time.strftime("%Y%m%d-%H%M%S-window")
    out.mkdir(parents=True)
    if a.no_build:  # the app embeds the page, sink port and repeats included, as it was built
        sink = Sink(json.loads((PAGE / "sink.json").read_text())["port"])
    else:
        sink = Sink()
        build(a.repeats, sink.port)
    swift = out / "window_id.swift"
    swift.write_text(WINDOW_ID)
    home = ROOT / ".scratch/home"
    nhome = ROOT / ".scratch/wh"  # short: the core socket path must stay < 104 bytes
    nhome.mkdir(parents=True, exist_ok=True)
    env = clean_env({"HOME": str(home), "NUNCHIRO_HOME": str(nhome), "NUNCHIRO_BIN": str(rel.CORE)})
    print(f"waiting for 1-min load < {ml.PAINT_LOAD_START:g}", flush=True)
    while rel.load() >= ml.PAINT_LOAD_START:
        time.sleep(60)
    loads = [rel.load()]
    log = open(out / "app.log", "ab")
    proc = subprocess.Popen([str(app_binary())], env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    runs, wid = [], None
    try:
        sink.accept(120)
        while True:
            m = sink.recv()
            loads.append(rel.load())
            if m.get("done"):
                break
            if loads[-1] > ml.PAINT_LOAD_STOP:
                raise SystemExit(f"not run: load {loads[-1]} > {ml.PAINT_LOAD_STOP:g}")
            wid = wid or window_id(proc.pid, swift)
            shot = out / f"r{m['rep']}-{m['load']}-{m['renderer']}.png"
            if wid:
                subprocess.run(["screencapture", "-x", "-o", "-l", wid, str(shot)], timeout=30)
            m["shot"] = str(shot.relative_to(ROOT)) if shot.is_file() else None
            runs.append(m)
            print(f"{m['rep']} {m['load']} {m['renderer']}: {'error ' + m['error'] if m.get('error') else str(round(m['wall_ms'])) + ' ms'}", flush=True)
            sink.send("k")
    finally:
        (out / "result.json").write_text(json.dumps(dict(runs=runs, loads=loads, window_id=wid), indent=1))
        import paint  # noqa: E402 - its stop_tree also ends the WebKit helpers this app is responsible for

        paint.stop_tree(proc)
        if rel.CORE.is_file():  # the core this app may have started under the scratch NUNCHIRO_HOME
            subprocess.run([str(rel.CORE), "serve", "stop", "--yes"], env=env, capture_output=True, timeout=60)
        loads.append(rel.load())
    rows = summary(runs)
    print(json.dumps(dict(rows=rows, load=ml.load_range(loads)), indent=1))


if __name__ == "__main__":
    main()
