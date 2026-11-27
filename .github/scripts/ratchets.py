#!/usr/bin/env python3
"""CI lint stage: the ratchets of scripts/ against a base commit (a pull request's base, or the commit before a main
tip). Run from the repository root:  python3 -B .github/scripts/ratchets.py BASE_REF
CI runs the base commit's copy of this file, and everything it judges by comes from the base commit too (the
baselines, the raw-literal counter scripts/raw-literals.sh and the scorecard's source-file pattern), so a change cannot
loosen its own gate; only the counted files come from the checkout.

1. No baseline gains a line or a higher count: scripts/dead-click.baseline, scripts/noop-click.baseline and
   scripts/overlap.baseline only lose lines (the browser scans that read them run in the web job's core set; the no-op
   scan runs in the weekly full run, full.yml); scripts/raw-literals.baseline and scripts/file-sizes.baseline only
   lower their numbers.
2. No raw-literal count (scripts/raw-literal-ratchet.sh) and no source file's line count (scripts/file-size-ratchet.sh)
   rises above the larger of its base baseline number and the base commit's own count: main may already be over a
   baseline (that is its own fix), but no change makes it worse.
Exit 0 pass, 1 a ratchet failed, 2 usage or no such base commit.
"""
import importlib.util, io, subprocess, sys, tarfile, tempfile
from pathlib import Path

SETS = ("scripts/dead-click.baseline", "scripts/noop-click.baseline", "scripts/overlap.baseline")
RAW, SIZES = "scripts/raw-literals.baseline", "scripts/file-sizes.baseline"
LIMIT = 2000  # scripts/file-size-ratchet.sh


def lines(text):
    return [l for l in text.splitlines() if l.strip() and not l.startswith("#")]


def raw_counts(text):  # "kind path count"
    return {tuple(l.split()[:2]): int(l.split()[2]) for l in lines(text)}


def size_counts(text):  # "count path"
    return {l.split(None, 1)[1].strip(): int(l.split(None, 1)[0]) for l in lines(text)}


def read(path):
    return Path(path).read_text() if Path(path).is_file() else ""


def main():
    if len(sys.argv) != 2:
        print(__doc__.split("\n\n")[0], file=sys.stderr)
        return 2
    ref, bad = sys.argv[1], []
    if subprocess.run(["git", "rev-parse", "--verify", "--quiet", ref + "^{commit}"], capture_output=True).returncode:
        print(f"ratchets: no base commit {ref} (fetch it: the checkout needs fetch-depth 0)", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        with tarfile.open(fileobj=io.BytesIO(subprocess.run(["git", "archive", ref], capture_output=True, check=True).stdout)) as t:
            t.extractall(base, filter="data")
        for path in SETS:
            bad += [f"{path} gained a line: {l}" for l in sorted(set(lines(read(path))) - set(lines(read(base / path))))]
        for path, parse in ((RAW, raw_counts), (SIZES, size_counts)):
            old = parse(read(base / path))
            bad += [f"{path} raised {k}: {old.get(k, 0)} to {n}" for k, n in sorted(parse(read(path)).items()) if n > old.get(k, 0)]

        # raw literals: the base's counter over both trees
        count = lambda src: raw_counts(subprocess.run(["sh", str(base / "scripts/raw-literals.sh"), str(src)],  # noqa: E731
                                                      capture_output=True, text=True, check=True).stdout)
        allowed = raw_counts(read(base / RAW))
        for k, n in count(base / "web/src").items():
            allowed[k] = max(allowed.get(k, 0), n)
        bad += [f"raw literals: {a} {p}: {n}, allowed {allowed.get((a, p), 0)}" for (a, p), n in sorted(count(Path("web/src")).items())
                if n > allowed.get((a, p), 0)]

        # file sizes: the base's source-file pattern (scorecard.py SOURCE, NOT_SOURCE), as the judge counts
        spec = importlib.util.spec_from_file_location("base_scorecard", base / "scripts/measure/scorecard.py")
        card = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(card)
        source = lambda p: card.SOURCE.search(p) and not card.NOT_SOURCE.search(p)  # noqa: E731
        size = lambda f: f.read_bytes().count(b"\n") if f.is_file() else 0  # noqa: E731
        listed = size_counts(read(base / SIZES))
        for p in subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout.splitlines():
            if source(p):
                cap = max(listed.get(p, LIMIT), size(base / p))
                if size(Path(p)) > cap:
                    bad.append(f"file size: {p}: {size(Path(p))} lines, allowed {cap}")
    for b in bad:
        print(f"ratchets: {b}", file=sys.stderr)
    if bad:
        print("ratchets failed: a baseline may only shrink, and no count may rise above its baseline or main's own "
              "(use a token from web/src/tokens.css; split a long file or move its tests to a sibling tests.rs)", file=sys.stderr)
        return 1
    print("ratchets: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
