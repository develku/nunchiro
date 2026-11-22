#!/usr/bin/env python3
"""V2.5-19 live check of the browser view in real WKWebViews (a headless test cannot make one). Serves a fixture on
127.0.0.1, starts the debug app with NUNCHIRO_BROWSER_SELFTEST=<fixture> under an isolated NUNCHIRO_HOME, waits for the app's
scripted steps, and checks what the pages reported. Usage: browser-selftest.py <nunchiro-app> <nunchiro-cli>
Proves (ticket 264, on throwaway profiles, never the built-in one): spaces_on_default_profile_share_cookies,
profiles_do_not_share_cookies, space_forget_keeps_shared_profile_data, a profile clear reaching every space; agent_view_has_no_ipc;
V2.5-41 (threat model A18): agent_view_never_receives_window_token, agent_view_token_absent_everywhere,
main_window_still_boots. A second fixture listens on :80 (dual-stack wildcard, loopback clients only; `tauri.localhost`
resolves to ::1 and 127.0.0.1), and the agent view is sent to `http://tauri.localhost/` typed, by 302 (three spellings) and by page script.
Does not prove: the "you" store (the main window is a different webview), inspector absence (unit test only), the dev-load
origin (unit test only)."""
import json, os, shutil, socket, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROBE = """<!doctype html><title>probe</title><script>
const tag = new URLSearchParams(location.search).get('tag');
const seen = {boot: false, messages: []};
addEventListener('nunchiro:boot', () => { seen.boot = true; });
addEventListener('message', (e) => seen.messages.push({origin: e.origin, data: String(JSON.stringify(e.data))}));
(async () => {
  const r = {tag, cookie: document.cookie, tauri: typeof window.__TAURI__, internals: typeof window.__TAURI_INTERNALS__, ipc: 'none', nav: (performance.getEntriesByType('navigation')[0] || {}).type};
  try { if (window.__TAURI_INTERNALS__) { await window.__TAURI_INTERNALS__.invoke('browser_hide', {space: 'A'}); r.ipc = 'allowed'; } } catch (e) { r.ipc = 'refused'; r.err = String(e); }
  try { await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {event: 'browser-moved', target: {kind: 'Any'}, handler: 0}); r.listen = 'allowed'; } catch (e) { r.listen = 'refused'; }
  // T probes (A18) wait for the page-load handler, which runs after load, then report every place a token could sit.
  if (tag.startsWith('T')) {
    await new Promise((ok) => setTimeout(ok, 2000));
    r.origin = location.origin;
    r.nunchiro = typeof window.__NUNCHIRO__;
    r.boot_value = window.__NUNCHIRO__ === undefined ? null : JSON.stringify(window.__NUNCHIRO__);
    r.boot_event = seen.boot;
    r.messages = seen.messages;
    r.local = JSON.stringify({...localStorage});
    r.session = JSON.stringify({...sessionStorage});
    try { r.idb = (await indexedDB.databases()).map((d) => d.name); } catch (e) { r.idb = 'error ' + e; }
    r.cookie = document.cookie;
  }
  await fetch('/report', {method: 'POST', body: JSON.stringify(r)});
})();
addEventListener('pageshow', (e) => e.persisted && fetch('/report', {method: 'POST', body: JSON.stringify({tag, nav: 'bfcache'})}));</script>"""
# Each `/away` step leaves the loopback fixture for the app's own origin a different way.
AWAY = {
    "T2": ("302", "http://tauri.localhost/probe?tag=T2"),
    "T3": ("script", "http://tauri.localhost/probe?tag=T3"),
    "T4": ("302", "http://TAURI.localhost:80/probe?tag=T4"),
    "T5": ("302", "http://tauri.localhost./probe?tag=T5"),
}
reports = []
requests = []  # (fixture, method, path, headers, body) of every request either fixture saw


def handler(name):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def record(self, body=b""):
            requests.append((name, self.command, self.path, dict(self.headers), body.decode(errors="replace")))

        def do_GET(self):
            if not self.loopback():
                return
            self.record()
            tag = self.path.partition("tag=")[2]
            if self.path.startswith("/away") and tag in AWAY:
                how, to = AWAY[tag]
                if how == "302":
                    self.send_response(302)
                    self.send_header("Location", to)
                    self.end_headers()
                    return
                body = f"<!doctype html><title>away</title><script>location.href = {json.dumps(to)};</script>"
            else:
                body = PROBE if self.path.startswith("/probe") else "<title>set</title>cookie set"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            if self.path.startswith("/set"):
                self.send_header("Set-Cookie", "k=secret; Max-Age=3600; Path=/")
            self.end_headers()
            self.wfile.write(body.encode())

        def loopback(self):
            # The :80 fixture binds the wildcard address (below); it answers loopback clients only.
            if self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
                return True
            self.send_error(403)
            return False

        def do_POST(self):
            if not self.loopback():
                return
            body = self.rfile.read(int(self.headers["Content-Length"]))
            self.record(body)
            reports.append({**json.loads(body), "fixture": name})
            self.send_response(204)
            self.end_headers()

    return H


class Server6(ThreadingHTTPServer):
    """Dual-stack `[::]`: macOS lets a user process bind port 80 on the wildcard address only (127.0.0.1:80 is EACCES),
    which is also what an agent's dev server would do. `tauri.localhost` resolves to ::1 and 127.0.0.1."""
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def serve(cls, addr, name):
    srv = cls(addr, handler(name))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def window_token(home):
    """The window token, asked of the isolated core over its owner socket as the app does (never printed whole)."""
    with open(os.path.join(home, "core.token")) as f:
        owner = f.read().strip()
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(3)
    s.connect(os.path.join(home, "core.sock"))
    s.sendall((json.dumps({"token": owner, "request": {"op": "window_auth"}}) + "\n").encode())
    reply = json.loads(s.makefile().readline())
    s.close()
    return reply["Ok"]["token"], reply["Ok"]["port"]


def main():
    app, cli = sys.argv[1:3]
    srv = serve(ThreadingHTTPServer, ("127.0.0.1", 0), "fixture")
    try:
        own = [serve(Server6, ("::", 80), "port80")]
    except OSError as e:
        print(f"BLOCKED loopback :80 is not free ({e}); see `lsof -nP -iTCP:80 -sTCP:LISTEN`")
        sys.exit(2)
    home = tempfile.mkdtemp(prefix="ns-bv-", dir=os.environ.get("TMPDIR", "/tmp"))
    env = {**os.environ, "NUNCHIRO_HOME": home, "NUNCHIRO_LOGIN_PATH": "off", "NUNCHIRO_BIN": cli, "NUNCHIRO_BROWSER_SELFTEST": f"http://127.0.0.1:{srv.server_port}"}
    p = subprocess.Popen([app], env=env, stderr=subprocess.PIPE, text=True)
    print("app pid", p.pid)
    done = threading.Event()
    log = []

    def pump():
        for line in p.stderr:
            log.append(line.rstrip())
            if "selftest done" in line:
                done.set()
    threading.Thread(target=pump, daemon=True).start()
    try:
        ok = done.wait(180)
        # The app starts the core only on the main window's boot, so no core means no token and no boot.
        try:
            token, port = window_token(home)
        except (OSError, ValueError, KeyError) as e:
            print("no window token from the core:", e)
            token, port = "", 0
        # The main window's web UI opens its WebSocket to the window port only after it read the boot script.
        lsof = subprocess.run(["lsof", "-nP", f"-iTCP@127.0.0.1:{port}", "-sTCP:ESTABLISHED"], capture_output=True, text=True).stdout
        booted = bool(port) and f"->127.0.0.1:{port}" in lsof
    finally:
        p.terminate()
        try:
            p.wait(10)
        except subprocess.TimeoutExpired:
            p.kill()
        subprocess.run([cli, "serve", "stop", "--yes"], env=env, capture_output=True)
    for s in [srv, *own]:
        s.shutdown()
    # The profile clear reloads every open view on st-a (A, B, N, T) near the end, and those reloads report again with an
    # empty jar: each check reads the load its own step made, the first report of its tag, and the N steps' first four.
    by = {}
    for r in reports:
        if "cookie" in r:
            by.setdefault(r["tag"], r)
    n = [(r["tag"], r["nav"]) for r in reports if r["tag"].startswith("N")][:4]
    n = [(t, "back" if k in ("back_forward", "bfcache") else k) for t, k in n]
    t_own = [r for r in reports if r["tag"].startswith("T") and r["fixture"] == "port80"]
    # Each way out was really taken: the fixture served every `/away` step (else the refusal check passes vacuously).
    left = {q[2].partition("tag=")[2] for q in requests if q[0] == "fixture" and q[2].startswith("/away")}
    seen = json.dumps(reports) + json.dumps(requests) + "\n".join(log)
    checks = {
        "nav_controls: load, go, back, reload": n == [("N1", "navigate"), ("N2", "navigate"), ("N1", "back"), ("N1", "reload")],
        "selftest finished, no step error": ok and not [l for l in log if l.startswith("selftest ") and "done" not in l],
        "a fresh profile starts empty (A0)": by.get("A0", {}).get("cookie") == "",
        "cookie set in A is read back in A (A1)": by.get("A1", {}).get("cookie") == "k=secret",
        "spaces_on_default_profile_share_cookies (B0)": by.get("B0", {}).get("cookie") == "k=secret",
        "profiles_do_not_share_cookies (C0)": by.get("C0", {}).get("cookie") == "",
        "space_forget_keeps_shared_profile_data (A2)": by.get("A2", {}).get("cookie") == "k=secret",
        "profile_clear_reaches_every_space (B1)": by.get("B1", {}).get("cookie") == "",
        "agent_view_has_no_ipc (no __TAURI__; invoke and event listen refused (the main window's capability does not reach it); Tauri 2.12.5 leaves an inert __TAURI_INTERNALS__ object)": bool(by) and all(r["tauri"] == "undefined" and r["ipc"] == "refused" and r["listen"] == "refused" for r in reports if "cookie" in r),
        "own origin refused in the agent view: typed, 302 x3, script (no request reached loopback :80)": "T0" in by and left == set(AWAY) and not [q for q in requests if q[0] == "port80"],
        "agent_view_never_receives_window_token (no T probe saw __NUNCHIRO__ or the boot event)": "T0" in by and all(r.get("nunchiro") == "undefined" and r.get("boot_event") is False for r in reports if r["tag"].startswith("T")),
        "agent_view_token_absent_everywhere (DOM, storage, IndexedDB, cookies, messages, IPC reply, fixture headers and bodies, app log)": len(token) >= 16 and token not in seen,
        "main_window_still_boots (window WebSocket open to the core)": booted,
    }
    for k, v in checks.items():
        print("PASS" if v else "FAIL", k)
    red = lambda text: text.replace(token, token[:4] + "<redacted>") if token else text
    print("T probes served from loopback :80:", red(json.dumps(t_own)))
    print("port80 requests:", red(json.dumps([(q[1], q[2], q[3].get("Host")) for q in requests if q[0] == "port80"])))
    print("reports:", red(json.dumps(reports)))
    print("log:", *[red(l) for l in log[-12:]], sep="\n  ")
    if all(checks.values()):
        shutil.rmtree(home, ignore_errors=True)
        sys.exit(0)
    print("home kept:", home)
    sys.exit(1)


main()
