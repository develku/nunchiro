#!/usr/bin/env python3
"""Development speed for the scorecard (part p30): the DORA four keys, adapted to this repo.

  python3 -B scripts/measure-dev-speed.py [--days 7] [--out FILE] [--prs FILE] [--runs FILE] [--main-log FILE]
  python3 -B scripts/measure-dev-speed.py --record KIND (--pr N | --branch NAME) [--sha SHA] [--verdict accept|reject] [--by WHO] [--at ISO] [--note TEXT]
  python3 -B scripts/measure-dev-speed.py --selftest

Read only. Sources:
- pull requests into main (every landing is a merged one): one GitHub search of MEASURE_REPO (default
  develku/nunchiro) through "gh api graphql", read only, or --prs FILE with the same fields as JSON: head branch,
  title, opening and merge times, first commit, the checks of the last commit and the auto-merge enable times.
- the CI runs of ci.yml on pull requests ("gh api .../actions/workflows/ci.yml/runs", every attempt of a rerun through
  ".../attempts/<n>"), or --runs FILE: gate rejects, reruns and rework. When they cannot be read those figures are
  null, not 0.
- the main CI log (scripts/measure/ci-log.py: Actions runs on main and owner installs; scorecard.CI_LOG, --main-log or
  MEASURE_CI_LOG): red episodes, culprit commits (in its history part), owner installs.
- the review record: a private JSON-lines file outside git (MEASURE_LANE_RECORD, default lane-record.jsonl beside the
  main CI log), written with --record when a fact happens: task (work item created), review_start, verdict (accept or
  reject, by acceptance or maintainer), look (a Codex look: shown, not a round), ask and answer (the owner asked for
  something the pull request waits on). Its notes are never read into the output. Lanes that started before its first
  line (lines marked "backfill" do not count) have no owner figures: unknown, not 0.
- the core's event journal ("nunchiro events --history", read from the day files; the owner's shell only) and the agents'
  own transcripts: ~/.claude, the folders in MEASURE_CLAUDE_DIRS (other accounts, ':' between them) and
  MEASURE_CODEX_SESSIONS (default ~/.codex/sessions). A session is joined to the pull requests it worked on (join()):
  the branches it made a worktree for or pushed, else the one pull request its first message names, else its folder.
  Only token counts, models and times are read into the output, never text.

The four keys:
1. Deployment frequency: pull requests landed on main per day (and landings, a landing being one merge time), owner
   installs per day ("owner install ...: installed" in the main CI log), and nights (local 00:00-07:00) with a landing.
2. Lead time for changes: first commit (author date) to the merge on main, median and p90 (the DORA definition); also
   task created (the record's task line) to the merge.
3. Change failure rate: landed pull requests later reverted (GitHub's "revert-<number>-<branch>" branch, a title
   'Revert "<title>"', git's default subject, which names the reverted pull request by its title, or a branch named
   as a revert by scorecard.REVERT_LANE) or named culprit in the main CI log, over those landed.
   Gate rejects are shown beside it: a pull request is rejected when an attempt of a CI run on it that started at or
   after its first auto-merge enable ended in failure or timed out (reds before that are the builder's own checks,
   counted apart). Rejects over landed plus rejected.
4. Time to restore: main red to green again (the main CI log), median.
Flow split, where data exists: task created to the first review start (build), the first review start to the last
accept (review), the last accept to the first auto-merge enable after it, the gate queue and the gate run. The enqueue is the last auto-merge enable before the merge (none: the queue is not
known), the gate run the last CI run (first job start to the end of `gate`) and the gate queue the rest of the time.
"""
import argparse, datetime, json, os, re, statistics, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts/measure"))
import scorecard  # noqa: E402  (CI_LOG, its date and the red-episode parser of part p27)

REPO = os.environ.get("MEASURE_REPO") or "develku/nunchiro"
REVERT = scorecard.REVERT_LANE  # an older revert lane name; GitHub's revert branch of a pull request
REVERT_TITLE = re.compile(r'^Revert "(?!Revert ")(.*)"$')  # git's default subject; a revert of a revert lands it again
RED = ("failure", "timed_out")
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


def pr_merges(prs, since):
    """One row per pull request merged since an epoch: the lane and the branch are the head branch, the sha is the
    commit on main. 'opened', 'enabled' (the auto-merge enable times) and 'gate_run_s' (the last CI run, from the first
    job's start to the end of the `gate` job) feed the flow split."""
    out = []
    for p in prs:
        if not p.get("mergedAt"):
            continue
        at = iso(p["mergedAt"])
        if at < since:
            continue
        own = [iso(c["authoredDate"]) for c in p.get("commits") or []]
        checks = [c for c in p.get("statusCheckRollup") or [] if c.get("workflowName") == "CI" and c.get("startedAt")]
        gate = next((c for c in checks if c.get("name") == "gate" and c.get("completedAt")), None)
        out.append(dict(lane=p["headRefName"], branch=p["headRefName"], sha=(p.get("mergeCommit") or {}).get("oid"), at=int(at),
                        number=p.get("number"), head_oid=p.get("headRefOid"),
                        first_commit=int(min(own)) if own else None, opened=iso(p["createdAt"]), title=p.get("title") or "",
                        enabled=sorted(iso(x) for x in p.get("autoMergeEnabledAt") or []),
                        gate_run_s=gate and iso(gate["completedAt"]) - min(iso(c["startedAt"]) for c in checks)))
    return out


# One page is 50 pull requests with their first commit, the checks of their last one and their last 5 auto-merge enables
# (GitHub records a squash auto-merge as its own event type). "gh pr list --json commits"
# asks for every commit and its authors, which GitHub refuses from 50 pull requests up (500,000 nodes).
PR_QUERY = """query($q: String!, $endCursor: String) { search(query: $q, type: ISSUE, first: 50, after: $endCursor) {
  pageInfo { hasNextPage endCursor }
  nodes { ... on PullRequest { number title headRefName headRefOid createdAt mergedAt mergeCommit { oid }
    timelineItems(itemTypes: [AUTO_MERGE_ENABLED_EVENT, AUTO_SQUASH_ENABLED_EVENT, AUTO_REBASE_ENABLED_EVENT], last: 5) { nodes {
      ... on AutoMergeEnabledEvent { createdAt } ... on AutoSquashEnabledEvent { createdAt } ... on AutoRebaseEnabledEvent { createdAt } } }
    first: commits(first: 1) { nodes { commit { authoredDate } } }
    last: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes {
      ... on CheckRun { name startedAt completedAt checkSuite { workflowRun { workflow { name } } } } } } } } } } } } } }"""


def gh_prs(q):
    """Pull requests for a search, in the field names of "gh pr list --json" plus autoMergeEnabledAt (read only), and
    where they came from."""
    r = subprocess.run(["gh", "api", "graphql", "--paginate", "--slurp", "-f", "query=" + PR_QUERY, "-f", "q=" + q], capture_output=True, text=True)
    if r.returncode:
        return [], f"not read ({r.stderr.strip()[:80]})"
    dig = lambda v, *keys: dig((v or {}).get(keys[0]), *keys[1:]) if keys else v  # noqa: E731
    out = []
    for n in (n for page in json.loads(r.stdout) for n in page["data"]["search"]["nodes"] if n):
        checks = dig((n.pop("last")["nodes"] or [None])[0], "commit", "statusCheckRollup", "contexts", "nodes") or []
        out.append(dict(n, commits=[c["commit"] for c in n.pop("first")["nodes"]],
                        autoMergeEnabledAt=[x["createdAt"] for x in n.pop("timelineItems")["nodes"] if x],
                        statusCheckRollup=[dict(c, workflowName=dig(c, "checkSuite", "workflowRun", "workflow", "name")) for c in checks if c]))
    return out, "gh api graphql"


def read_prs(path, since):
    if path:
        return json.loads(Path(path).read_text()), f"file {Path(path).name}"
    # every state: a pull request closed without merging after a red gate is a reject too
    return gh_prs(f"repo:{REPO} is:pr base:main updated:>={datetime.date.fromtimestamp(since - DAY)}")


def run_row(r):
    """A REST workflow run in the field names of "gh run list --json" (scorecard.attempts reads them)."""
    return dict(databaseId=r["id"], attempt=r.get("run_attempt") or 1, headBranch=r["head_branch"], headSha=r["head_sha"],
                status=r["status"], conclusion=r["conclusion"], createdAt=r["created_at"], startedAt=r["run_started_at"],
                updatedAt=r["updated_at"])


def gh_json(*args):
    r = subprocess.run(["gh", *args], capture_output=True, text=True)
    if r.returncode:
        raise OSError(r.stderr.strip()[:80])
    return json.loads(r.stdout)


def read_runs(path, since):
    """(one row per attempt of the ci.yml runs on pull requests, where they came from); None for the rows when they
    cannot be read. Every attempt of a rerun is its own row, as in ci-log.py."""
    try:
        if path:
            runs, src = json.loads(Path(path).read_text()), f"file {Path(path).name}"
        else:
            day = datetime.date.fromtimestamp(since - DAY)
            pages = gh_json("api", "--paginate", "--slurp",
                            f"repos/{REPO}/actions/workflows/ci.yml/runs?event=pull_request&per_page=100&created=%3E%3D{day}")
            runs, src = [run_row(r) for page in pages for r in page["workflow_runs"]], "gh api actions runs"
        return scorecard.attempts(runs, lambda run, n: gh_json("api", f"repos/{REPO}/actions/runs/{run}/attempts/{n}")), src
    except (OSError, ValueError, KeyError) as e:
        return None, f"not read ({e})"


def stamped(text, start):
    """(epoch, line) for the main CI log's lines, which carry times only: a time earlier than the one before starts the next
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


RECORD = Path(os.environ.get("MEASURE_LANE_RECORD") or scorecard.CI_LOG.parent / "lane-record.jsonl")
KINDS = ("task", "review_start", "verdict", "look", "ask", "answer")


def write_record(a, ap):
    """--record: append one line to the private review record (RECORD, outside git). Refuses a bad line whole."""
    if not (a.pr or a.branch):
        ap.error("--record needs --pr or --branch")
    if (a.record == "verdict") != bool(a.verdict):
        ap.error("--verdict goes with --record verdict, and only with it")
    if a.sha and not re.fullmatch(r"[0-9a-f]{4,40}", a.sha):
        ap.error(f"--sha {a.sha!r} is not a hex commit")
    try:
        at = a.at and datetime.datetime.fromisoformat(a.at.replace("Z", "+00:00"))
    except ValueError:
        ap.error(f"--at {a.at!r} is not an ISO time")
    if at and at.tzinfo is None:
        ap.error("--at needs a zone (Z or +hh:mm)")
    at = a.at or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    line = {k: v for k, v in dict(at=at, kind=a.record, pr=a.pr, branch=a.branch, sha=a.sha, verdict=a.verdict, by=a.by,
                                  note=a.note).items() if v is not None}
    RECORD.parent.mkdir(parents=True, exist_ok=True)
    with open(RECORD, "a") as f:
        f.write(json.dumps(line) + "\n")
    print(f"recorded {a.record} in {RECORD}")


def read_record(path):
    """The record's lines with their time as 't' (bad lines and unknown kinds are skipped), oldest first."""
    out = []
    if path and Path(path).is_file():
        for line in Path(path).read_text().splitlines():
            try:
                x = json.loads(line)
                x["t"] = iso(x["at"])
            except (ValueError, KeyError, TypeError, AttributeError):
                continue
            if x.get("kind") in KINDS and (x.get("pr") or x.get("branch")):
                out.append(x)
    return sorted(out, key=lambda x: x["t"])


def review_facts(lines, enabled):
    """Per pull request, from its record lines: review rounds (distinct commits given a verdict by a reviewer; Codex
    looks are shown apart), the first verdict, the review and build times and the owner's asks."""
    verdicts = [x for x in lines if x["kind"] == "verdict" and x.get("by") != "codex"]
    accepts = [x for x in verdicts if x.get("verdict") == "accept"]
    first = lambda kind: next((x["t"] for x in lines if x["kind"] == kind), None)  # noqa: E731
    f = dict(task_at=first("task"), review_start=first("review_start"), last_accept=accepts[-1]["t"] if accepts else None,
             looks=sum(1 for x in lines if x["kind"] == "look" or (x["kind"] == "verdict" and x.get("by") == "codex")))
    if verdicts:
        f.update(rounds=len({x.get("sha") or x["at"] for x in verdicts}), first_accept=verdicts[0].get("verdict") == "accept",
                 accepted_sha=next((x.get("sha") for x in reversed(accepts) if x.get("sha")), None))
    if accepts:
        f["enqueue_after_accept"] = next((t for t in enabled if t >= accepts[-1]["t"]), None)
    return f


def owner_waits(lines, now):
    """Seconds each ask waited for its answer (the first answer after it); an open ask runs to now."""
    answers, out = sorted(x["t"] for x in lines if x["kind"] == "answer"), []
    for ask in (x["t"] for x in lines if x["kind"] == "ask"):
        end = next((a for a in answers if a >= ask), None)
        if end is not None:
            answers.remove(end)
        out.append((end if end is not None else now) - ask)
    return out


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


def usd(parts, model, prices, one_hour=0):
    """List-price dollars of [input, output, cache write, cache read] tokens; 'one_hour' of the cache writes were 1-hour
    writes, which cost twice the base input (the price page) instead of the 5-minute write price."""
    # Same rule as the core's price_of: a prefix never ends inside a number (claude-fable-5-2026... is not Fable 5.2).
    row = next((p for name, p in prices if model and re.match(re.escape(name) + r"(?!\d)", model)), None)
    return None if row is None else (sum(a * b for a, b in zip(parts, row)) + one_hour * (2 * row[0] - row[2])) / 1e9


def folder_key(name):
    """Claude Code names a project folder after its cwd with every character other than a letter or digit as '-'."""
    return re.sub(r"[^A-Za-z0-9]", "-", name)


# other flags may come first ("worktree add -q -b", "push -q -u", "push --force-with-lease")
WORKTREE_ADD = re.compile(r"worktree add (?:-\S+ )*?-[bB] ['\"]?([^\s'\";&|]+)['\"]? ['\"]?([^\s'\";&|]+)")
PUSH = re.compile(r"push (?:-\S+ )*origin ['\"]?([^\s'\";&|]+)")
PR_NUMBER = re.compile(r"PR #(\d+)|/pull/(\d+)")


def text_of(content):
    """The typed text of a message's content, or None for a tool result."""
    if isinstance(content, str):
        return content
    blocks = content if isinstance(content, list) else []
    if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in blocks):
        return None
    return " ".join(b.get("text") or "" for b in blocks if isinstance(b, dict) and b.get("type") == "text") or None


def sessions(claude_dirs, codex_dir, since, seen):
    """Every agent session of the window, read only: Claude session files (projects/*/*.jsonl and their
    */subagents/*.jsonl) changed since the window start, and Codex rollouts of its days. Per session: tokens by model
    ([input, output, cache write, cache read, of them 1-hour writes]; a Claude message id counted once, as the core
    does), its first time, the branches it made a worktree for or pushed, the worktree folders it made, the one pull
    request number its first message names, and for a top-level Claude session the owner's typed messages per day.
    'usage' is the whole session (a lane's cost includes its days before the window), 'in_window' its messages since.
    No text leaves this function."""
    out, read = [], set()
    for root in claude_dirs:
        proj = (Path(root) / "projects").resolve()
        if proj in read:  # a second account whose projects folder links to the first one's
            continue
        read.add(proj)
        for d in sorted(proj.iterdir() if proj.is_dir() else []):
            if not d.is_dir():
                continue
            files = [(f, False) for f in d.glob("*.jsonl")] + [(f, True) for f in d.glob("*/subagents/*.jsonl")]
            for f, sub in files:
                if f.stat().st_mtime < since:
                    continue
                s = dict(kind="claude", folder=d.name, subagent=sub, runs_others=not sub and (d / f.stem / "subagents").is_dir(),
                         usage={}, in_window={}, first=None, branches=set(), made={}, pr=None, typed={})
                asked = False
                with open(f, errors="replace") as fh:
                    for line in fh:
                        if '"assistant"' not in line and '"user"' not in line:
                            continue
                        if '"tool_result"' in line and '"usage"' not in line:
                            continue  # shortcut: a tool result is never typed text; a typed line naming "tool_result" is missed
                        try:
                            v = json.loads(line)
                        except ValueError:
                            continue
                        if v.get("type") not in ("user", "assistant"):
                            continue
                        at = v.get("timestamp") and iso(v["timestamp"])
                        if at and (s["first"] is None or at < s["first"]):
                            s["first"] = at
                        msg = v.get("message") or {}
                        if v["type"] == "user":
                            typed = text_of(msg.get("content"))
                            if typed is not None and not asked:
                                asked, nums = True, {a or b for a, b in PR_NUMBER.findall(typed)}
                                s["pr"] = int(nums.pop()) if len(nums) == 1 else None
                            if (not sub and typed and at and at >= since and not typed.startswith("<") and not v.get("isMeta")
                                    and not v.get("isSidechain") and "toolUseResult" not in v):
                                k = datetime.date.fromtimestamp(at).isoformat()
                                s["typed"][k] = s["typed"].get(k, 0) + 1
                            continue
                        for b in msg.get("content") or []:
                            cmd = isinstance(b, dict) and b.get("type") == "tool_use" and (b.get("input") or {}).get("command")
                            if isinstance(cmd, str):
                                for branch, path in WORKTREE_ADD.findall(cmd):
                                    s["branches"].add(branch)
                                    s["made"][Path(path.rstrip("/")).name] = branch
                                s["branches"].update(PUSH.findall(cmd))
                        u, mid, model = msg.get("usage") or {}, msg.get("id"), msg.get("model")
                        if not u or not mid or mid in seen or model == "<synthetic>":
                            continue
                        seen.add(mid)
                        parts = [u.get(k) or 0 for k in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")]
                        one_hour = min((u.get("cache_creation") or {}).get("ephemeral_1h_input_tokens") or 0, parts[2])
                        for o in [s["usage"].setdefault(model, [0] * 5)] + ([s["in_window"].setdefault(model, [0] * 5)] if at and at >= since else []):
                            for i, x in enumerate(parts + [one_hour]):
                                o[i] += x
                out.append(s)
    day = datetime.date.fromtimestamp(since)
    while codex_dir and day <= datetime.date.today():
        for f in sorted((Path(codex_dir) / f"{day:%Y/%m/%d}").glob("*.jsonl")):
            with open(f, errors="replace") as fh:
                meta = json.loads(fh.readline() or "{}").get("payload") or {}
                s = dict(kind="codex", cwd_parts=Path(meta.get("cwd") or "/").parts, usage={}, first=None)
                model, previous = None, None
                for line in fh:
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
                        o = s["usage"].setdefault(model, [0] * 5)
                        for i, x in enumerate([inp - cached, outp, 0, cached, 0]):
                            o[i] += x
                s["in_window"] = s["usage"]  # a rollout's day is in the window
                out.append(s)
        day += datetime.timedelta(days=1)
    return out


def join(ss, landed):
    """For each session, the indexes of the landed pull requests it worked on, by the first rule that joins it:
    a. the branches it made a worktree for or pushed; b. the one pull request number its first message names;
    c. (Codex) its cwd folder, through the folders of rule a, else the branch's last part; d. (Claude) a project folder
    named after the worktree folder (a seat whose cwd is the worktree). A session that runs others (it has subagents) is
    never joined: its cost is design, research and running the work. Returns [(session, [indexes], by rule a)]."""
    by_branch, by_number, tails = {}, {}, {}
    for i, m in enumerate(landed):
        by_branch.setdefault(m["branch"], []).append(i)
        by_number.setdefault(m["number"], []).append(i)
        tails.setdefault(m["branch"].split("/", 1)[-1], []).append(i)
    made = {k: v for s in ss if s["kind"] == "claude" for k, v in s["made"].items()}
    out = []
    for s in ss:
        got, builder = [], False
        if s["kind"] == "codex":
            for part in reversed(s["cwd_parts"]):
                got = by_branch.get(made.get(part), []) or tails.get(part, [])
                if got:
                    break
        elif not s["runs_others"]:
            got = sorted({i for b in s["branches"] for i in by_branch.get(b, [])})
            builder = bool(got)
            if not got and s["pr"] is not None:
                got = by_number.get(s["pr"], [])
            if not got:
                got = next((v for k, v in tails.items() if s["folder"].endswith("-" + folder_key(k))), [])
        out.append((s, got, builder))
    return out


def nunchiro_cli():
    """MEASURE_NUNCHIRO, else the owner's app's own CLI, else nunchiro on PATH (an older install may lack `events`)."""
    app = Path.home() / "Applications/Nunchiro.app/Contents/MacOS/nunchiro"
    return os.environ.get("MEASURE_NUNCHIRO") or (str(app) if app.is_file() else "nunchiro")


def core_events(project, days):
    """The core's event journal for a project ("nunchiro events --history": read from the day files, no running core
    needed, the owner's shell only), with the core's own lines that name no project (core_started, journal_full);
    None when it cannot be read. A room event's data is not in the journal."""
    try:
        r = subprocess.run([nunchiro_cli(), "events", "--history", str(max(1, min(days + 1, 14)))],
                           capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"core events not read: {e}", file=sys.stderr)
        return None
    if r.returncode:
        print(f"core events not read: {r.stderr.strip()}", file=sys.stderr)
        return None
    out = []
    for line in r.stdout.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        # "--project" would drop the project-less lines, which end the states a stopped core left open
        if not e.get("project") or e["project"] == str(project):
            out.append(e)
    return out


def seat_time(events, now):
    """Per session, seconds in each attention state from the core's state events, and the core's auto-advance notes
    (nudge with its quiet minutes, card to the user, resend of a waiting message, seat moves again, other)."""
    states, stalls = {}, []
    cur = {}
    for e in sorted((e for e in events if e.get("at") is not None), key=lambda e: e["at"]):
        t, s = e["at"] / 1000, e.get("session")
        if e["type"] in ("core_started", "journal_full"):
            # a new core lists its live sessions again; a full day file shows nothing more: what was open ends here
            for s, (st, since) in cur.items():
                states.setdefault(s, {}).setdefault(st, 0)
                states[s][st] += t - since
            cur = {}
        elif e["type"] in ("session_started", "state") and s and e.get("state"):
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


def measure(days, record_path=None, log_path=scorecard.CI_LOG, now=None, project=None,
            claude_dirs=(), codex_dir=None, core=None, prs_file=None, prs=None, runs_file=None, runs=None):
    now = now or time.time()
    start = now - days * DAY
    prs, prs_src = (prs, "given") if prs is not None else read_prs(prs_file, start)
    runs, runs_src = (runs, "given") if runs is not None else read_runs(runs_file, start)
    ms = pr_merges(prs, start)
    by_title = {m["title"]: m["lane"] for m in ms}
    for m in ms:  # what each reverts (the branch name, else the title naming the reverted pull request), None for a landing
        m["reverts"] = scorecard.revert_of(m["lane"])
        named = REVERT_TITLE.match(m["title"])
        if m["reverts"] is None and named:
            m["reverts"] = by_title.get(re.sub(r" \(#\d+\)$", "", named[1]), "")  # squash subjects end with " (#n)"
    landed = [m for m in ms if m["reverts"] is None]
    record = read_record(RECORD if record_path is None else record_path)
    # lines copied in later from older notes (note "backfill ...") carry verdicts, never the asks of their days
    live = [x["t"] for x in record if not str(x.get("note") or "").startswith("backfill")]
    record_from = min(live, default=None)

    # 1. Deployment frequency
    if not log_path.is_file():
        print(f"main CI log missing at {log_path}: run scripts/measure/ci-log.py first", file=sys.stderr)
    mw = log_path.read_text() if log_path.is_file() else ""
    mw_start = scorecard.log_start(mw)
    lines = list(stamped(mw, mw_start)) if mw_start else []
    installs = [t for t, line in lines if t >= start and re.search(r" owner install [0-9a-f]{40}: owner-install: installed ", line)]
    lane_days = per_day([m["at"] for m in landed], start, days)
    landings = sorted({m["at"] for m in landed})
    freq = dict(lanes=len(landed), lanes_per_day=round(len(landed) / days, 1), landings=len(landings),
                landings_per_day=round(len(landings) / days, 1), days_with_a_landing=sum(1 for v in lane_days.values() if v),
                lanes_by_day=lane_days, owner_installs=len(installs), owner_installs_per_day=round(len(installs) / days, 1),
                days_with_an_install=sum(1 for v in per_day(installs, start, days).values() if v),
                installs_by_day=per_day(installs, start, days),
                nights_with_a_landing=len({datetime.datetime.fromtimestamp(m["at"]).date() for m in landed
                                           if datetime.datetime.fromtimestamp(m["at"]).hour < 7}))

    # 2. Lead time, and each pull request's lines of the review record (by its number or its branch)
    rows = []
    for m in landed:
        mine = [x for x in record if (x.get("pr") and x["pr"] == m["number"]) or (x.get("branch") and x["branch"] == m["branch"])]
        f = review_facts(mine, m["enabled"])
        row = dict(lane=m["lane"], landed=m["at"], first_commit=m["first_commit"], task=None,  # a ticket name stays private
                   commit_lead_s=m["at"] - m["first_commit"] if m["first_commit"] else None,
                   task_lead_s=m["at"] - f["task_at"] if f["task_at"] else None,
                   created=f["task_at"], reviewer_seat=f["review_start"], review_pass=f["last_accept"],
                   first_enqueue=f.get("enqueue_after_accept"))
        if "rounds" in f:
            row.update(review_rounds=f["rounds"], first_accept=f["first_accept"],
                       changed_after_accept=bool(f["accepted_sha"] and m["head_oid"] and f["accepted_sha"] != m["head_oid"]))
        if f["looks"]:
            row["looks"] = f["looks"]
        started = m["first_commit"] or m["opened"]
        if record_from is not None and started >= record_from:  # earlier lanes may have had asks the record never saw
            waits = owner_waits(mine, now)
            row.update(owner_touches=len(waits), owner_wait_min=round(sum(waits) / 60), owner_max_wait_s=max(waits, default=0))
        if m["gate_run_s"] is not None:
            row.update(gate_run_s=m["gate_run_s"])
        enabled = [t for t in m["enabled"] if t <= m["at"]]
        if enabled:  # merged by hand (no enable event): the queue is not known, never the time from the opening
            row.update(enqueued=enabled[-1])
            if m["gate_run_s"] is not None:
                row.update(gate_queue_s=max(0, m["at"] - enabled[-1] - m["gate_run_s"]))
        rows.append(row)
    lead = dict(commit_to_main=hours(r["commit_lead_s"] for r in rows), task_to_main=hours(r["task_lead_s"] for r in rows),
                lanes_with_task=sum(1 for r in rows if r["task_lead_s"] is not None), pull_requests_source=prs_src)

    # 3. Change failure rate
    reverted = {m["reverts"] for m in ms if m["reverts"]}
    # lead-revert<ticket> names a ticket: the reverted lane is the one named with that number at its end
    of_ticket = lambda lane: any(t.isdigit() and lane.endswith(t) for t in reverted)  # noqa: E731
    culprit_shas = set(re.findall(r"^\d\d:\d\d:\d\d culprit ([0-9a-f]{40})", mw, re.M))
    failed = sorted({m["lane"] for m in landed if m["lane"] in reverted or of_ticket(m["lane"]) or m["sha"] in culprit_shas})
    # Gate rejects: a red attempt that started at or after the pull request's first auto-merge enable, merged or not.
    first_enable = {}
    for p in prs:
        for x in p.get("autoMergeEnabledAt") or []:
            first_enable[p["headRefName"]] = min(first_enable.get(p["headRefName"], iso(x)), iso(x))
    tried = sorted((r for r in runs or [] if r.get("startedAt") and iso(r["startedAt"]) >= start), key=lambda r: iso(r["startedAt"]))
    done = [r for r in tried if r["status"] == "completed"]
    queued = lambda r: r["headBranch"] in first_enable and iso(r["startedAt"]) >= first_enable[r["headBranch"]]  # noqa: E731
    red = [r for r in done if r["conclusion"] in RED]
    rejects = sorted({r["headBranch"] for r in red if queued(r)})
    tries = len(landed) + len(rejects)
    by_sha = {}
    for r in done:
        by_sha.setdefault((r["headBranch"], r["headSha"]), []).append(r["conclusion"])
    # red then green on the same commit: the PR-flow form of a contaminated gate result
    rerun_green = {k for k, v in by_sha.items() if "success" in v and any(c in RED for c in v[:v.index("success")])}
    landed_names = {m["lane"] for m in landed}
    rr = [r["review_rounds"] for r in rows if "review_rounds" in r]
    read = runs is not None
    cfr = dict(failed_lanes=failed, change_failure_pct=round(100 * len(failed) / len(landed), 1) if landed else None,
               gate_rejected_lanes=rejects, gate_reject_pct=round(100 * len(rejects) / tries, 1) if tries and read else None,
               rerun_green_lanes=sorted({b for b, _ in rerun_green}), pre_enqueue_red=sum(1 for r in red if not queued(r)),
               cancelled=sum(1 for r in done if r["conclusion"] == "cancelled"),
               kicks="not counted: GitHub keeps no event for a pull request set aside by a conflict",
               gate_results=dict(attempts=len(done), red_pct=round(100 * len(red) / len(done), 1) if done else None,
                                 rerun_green_pct=round(100 * len(rerun_green) / len(by_sha), 1) if by_sha else None),
               review_rounds=dict(lanes=len(rr), median=statistics.median(rr) if rr else None, max=max(rr, default=None),
                                  looks=sum(r.get("looks", 0) for r in rows)))

    # 4. Time to restore (the p27 parser, cut to the window)
    deploy = scorecard.parse_deploys(mw, mw_start)
    cut = datetime.datetime.fromtimestamp(start).strftime("%Y-%m-%d %H:%M")
    eps = [e for e in deploy["episodes"] if e["green_at"] >= cut]  # red before the window, green inside it, counts
    mins = [e["minutes"] for e in eps]
    restore = dict(episodes=eps, still_red=deploy["still_red"], median_min=statistics.median(mins) if mins else None,
                   max_min=max(mins, default=None))

    # What each source covers: a figure counts only the part of the window its source has.
    stamp = lambda t: t and datetime.datetime.fromtimestamp(t).strftime("%Y-%m-%d %H:%M")  # noqa: E731
    coverage = dict(pull_requests_from=stamp(min((m["at"] for m in ms), default=None)),
                    pull_request_checks=runs_src, checks_from=stamp(min((iso(r["startedAt"]) for r in tried), default=None)),
                    main_log_from=stamp(lines[0][0]) if lines else None, record_from=stamp(record_from),
                    record_lines=len(record))

    # 5. Cost per landed lane: every session joined to it (builder, review seats, fixes, Codex looks); a session joined
    # to n pull requests is split 1/n; the rest is summed as unassigned, by model.
    prices, unassigned, unpriced = price_table(), dict(tokens=0, usd=0.0, by_model={}), {}
    ss = sessions(claude_dirs, codex_dir, start, set())
    for s, got, builder in join(ss, landed):
        # a joined session counts whole; an unjoined one (a long design or running session) only inside the window
        for model, (inp, outp, cw, cr, one_hour) in s["usage" if got else "in_window"].items():
            tokens, cost = inp + outp + cw + cr, usd([inp, outp, cw, cr], model, prices, one_hour)
            if cost is None:
                unpriced[model] = unpriced.get(model, 0) + tokens
            for i in got:
                rows[i]["tokens"] = rows[i].get("tokens", 0) + tokens / len(got)
                key = "unpriced_tokens" if cost is None else "usd"  # a lane with only unpriced tokens has no cost, not 0
                rows[i][key] = rows[i].get(key, 0) + (tokens if cost is None else cost) / len(got)
            if not got:
                unassigned["tokens"] += tokens
                unassigned["usd"] += cost or 0
                b = unassigned["by_model"].setdefault(model, dict(tokens=0, usd=0.0))
                b["tokens"], b["usd"] = b["tokens"] + tokens, round(b["usd"] + (cost or 0), 2)
        for i in got if builder and s["first"] else []:
            rows[i]["lane_start"] = min(rows[i].get("lane_start", s["first"]), s["first"])
    for r in rows:
        r.update({k: round(r[k], 2 if k == "usd" else None) for k in ("usd", "tokens", "unpriced_tokens") if k in r})
    priced = [r["usd"] for r in rows if "usd" in r]
    cost = dict(lanes_with_cost=len(priced), median_usd=pct(priced, 50), p90_usd=pct(priced, 90),
                total_usd=round(sum(priced), 2), total_tokens=sum(r.get("tokens", 0) for r in rows),
                unpriced_tokens=sum(unpriced.values()), unpriced_by_model=unpriced,
                unassigned=dict(unassigned, usd=round(unassigned["usd"], 2)),
                sources=[str(Path(d).name) for d in claude_dirs] + ([Path(codex_dir).name] if codex_dir else []),
                price_source="crates/nunchiro-core/src/usage.rs PRICES (public list prices, an estimate; 1-hour cache writes at 2x input)")
    lead["lane_start_to_main"] = hours(r["landed"] - r["lane_start"] for r in rows if "lane_start" in r)
    # shown, not scored: the owner's typed messages per day in the folders of the sessions that run others
    runs_others = {s["folder"] for s in ss if s.get("runs_others")}
    chat = {}
    for s in ss:
        if s.get("folder") in runs_others and not s["subagent"]:
            for k, n in s["typed"].items():
                chat[k] = chat.get(k, 0) + n

    # 6. Owner touches: the record's asks per pull request and their waits; the core's event journal for Nunchiro seats
    # (permission waits; asks to the person only when the events carry room data, which the journal does not keep).
    core = core if core is not None else (core_events(project, days) if project else None)
    journal = "read" if core is not None else "not read: no project, or `nunchiro events --history` failed"
    core = core or []
    if core and not any(e.get("type") == "room_message" and e.get("data") for e in core):
        coverage["room_messages"] = "not in the journal: asks to the owner, core cards and stall nudges read 0"
    states, stalls = seat_time(core, now)
    asks = [e for e in core if e.get("type") == "room_message" and (e.get("data") or {}).get("to") == "person"
            and e["data"].get("kind") in ("ask", "question", "card")]
    perm = {s: v.get("permission", 0) + v.get("blocked", 0) for s, v in states.items() if v.get("permission") or v.get("blocked")}
    touches = [r["owner_touches"] for r in rows if "owner_touches" in r]
    max_wait = max((r["owner_max_wait_s"] for r in rows if "owner_max_wait_s" in r), default=None)
    owner = dict(measured=None if record_from is None else "whole" if record_from <= start else "part",
                 lanes=len(touches), touches=sum(touches), median_per_lane=pct(touches, 50), max_per_lane=max(touches, default=None),
                 lanes_with_a_touch=sum(1 for x in touches if x), max_wait_min=None if max_wait is None else round(max_wait / 60),
                 asks_to_owner=len(asks),
                 core_cards=sum(1 for x in stalls if x["kind"] == "card"),
                 permission_waits=len(perm) if journal == "read" else None,
                 permission_wait_min=round(sum(perm.values()) / 60) if journal == "read" else None,
                 core_events_from=stamp(min((e["at"] / 1000 for e in core if e.get("at")), default=None)),
                 chat_messages_by_day=dict(sorted(chat.items())))

    # 7. First-pass and rework (DORA 2024 rework rate: deployments that were not planned, made to fix a problem)
    reviewed = [r for r in rows if "review_rounds" in r]
    one = sum(1 for r in reviewed if r["first_accept"])  # passes its first review: the first verdict is an accept
    merged = {}
    for m in ms:
        merged.setdefault(m["branch"], []).append(m)
    again = sum(len(v) - 1 for v in merged.values())  # a second landing of the same branch is a fix of the first
    rejected_landed = sorted(set(rejects) & landed_names)
    revert_lanes = len(ms) - len(landed)
    rework = dict(first_pass_pct=round(100 * one / len(rr), 1) if rr else None, reviewed_lanes=len(rr),
                  changed_after_accept=sorted(r["lane"] for r in reviewed if r["changed_after_accept"]),
                  rejected_then_landed=rejected_landed, repeat_landings=again, revert_landings=revert_lanes,
                  # without the CI runs the rejected-then-landed pull requests are unknown: rework is not measured
                  rework_pct=round(100 * (len(rejected_landed) + again + revert_lanes) / len(ms), 1) if ms and read else None)

    # 8. Seat utilisation from the core's attention states (live states only: exited and lost seats are gone)
    live = {}
    for v in states.values():
        for st, secs in v.items():
            if st not in ("exited", "lost"):
                live[st] = live.get(st, 0) + secs
    total = sum(live.values())
    seats = dict(journal=journal, seats=len(states), seat_hours=round(total / 3600, 1) if journal == "read" else None,
                 share_pct=({k: round(100 * v / total, 1) for k, v in sorted(live.items())} if total else {}) if journal == "read" else None,
                 state_changes=sum(1 for e in core if e.get("type") == "state"),  # the rest are snapshots at a start
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
        f"landings on {f['days_with_a_landing']} of {len(f['lanes_by_day'])} calendar days, {f['nights_with_a_landing']} nights); owner installs {f['owner_installs']} ({f['owner_installs_per_day']}/day, on {f['days_with_an_install']} days)",
        f"2 Lead time: first commit to main {h(lt['commit_to_main'])}; task created to main {h(lt['task_to_main'])}; "
        f"builder start to main {h(lt['lane_start_to_main'])} "
        f"(review record: {d['coverage']['record_lines']} lines from {d['coverage']['record_from']})",
        f"3 Change failure rate: {c['change_failure_pct']} % ({len(c['failed_lanes'])} of {f['lanes']}: {', '.join(c['failed_lanes']) or 'none'}); "
        f"gate rejects {c['gate_reject_pct']} % ({len(c['gate_rejected_lanes'])} lanes; red before auto-merge {c['pre_enqueue_red']}, "
        f"red then green on a rerun {len(c['rerun_green_lanes'])}, cancelled {c['cancelled']}; attempts {c['gate_results']}); review rounds median {c['review_rounds']['median']}, "
        f"max {c['review_rounds']['max']} (n {c['review_rounds']['lanes']})",
        f"4 Time to restore: median {rs['median_min']} min, max {rs['max_min']} min over {len(rs['episodes'])} red episodes"
        + (" (main is red now)" if rs["still_red"] else ""),
        f"5 Cost per landed lane: median {d['cost']['median_usd']} USD, p90 {d['cost']['p90_usd']} USD over {d['cost']['lanes_with_cost']} lanes "
        f"(total {d['cost']['total_usd']} USD, {d['cost']['total_tokens']} tokens; unpriced {d['cost']['unpriced_by_model']}; "
        f"not joined to a landed pull request {d['cost']['unassigned']['usd']} USD, {d['cost']['unassigned']['tokens']} tokens)",
        f"6 Owner touches: {d['owner']['touches']} over {d['owner']['lanes']} lanes the record covers ({d['owner']['measured']}; median {d['owner']['median_per_lane']}, "
        f"max {d['owner']['max_per_lane']}); asks to the owner {d['owner']['asks_to_owner']}; permission waits {d['owner']['permission_waits']} "
        f"({d['owner']['permission_wait_min']} min); longest owner wait {d['owner']['max_wait_min']} min; owner chat messages by day {d['owner']['chat_messages_by_day']}; core events from {d['owner']['core_events_from']}",
        f"7 First pass {d['rework']['first_pass_pct']} % of {d['rework']['reviewed_lanes']} reviewed lanes "
        f"(changed after accept {len(d['rework']['changed_after_accept'])}); rework {d['rework']['rework_pct']} % "
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
    assert REVERT_TITLE.match('Revert "Composer takes focus (#12)"')[1] == "Composer takes focus (#12)"
    assert not REVERT_TITLE.match('Revert "Revert "x""') and not REVERT_TITLE.match("Revert button is blue")
    rest = dict(id=7, run_attempt=2, head_branch="b", head_sha="ab", status="completed", conclusion="success",
                created_at="c", run_started_at="s", updated_at="u")
    got = scorecard.attempts([run_row(rest)], lambda run, n: dict(status="completed", conclusion="failure", run_started_at="s1", updated_at="u1"))
    assert [(r["attempt"], r["conclusion"], r["startedAt"], r["headBranch"]) for r in got] == [(2, "failure", "s1", "b"), (2, "success", "s", "b")], got
    assert REVERT.match("fable-revert-lead-x1")[1] == "lead-x1" and REVERT.match("revert-12-lead/x-1")[1] == "lead/x-1"
    assert not REVERT.match("lead/revert-button-3") and REVERT.match("lead-revert1145")[1] == "1145"
    pr = dict(headRefName="lead/x-1", autoMergeEnabledAt=["2026-11-26T01:10:00Z"], createdAt="2026-11-26T01:00:00Z", mergedAt="2026-11-26T02:00:00Z", mergeCommit=dict(oid="ab"),
              commits=[dict(authoredDate="2026-11-25T23:00:00Z")],
              statusCheckRollup=[dict(workflowName="CI", name="lint", startedAt="2026-11-26T01:30:00Z", completedAt="2026-11-26T01:31:00Z"),
                                 dict(workflowName="CI", name="gate", startedAt="2026-11-26T01:49:55Z", completedAt="2026-11-26T01:50:00Z")])
    got = pr_merges([pr, dict(pr, mergedAt="2026-11-20T00:00:00Z")], iso("2026-11-25T00:00:00Z"))
    assert len(got) == 1 and got[0]["gate_run_s"] == 1200 and got[0]["at"] - got[0]["first_commit"] == 3 * 3600, got
    assert got[0]["enabled"] == [iso("2026-11-26T01:10:00Z")] and not pr_merges([dict(pr, mergedAt=None)], 0)
    assert hours([3600, 7200, None]) == dict(n=2, median_h=1.5, p90_h=2.0)
    assert minutes([60, 180]) == dict(n=2, median_min=2, p90_min=3)
    prices = price_table()
    assert len(prices) > 10 and usd([1000, 0, 0, 0], "claude-opus-5-5-x", prices) == 0.004, prices[:3]
    assert usd([1000, 0, 0, 0], "claude-fable-5-20261001", prices) == 0.01, "dated Fable 5 is not Fable 5.2"
    assert usd([1, 1, 1, 1], "unknown-model", prices) is None and folder_key("a.b/c-1") == "a-b-c-1"
    assert WORKTREE_ADD.findall("git -C /r worktree add -b x/y ~/w/z origin/main") == [("x/y", "~/w/z")]
    assert PUSH.findall("git push -u origin x/y && gh pr create") == ["x/y"] and text_of([dict(type="tool_result")]) is None
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
    ap.add_argument("--prs", help='the JSON of "gh pr list --json number,title,headRefName,headRefOid,createdAt,mergedAt,mergeCommit,commits,statusCheckRollup" plus autoMergeEnabledAt (default: ask GitHub through gh)')
    ap.add_argument("--runs", help='the JSON of the CI runs on pull requests, one row per attempt in the field names of "gh run list" plus headBranch (default: ask GitHub through gh)')
    ap.add_argument("--main-log", default=str(scorecard.CI_LOG), help="the main CI log (scripts/measure/ci-log.py)")
    ap.add_argument("--project", default=str(Path(scorecard._COMMON).parent) if scorecard._COMMON else None,
                    help="the place whose core events are read (default: the main checkout)")
    ap.add_argument("--selftest", action="store_true")
    w = ap.add_argument_group("--record: add one line to the private review record (MEASURE_LANE_RECORD, outside git) and stop")
    w.add_argument("--record", choices=KINDS, metavar="KIND", help="one of " + ", ".join(KINDS))
    key = w.add_mutually_exclusive_group()
    key.add_argument("--pr", type=int, help="the pull request number")
    key.add_argument("--branch", help="the head branch (a task line comes before its pull request)")
    w.add_argument("--sha", help="the head commit reviewed")
    w.add_argument("--verdict", choices=("accept", "reject"))
    w.add_argument("--by", choices=("acceptance", "maintainer", "codex"), help="who gave the verdict (codex: a look, not a round)")
    w.add_argument("--at", help="ISO time with a zone (default now)")
    w.add_argument("--note", help="private text; never read into the published figures")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if a.record:
        return write_record(a, ap)
    claude = list(dict.fromkeys([str(Path.home() / ".claude")] + [p for p in (os.environ.get("MEASURE_CLAUDE_DIRS") or "").split(os.pathsep) if p]))
    codex = os.environ.get("MEASURE_CODEX_SESSIONS") or str(Path.home() / ".codex/sessions")
    d = measure(a.days, None, Path(a.main_log), project=a.project, claude_dirs=claude,
                codex_dir=codex if Path(codex).is_dir() else None, prs_file=a.prs, runs_file=a.runs)
    out = Path(a.out) if a.out else ROOT / f"docs/measure/devspeed-{time.strftime('%Y-%m-%d')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(d, indent=1) + "\n")
    print(report(d))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
