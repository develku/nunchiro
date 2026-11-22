"""Fixture command run inside the sandbox. Prints `ROW <name> <ok|denied|...> <detail>` lines.
Usage: widget-fixture.py CACHE SENTINEL_DIR_PROJECT SENTINEL_HOME SENTINEL_TMP SENTINEL_DATA CORE_PORT CORE_SOCK PROXY_PORT DIRECT_IP SCRATCH"""
import os
import socket
import subprocess
import sys

(cache, s_proj, s_home, s_tmp, s_data, core_port, core_sock, proxy_port, direct_ip, scratch, secret) = sys.argv[1:12]


def row(name, result, detail=""):
    print(f"ROW {name} {result} {detail}".rstrip(), flush=True)


def write(name, path):
    try:
        with open(path, "x") as f:
            f.write("x")
        row(name, "ok")
    except OSError as e:
        row(name, "denied", e.strerror)


def run(argv, timeout=25):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout + p.stderr).strip().replace("\n", " | ")[:160]
    except (OSError, subprocess.TimeoutExpired) as e:
        return -1, repr(e)[:160]


for name, path in (("read_control", os.path.join(scratch, "open-me.txt")), ("read_secret", secret)):
    try:
        open(path).read()
        row(name, "ok")
    except OSError as e:
        row(name, "denied", e.strerror)

write("write_cache", os.path.join(cache, "out.txt"))
write("write_project", s_proj)
write("write_home", s_home)
write("write_tmp", s_tmp)
write("write_data", s_data)

try:
    socket.create_connection((direct_ip, 443), timeout=5).close()
    row("direct_tcp", "ok")
except OSError as e:
    row("direct_tcp", "denied", e.strerror or repr(e))
try:
    row("dns", "ok", socket.gethostbyname("example.com"))
except OSError as e:
    row("dns", "denied", str(e))

env_keys = sorted(k for k in os.environ if "NUNCHIRO" in k.upper() or "TOKEN" in k.upper() or "SECRET" in k.upper())
row("env_secrets", "none" if not env_keys else "seen", ",".join(env_keys))

curl = ["/usr/bin/curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "15"]
proxy = f"http://127.0.0.1:{proxy_port}"
for name, host in (("proxy_approved", "example.com"), ("proxy_unapproved", "example.org")):
    rc, out = run(curl + ["-x", proxy, f"https://{host}/"])
    row(name, "ok" if rc == 0 else "refused", f"rc={rc} {out}")

rc, out = run(curl + ["--noproxy", "*", "https://example.com/"])
row("esc_noproxy", "ok" if rc == 0 else "denied", f"rc={rc} {out}")
rc, out = run(curl + ["-x", f"http://127.0.0.1:{core_port}", "https://example.com/"])
row("esc_own_proxy", "ok" if rc == 0 else "denied" if rc == 7 else "other", f"rc={rc} {out}")
for k in ("https_proxy", "HTTPS_PROXY", "all_proxy"):
    os.environ[k] = f"http://127.0.0.1:{core_port}"
rc, out = run(curl + ["https://example.com/"])
row("esc_own_proxy_env", "ok" if rc == 0 else "denied" if rc == 7 else "other", f"rc={rc} {out}")

try:
    socket.create_connection(("127.0.0.1", int(core_port)), timeout=5).close()
    row("esc_core_tcp", "ok")
except OSError as e:
    row("esc_core_tcp", "denied", e.strerror or repr(e))
try:
    u = socket.socket(socket.AF_UNIX)
    u.settimeout(5)
    u.connect(core_sock)
    row("esc_core_unix", "ok")
except OSError as e:
    row("esc_core_unix", "denied", e.strerror or repr(e))

osa = "/usr/bin/osascript"
rc, out = run([osa, "-e", "return 1"], timeout=20)
row("osascript_local", "ok" if rc == 0 else "denied", f"rc={rc} {out}")  # no AppleEvent leaves the process
rc, out = run([osa, "-e", 'tell application "Finder" to get name of startup disk'], timeout=20)
row("esc_osascript_finder", "ok" if rc == 0 else "denied", f"rc={rc} {out}")  # read-only AppleEvent to another app; no control (fails unsandboxed too), not evidence
rc, out = run([osa, "-e", f'do shell script "touch {s_proj}-osa"'], timeout=20)
# inside the sandbox this ends in AppleScript syntax error -2740 (StandardAdditions not loaded): the touch is never attempted
row("esc_osascript_shell", "ok" if os.path.exists(s_proj + "-osa") else "denied", f"rc={rc} {out}")
rc, out = run(["/usr/bin/open", "-g", "-j", os.path.join(scratch, "open-me.txt")], timeout=20)
row("esc_open", "ok" if rc == 0 else "denied", f"rc={rc} {out}")
