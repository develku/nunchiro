#!/usr/bin/env python3
"""The mainwatch log of the PR flow (ticket 1148): the GitHub Actions runs of ci.yml on main, and the owner installs made
by hand, written in the line format scorecard.py parse_mainwatch and parse_deploys already read.

  python3 -B scripts/measure/ci-log.py [--since LOCAL-TIME] [--runs FILE]
  python3 -B scripts/measure/ci-log.py --install SHA --rc N "the line owner-install.sh printed"

It writes ci-mainwatch.log beside the old mainwatch.log (the folder of MEASURE_MAINWATCH, default the main checkout's
.scratch/fable) and replaces it whole on every run: the old mainwatch.log as it is (read only, so the history before the
cutover still counts), then one "testing <sha>" line per run at its start and "GREEN <sha>" or "RED <sha>: ..." at its
end, then the lines of ci-installs.log. The judge sets MEASURE_MAINWATCH to ci-mainwatch.log.

--install adds one line to ci-installs.log the way mainwatch.sh wrote it (exit 0: "owner install <sha>: <line>"; 3 or
4: "owner wait", which is no outcome; any other: "owner install <sha>: FAILED: ..."), then writes the log again. It
installs nothing.

The log has times only and its readers start a new day when a time is earlier than the one before. So for every
midnight between two lines this script writes a "23:59:59" and a "00:00:00" line that repeat main's state (GREEN or
RED of commit 0000...): the readers count the day and nothing else. Times are local, as mainwatch wrote them.
Read only on GitHub ("gh run list", and "gh api .../actions/runs/<id>/attempts/<n>" for the earlier attempts of a
rerun: every attempt is a gate run of its own). MEASURE_REPO names the repository (default develku/nunchiro).

Runs on main overlap, and parse_deploys ends a red episode at any GREEN line. So the GREEN of a commit older than the
newest red commit of the open episode (an older tip that ended late, or its rerun) is held back and written right
after the GREEN that really ends the episode: it is a gate run, it restores nothing. Until then its run reads as
still going, and its minutes then run to that later time: both make the score worse, never better.
shortcut: a commit is rerun again while its green is held: that green is not counted; give the held line its own
testing line when that is ever seen.
shortcut: the last 500 runs; older ones leave the log (the old mainwatch.log part stays).
"""
import argparse, datetime, json, os, re, subprocess, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scorecard  # noqa: E402  (the folder of the logs, and the landloop log that dates the old log's first line)

REPO = os.environ.get("MEASURE_REPO") or "develku/nunchiro"
DIR = scorecard.MAINWATCH.parent
OLD, OUT, INSTALLS = DIR / "mainwatch.log", DIR / "ci-mainwatch.log", DIR / "ci-installs.log"
ZERO, FIRST = "0" * 40, ("", 0)


def local(utc):
    return datetime.datetime.fromisoformat(utc.replace("Z", "+00:00")).astimezone().replace(tzinfo=None)


def end_of(text, start):
    """(time of the last line, main is red) of a mainwatch log whose first line is on the date 'start', days counted
    as the readers count them (parse_deploys counts on the testing, GREEN and RED lines only; on the old log both
    ways give the same day, 2026-11-25)."""
    day, last, red = 0, None, False
    for m in re.finditer(r"^(\d\d):(\d\d):(\d\d) (\S+)", text, re.M):
        t = int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3])
        day += last is not None and t < last
        last, red = t, {"RED": True, "GREEN": False}.get(m[4], red)
    if last is None:
        return None, False
    return datetime.datetime.combine(start, datetime.time()) + datetime.timedelta(days=day, seconds=last), red


def attempts(runs, fetch):
    """One row per attempt. "gh run list" gives a run's last attempt only; fetch(run id, n) gives an earlier one (the
    REST attempts endpoint), so a failed attempt stays a red gate run when its rerun is green."""
    out = []
    for r in runs:
        for n in range(1, r.get("attempt") or 1):
            a = fetch(r["databaseId"], n)
            out.append(dict(r, status=a["status"], conclusion=a["conclusion"], startedAt=a["run_started_at"], updatedAt=a["updated_at"]))
        out.append(r)
    return out


def build(old, start, runs, installs=(), since="0001-01-01"):
    """The whole log. old, start: the old mainwatch log and the date of its first line; runs: one row per attempt
    (attempts()); installs: the lines of ci-installs.log; since: runs created before it (local time, ISO) are left out."""
    at, red = end_of(old, start) if old.strip() else (None, False)
    rows = []  # (time, line, the run's creation time and id: a run is created by its push, so they order the commits on main)
    for r in runs:
        if local(r["createdAt"]) < datetime.datetime.fromisoformat(since):
            continue
        sha, c, commit = r["headSha"], r.get("conclusion"), (r["createdAt"], r["databaseId"])
        rows.append((local(r["startedAt"]), f"testing {sha}", commit))
        if r["status"] == "completed":
            rows.append((local(r["updatedAt"]), f"GREEN {sha}" if c == "success" else
                         f"RED {sha}: Actions run {r['databaseId']}" if c in ("failure", "timed_out") else
                         f"red at {sha} with no named failure ({c}): infra or unnamed", commit))
    for line in installs:
        ts, _, rest = line.partition(" ")
        rows.append((datetime.datetime.fromisoformat(ts), rest, FIRST))
    out = [old.rstrip("\n")] if at else []
    newest_red, held = FIRST, []  # of the open red episode; FIRST for one the old log left open: every commit here is newer
    for t, text, commit in sorted((r for r in rows if not at or r[0] > at), key=lambda r: r[0]):  # stable: testing before its verdict
        kind = text.split()[0]
        if kind == "GREEN" and red and commit < newest_red:
            held.append(text)
            continue
        for d in range((t.date() - at.date()).days if at else 0):
            mark = f"{'RED' if red else 'GREEN'} {ZERO} day {at.date() + datetime.timedelta(days=d + 1)}"
            out += ["23:59:59 " + mark, "00:00:00 " + mark]
        out += [f"{t:%H:%M:%S} {text}"] + ([f"{t:%H:%M:%S} {h}" for h in held] if kind == "GREEN" else [])
        at = t
        if kind == "RED":
            newest_red, red = max(newest_red, commit) if red else commit, True
        elif kind == "GREEN":
            red, held = False, []
    return "\n".join(out) + "\n"


def install_line(sha, rc, line, now):
    """The ci-installs.log line for one run of owner-install.sh (mainwatch.sh: a line for a build that did not land
    never holds the word "installed", which is what parse_mainwatch counts as landed)."""
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        sys.exit(f"ci-log: {sha!r} is not a full 40-character commit; the scorecard reads no other form")
    line = " ".join(line.split())
    what = (f"owner install {sha}: {line}" if rc == 0 else f"owner wait {sha}: {line}" if rc in (3, 4) else
            f"owner install {sha}: FAILED: {line.replace('installed', 'in place')}")
    return f"{now:%Y-%m-%dT%H:%M:%S} {what}"


def gh(*args):
    r = subprocess.run(["gh", *args], capture_output=True, text=True)
    if r.returncode:  # a run or an attempt that cannot be read must not leave a log without it
        sys.exit(f"ci-log: gh {' '.join(args[:2])} failed, {OUT} is unchanged: {r.stderr.strip()}")
    return r.stdout


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--since", default=os.environ.get("MEASURE_CI_SINCE") or "2026-11-26",
                    help="leave out runs created before this local time (default: the day of the PR-flow cutover; before it a main run had no gate job)")
    ap.add_argument("--runs", help='a file with the JSON of "gh run list" (default: ask gh); earlier attempts are still asked from gh')
    ap.add_argument("--install", metavar="SHA", help="record one owner-install.sh run of this commit")
    ap.add_argument("--rc", type=int, help="with --install: the exit code of owner-install.sh")
    ap.add_argument("line", nargs="?", help="with --install: the line owner-install.sh printed")
    a = ap.parse_args()
    if a.install:
        if a.rc is None or not a.line:
            ap.error("--install needs --rc and the line")
        with open(INSTALLS, "a") as f:
            f.write(install_line(a.install, a.rc, a.line, datetime.datetime.now()) + "\n")
    if a.runs:
        runs = json.loads(Path(a.runs).read_text())
    else:
        runs = json.loads(gh("run", "list", "--repo", REPO, "--workflow", "ci.yml", "--branch", "main", "--event", "push", "--limit", "500",
                             "--json", "databaseId,attempt,headSha,status,conclusion,createdAt,startedAt,updatedAt"))
    runs = attempts(runs, lambda run, n: json.loads(gh("api", f"repos/{REPO}/actions/runs/{run}/attempts/{n}")))
    old = OLD.read_text() if OLD.is_file() else ""
    first = re.search(r'"ts": "(\d{4}-\d\d-\d\d)T', scorecard.LANDLOOP.read_text() if scorecard.LANDLOOP.is_file() else "")
    if old.strip() and not first:
        sys.exit(f"ci-log: {OLD} has no date without {scorecard.LANDLOOP} (the scorecard dates it the same way)")
    installs = [x for x in INSTALLS.read_text().splitlines() if x.strip()] if INSTALLS.is_file() else []
    text = build(old, first and datetime.date.fromisoformat(first[1]), runs, installs, a.since)
    tmp = OUT.with_suffix(".tmp")
    tmp.write_text(text)  # a reader never sees half a log
    tmp.replace(OUT)
    green = re.findall(r"^\d\d:\d\d:\d\d GREEN ([0-9a-f]{40})$", text, re.M)
    print(f"wrote {OUT}: {text.count(' testing ') - old.count(' testing ')} runs, {len(installs)} install lines; "
          f"latest green {green[-1] if green else 'none'}")


if __name__ == "__main__":
    main()
