"""Seeded agent-like terminal output for the V1A-44 paint figures. Usage: stream_gen.py OUT [--size BYTES]
(default 20 MiB); prints the sha256 and the size. Same seed and size = the same bytes on any run.

Records mix 256-colour and truecolour SGR, line rewrites (progress bars), relative cursor moves, Hangul, emoji
and wide CJK. Each record ends with CRLF and only moves the cursor inside itself (no absolute moves, scroll
regions, saved cursor or alternate screen), so the fake agent's status row (stream_agent.py) is never touched."""
import argparse, hashlib, random, unicodedata

SEED = 44
SIZE = 20 * 2**20
WORDS = ("build", "test", "index", "parse", "render", "frame", "queue", "agent", "session", "commit", "merge", "write",
         "read", "fetch", "patch", "check", "token", "delta", "scroll", "buffer", "socket", "worker", "cache", "trace")
EMOJI = "🚀✅🔥📦🧪🌱🎯💡🛠🔍📝⚡🐛🧩🌊🍀"
CJK = "漢字表示確認幅広文字端末描画速度ＡＢＣＤＥ１２３"


def cells(text):
    """Terminal cells of `text`: East Asian wide/fullwidth and emoji take 2."""
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)


def hangul(r, n):
    return "".join(chr(r.randrange(0xAC00, 0xD7A4)) for _ in range(n))


def words(r, n):
    return " ".join(r.choice(WORDS) for _ in range(n))


def record(r):
    k = r.randrange(8)
    if k == 0:  # 256-colour log line
        return "".join(f"\x1b[38;5;{r.randrange(256)}m{w} " for w in words(r, r.randrange(4, 20)).split()) + "\x1b[0m\r\n"
    if k == 1:  # truecolour, bold, underline
        rgb = ";".join(str(r.randrange(256)) for _ in range(3))
        return f"\x1b[1;38;2;{rgb}m{words(r, r.randrange(3, 10))}\x1b[0m \x1b[4m{words(r, 3)}\x1b[24m\r\n"
    if k == 2:  # progress bar rewritten in place
        out = ""
        for p in range(0, 101, r.choice((10, 20, 25))):
            out += f"\r\x1b[2K\x1b[36m{'█' * (p // 5)}{'░' * (20 - p // 5)}\x1b[0m {p:3d}% {r.choice(WORDS)}"
        return out + "\r\n"
    if k == 3:  # two lines, then back up into the first to patch it, and down again
        return (f"\x1b[33m{words(r, 6)}\x1b[0m\r\n{words(r, 8)}\x1b[1A\r\x1b[{r.randrange(1, 30)}C\x1b[32m{r.choice(WORDS)}\x1b[0m"
                f"\x1b[1B\r\n")
    if k == 4:  # Hangul
        return f"\x1b[35m{hangul(r, r.randrange(4, 30))}\x1b[0m {hangul(r, r.randrange(2, 12))}\r\n"
    if k == 5:  # emoji
        return " ".join(r.choice(EMOJI) + r.choice(WORDS) for _ in range(r.randrange(3, 10))) + "\r\n"
    if k == 6:  # wide CJK and fullwidth forms
        return "".join(r.choice(CJK) for _ in range(r.randrange(5, 40))) + "\r\n"
    return f"\x1b[2m{r.randrange(10**6):06d}\x1b[0m {words(r, r.randrange(1, 12))}\r\n"  # dim numbered line


def generate(size=SIZE, seed=SEED):
    """Exactly `size` bytes of records; the last one is ASCII padding so the total is exact."""
    r, parts, n = random.Random(seed), [], 0
    while True:
        rec = record(r).encode()
        if n + len(rec) > size - 64:
            break
        parts.append(rec)
        n += len(rec)
    parts.append(b"=" * (size - n - 2) + b"\r\n")
    return b"".join(parts)


def fill_lines(n, cols, seed=SEED):
    """n lines of SGR-dense mixed text, each 1-2 cells short of `cols` (a wide character never wraps)."""
    r, out = random.Random(seed), []
    for _ in range(n):
        line, used = "", 0
        while True:
            seg = r.choice((r.choice(WORDS), hangul(r, r.randrange(1, 4)), r.choice(EMOJI), r.choice(CJK)))
            w = cells(seg) + 1
            if used + w > cols - 1:
                break
            line += f"\x1b[38;5;{r.randrange(256)}m{seg} "
            used += w
        pad = max(0, cols - 2 - used)
        out.append((line + "\x1b[0m" + "." * pad).encode())
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--size", type=int, default=SIZE)
    a = ap.parse_args()
    data = generate(a.size)
    with open(a.out, "wb") as f:
        f.write(data)
    print(hashlib.sha256(data).hexdigest(), len(data))


if __name__ == "__main__":
    main()
