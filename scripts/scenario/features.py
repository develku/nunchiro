"""Ticket 01 feature checks. Usage: features.py image|switch|remote [claude|codex]

image   - a PNG saved to a file is sent as a path in the prompt; the reply must name its colour.
switch  - in-session model and effort switch through the agent's own picker, "this session only".
remote  - Claude Remote Control starts in a PTY-launched claude (then is stopped with the session).
Every check snapshots the guarded user config before and after.
"""
import json, os, re, struct, sys, time, uuid, zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import HERE, OUT, TRUSTED_CWD, Core, guard_check, snapshot, sock_path  # noqa: E402
from matrix import CODEX_ARGS, READY, launch  # noqa: E402


def png(path, rgb, size=64):
    row = b"\x00" + bytes(rgb) * size
    raw = zlib.compress(row * size)
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
                           + chunk(b"IDAT", raw) + chunk(b"IEND", b""))


def session(agent, name, extra_row=None):
    d = os.path.join(OUT, "features", f"{name}-{agent}-{uuid.uuid4().hex[:6]}")
    os.makedirs(d, exist_ok=True)
    sock, sink, evf = sock_path(), d + "/sink.jsonl", d + "/events.jsonl"
    for f in (sink, evf):
        open(f, "w").close()
    core = Core(sock, evf, "record")
    s = launch(agent, d, sock, sink, TRUSTED_CWD, extra_row)
    if not s.wait_for(READY[agent], 90):
        raise SystemExit(f"{agent}: no composer")
    if agent == "codex":  # the composer shows before startup ends ("Waiting for startup"); wait for SessionStart
        end = time.time() + 90
        while time.time() < end and not any(e["event"] == "SessionStart" for e in core.read()):
            time.sleep(0.3)
    time.sleep(2)
    return s, core, d


def image(agent):
    path = os.path.join(TRUSTED_CWD, f"img-{uuid.uuid4().hex[:6]}.png")  # stable file, as the ADR image amendment says
    png(path, (0, 190, 0))
    s, core, d = session(agent, "image")
    try:
        s.type(f"What single colour fills the image file at {path}? Look at the image and answer with one word.",
               submitted=lambda: any(e["event"] == "UserPromptSubmit" for e in core.read()))
        end, answer = time.time() + 120, None
        while time.time() < end and answer is None:
            for e in core.read():
                if e["event"] == "Stop":
                    answer = json.loads(e["payload"] or "{}").get("last_assistant_message")
                if e["event"] == "PermissionRequest":  # a read of the cwd file should not ask; deny if it does
                    s.send(b"\x1b")
            time.sleep(0.3)
        tools = [json.loads(e["payload"]).get("tool_name") for e in core.read() if e["event"] == "PreToolUse"]
        ok = bool(answer and re.search(r"green|초록|녹색", answer, re.I))
        return dict(check="image", agent=agent, pass_=ok, answer=answer, tools=tools, dir=d)
    finally:
        s.kill()
        core.kill()
        os.unlink(path)


def switch(agent):
    s, core, d = session(agent, "switch")
    try:
        if agent == "claude":
            # /model picker: Up from Haiku 5.5 to Sonnet 5.5, Left = lower effort, "s" = this session only
            s.type("/model")
            time.sleep(2.5)
            for k in (b"\x1b[A", b"\x1b[D"):
                s.send(k)
                time.sleep(0.8)
            t = time.time()
            s.send(b"s")
            ok_msg = s.wait_for(r"for this session only", 8, since=t) is not None
            time.sleep(1)
            s.type("/status")
            st = s.wait_for(r"Model:\s+sonnet", 8, since=t) is not None
            s.send(b"\x1b")
            return dict(check="switch", agent=agent, pass_=ok_msg and st, session_only_message=ok_msg, status_shows_sonnet=st,
                        method="/model, Up, Left (effort), s", dir=d)
        # Codex: only open the picker; selecting may persist to ~/.codex/config.toml (not exercised)
        t = time.time()
        s.type("/model")
        picker = s.wait_for(r"Select Model and Effort", 10, since=t) is not None
        s.send(b"\x1b")
        return dict(check="switch", agent=agent, pass_=None, picker_opens=picker,
                    note="selection not exercised: may write ~/.codex/config.toml", dir=d)
    finally:
        s.kill()
        core.kill()


HANGUL = "눈치로 한글 입력 확인: 가나다 똠방각하 읽었어요"  # fixed test text (mixed syllables, final consonants)


def hangul(agent):
    """PTY half of the Korean check: composed Hangul sent as bracketed paste and as plain keystroke bytes
    reaches the composer intact. IME composition in xterm.js/WebKit is not covered here."""
    s, core, d = session(agent, "hangul")
    try:
        out = {}
        for mode in ("paste", "keys"):
            t = time.time()
            if mode == "paste":
                s.type(HANGUL, enter=False)
            else:
                for ch in HANGUL:
                    s.send(ch)
                    time.sleep(0.03)
            time.sleep(2)
            txt = s.text_since(t)
            # shortcut: no VT emulator, and the TUIs draw wide glyphs cell by cell; compare with whitespace removed
            out[mode] = re.sub(r"\s", "", HANGUL) in re.sub(r"\s", "", txt)
            s.send(b"\x7f" * (len(HANGUL) + 5))  # clear without submitting
            time.sleep(1)
        return dict(check="hangul", agent=agent, pass_=all(out.values()), **out, dir=d)
    finally:
        s.kill()
        core.kill()


def remote(agent="claude"):
    s, core, d = session("claude", "remote")
    try:
        t = time.time()
        s.type("/remote-control")
        hit = s.wait_for(r"Remote Control (is )?(active|connected|enabled)|remote-control.*(active|connected)|claude\.ai/code", 30, since=t)
        time.sleep(3)
        txt = s.text_since(t)[-1500:]
        return dict(check="remote", agent="claude", pass_=hit is not None, screen=txt, dir=d)
    finally:
        s.kill()
        core.kill()


if __name__ == "__main__":
    what, agent = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "claude")
    os.makedirs(TRUSTED_CWD, exist_ok=True)
    before = snapshot()
    r = {"image": image, "switch": switch, "remote": remote, "hangul": hangul}[what](agent)
    r["guard_problems"], r["guard_foreign"] = guard_check(before, snapshot(), [TRUSTED_CWD, HERE])
    print(json.dumps(r, ensure_ascii=False))
    os.makedirs(os.path.join(OUT, "features"), exist_ok=True)
    open(os.path.join(OUT, "features", "results.jsonl"), "a").write(json.dumps(r, ensure_ascii=False) + "\n")
