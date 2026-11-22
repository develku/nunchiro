"""Keystroke-to-echo latency through a PTY relay. Usage: echo_latency.py [--busy N] [--n K] [--target cat|claude|codex]

client --unix socket--> relay.py --PTY--> target ; time from sending one key to seeing it come back.
--busy N starts N extra claude sessions in a long turn first (spec acceptance 10 uses 3)."""
import argparse, json, os, socket, subprocess, sys, time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scenario"))
from lib import CODEX_MODEL, OUT, Session, TRUSTED_CWD, clean_env, sock_path, visible  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
TARGETS = {"cat": ["/bin/cat"], "claude": ["claude", "--model", "haiku"],
           "codex": ["codex", "--no-daemon", "-m", CODEX_MODEL, "-c", 'model_reasoning_effort="low"']}
READY = {"cat": None, "claude": r"❯ +Try|manual mode on|for shortcuts", "codex": r"Ask Codex to do anything"}
KEYS = "QXZJKVWQXZJKVW"


def pct(v, p):
    v = sorted(v)
    return v[min(len(v) - 1, int(round(p / 100 * (len(v) - 1))))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default="cat")
    ap.add_argument("--busy", type=int, default=0)
    ap.add_argument("--n", type=int, default=100)
    a = ap.parse_args()
    busy = []
    for i in range(a.busy):
        s = Session(TARGETS["claude"], TRUSTED_CWD, clean_env())
        s.wait_for(READY["claude"], 60)
        time.sleep(1)
        s.type("Write the numbers from 1 to 400 as English words, one per line. No tools.")
        busy.append(s)
    if busy:
        time.sleep(8)  # let the busy turns start streaming
    sock = sock_path("nv1a-relay")
    rp = subprocess.Popen([sys.executable, "-I", os.path.join(HERE, "relay.py"), sock, TRUSTED_CWD, "--"] + TARGETS[a.target], env=clean_env())
    for _ in range(100):
        if os.path.exists(sock):
            break
        time.sleep(0.05)
    c = socket.socket(socket.AF_UNIX)
    c.connect(sock)
    c.settimeout(5)
    buf = b""
    if READY[a.target]:
        import re
        end = time.time() + 60
        while time.time() < end and not re.search(READY[a.target], visible(buf)):
            try:
                buf += c.recv(65536)
            except socket.timeout:
                pass
        time.sleep(8 if a.target == "codex" else 2)
        c.settimeout(0.2)
        try:
            while c.recv(65536):
                pass
        except socket.timeout:
            pass
    lat, misses = [], 0
    for i in range(a.n):
        k = KEYS[i % len(KEYS)].encode()
        t = time.perf_counter()
        c.sendall(k)
        got = b""
        c.settimeout(2)
        try:
            while k not in visible(got).encode():
                got += c.recv(65536)
            lat.append((time.perf_counter() - t) * 1000)
        except socket.timeout:
            misses += 1
        time.sleep(0.05)
        if i % 10 == 9 and a.target != "cat":
            c.sendall(b"\x7f" * 10)  # clear the composer
            time.sleep(0.3)
            c.settimeout(0.2)
            try:
                while c.recv(65536):
                    pass
            except socket.timeout:
                pass
    rp.kill()
    for s in busy:
        s.send(b"\x1b")
        s.kill()
    r = dict(target=a.target, busy=a.busy, n=len(lat), misses=misses, p50_ms=round(pct(lat, 50), 2), p95_ms=round(pct(lat, 95), 2),
             max_ms=round(max(lat), 2))
    print(json.dumps(r))
    os.makedirs(os.path.join(OUT, "measure"), exist_ok=True)
    open(os.path.join(OUT, "measure", "latency.jsonl"), "a").write(json.dumps(dict(r, t=time.time())) + "\n")


if __name__ == "__main__":
    main()
