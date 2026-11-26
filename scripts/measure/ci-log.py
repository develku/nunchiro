#!/usr/bin/env python3
"""The main CI log (ticket 1148): the GitHub Actions runs of ci.yml on main and the owner installs made by hand, in
the line format scorecard.py parse_main_log and parse_deploys read.

  python3 -B scripts/measure/ci-log.py [--since LOCAL-TIME] [--runs FILE] [--history FILE --history-start DATE]
  python3 -B scripts/measure/ci-log.py --install SHA --rc N "the line owner-install.sh printed"

It writes ci-main.log (the file MEASURE_CI_LOG names, default the main checkout's .scratch/fable/ci-main.log) and
replaces it whole on every run: a "# first day <date>" line that dates the log for its readers, then --history as it
is (an earlier log in the same line format, whose first line is on --history-start; read only, so the runs before the
PR flow still count in "the last 30 runs"), then one "testing <sha>" line per run at its start and "GREEN <sha>" or
"RED <sha>: ..." at its end, then the lines of ci-installs.log (beside ci-main.log).

--install adds one line to ci-installs.log (exit 0: "owner install <sha>: <line>"; 3 or 4: "owner wait", which is no
outcome; any other: "owner install <sha>: FAILED: ..."), then writes the log again. It installs nothing.

The log has times only and its readers start a new day when a time is earlier than the one before. So for every
midnight between two lines this script writes a "23:59:59" and a "00:00:00" line that repeat main's state (GREEN or
RED of commit 0000...): the readers count the day and nothing else. Times are local.
Read only on GitHub ("gh run list", and "gh api .../actions/runs/<id>/attempts/<n>" for the earlier attempts of a
rerun: every attempt is a gate run of its own). MEASURE_REPO names the repository (default develku/nunchiro).

Runs on main overlap, and parse_deploys ends a red episode at any GREEN line. So the GREEN of a commit older than the
newest red commit of the open episode (an older tip that ended late, or its rerun) is held back and written right
after the GREEN that really ends the episode: it is a gate run, it restores nothing. Until then its run reads as
still going, and its minutes then run to that later time: both make the score worse, never better.
shortcut: a commit is rerun again while its green is held: that green is not counted; give the held line its own
testing line when that is ever seen.
shortcut: the last 500 runs; older ones leave the log (the --history part stays).
"""
import argparse, datetime, json, os, re, subprocess, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scorecard  # noqa: E402  (where the log goes)

REPO = os.environ.get("MEASURE_REPO") or "develku/nunchiro"
OUT = scorecard.CI_LOG
INSTALLS = OUT.parent / "ci-installs.log"
ZERO, FIRST = "0" * 40, ("", 0)


def local(utc):
    return datetime.datetime.fromisoformat(utc.replace("Z", "+00:00")).astimezone().replace(tzinfo=None)


def end_of(text, start):
    """(time of the last line, main is red) of a log whose first line is on the date 'start', days counted as the
    readers count them (parse_deploys counts on the testing, GREEN and RED lines only; on the history log of
    2026-11-20 to 11-25 both ways give the same day, 2026-11-25)."""
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
    """The whole log. old, start: the history log and the date of its first line; runs: one row per attempt
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
    first_day = start if at else min((r[0] for r in rows), default=None)
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
    return "".join(f"{x}\n" for x in ([f"# first day {first_day:%Y-%m-%d}"] if first_day else []) + out)


def install_line(sha, rc, line, now):
    """The ci-installs.log line for one run of owner-install.sh (a line for a build that did not land never holds the
    word "installed", which is what parse_main_log counts as landed)."""
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
    ap.add_argument("--history", help="an earlier log in the same line format, written first as it is")
    ap.add_argument("--history-start", help="with --history: the local date of its first line (YYYY-MM-DD)")
    ap.add_argument("--install", metavar="SHA", help="record one owner-install.sh run of this commit")
    ap.add_argument("--rc", type=int, help="with --install: the exit code of owner-install.sh")
    ap.add_argument("line", nargs="?", help="with --install: the line owner-install.sh printed")
    a = ap.parse_args()
    if bool(a.history) != bool(a.history_start):
        ap.error("--history and --history-start go together")
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
    old = Path(a.history).read_text() if a.history else ""
    installs = [x for x in INSTALLS.read_text().splitlines() if x.strip()] if INSTALLS.is_file() else []
    text = build(old, a.history_start and datetime.date.fromisoformat(a.history_start), runs, installs, a.since)
    tmp = OUT.with_suffix(".tmp")
    tmp.write_text(text)  # a reader never sees half a log
    tmp.replace(OUT)
    green = re.findall(r"^\d\d:\d\d:\d\d GREEN ([0-9a-f]{40})$", text, re.M)
    print(f"wrote {OUT}: {text.count(' testing ') - old.count(' testing ')} runs, {len(installs)} install lines; "
          f"latest green {green[-1] if green else 'none'}")


if __name__ == "__main__":
    main()
