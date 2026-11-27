"""Part p35's bot task set (docs/measure/rubric.md, "p35 Bot quality"): fresh fixture copies, one checker per task's
acceptance, and the two figures from the recorded runs. Fake data only: the mails, the calendar and the remote are
files under fixtures/p35; nothing here talks to a mail or calendar account or to the network.

Usage:
  bottasks.py setup TASK RUN [--root DIR]
      A fresh copy of the task's fixture in a new folder under DIR (default $TMPDIR/nunchiro-p35); prints the folder
      and the exact first message to send. Answer keys (mail labels, free hours, the planted line) stay here.
  bottasks.py check DIR --touches N [--stalled ID --agents-before FILE --agents-after FILE] [--card-shown] [--out FILE]
      Checks the run in DIR against its task's acceptance and appends one JSON line to
      docs/measure/bottasks-<date>.jsonl (or --out). A run passes when the acceptance holds and N, the owner's inputs
      after the first message, is 0. Task 6 takes the stalled worker's session id and `nunchiro agent list --json`
      saved before the stall and after the end; task 9 takes --card-shown when the approval card was seen.
  bottasks.py report [FILE...]
      The figures from the JSON lines (the newest line per task and run): written by `scorecard.py bottasks` only when
      all ten tasks have their three runs on one fixture version.
Tests: tests/scenario/test_measure_bottasks.py (each checker on a right and a wrong result).
"""
import argparse
import hashlib
import json
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

FIX = Path(__file__).resolve().parent / "fixtures" / "p35"
OUT_DIR = Path(__file__).resolve().parents[2] / "docs" / "measure"
TASKS = range(1, 11)
RUNS = range(1, 4)
BASE_TESTS = 9  # the fixture repository's own tests
META = ".p35.json"
GIT_ID = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com"]
FIRST = {
    1: "One unit test of calc fails. Fix the code so the whole suite "
              "(`python3 -m unittest discover -s tests -t .`) is green. Do not change the tests.",
    2: "Add a `--precision N` option to the calc CLI that rounds the printed result to N decimal places, with a "
              "test for it and a line in the CLI's --help. Keep the whole suite green.",
    3: "Rename the function `parse_number` to `to_number` everywhere in this repository. Keep the suite green.",
    4: "Split this between your two workers, each in its own worktree, then merge both into `main`: (a) a "
              "`mul` operation (`python3 -m calc mul 4 3` prints 12); (b) a `median` command (`python3 -m calc median "
              "3 1 2` prints 2, `median 1 2 3 4` prints 2.5). Tests for both, suite green on main.",
    5: "Review the change in review/clamp.diff (a patch to calc/stats.py; do not apply it). Write your review "
              "to REVIEW.md at the repository root; name each problem by its line in the patched calc/stats.py.",
    6: "Add a `pow` operation (`python3 -m calc pow 2 10` prints 1024) with a test; have a worker do it. Keep "
              "the suite green.",
    7: "Add a `mod` operation (`python3 -m calc mod 7 3` prints 1) with a test, and open a pull request for "
              "it on `origin`. origin is a local bare git folder with no web host, so the pull request is: a new "
              "branch pushed to origin (not main) whose tip commit has PULL_REQUEST.md at the repository root with "
              "the pull request's summary. Leave origin's main as it is.",
    8: "Assistant task. The folder {dir}/inbox holds ten mails (.eml files). Sort them into three labels: Billing, "
       "Meetings, Newsletters. Move each mail into {dir}/labels/<label>/, one label per mail.",
    9: "Assistant task. Draft a reply to the mail {dir}/inbox/03-sync-next-week.eml offering a time next week. Save "
       "the draft as an .eml file (To, Subject, body) in {dir}/drafts/. Do not send it without my approval; "
       "{dir}/bin/send-mail is the only way to send from here.",
    10: "Assistant task. Find a free hour on Monday 7 December 2026 between 09:00 and 18:00 in the calendar "
        "{dir}/calendar/week.ics (local times) and propose it: write the start as `YYYY-MM-DD HH:MM` (one slot "
        "only) to {dir}/proposal.txt.",
}


def fixture_version():
    """A hash over every fixture file: runs on another version of the set are not mixed in one figure."""
    h = hashlib.sha256()
    for p in sorted(FIX.rglob("*")):
        if p.is_file():
            h.update(str(p.relative_to(FIX)).encode() + b"\0" + p.read_bytes())
    return h.hexdigest()[:12]


def git(cwd, *args, check=True):
    return subprocess.run(["git", *GIT_ID, *args], cwd=cwd, capture_output=True, text=True, check=check).stdout.strip()


def setup(task, run, root=None):
    if task not in TASKS or run not in RUNS:
        raise SystemExit(f"task 1-10 and run 1-3, not {task} {run}")
    root = Path(root or Path(tempfile.gettempdir()) / "nunchiro-p35")
    root.mkdir(parents=True, exist_ok=True)
    d = Path(tempfile.mkdtemp(prefix=f"p35-t{task:02d}-r{run}-{time.strftime('%Y%m%d-%H%M%S')}-", dir=root))  # always new
    meta = dict(task=task, run=run, fixture=fixture_version(), created=time.strftime("%Y-%m-%dT%H:%M:%S"))
    if task <= 7:
        repo = d / "repo"
        shutil.copytree(FIX / "repo", repo, ignore=shutil.ignore_patterns("__pycache__"))
        if (FIX / "overlay" / str(task)).is_dir():
            shutil.copytree(FIX / "overlay" / str(task), repo, dirs_exist_ok=True)
        git(repo, "init", "-q", "-b", "main")
        git(repo, "add", "-A")
        git(repo, "commit", "-qm", "calc fixture")
        git(d, "clone", "-q", "--bare", str(repo), "remote.git")
        git(repo, "remote", "add", "origin", str(d / "remote.git"))
        git(repo, "fetch", "-q", "origin")
        meta["base"] = git(repo, "rev-parse", "HEAD")
    elif task <= 9:
        shutil.copytree(FIX / "mail" / "inbox", d / "inbox")
        (d / "drafts").mkdir()
        (d / "sent").mkdir()
        (d / "bin").mkdir()
        send = d / "bin" / "send-mail"
        # the only "send" here: it files the mail under sent/, so a send without approval is seen; nothing leaves
        send.write_text('#!/bin/sh\n# Fixture send: files the mail under sent/; nothing leaves the Mac.\n'
                        'cat "$@" > "$(dirname "$0")/../sent/$(date +%s)-$$.eml"\necho sent\n')
        send.chmod(0o755)
    else:
        shutil.copytree(FIX / "calendar", d / "calendar", ignore=shutil.ignore_patterns("key.json"))
    (d / META).write_text(json.dumps(meta, indent=1) + "\n")
    where = (f"Open {d / 'repo'} as a project; send to its lead, with two workers" if task <= 7
             else "Send to the Assistant")
    return d, where, FIRST[task].format(dir=d)


# The checks. Each returns the list of what does not hold; an empty list is the acceptance holding.

def suite(tree, at_least):
    try:
        r = subprocess.run([sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests", "-t", "."], cwd=tree,
                           capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        return ["the test suite ran over 300 s"]
    ran = re.search(r"^Ran (\d+) tests?", r.stderr, re.M)
    n = int(ran.group(1)) if ran else 0
    last = r.stderr.strip().splitlines()[-1:] or [""]
    if r.returncode or last[0] != "OK":  # "OK (skipped=1)" is not green: a skip hides a test
        return [f"the test suite is not green ({last[0] or 'no output'})"]
    return [] if n >= at_least else [f"the suite ran {n} tests, the fixture has {at_least}"]


def calc(tree, *args):
    r = subprocess.run([sys.executable, "-B", "-m", "calc", *args], cwd=tree, capture_output=True, text=True, timeout=60)
    return (r.stdout + r.stderr).strip() if r.returncode else r.stdout.strip()


def expect(tree, args, want):
    got = calc(tree, *args)
    return [] if got == want else [f"`calc {' '.join(args)}` printed {got[-200:]!r}, not {want!r}"]


def files(tree):
    return [p for p in Path(tree).rglob("*") if p.is_file() and ".git" not in p.parts and "__pycache__" not in p.parts]


def at_ref(repo, ref, into):
    """The tree of `ref` (a branch, not the working copy) in a new folder."""
    into.mkdir()
    a = subprocess.run(["git", "archive", ref], cwd=repo, capture_output=True, check=True)
    subprocess.run(["tar", "-x", "-C", str(into)], input=a.stdout, check=True)
    return into


def check_1(d, meta, obs, tmp):
    repo = d / "repo"
    changed = [t for t in ("tests/test_core.py", "tests/test_cli.py", "tests/test_numbers.py", "tests/test_stats.py")
               if (repo / t).read_bytes() != (FIX / "repo" / t).read_bytes()] if (repo / "tests").is_dir() else ["tests/"]
    return suite(repo, BASE_TESTS) + [f"{t} was changed" for t in changed]


def check_2(d, meta, obs, tmp):
    repo = d / "repo"
    why = suite(repo, BASE_TESTS + 1)
    helps = calc(repo, "--help") + calc(repo, "div", "--help")
    if "--precision" not in helps:
        why.append("the help does not show --precision")
    if "3.33" not in (calc(repo, "--precision", "2", "div", "10", "3"), calc(repo, "div", "10", "3", "--precision", "2")):
        why.append("`--precision 2` does not print 10 / 3 as 3.33")
    if not any("precision" in p.read_text(errors="replace") for p in (repo / "tests").glob("test*.py")):
        why.append("no test names precision")
    return why


def check_3(d, meta, obs, tmp):
    repo = d / "repo"
    why = suite(repo, BASE_TESTS)
    old = [str(p.relative_to(repo)) for p in files(repo) if re.search(r"\bparse_number\b", p.read_text(errors="replace"))]
    if old:
        why.append("the old name is still in " + ", ".join(sorted(old)))
    if not re.search(r"^def to_number\(", (repo / "calc" / "numbers.py").read_text(), re.M):
        why.append("calc/numbers.py does not define to_number")
    for f in ("calc/core.py", "calc/cli.py", "calc/stats.py", "tests/test_numbers.py"):
        if "to_number" not in (repo / f).read_text():
            why.append(f"{f} does not use to_number")
    return why


def check_4(d, meta, obs, tmp):
    t = at_ref(d / "repo", "main", tmp / "main")
    return (suite(t, BASE_TESTS + 2) + expect(t, ["mul", "4", "3"], "12") + expect(t, ["median", "3", "1", "2"], "2")
            + expect(t, ["median", "1", "2", "3", "4"], "2.5"))


PLANTED = dict(file="stats.py", line=15)  # `return max(low, min(value, low))` in the patched calc/stats.py
MOST_LINES = 3  # a review that names more lines than this guesses rather than finds
NUMS = r"\d+(?:\s*(?:,|and|&|-|\u2013|to)\s*\d+)*"
REFS = re.compile(rf"{re.escape(PLANTED['file'])}:({NUMS})|\b(?:lines?|L)\s*({NUMS})", re.I)


def named_lines(text):
    """Every line of the patched file the text names: `stats.py:N`, "line N", "lines N, M and K", and each line of a
    range ("lines 1-40", "stats.py:14-16")."""
    out = set()
    for m in REFS.finditer(text):
        for part in re.split(r"\s*(?:,|and|&)\s*", m.group(1) or m.group(2)):
            ends = [int(x) for x in re.split(r"\s*(?:-|\u2013|to)\s*", part) if x.isdigit()]
            out.update(range(min(ends), max(ends) + 1) if ends else ())
    return out


def check_5(d, meta, obs, tmp):
    review = d / "repo" / "REVIEW.md"
    if not review.is_file():
        return ["no REVIEW.md at the repository root"]
    lines, n = named_lines(review.read_text(errors="replace")), PLANTED["line"]
    why = [] if n in lines else [f"the review does not name line {n} of calc/stats.py"]
    if len(lines) > MOST_LINES:
        why.append(f"the review names {len(lines)} lines, at most {MOST_LINES} count as finding the bug")
    return why


def agents(path):
    rows = json.loads(Path(path).read_text())
    return {r["id"]: r for r in rows if isinstance(r, dict) and r.get("id")}


def check_6(d, meta, obs, tmp):
    repo = d / "repo"
    why = suite(repo, BASE_TESTS + 1) + expect(repo, ["pow", "2", "10"], "1024")
    if not (obs.get("stalled") and obs.get("agents_before") and obs.get("agents_after")):
        return why + ["task 6 needs --stalled, --agents-before and --agents-after"]
    before, after = agents(obs["agents_before"]), agents(obs["agents_after"])
    if obs["stalled"] not in before:
        why.append("the stalled worker is not in the list saved before the stall")
    fresh = [k for k, r in after.items() if k not in before and r.get("kind") != "shell"]
    if not fresh:
        why.append("no fresh agent conversation was started after the stall")
    return why


def check_7(d, meta, obs, tmp):
    remote = d / "remote.git"
    if git(remote, "rev-parse", "main") != meta["base"]:
        return ["origin's main moved: the change was merged, not opened as a pull request"]
    branches = [b for b in git(remote, "for-each-ref", "refs/heads", "--format=%(refname:short)").split() if b != "main"]
    if not branches:
        return ["no branch other than main on origin"]
    fails = []
    for i, b in enumerate(branches):
        tree = at_ref(remote, b, tmp / f"b{i}")
        why = suite(tree, BASE_TESTS + 1) + expect(tree, ["mod", "7", "3"], "1")
        summary = tree / "PULL_REQUEST.md"
        if not summary.is_file():
            why.append("no PULL_REQUEST.md at its tip")
        else:
            text = summary.read_text(errors="replace")
            changed = [f for f in git(remote, "diff", "--name-only", "main", b).split() if f != "PULL_REQUEST.md"]
            why += [f"the summary does not name {f}" for f in changed if f not in text and Path(f).name not in text]
            if not changed:
                why.append("the branch changes no file")
        if not why:
            return []
        fails += [f"{b}: {w}" for w in why]
    return fails


def key():
    return json.loads((FIX / "mail" / "key.json").read_text())


def check_8(d, meta, obs, tmp):
    k = key()
    where = {}
    for p in (d / "labels").glob("*/*.eml") if (d / "labels").is_dir() else []:
        where.setdefault(p.name, []).append(p.parent.name)
    right = sum(1 for m, label in k["mails"].items() if where.get(m) == [label])
    return [] if right >= 9 else [f"{right} of 10 mails under their right label (a mail in two labels counts wrong)"]


def headers(text):
    head = text.replace("\r\n", "\n").split("\n\n", 1)
    h = {}
    for line in head[0].splitlines():
        if ":" in line:
            name, value = line.split(":", 1)
            h[name.strip().lower()] = value.strip()
    return h, head[1].strip() if len(head) > 1 else ""


def check_9(d, meta, obs, tmp):
    r = key()["reply_to"]
    why = []
    drafts = sorted((d / "drafts").glob("*")) if (d / "drafts").is_dir() else []
    good = []
    for p in drafts:
        h, body = headers(p.read_text(errors="replace"))
        if r["to"] in h.get("to", "") and re.match(r"re:", h.get("subject", ""), re.I) and r["subject"] in h["subject"] and body:
            good.append(p.name)
    if not good:
        why.append(f"no draft in drafts/ with To {r['to']}, Subject Re: {r['subject']} and a body")
    sent = [p.name for p in (d / "sent").glob("*")] if (d / "sent").is_dir() else []
    if sent:
        why.append("sent: " + ", ".join(sent))
    if not obs.get("card_shown"):
        why.append("the approval card was not seen (--card-shown)")
    return why


def check_10(d, meta, obs, tmp):
    k = json.loads((FIX / "calendar" / "key.json").read_text())
    p = d / "proposal.txt"
    slots = re.findall(r"\b(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})\b", p.read_text(errors="replace")) if p.is_file() else []
    if len(slots) != 1:
        return [f"proposal.txt holds {len(slots)} slots, the task asks for one"]
    day, hh, mm = slots[0]
    start = int(hh) * 60 + int(mm)
    mins = lambda s: int(s[:2]) * 60 + int(s[3:])  # noqa: E731
    if day != k["day"]:
        return [f"{day} is not the asked day {k['day']}"]
    if not any(mins(a) <= start and start + 60 <= mins(b) for a, b in k["free"]):
        return [f"{day} {hh}:{mm} to an hour later is not free in the fixture"]
    return []


CHECKS = {1: check_1, 2: check_2, 3: check_3, 4: check_4, 5: check_5, 6: check_6, 7: check_7, 8: check_8, 9: check_9,
          10: check_10}


def check(d, touches, obs=None):
    d = Path(d).resolve()
    meta = json.loads((d / META).read_text())
    with tempfile.TemporaryDirectory() as tmp:
        try:
            why = CHECKS[meta["task"]](d, meta, obs or {}, Path(tmp))
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
            why = [f"the check could not read the run: {type(e).__name__}: {e}"]
    return dict(at=time.strftime("%Y-%m-%dT%H:%M:%S"), task=meta["task"], run=meta["run"], fixture=meta["fixture"],
                dir=str(d), acceptance=not why, why=why, touches=touches, passed=not why and touches == 0,
                observed={k: v for k, v in (obs or {}).items() if v})


def figures(lines):
    """bot_task_success_pct and bot_owner_touches (the median over the 30 runs) from the newest line per task and run;
    `complete` only with all 30 on one fixture version."""
    newest = {}
    for r in sorted(lines, key=lambda r: r["at"]):
        newest[(r["task"], r["run"])] = r
    want = {(t, n) for t in TASKS for n in RUNS}
    runs = [newest[k] for k in sorted(want & newest.keys())]
    versions = {r["fixture"] for r in runs}
    missing = sorted(want - newest.keys())
    res = dict(runs=len(runs), missing=[f"t{t}r{n}" for t, n in missing], versions=sorted(versions),
               passed=sum(r["passed"] for r in runs), complete=not missing and len(versions) == 1)
    if res["complete"]:
        res["figures"] = dict(bot_task_success_pct=round(100 * res["passed"] / len(runs), 1),
                              bot_owner_touches=statistics.median(r["touches"] for r in runs))
    return res


def read_lines(paths):
    return [json.loads(x) for p in paths for x in Path(p).read_text().splitlines() if x.strip()]


def main(argv=None):
    ap = argparse.ArgumentParser(prog="bottasks.py", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("setup")
    s.add_argument("task", type=int)
    s.add_argument("run", type=int)
    s.add_argument("--root")
    c = sub.add_parser("check")
    c.add_argument("dir")
    c.add_argument("--touches", type=int, required=True, help="the owner's inputs after the first message")
    c.add_argument("--stalled", help="task 6: the stalled worker's session id")
    c.add_argument("--agents-before", help="task 6: `nunchiro agent list --json` saved before the stall")
    c.add_argument("--agents-after", help="task 6: the same, saved after the task ended")
    c.add_argument("--card-shown", action="store_true", help="task 9: the approval card was seen in the window")
    c.add_argument("--out")
    r = sub.add_parser("report")
    r.add_argument("files", nargs="*")
    a = ap.parse_args(argv)
    if a.cmd == "setup":
        d, where, first = setup(a.task, a.run, a.root)
        print(f"run folder: {d}\n{where}. The first message (send it unchanged):\n\n{first}")
        return None
    if a.cmd == "check":
        rec = check(a.dir, a.touches, dict(stalled=a.stalled, agents_before=a.agents_before, agents_after=a.agents_after,
                                           card_shown=a.card_shown))
        out = Path(a.out) if a.out else OUT_DIR / f"bottasks-{time.strftime('%Y-%m-%d')}.jsonl"
        with out.open("a") as f:
            f.write(json.dumps(rec) + "\n")
        print(("PASS" if rec["passed"] else "FAIL") + f" task {rec['task']} run {rec['run']}: "
              + ("; ".join(rec["why"]) or "acceptance holds") + f"; owner touches {rec['touches']} -> {out}")
        return rec
    paths = a.files or sorted(str(p) for p in OUT_DIR.glob("bottasks-*.jsonl"))
    res = figures(read_lines(paths))
    res["files"] = [Path(p).name for p in paths]
    print(json.dumps(res, indent=1))
    return res


if __name__ == "__main__":
    main()
