#!/usr/bin/env python3
"""Development speed for the scorecard (ticket 1127, part p30): the DORA four keys, adapted to this repo.

  python3 -B scripts/measure-dev-speed.py [--days 7] [--out FILE] [--tasks FILE] [--prs FILE] [--events FILE] [--mainwatch FILE]
  python3 -B scripts/measure-dev-speed.py --selftest

Read only. Sources:
- git log of origin/main: "Merge lane <lane> (<branch> <sha>)" commits are the landings (the ground truth; merging moves
  from bin/land into Nunchiro, so the bin/land events are optional). The lane's own commits are <merge>^1..<merge>^2.
- merged pull requests (ticket 1148, the PR flow): one GitHub search of MEASURE_REPO (default develku/nunchiro) through
  "gh api graphql", read only, or --prs FILE with the JSON of "gh pr list --state merged --json ...". A merged pull
  request is a landing like a "Merge lane" commit; both are counted.
- the bin/land events (<main checkout>/.scratch/build-loop/events.jsonl): enqueue, gate_result, landed, eject, kick,
  receipt. Default: the main checkout of this repo's git common dir; --events or MEASURE_EVENTS.
- the mainwatch log (<main checkout>/.scratch/fable/mainwatch.log, as in scorecard.py; --mainwatch or MEASURE_MAINWATCH):
  red episodes, culprit lanes, owner installs.
- the task ledger: --tasks FILE (the JSON of "nunchiro task list --all --json"); without it the script runs that command
  when NUNCHIRO_SESSION is set (it only lists), else it skips the ledger.
- the core's event journal ("nunchiro events --history", read from the day files; the owner's shell only) and the agents'
  own transcripts: ~/.claude, the folders in MEASURE_CLAUDE_DIRS (other accounts, ':' between them) and
  MEASURE_CODEX_SESSIONS (default ~/.codex/sessions).

The four keys:
1. Deployment frequency: lanes landed on main per day (and landings, a landing being one merge time that can carry
   several lanes), and owner installs per day ("owner install ...: installed" in the mainwatch log).
2. Lead time for changes: first lane commit (author date) to the merge on main, median and p90 (the DORA definition);
   also task created (ledger) to the merge, for lanes whose branch matches a task's worktree folder.
3. Change failure rate: landed lanes later reverted (a "fable-revert-<lane>" merge, a "lead-revert<ticket>" merge
   (the lane of that ticket), a lane whose own commits are all reverts ("Revert ..."), or a merged pull request from a
   "revert-<number>-<branch>" branch, GitHub's Revert button) or named culprit by mainwatch, over
   lanes landed. Gate rejects (eject and kick events) are shown beside it: they never reached main.
4. Time to restore: main red to green again (mainwatch), median.
Flow split, where data exists: task created to the Reviewer seat, the Reviewer seat to its pass, the pass to the enqueue,
the gate queue (last enqueue to landed, less the gate runs) and the gate runs (gate_result durations of the landed
candidate). Review rounds per lane: distinct reviewed patches (receipt events of kind review). For a pull request the
enqueue is its opening, the gate run its last CI run (first job start to the end of `gate`) and the gate queue the rest
of the time to the merge.
"""
import argparse, datetime, json, os, re, statistics, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts/measure"))
import scorecard  # noqa: E402  (MAINWATCH, LANDLOOP and the red-episode parser of part p27)

EVENTS = Path(os.environ.get("MEASURE_EVENTS") or scorecard.MAINWATCH.parent.parent / "build-loop/events.jsonl")
MERGE = re.compile(r"^Merge lane (\S+) \((\S+) [0-9a-f]+\)$")
REVERT = scorecard.REVERT_LANE  # a bin/land or lead revert lane; GitHub's revert branch of a pull request
DAY = 86400


def git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, check=True).stdout


def pct(values, q):
    """Nearest-rank percentile (q in 0..100); None when empty."""
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    return vals[max(0, min(len(vals) - 1, -(-len(vals) * q // 100) - 1))]


def hours(values):
    vals = [v for v in values if v is not None]
    return dict(n=len(vals), median_h=round(statistics.median(vals) / 3600, 1) if vals else None,
                p90_h=round(pct(vals, 90) / 3600, 1) if vals else None)


def minutes(values):
    vals = [v for v in values if v is not None]
    return dict(n=len(vals), median_min=round(statistics.median(vals) / 60) if vals else None,
                p90_min=round(pct(vals, 90) / 60) if vals else None)


def iso(ts):
    return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


def merges(since):
    """[{lane, branch, sha, at, first_commit, subjects}] for the first-parent lane merges on origin/main since an epoch."""
    out = []
    for line in git("log", "origin/main", "--first-parent", "--merges", f"--since=@{int(since)}", "--format=%H %ct %s").splitlines():
        sha, at, subject = line.split(" ", 2)
        m = MERGE.match(subject)
        if not m:
            continue
        own = [x.split(" ", 1) for x in git("log", "--no-merges", "--format=%at %s", f"{sha}^1..{sha}^2").splitlines()]
        out.append(dict(lane=m[1], branch=m[2], sha=sha, at=int(at), first_commit=min(int(t) for t, _ in own) if own else None,
                        subjects=[x for _, x in own]))
    return out


def pr_merges(prs, since):
    """The rows of merges() for merged pull requests (the JSON of "gh pr list --state merged"): the lane and the branch
    are the head branch, the sha is the commit on main. 'opened' and 'gate_run_s' (the last CI run, from the first job's
    start to the end of the `gate` job) feed the flow split.
    shortcut: the opening stands for the enqueue; read the auto-merge time from the PR timeline when PRs are opened
    long before they are ready."""
    out = []
    for p in prs:
        at = iso(p["mergedAt"])
        if at < since:
            continue
        own = [iso(c["authoredDate"]) for c in p.get("commits") or []]
        checks = [c for c in p.get("statusCheckRollup") or [] if c.get("workflowName") == "CI" and c.get("startedAt")]
        gate = next((c for c in checks if c.get("name") == "gate" and c.get("completedAt")), None)
        out.append(dict(lane=p["headRefName"], branch=p["headRefName"], sha=(p.get("mergeCommit") or {}).get("oid"), at=int(at),
                        first_commit=int(min(own)) if own else None, opened=iso(p["createdAt"]),
                        gate_run_s=gate and iso(gate["completedAt"]) - min(iso(c["startedAt"]) for c in checks)))
    return out


# One page is 50 pull requests with their first commit and the checks of their last one. "gh pr list --json commits"
# asks for every commit and its authors, which GitHub refuses from 50 pull requests up (500,000 nodes).
PR_QUERY = """query($q: String!, $endCursor: String) { search(query: $q, type: ISSUE, first: 50, after: $endCursor) {
  pageInfo { hasNextPage endCursor }
  nodes { ... on PullRequest { number headRefName createdAt mergedAt mergeCommit { oid }
    first: commits(first: 1) { nodes { commit { authoredDate } } }
    last: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes {
      ... on CheckRun { name startedAt completedAt checkSuite { workflowRun { workflow { name } } } } } } } } } } } } } }"""


def gh_prs(q):
    """Merged pull requests for a search, in the field names of "gh pr list --json" (read only), and where they came from."""
    r = subprocess.run(["gh", "api", "graphql", "--paginate", "--slurp", "-f", "query=" + PR_QUERY, "-f", "q=" + q], capture_output=True, text=True)
    if r.returncode:
        return [], f"not read ({r.stderr.strip()[:80]})"
    dig = lambda v, *keys: dig((v or {}).get(keys[0]), *keys[1:]) if keys else v  # noqa: E731
    out = []
    for n in (n for page in json.loads(r.stdout) for n in page["data"]["search"]["nodes"] if n):
        checks = dig((n.pop("last")["nodes"] or [None])[0], "commit", "statusCheckRollup", "contexts", "nodes") or []
        out.append(dict(n, commits=[c["commit"] for c in n.pop("first")["nodes"]],
                        statusCheckRollup=[dict(c, workflowName=dig(c, "checkSuite", "workflowRun", "workflow", "name")) for c in checks if c]))
    return out, "gh api graphql"


def read_prs(path, since):
    if path:
        return json.loads(Path(path).read_text()), f"file {Path(path).name}"
    return gh_prs(f"repo:{os.environ.get('MEASURE_REPO') or 'develku/nunchiro'} is:pr is:merged base:main "
                  f"merged:>={datetime.date.fromtimestamp(since - DAY)}")


def stamped(text, start):
    """(epoch, line) for the mainwatch lines, which carry times only: a time earlier than the one before starts the next
    day, from the start date (shortcut: the same as scorecard.parse_deploys, a gap of more than a day is not seen)."""
    day, last = 0, None
    for line in text.splitlines():
        m = re.match(r"^(\d\d):(\d\d):(\d\d) ", line)
        if not m:
            continue
        t = int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3])
        if last is not None and t < last:
            day += 1
        last = t
        midnight = datetime.datetime.combine(start + datetime.timedelta(days=day), datetime.time())
        yield midnight.timestamp() + t, line


def read_events(path):
    out = []
    if path.is_file():
        for line in path.read_text().splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def read_tasks(path):
    if path:
        return json.loads(Path(path).read_text()).get("tasks", []), f"file {Path(path).name}"
    if os.environ.get("NUNCHIRO_SESSION"):
        r = subprocess.run(["nunchiro", "task", "list", "--all", "--json"], capture_output=True, text=True)
        if r.returncode == 0:
            return json.loads(r.stdout).get("tasks", []), "nunchiro task list --all --json"
    return [], "not read"


def per_day(times, start, days):
    counts = {(datetime.date.fromtimestamp(start) + datetime.timedelta(days=i)).isoformat(): 0 for i in range(days + 1)}
    for t in times:
        k = datetime.date.fromtimestamp(t).isoformat()
        if k in counts:
            counts[k] += 1
    return counts


def price_table():
    """{model prefix: [input, output, cache write, cache read]} in millionths of a dollar per 1,000 tokens, read from the
    core's own table (crates/nunchiro-core/src/usage.rs PRICES), so the two never disagree."""
    text = (ROOT / "crates/nunchiro-core/src/usage.rs").read_text()
    body = text.split("const PRICES", 1)[1].split("];", 1)[0]
    return [(m[1], [int(x) for x in m[2].split(",")]) for m in re.finditer(r'\("([^"]+)", \[([\d, ]+)\]\)', body)]


def usd(parts, model, prices):
    row = next((p for name, p in prices if model and model.startswith(name)), None)
    return None if row is None else sum(a * b for a, b in zip(parts, row)) / 1e9


def folder_key(name):
    """Claude Code names a project folder after its cwd with every character other than a letter or digit as '-'."""
    return re.sub(r"[^A-Za-z0-9]", "-", name)


def lane_costs(tails, claude_dirs, codex_dir, since):
    """{worktree folder: {tokens, usd, unpriced_tokens, sessions}} over the agents' own transcripts (read only): Claude
    project folders whose name ends with the worktree folder (messages counted once by message id, as the core does),
    and Codex rollouts since the window start whose session_meta cwd is the worktree or under it."""
    prices, out, seen = price_table(), {}, set()
    def add(tail, parts, model, session):
        o = out.setdefault(tail, dict(tokens=0, usd=0.0, unpriced_tokens=0, sessions=set()))
        o["tokens"] += sum(parts)
        cost = usd(parts, model, prices)
        if cost is None:
            o["unpriced_tokens"] += sum(parts)
        else:
            o["usd"] += cost
        o["sessions"].add(session)
    keys = {"-" + folder_key(t): t for t in tails}
    for root in claude_dirs:
        proj = Path(root) / "projects"
        for d in (proj.iterdir() if proj.is_dir() else []):
            tail = next((t for k, t in keys.items() if d.name.endswith(k)), None)
            if not tail or not d.is_dir():
                continue
            for f in d.rglob("*.jsonl"):
                with open(f, errors="replace") as fh:
                    for line in fh:
                        if '"usage"' not in line or '"assistant"' not in line:
                            continue
                        try:
                            v = json.loads(line)
                        except ValueError:
                            continue
                        msg = v.get("message") or {}
                        u, mid = msg.get("usage") or {}, msg.get("id")
                        if v.get("type") != "assistant" or not mid or mid in seen:
                            continue
                        seen.add(mid)
                        parts = [u.get(k) or 0 for k in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")]
                        add(tail, parts, msg.get("model"), v.get("sessionId"))
    day = datetime.date.fromtimestamp(since)
    while codex_dir and day <= datetime.date.today():
        for f in sorted((Path(codex_dir) / f"{day:%Y/%m/%d}").glob("*.jsonl")):
            with open(f, errors="replace") as fh:
                meta = json.loads(fh.readline() or "{}").get("payload") or {}
                parts_of = Path(meta.get("cwd") or "/").parts
                tail = next((t for t in tails if t in parts_of), None)
                model, previous = None, None
                for line in fh if tail else []:
                    if '"turn_context"' in line:
                        model = (json.loads(line).get("payload") or {}).get("model") or model
                    elif '"token_count"' in line:
                        info = (json.loads(line).get("payload") or {}).get("info") or {}
                        total = (info.get("total_token_usage") or {}).get("total_tokens")
                        if total is None or total == previous:
                            continue
                        previous, last = total, info.get("last_token_usage") or {}
                        inp, outp = last.get("input_tokens") or 0, last.get("output_tokens") or 0
                        cached = min(last.get("cached_input_tokens") or 0, inp)
                        add(tail, [inp - cached, outp, 0, cached], model, meta.get("id"))
        day += datetime.timedelta(days=1)
    return {t: dict(o, usd=round(o["usd"], 2), sessions=len(o["sessions"])) for t, o in out.items()}


def core_events(project, days):
    """The core's event journal for a project ("nunchiro events --history": read from the day files, no running core
    needed, the owner's shell only). A room event's data is not in the journal."""
    try:
        r = subprocess.run(["nunchiro", "events", "--history", str(max(1, min(days + 1, 14))), "--project", str(project)],
                           capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return []
    if r.returncode:
        print(f"core events not read: {r.stderr.strip()}", file=sys.stderr)
    out = []
    for line in r.stdout.splitlines():
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def seat_time(events, now):
    """Per session, seconds in each attention state from the core's state events, and the core's auto-advance notes
    (nudge with its quiet minutes, card to the user, resend of a waiting message, seat moves again, other)."""
    states, stalls = {}, []
    cur = {}
    for e in sorted((e for e in events if e.get("at") is not None), key=lambda e: e["at"]):
        t, s = e["at"] / 1000, e.get("session")
        if e["type"] in ("session_started", "state") and s and e.get("state"):
            if s in cur:
                st, since = cur[s]
                states.setdefault(s, {}).setdefault(st, 0)
                states[s][st] += t - since
            cur[s] = (e["state"], t)
        elif e["type"] == "session_ended" and s in cur:
            st, since = cur.pop(s)
            states.setdefault(s, {}).setdefault(st, 0)
            states[s][st] += t - since
        elif e["type"] == "room_message" and (e.get("data") or {}).get("kind") == "team":
            team = e["data"].get("team") or {}
            if team.get("what") == "advance":
                # the core's own lines (advance.rs room_line): a nudge carries the quiet minutes before it
                body = e["data"].get("body") or ""
                m = re.match(r"core nudged .* \(quiet (\d+) min\)$", body)
                kind = ("nudge" if m else "card" if body.startswith("core asked the user") else
                        "resend" if body.startswith("core sent the waiting message") else
                        "moved" if body.endswith(" moves again") else "other")
                stalls.append(dict(seat=team.get("seat"), at=t, kind=kind, quiet_min=int(m[1]) if m else 0))
    for s, (st, since) in cur.items():
        states.setdefault(s, {}).setdefault(st, 0)
        states[s][st] += now - since
    return states, stalls


def measure(days, tasks_file=None, events_path=EVENTS, mainwatch_path=scorecard.MAINWATCH, now=None, project=None,
            claude_dirs=(), codex_dir=None, core=None, prs_file=None, prs=None):
    now = now or time.time()
    start = now - days * DAY
    prs, prs_src = (prs, "given") if prs is not None else read_prs(prs_file, start)
    ms = merges(start) + pr_merges(prs, start)
    for m in ms:  # what each reverts (scorecard.revert_of), None for a landing
        m["reverts"] = scorecard.revert_of(m["lane"], m.get("subjects", ()))
    landed = [m for m in ms if m["reverts"] is None]
    events = [e for e in read_events(events_path) if e.get("ts") and iso(e["ts"]) >= start - 2 * DAY]
    tasks, tasks_src = read_tasks(tasks_file)

    # 1. Deployment frequency
    mw = mainwatch_path.read_text() if mainwatch_path.is_file() else ""
    ll = scorecard.LANDLOOP.read_text() if scorecard.LANDLOOP.is_file() else ""
    first = re.search(r'"ts": "(\d{4}-\d\d-\d\d)T', ll)  # the landloop and mainwatch logs start in the same minute
    mw_start = datetime.date.fromisoformat(first[1]) if first else None
    lines = list(stamped(mw, mw_start)) if mw_start else []
    installs = [t for t, line in lines if t >= start and re.search(r" owner install [0-9a-f]{40}: owner-install: installed ", line)]
    lane_days = per_day([m["at"] for m in landed], start, days)
    landings = sorted({m["at"] for m in landed})
    freq = dict(lanes=len(landed), lanes_per_day=round(len(landed) / days, 1), landings=len(landings),
                landings_per_day=round(len(landings) / days, 1), days_with_a_landing=sum(1 for v in lane_days.values() if v),
                lanes_by_day=lane_days, owner_installs=len(installs), owner_installs_per_day=round(len(installs) / days, 1),
                days_with_an_install=sum(1 for v in per_day(installs, start, days).values() if v),
                installs_by_day=per_day(installs, start, days))

    # 2. Lead time
    by_folder = {}
    for t in tasks:
        for s in t.get("seats", []):
            if s.get("worktree"):
                by_folder.setdefault(Path(s["worktree"]).name, t)
    rows = []
    for m in landed:
        task = by_folder.get(m["branch"].split("/", 1)[-1])
        row = dict(lane=m["lane"], landed=m["at"], first_commit=m["first_commit"], task=task and task["id"],
                   commit_lead_s=m["at"] - m["first_commit"] if m["first_commit"] else None,
                   task_lead_s=m["at"] - task["created"] / 1000 if task else None)
        if task:
            rev = sorted(s["at"] / 1000 for s in task.get("seats", []) if s.get("role") == "reviewer")
            passed = (task.get("review") or {}).get("pass") and task["review"]["at"] / 1000
            row.update(reviewer_seat=rev[0] if rev else None, review_pass=passed or None, created=task["created"] / 1000)
        if m.get("opened"):  # a pull request
            row.update(enqueued=m["opened"], first_enqueue=m["opened"])
            if m["gate_run_s"] is not None:
                row.update(gate_run_s=m["gate_run_s"], gate_queue_s=max(0, m["at"] - m["opened"] - m["gate_run_s"]))
        rows.append(row)
    lead = dict(commit_to_main=hours(r["commit_lead_s"] for r in rows), task_to_main=hours(r["task_lead_s"] for r in rows),
                lanes_with_task=sum(1 for r in rows if r["task"]), tasks_source=tasks_src, pull_requests_source=prs_src)

    # 3. Change failure rate
    reverted = {m["reverts"] for m in ms if m["reverts"]}
    # lead-revert<ticket> names a ticket: the reverted lane is the one named with that number at its end
    of_ticket = lambda lane: any(t.isdigit() and lane.endswith(t) for t in reverted)  # noqa: E731
    culprit_shas = set(re.findall(r"^\d\d:\d\d:\d\d culprit ([0-9a-f]{40})", mw, re.M))
    failed = sorted({m["lane"] for m in landed if m["lane"] in reverted or of_ticket(m["lane"]) or m["sha"] in culprit_shas})
    win = [e for e in events if iso(e["ts"]) >= start]
    rejects = sorted({e["lane"] for e in win if e["kind"] in ("eject", "kick")})
    tries = len(landed) + len(rejects)
    rounds = {}
    for e in win:
        if e["kind"] == "receipt" and e.get("review_kind") == "review":
            rounds.setdefault(e["lane"], set()).add(e["patch_id"])
    landed_names = {m["lane"] for m in landed}
    rr = [len(v) for k, v in rounds.items() if k in landed_names]
    cfr = dict(failed_lanes=failed, change_failure_pct=round(100 * len(failed) / len(landed), 1) if landed else None,
               gate_rejected_lanes=rejects, gate_reject_pct=round(100 * len(rejects) / tries, 1) if tries else None,
               review_rounds=dict(lanes=len(rr), median=statistics.median(rr) if rr else None, max=max(rr, default=None)))

    # 4. Time to restore (the p27 parser, cut to the window)
    deploy = scorecard.parse_deploys(mw, mw_start)
    cut = datetime.datetime.fromtimestamp(start).strftime("%Y-%m-%d %H:%M")
    eps = [e for e in deploy["episodes"] if e["green_at"] >= cut]  # red before the window, green inside it, counts
    mins = [e["minutes"] for e in eps]
    restore = dict(episodes=eps, still_red=deploy["still_red"], median_min=statistics.median(mins) if mins else None,
                   max_min=max(mins, default=None))

    # What each source covers: a figure counts only the part of the window its source has.
    stamp = lambda t: t and datetime.datetime.fromtimestamp(t).strftime("%Y-%m-%d %H:%M")  # noqa: E731
    coverage = dict(git_merges_from=stamp(min((m["at"] for m in ms if "opened" not in m), default=None)),
                    pull_requests_from=stamp(min((m["at"] for m in ms if "opened" in m), default=None)),
                    mainwatch_from=stamp(lines[0][0]) if lines else None,
                    events_from=stamp(min((iso(e["ts"]) for e in win), default=None)),
                    task_ledger_from=stamp(min((t["created"] / 1000 for t in tasks), default=None)))

    # Flow split
    enq, gate_s, landed_ev = {}, {}, {}
    for e in events:
        if e["kind"] == "enqueue":
            enq.setdefault(e["lane"], []).append(iso(e["ts"]))
        elif e["kind"] == "gate_result" and e.get("duration_s"):
            gate_s[e["candidate"]] = gate_s.get(e["candidate"], 0) + e["duration_s"]
        elif e["kind"] == "landed":
            for lane in e["lanes"]:
                landed_ev[lane] = (iso(e["ts"]), e["candidate"])
    for r in rows:
        if r["lane"] in landed_ev:
            at, cand = landed_ev[r["lane"]]
            before = [t for t in enq.get(r["lane"], []) if t <= at]
            if before:
                r.update(enqueued=before[-1], first_enqueue=min(t for t in before if t >= before[-1] - 3 * DAY),
                         gate_run_s=gate_s.get(cand, 0), gate_queue_s=max(0, at - before[-1] - gate_s.get(cand, 0)))
    # 5. Cost per landed lane: every session whose folder is the lane's worktree (Builder, Reviewers, rework)
    # the worktree folder; GitHub's revert branch ends with the branch it reverts and is not a second landing of it
    tail_of = lambda m: m["lane"] if m["reverts"] is not None else m["branch"].split("/", 1)[-1]  # noqa: E731
    merged = {}
    for m in ms:
        merged.setdefault(tail_of(m), []).append(m)
    costs = lane_costs(sorted({tail_of(m) for m in landed}), claude_dirs, codex_dir, start)
    for r, m in zip(rows, landed):
        c_ = costs.get(tail_of(m))
        if c_:  # a branch that landed twice in the window shares its cost between its landings
            r.update(usd=round(c_["usd"] / len(merged[tail_of(m)]), 2), tokens=c_["tokens"] // len(merged[tail_of(m)]))
    priced = [r["usd"] for r in rows if "usd" in r]
    cost = dict(lanes_with_cost=len(priced), median_usd=pct(priced, 50), p90_usd=pct(priced, 90),
                total_usd=round(sum(priced), 2), total_tokens=sum(r.get("tokens", 0) for r in rows),
                unpriced_tokens=sum(c_["unpriced_tokens"] for c_ in costs.values()),
                sources=[str(Path(d).name) for d in claude_dirs] + ([Path(codex_dir).name] if codex_dir else []),
                price_source="crates/nunchiro-core/src/usage.rs PRICES (public list prices, an estimate)")

    # 6. Owner touches: ledger accept conditions that need the owner and merge waits; the core's event journal
    # (permission waits; asks to the person only when the events carry room data, which the journal does not keep).
    core = core if core is not None else (core_events(project, days) if project else [])
    if core and not any(e.get("type") == "room_message" and e.get("data") for e in core):
        coverage["room_messages"] = "not in the journal: asks to the owner, core cards and stall nudges read 0"
    states, stalls = seat_time(core, now)
    seat_task = {s["session"]: t for t in tasks for s in t.get("seats", [])}
    task_of = {r["lane"]: next((t for t in tasks if t["id"] == r["task"]), None) for r in rows if r["task"]}
    asks = [e for e in core if e.get("type") == "room_message" and (e.get("data") or {}).get("to") == "person"
            and e["data"].get("kind") in ("ask", "question", "card")]
    perm = {s: v.get("permission", 0) + v.get("blocked", 0) for s, v in states.items() if v.get("permission") or v.get("blocked")}
    for r in rows:
        t = task_of.get(r["lane"])
        if not t:
            continue
        sess = {s["session"] for s in t.get("seats", [])}
        r["owner_touches"] = (sum(1 for a in t.get("accept", []) if re.search(r"\b(owner|user)\b", a, re.I))
                              + (t.get("waits") == "merge") + sum(1 for s in sess if s in perm)
                              + sum(1 for a in asks if a["data"].get("from") in sess)
                              + sum(1 for x in stalls if x["kind"] in ("card",) and x["seat"] in sess))
    touches = [r["owner_touches"] for r in rows if "owner_touches" in r]
    waiting_merge = [dict(task=t["id"], hours=round((now - t["updated"] / 1000) / 3600, 1)) for t in tasks
                     if t.get("waits") == "merge" and t.get("state") != "done"]
    owner = dict(lanes=len(touches), touches=sum(touches), median_per_lane=pct(touches, 50), max_per_lane=max(touches, default=None),
                 lanes_with_a_touch=sum(1 for x in touches if x), asks_to_owner=len(asks),
                 core_cards=sum(1 for x in stalls if x["kind"] == "card"), permission_waits=len(perm), permission_wait_min=round(sum(perm.values()) / 60),
                 waiting_for_merge_now=waiting_merge, core_events_from=stamp(min((e["at"] / 1000 for e in core if e.get("at")), default=None)))

    # 7. First-pass and rework (DORA 2024 rework rate: deployments that were not planned, made to fix a problem)
    one = sum(1 for x in rr if x == 1)
    again = sum(len(v) - 1 for v in merged.values())  # a second landing of the same branch is a fix of the first
    rejected_landed = sorted(set(rejects) & landed_names)
    revert_lanes = len(ms) - len(landed)
    rework = dict(first_pass_pct=round(100 * one / len(rr), 1) if rr else None, reviewed_lanes=len(rr),
                  rejected_then_landed=rejected_landed, repeat_landings=again, revert_landings=revert_lanes,
                  rework_pct=round(100 * (len(rejected_landed) + again + revert_lanes) / len(ms), 1) if ms else None)

    # 8. Seat utilisation from the core's attention states (live states only: exited and lost seats are gone)
    live = {}
    for v in states.values():
        for st, secs in v.items():
            if st not in ("exited", "lost"):
                live[st] = live.get(st, 0) + secs
    total = sum(live.values())
    seats = dict(seats=len(states), seat_hours=round(total / 3600, 1),
                 share_pct={k: round(100 * v / total, 1) for k, v in sorted(live.items())} if total else {},
                 stall_nudges=sum(1 for x in stalls if x["kind"] == "nudge"),
                 stalled_min=sum(x["quiet_min"] for x in stalls),  # quiet minutes before each nudge: a lower bound
                 resends=sum(1 for x in stalls if x["kind"] == "resend"), moved_again=sum(1 for x in stalls if x["kind"] == "moved"),
                 enter_dropped=sum(1 for e in core if "enter_dropped" in json.dumps(e)))

    gap = lambda r, a, b: r[b] - r[a] if r.get(a) and r.get(b) and r[b] >= r[a] else None  # noqa: E731
    flow = dict(build=minutes(gap(r, "created", "reviewer_seat") for r in rows),
                review=minutes(gap(r, "reviewer_seat", "review_pass") for r in rows),
                review_to_enqueue=minutes(gap(r, "review_pass", "first_enqueue") for r in rows),
                gate_queue=minutes(r.get("gate_queue_s") for r in rows), gate_run=minutes(r.get("gate_run_s") for r in rows),
                lanes_with_gate_events=sum(1 for r in rows if "gate_run_s" in r))
    return dict(date=time.strftime("%Y-%m-%d %H:%M", time.localtime(now)), commit=git("rev-parse", "--short", "origin/main").strip(),
                days=days, since=cut, coverage=coverage, deployment_frequency=freq, cost=cost, owner=owner,
                rework=rework, seat_use=seats, lead_time=lead, change_failure=cfr, time_to_restore=restore,
                flow=flow, lanes=[dict(r, landed=datetime.datetime.fromtimestamp(r["landed"]).strftime("%m-%d %H:%M"),
                                       commit_lead_h=r["commit_lead_s"] and round(r["commit_lead_s"] / 3600, 1),
                                       task_lead_h=r["task_lead_s"] and round(r["task_lead_s"] / 3600, 1))
                                  for r in rows])


def report(d):
    f, lt, c, rs, fl = d["deployment_frequency"], d["lead_time"], d["change_failure"], d["time_to_restore"], d["flow"]
    h = lambda x: f"median {x['median_h']} h, p90 {x['p90_h']} h (n {x['n']})"  # noqa: E731
    return "\n".join([
        f"Development speed, last {d['days']} days (since {d['since']}), origin/main {d['commit']}",
        "Sources from: " + ", ".join(f"{k} {v}" for k, v in d["coverage"].items()),
        f"1 Deployment frequency: {f['lanes']} lanes in {f['landings']} landings ({f['lanes_per_day']} lanes/day, "
        f"landings on {f['days_with_a_landing']} of {len(f['lanes_by_day'])} calendar days); owner installs {f['owner_installs']} ({f['owner_installs_per_day']}/day, on {f['days_with_an_install']} days)",
        f"2 Lead time: first commit to main {h(lt['commit_to_main'])}; task created to main {h(lt['task_to_main'])} "
        f"(task ledger: {lt['tasks_source']})",
        f"3 Change failure rate: {c['change_failure_pct']} % ({len(c['failed_lanes'])} of {f['lanes']}: {', '.join(c['failed_lanes']) or 'none'}); "
        f"gate rejects {c['gate_reject_pct']} % ({len(c['gate_rejected_lanes'])} lanes); review rounds median {c['review_rounds']['median']}, "
        f"max {c['review_rounds']['max']} (n {c['review_rounds']['lanes']})",
        f"4 Time to restore: median {rs['median_min']} min, max {rs['max_min']} min over {len(rs['episodes'])} red episodes"
        + (" (main is red now)" if rs["still_red"] else ""),
        f"5 Cost per landed lane: median {d['cost']['median_usd']} USD, p90 {d['cost']['p90_usd']} USD over {d['cost']['lanes_with_cost']} lanes "
        f"(total {d['cost']['total_usd']} USD, {d['cost']['total_tokens']} tokens; unpriced {d['cost']['unpriced_tokens']})",
        f"6 Owner touches: {d['owner']['touches']} over {d['owner']['lanes']} lanes with a task (median {d['owner']['median_per_lane']}, "
        f"max {d['owner']['max_per_lane']}); asks to the owner {d['owner']['asks_to_owner']}; permission waits {d['owner']['permission_waits']} "
        f"({d['owner']['permission_wait_min']} min); waiting for a merge yes now: {d['owner']['waiting_for_merge_now']}; core events from {d['owner']['core_events_from']}",
        f"7 First pass {d['rework']['first_pass_pct']} % of {d['rework']['reviewed_lanes']} reviewed lanes; rework {d['rework']['rework_pct']} % "
        f"({len(d['rework']['rejected_then_landed'])} rejected then landed, {d['rework']['repeat_landings']} repeat landings, {d['rework']['revert_landings']} reverts)",
        f"8 Seat use: {d['seat_use']['seat_hours']} seat hours over {d['seat_use']['seats']} seats, {d['seat_use']['share_pct']}; "
        f"stall nudges {d['seat_use']['stall_nudges']} ({d['seat_use']['stalled_min']} quiet min before them), moved again {d['seat_use']['moved_again']}, "
        f"resent messages {d['seat_use']['resends']}; enter_dropped {d['seat_use']['enter_dropped']}; core cards to the owner {d['owner']['core_cards']}",
        "Flow: " + "; ".join(f"{k.replace('_', ' ')} median {v['median_min']} min, p90 {v['p90_min']} min (n {v['n']})"
                             for k, v in fl.items() if isinstance(v, dict)),
    ])


def selftest():
    assert pct([], 90) is None and pct([5], 90) == 5
    assert pct(list(range(1, 11)), 50) == 5 and pct(list(range(1, 11)), 90) == 9 and pct(list(range(1, 11)), 100) == 10
    start = datetime.date(2026, 11, 20)
    got = [t for t, _ in stamped("23:00:00 a\nnoise\n01:00:00 b\n01:00:00 c\n", start)]
    base = datetime.datetime(2026, 11, 20).timestamp()
    assert got == [base + 23 * 3600, base + DAY + 3600, base + DAY + 3600], got
    assert MERGE.match("Merge lane lead-x1 (lead/x-1 8f4cac357467)")[2] == "lead/x-1"
    assert not MERGE.match("Merge remote-tracking branch 'origin/main' into lead/x-1")
    assert REVERT.match("fable-revert-lead-x1")[1] == "lead-x1" and REVERT.match("revert-12-lead/x-1")[1] == "lead/x-1"
    assert not REVERT.match("lead/revert-button-3") and REVERT.match("lead-revert1145")[1] == "1145"
    pr = dict(headRefName="lead/x-1", createdAt="2026-11-26T01:00:00Z", mergedAt="2026-11-26T02:00:00Z", mergeCommit=dict(oid="ab"),
              commits=[dict(authoredDate="2026-11-25T23:00:00Z")],
              statusCheckRollup=[dict(workflowName="CI", name="lint", startedAt="2026-11-26T01:30:00Z", completedAt="2026-11-26T01:31:00Z"),
                                 dict(workflowName="CI", name="gate", startedAt="2026-11-26T01:49:55Z", completedAt="2026-11-26T01:50:00Z")])
    got = pr_merges([pr, dict(pr, mergedAt="2026-11-20T00:00:00Z")], iso("2026-11-25T00:00:00Z"))
    assert len(got) == 1 and got[0]["gate_run_s"] == 1200 and got[0]["at"] - got[0]["first_commit"] == 3 * 3600, got
    assert hours([3600, 7200, None]) == dict(n=2, median_h=1.5, p90_h=2.0)
    assert minutes([60, 180]) == dict(n=2, median_min=2, p90_min=3)
    prices = price_table()
    assert len(prices) > 10 and usd([1000, 0, 0, 0], "claude-opus-5-5-x", prices) == 0.004, prices[:3]
    assert usd([1, 1, 1, 1], "unknown-model", prices) is None and folder_key("a.b/c-1") == "a-b-c-1"
    ev = [dict(type="session_started", at=0, session="s", state="working"), dict(type="state", at=60_000, session="s", state="waiting"),
          dict(type="room_message", at=180_000, data=dict(kind="team", body="core nudged B (quiet 21 min)", team=dict(what="advance", seat="s"))),
          dict(type="state", at=240_000, session="s", state="working")]
    st, stalls = seat_time(ev, 300)
    assert st == {"s": {"working": 120, "waiting": 180}} and stalls == [dict(seat="s", at=180.0, kind="nudge", quiet_min=21)], (st, stalls)
    print("selftest ok")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--out", help="JSON file (default docs/measure/devspeed-<today>.json)")
    ap.add_argument("--tasks", help='the JSON of "nunchiro task list --all --json"')
    ap.add_argument("--prs", help='the JSON of "gh pr list --state merged --json headRefName,createdAt,mergedAt,mergeCommit,commits,statusCheckRollup" (default: ask GitHub through gh)')
    ap.add_argument("--events", default=str(EVENTS))
    ap.add_argument("--mainwatch", default=str(scorecard.MAINWATCH))
    ap.add_argument("--project", default=str(Path(scorecard._COMMON).parent) if scorecard._COMMON else None,
                    help="the place whose core events are read (default: the main checkout)")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    claude = list(dict.fromkeys([str(Path.home() / ".claude")] + [p for p in (os.environ.get("MEASURE_CLAUDE_DIRS") or "").split(os.pathsep) if p]))
    codex = os.environ.get("MEASURE_CODEX_SESSIONS") or str(Path.home() / ".codex/sessions")
    d = measure(a.days, a.tasks, Path(a.events), Path(a.mainwatch), project=a.project, claude_dirs=claude,
                codex_dir=codex if Path(codex).is_dir() else None, prs_file=a.prs)
    out = Path(a.out) if a.out else ROOT / f"docs/measure/devspeed-{time.strftime('%Y-%m-%d')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(d, indent=1) + "\n")
    print(report(d))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
