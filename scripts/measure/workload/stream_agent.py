"""Fake streaming agent for the V1A-44 paint figures (no model, no agent config). Runs in a Nunchiro shell session.

  stream_agent.py --label L --trigger PATH (--stream FILE [--rate BPS] [--loop] [--heartbeat S] | --fill N)

The bottom row is a status row outside the scroll region (as agent TUIs keep one): `READY L` at start, `HB L <seq>`
every --heartbeat seconds while streaming, `@@PAINT END L@@` when done. The page detects these in the rendered rows,
so a marker is never scrolled away before it is painted. Output starts when PATH exists; --rate 0 writes as fast as
the PTY takes it. --fill writes N full-width mixed lines (memory row). Idles after the end until killed."""
import argparse, os, signal, sys, time, tty

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import stream_gen  # noqa: E402


def chunks(data, size):
    """Pieces of about `size` bytes, each ending on a newline (records and escapes are never split)."""
    i = 0
    while i < len(data):
        j = data.rfind(b"\n", i, i + size)
        if j < 0:
            j = data.find(b"\n", i + size)
            j = len(data) - 1 if j < 0 else j
        yield data[i:j + 1]
        i = j + 1


def status(text, rows):
    """Save cursor, keep the scroll region above the last row, write `text` there, restore the cursor."""
    if rows < 3:
        return b""
    return f"\x1b7\x1b[1;{rows - 1}r\x1b[{rows};1H\x1b[0m\x1b[2K{text}\x1b8".encode()


def write_all(b):
    while b:
        b = b[os.write(1, b):]


def size():
    try:
        return os.get_terminal_size(1)
    except OSError:
        return os.terminal_size((80, 24))


def rows():
    return size().lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--trigger", required=True)
    ap.add_argument("--stream")
    ap.add_argument("--rate", type=int, default=0)
    ap.add_argument("--loop", action="store_true")
    ap.add_argument("--heartbeat", type=float, default=0)
    ap.add_argument("--fill", type=int, default=0)
    a = ap.parse_args()
    tty.setraw(0)  # bytes reach the terminal as generated (no CRLF translation, no echo)
    state, resized = [f"READY {a.label}"], [True]
    signal.signal(signal.SIGWINCH, lambda *_: resized.__setitem__(0, True))

    def show(text=None):
        if text:
            state[0] = text
        resized[0] = False
        write_all(status(state[0], rows()))

    def idle_until(cond):
        while not cond():
            if resized[0]:
                show()
            time.sleep(0.01)

    write_all(b"\x1b[2J\x1b[H")
    idle_until(lambda: os.path.exists(a.trigger))
    if a.fill:
        cols = size().columns
        for piece in chunks(b"\r\n".join(stream_gen.fill_lines(a.fill, cols)) + b"\r\n", 1 << 16):
            write_all(piece)
    else:
        data = open(a.stream, "rb").read()
        step = max(1024, a.rate // 16) if a.rate else 1 << 16
        t0, sent, seq, beat = time.monotonic(), 0, 0, time.monotonic()
        while True:
            for piece in chunks(data, step):
                if resized[0]:
                    show()
                if a.heartbeat and time.monotonic() >= beat:
                    seq += 1
                    show(f"HB {a.label} {seq}")
                    beat += a.heartbeat
                write_all(piece)
                sent += len(piece)
                if a.rate:
                    wait = t0 + sent / a.rate - time.monotonic()
                    if wait > 0:
                        time.sleep(wait)
            if not a.loop:
                break
    show(f"@@PAINT END {a.label}@@ {size().columns}x{size().lines}")  # the memory row records the terminal size
    idle_until(lambda: False)


if __name__ == "__main__":
    main()
