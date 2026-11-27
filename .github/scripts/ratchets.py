#!/usr/bin/env python3
"""CI lint stage: the ratchets of scripts/ against a base commit (a pull request's base, or the commit before a main
tip). Run from the repository root:  python3 -B .github/scripts/ratchets.py BASE_REF

1. No baseline gains a line or a higher count: scripts/dead-click.baseline, scripts/noop-click.baseline and
   scripts/overlap.baseline only lose lines (the browser scans that read them run in the web job's core set, the no-op
   scan nightly); scripts/raw-literals.baseline and scripts/file-sizes.baseline only lower their numbers.
2. scripts/raw-literal-ratchet.sh and scripts/file-size-ratchet.sh run against the larger of each baseline number and
   the base commit's own count: main may already be over a baseline (that is its own fix), but no change makes it worse.
Exit 0 pass, 1 a ratchet failed, 2 usage.
"""
import os, subprocess, sys, tarfile, tempfile
from pathlib import Path

sys.path.insert(0, "scripts/measure")
from scorecard import SOURCE, NOT_SOURCE  # noqa: E402  (the judge's own "source file")

SETS = ("scripts/dead-click.baseline", "scripts/noop-click.baseline", "scripts/overlap.baseline")
RAW, SIZES = "scripts/raw-literals.baseline", "scripts/file-sizes.baseline"
LIMIT = 2000  # scripts/file-size-ratchet.sh


def at_base(ref, path):
    r = subprocess.run(["git", "show", f"{ref}:{path}"], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else ""


def lines(text):
    return [l for l in text.splitlines() if l.strip() and not l.startswith("#")]


def raw_counts(text):  # "kind path count"
    return {tuple(l.split()[:2]): int(l.split()[2]) for l in lines(text)}


def size_counts(text):  # "count path"
    return {l.split(None, 1)[1].strip(): int(l.split(None, 1)[0]) for l in lines(text)}


def main():
    if len(sys.argv) != 2:
        print(__doc__.split("\n\n")[0], file=sys.stderr)
        return 2
    ref, bad = sys.argv[1], []
    for path in SETS:
        head = set(lines(Path(path).read_text())) if Path(path).is_file() else set()
        bad += [f"{path} gained a line: {l}" for l in sorted(head - set(lines(at_base(ref, path))))]
    for path, parse in ((RAW, raw_counts), (SIZES, size_counts)):
        old, new = parse(at_base(ref, path)), parse(Path(path).read_text()) if Path(path).is_file() else {}
        bad += [f"{path} raised {k}: {old.get(k, 0)} to {n}" for k, n in sorted(new.items()) if n > old.get(k, 0)]
    with tempfile.TemporaryDirectory() as tmp:
        tree = Path(tmp) / "base"
        archive = subprocess.run(["git", "archive", ref], capture_output=True, check=True).stdout
        tree.mkdir()
        with tarfile.open(fileobj=__import__("io").BytesIO(archive)) as t:
            t.extractall(tree, filter="data")
        # the base's own counts, by this checkout's counters
        counts = subprocess.run(["sh", "scripts/raw-literals.sh", str(tree / "web/src")], capture_output=True, text=True, check=True).stdout
        raw = raw_counts(Path(RAW).read_text())
        for k, n in raw_counts(counts).items():
            raw[k] = max(raw.get(k, 0), n)
        sizes = size_counts(Path(SIZES).read_text())
        for p in subprocess.run(["git", "ls-tree", "-r", "--name-only", ref], capture_output=True, text=True, check=True).stdout.splitlines():
            if SOURCE.search(p) and not NOT_SOURCE.search(p) and (tree / p).is_file():
                n = (tree / p).read_bytes().count(b"\n")
                if n > sizes.get(p, LIMIT):  # a listed file under the limit keeps its own number
                    sizes[p] = n
        Path(tmp, "raw").write_text("".join(f"{a} {b} {n}\n" for (a, b), n in sorted(raw.items())))
        Path(tmp, "sizes").write_text("".join(f"{n} {p}\n" for p, n in sorted(sizes.items())))
        env = dict(os.environ, RAW_LITERALS_BASELINE=str(Path(tmp, "raw")), FILE_SIZES_BASELINE=str(Path(tmp, "sizes")))
        failed = [s for s in ("scripts/raw-literal-ratchet.sh", "scripts/file-size-ratchet.sh") if subprocess.run(["sh", s], env=env).returncode]
    for b in bad:
        print(f"ratchets: {b}", file=sys.stderr)
    if bad or failed:
        print("ratchets failed: a baseline may only shrink, and no count may rise above its baseline or main's own", file=sys.stderr)
        return 1
    print("ratchets: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
