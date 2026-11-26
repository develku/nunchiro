"""The flow record on the PR flow: scripts/measure/ci-log.py (Actions runs and owner installs in the
main CI log) and the pull-request and journal parts of scripts/measure-dev-speed.py. Fixtures only: no gh, no
nunchiro command, no owner file."""
import datetime
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/measure"))
import scorecard as s  # noqa: E402


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


cilog = load("cilog", "scripts/measure/ci-log.py")
speed = load("devspeed", "scripts/measure-dev-speed.py")
A, B, C, D, E, F, Z = ("a" * 40, "b" * 40, "c" * 40, "d" * 40, "e" * 40, "f" * 40, "0" * 40)


def run(sha, start, end=None, conclusion=None, n=1, **more):
    return dict(dict(databaseId=n, headSha=sha, status="completed" if end else "in_progress", conclusion=conclusion,
                     createdAt=start, startedAt=start, updatedAt=end or start), **more)


class UtcClock(unittest.TestCase):
    """The log holds local times: the fixtures are read as UTC."""
    def setUp(self):
        old = os.environ.get("TZ")
        os.environ["TZ"] = "UTC"
        time.tzset()
        self.addCleanup(time.tzset)
        self.addCleanup(lambda: os.environ.pop("TZ") if old is None else os.environ.__setitem__("TZ", old))


class CiLog(UtcClock):
    # A history log: its first line is on 2026-11-24, its last on 2026-11-25 at 16:22:03, main green.
    OLD = "\n".join([f"22:00:00 testing {A}", f"22:10:00 GREEN {A}", f"16:06:00 testing {A}", f"16:16:00 GREEN {A}",
                     f"16:22:03 owner install {A}: owner-install: waiting, the core cannot be replaced now"]) + "\n"
    RUNS = [  # newest first, as gh prints them
        run(F, "2026-11-28T18:40:00Z", "2026-11-28T18:41:00Z", "cancelled"),
        run(E, "2026-11-28T18:30:00Z"),
        run(D, "2026-11-28T18:00:00Z", "2026-11-28T18:12:00Z", "success"),
        run(C, "2026-11-26T17:05:00Z", "2026-11-26T17:30:00Z", "failure", n=7),
        run(B, "2026-11-26T17:00:00Z", "2026-11-26T17:20:00Z", "success"),
        run(A, "2026-11-25T11:11:47Z", "2026-11-25T11:15:31Z", "failure"),  # before the cutover: left out
    ]

    def text(self):
        at = datetime.datetime(2026, 11, 26, 17, 25)
        installs = [cilog.install_line(B, 0, f"owner-install: installed {B} (backup /x), core connected\n", at),
                    cilog.install_line(C, 3, "owner-install: waiting, the owner is active in Nunchiro", at),
                    cilog.install_line(D, 1, "owner-install: FAILED (app did not start), restoring /x; not installed",
                                       datetime.datetime(2026, 11, 28, 18, 20))]
        return cilog.build(self.OLD, datetime.date(2026, 11, 24), self.RUNS, installs, "2026-11-26")

    def test_the_exact_lines(self):
        day = lambda mark, d: [f"23:59:59 {mark} {Z} day {d}", f"00:00:00 {mark} {Z} day {d}"]  # noqa: E731
        self.assertEqual(self.text(), "# first day 2026-11-24\n" + self.OLD + "\n".join(
            day("GREEN", "2026-11-26") + [
                f"17:00:00 testing {B}",
                f"17:05:00 testing {C}",
                f"17:20:00 GREEN {B}",
                f"17:25:00 owner install {B}: owner-install: installed {B} (backup /x), core connected",
                f"17:25:00 owner wait {C}: owner-install: waiting, the owner is active in Nunchiro",
                f"17:30:00 RED {C}: Actions run 7",
            ] + day("RED", "2026-11-27") + day("RED", "2026-11-28") + [
                f"18:00:00 testing {D}",
                f"18:12:00 GREEN {D}",
                f"18:20:00 owner install {D}: FAILED: owner-install: FAILED (app did not start), restoring /x; not in place",
                f"18:30:00 testing {E}",
                f"18:40:00 testing {F}",
                f"18:41:00 red at {F} with no named failure (cancelled): infra or unnamed",
            ]) + "\n")

    def test_the_scorecard_parsers_read_it(self):
        r = s.parse_main_log(self.text())
        self.assertEqual((r["runs"], r["green"], r["median_min"], r["max_min"]), (5, 4, 12.0, 25.0))
        i = r["installs"]
        self.assertEqual((i["n"], i["installed"], i["skipped"], i["failed"]), (3, 1, 1, 1))
        self.assertEqual(s.log_start(self.text()), datetime.date(2026, 11, 24))
        d = s.parse_deploys(self.text(), s.log_start(self.text()))
        # the first line after the old log is later in the day than its last line, and 11-27 has no line at all
        self.assertEqual([(e["red_at"], e["green_at"], e["minutes"]) for e in d["episodes"]],
                         [("2026-11-26 17:30", "2026-11-28 18:12", 2 * 1440 + 42)])
        self.assertEqual((d["tested"], d["failures"], d["still_red"]), (7, 1, False))

    def test_the_dev_speed_reader_dates_every_line(self):
        got = {line.split(" ", 1)[1]: datetime.datetime.fromtimestamp(t) for t, line in speed.stamped(self.text(), datetime.date(2026, 11, 24))}
        self.assertEqual(got[f"GREEN {B}"], datetime.datetime(2026, 11, 26, 17, 20))
        self.assertEqual(got[f"testing {F}"], datetime.datetime(2026, 11, 28, 18, 40))

    def test_no_old_log(self):
        self.assertEqual(cilog.build("", None, self.RUNS[-2:-1], since="2026-11-26"), "# first day 2026-11-26\n" f"17:00:00 testing {B}\n17:20:00 GREEN {B}\n")

    def test_the_day_lines_are_no_gate_run_and_end_no_red_episode(self):
        text = self.text()
        marks = [line for line in text.splitlines() if Z in line]
        self.assertEqual(len(marks), 6)
        bare = "\n".join(line for line in text.splitlines() if Z not in line)
        self.assertEqual(s.parse_main_log(text), s.parse_main_log(bare))  # runs, green rate, minutes, installs
        d = s.parse_deploys(text, datetime.date(2026, 11, 24))
        self.assertEqual((d["tested"], len(d["episodes"])), (s.parse_deploys(bare)["tested"], 1))  # red through two midnights: one episode
        # main red and never green again: the RED day lines keep it red, a GREEN one is never written into it
        red = cilog.build(self.OLD, datetime.date(2026, 11, 24), [run(E, "2026-11-28T09:00:00Z"), self.RUNS[3]], since="2026-11-26")
        self.assertEqual([m.split()[1] for m in red.splitlines() if Z in m], ["GREEN"] * 2 + ["RED"] * 4)
        d = s.parse_deploys(red, datetime.date(2026, 11, 24))
        self.assertEqual((d["still_red"], d["episodes"], d["failures"]), (True, [], 1))
        self.assertEqual(s.parse_main_log(red)["runs"], 3)  # the old log's two and the red one

    def test_every_attempt_of_a_rerun_is_a_gate_run(self):
        """Codex look, P1: a failed run rerun to green was read as one green run."""
        listed = [run(B, "2026-11-26T17:00:00Z", "2026-11-26T17:50:00Z", "success", n=9, attempt=2, startedAt="2026-11-26T17:40:00Z")]
        asked = []

        def fetch(run_id, n):
            asked.append((run_id, n))
            return dict(status="completed", conclusion="failure", run_started_at="2026-11-26T17:00:00Z", updated_at="2026-11-26T17:20:00Z")
        text = cilog.build("", None, cilog.attempts(listed, fetch))
        self.assertEqual(asked, [(9, 1)])
        self.assertEqual(text, "# first day 2026-11-26\n" f"17:00:00 testing {B}\n17:20:00 RED {B}: Actions run 9\n17:40:00 testing {B}\n17:50:00 GREEN {B}\n")
        r = s.parse_main_log(text)
        self.assertEqual((r["runs"], r["green"], r["green_pct"]), (2, 1, 50.0))
        d = s.parse_deploys(text, datetime.date(2026, 11, 26))
        self.assertEqual((d["tested"], d["failures"], d["change_failure_pct"], d["restore_median_min"]), (2, 1, 50.0, 30))

    # Codex look, P2. A is the older main tip, B the newer one; A's run ends after B's.
    OLDER_GREEN_AFTER_NEWER_RED = [run(B, "2026-11-26T10:00:00Z", "2026-11-26T10:10:00Z", "failure", n=2),
                                   run(A, "2026-11-26T09:55:00Z", "2026-11-26T10:20:00Z", "success")]

    def test_an_older_tips_green_does_not_restore_a_newer_red(self):
        text = cilog.build("", None, self.OLDER_GREEN_AFTER_NEWER_RED)
        self.assertEqual(text, "# first day 2026-11-26\n" f"09:55:00 testing {A}\n10:00:00 testing {B}\n10:10:00 RED {B}: Actions run 2\n")
        d = s.parse_deploys(text, datetime.date(2026, 11, 26))
        self.assertEqual((d["still_red"], d["episodes"], d["failures"]), (True, [], 1))

    def test_the_older_green_counts_as_a_gate_run_once_main_is_green(self):
        runs = [run(C, "2026-11-26T10:15:00Z", "2026-11-26T10:40:00Z", "success")] + self.OLDER_GREEN_AFTER_NEWER_RED
        text = cilog.build("", None, runs)
        self.assertEqual(text.splitlines()[4:], [f"10:15:00 testing {C}", f"10:40:00 GREEN {C}", f"10:40:00 GREEN {A}"])
        d = s.parse_deploys(text, datetime.date(2026, 11, 26))
        self.assertEqual([(e["red_at"], e["green_at"], e["minutes"]) for e in d["episodes"]], [("2026-11-26 10:10", "2026-11-26 10:40", 30)])
        r = s.parse_main_log(text)
        self.assertEqual((r["runs"], r["green"], r["green_pct"]), (3, 2, 66.7))

    def test_a_green_rerun_of_an_older_tip_does_not_restore_a_newer_red(self):
        listed = [run(B, "2026-11-26T10:00:00Z", "2026-11-26T10:10:00Z", "failure", n=2),
                  run(A, "2026-11-26T09:50:00Z", "2026-11-26T11:00:00Z", "success", attempt=2, startedAt="2026-11-26T10:45:00Z")]
        first = dict(status="completed", conclusion="failure", run_started_at="2026-11-26T09:50:00Z", updated_at="2026-11-26T10:05:00Z")
        d = s.parse_deploys(cilog.build("", None, cilog.attempts(listed, lambda run_id, n: first)), datetime.date(2026, 11, 26))
        self.assertEqual((d["still_red"], d["episodes"], d["tested"]), (True, [], 3))

    def test_an_install_needs_the_full_commit(self):
        with self.assertRaises(SystemExit):
            cilog.install_line("abc1234", 0, "owner-install: installed", datetime.datetime(2026, 11, 26))


def pr(head, created, merged, sha, first=None, checks=(), title=None, number=None, enabled=(), oid=None):
    return dict(headRefName=head, createdAt=created, mergedAt=merged, mergeCommit=merged and dict(oid=sha), title=title or head,
                number=number, headRefOid=oid, autoMergeEnabledAt=list(enabled),
                commits=[dict(authoredDate=first or created)], statusCheckRollup=list(checks))


def check(name, start, end, workflow="CI"):
    return dict(workflowName=workflow, name=name, startedAt=start, completedAt=end)


def attempt(branch, sha, start, end, conclusion, run_id=1, n=1):
    """One attempt of a CI run on a pull request, in the form read_runs gives."""
    return dict(databaseId=run_id, attempt=n, headBranch=branch, headSha=sha, status="completed", conclusion=conclusion,
                createdAt=start, startedAt=start, updatedAt=end)


T = "2026-11-27T"


class DevSpeed(UtcClock):
    def measure(self, core=(), more=(), log="", runs=(), prs=None):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(tmp))
        ms = lambda at: speed.iso(at) * 1000  # noqa: E731
        tasks = dict(tasks=[dict(id="t1", created=ms("2026-11-26T19:00:00Z"), updated=ms("2026-11-27T02:00:00Z"),
                                 review={"pass": True, "at": ms("2026-11-27T00:30:00Z")},
                                 seats=[dict(session="s1", role="builder", at=ms("2026-11-26T19:00:00Z"), worktree="/w/flow-a-1"),
                                        dict(session="s2", role="reviewer", at=ms("2026-11-27T00:00:00Z"))])])
        (tmp / "tasks.json").write_text(json.dumps(tasks))
        if prs is None:
            prs = [
                pr("lead/flow-a-1", T + "01:00:00Z", T + "02:00:00Z", A, first="2026-11-26T20:00:00Z", enabled=[T + "01:00:00Z"], checks=[
                    check("lint", T + "01:30:00Z", T + "01:32:00Z"), check("gate", T + "01:49:55Z", T + "01:50:00Z"),
                    check("scan", T + "01:00:00Z", T + "01:01:00Z", workflow="Other")]),
                pr("revert-1-lead/flow-a-1", T + "04:00:00Z", T + "05:00:00Z", B),
                pr("lead/flow-b-2", T + "15:00:00Z", T + "16:00:00Z", C),
                pr("lead/too-old-3", "2026-11-01T15:00:00Z", "2026-11-01T16:00:00Z", D),
            ] + list(more)
        keep = speed.git
        self.addCleanup(lambda: setattr(speed, "git", keep))
        speed.git = lambda *a: "abc1234\n"
        (tmp / "ci-main.log").write_text(log)
        return speed.measure(7, tasks_file=tmp / "tasks.json", log_path=tmp / "ci-main.log", now=speed.iso("2026-11-28T12:00:00Z"),
                             core=list(core), prs=prs, runs=runs if runs is None else list(runs))

    def test_pull_requests_are_the_landings(self):
        d = self.measure()
        self.assertEqual(sorted(r["lane"] for r in d["lanes"]), ["lead/flow-a-1", "lead/flow-b-2"])
        self.assertEqual(d["deployment_frequency"]["lanes"], 2)
        self.assertEqual(d["lead_time"]["commit_to_main"], dict(n=2, median_h=3.5, p90_h=6.0))
        self.assertEqual(d["coverage"]["pull_requests_from"], "2026-11-27 02:00")
        self.assertNotIn("git_merges_from", d["coverage"])

    def test_a_github_revert_marks_the_lane_and_is_not_a_second_landing(self):
        d = self.measure()
        self.assertEqual((d["change_failure"]["failed_lanes"], d["change_failure"]["change_failure_pct"]), (["lead/flow-a-1"], 50.0))
        self.assertEqual((d["rework"]["revert_landings"], d["rework"]["repeat_landings"]), (1, 0))
        # the checks were read and none went red: 0 rejects, rework is the revert alone over 3 merges
        self.assertEqual((d["change_failure"]["gate_reject_pct"], d["rework"]["rework_pct"]), (0.0, 33.3))

    GATE_A = pr("lead/gate-a", T + "00:00:00Z", T + "02:00:00Z", E, enabled=[T + "01:00:00Z"])

    def test_a_red_gate_after_enqueue_is_a_reject(self):
        d = self.measure(more=[self.GATE_A], runs=[attempt("lead/gate-a", F, T + "01:05:00Z", T + "01:10:00Z", "failure", 9, 1),
                                                   attempt("lead/gate-a", F, T + "01:20:00Z", T + "01:40:00Z", "success", 9, 2)])
        c = d["change_failure"]
        self.assertEqual((c["gate_rejected_lanes"], c["rerun_green_lanes"], d["rework"]["rejected_then_landed"]),
                         (["lead/gate-a"], ["lead/gate-a"], ["lead/gate-a"]))
        self.assertEqual(c["gate_reject_pct"], round(100 * 1 / (d["deployment_frequency"]["lanes"] + 1), 1))
        self.assertEqual(c["gate_results"], dict(attempts=2, red_pct=50.0, rerun_green_pct=100.0))

    def test_a_red_before_enqueue_is_shown_not_counted(self):
        d = self.measure(more=[self.GATE_A], runs=[attempt("lead/gate-a", F, T + "00:20:00Z", T + "00:30:00Z", "failure"),
                                                   attempt("lead/gate-a", F, T + "01:05:00Z", T + "01:30:00Z", "success", 2)])
        c = d["change_failure"]
        self.assertEqual((c["gate_rejected_lanes"], c["pre_enqueue_red"], c["gate_reject_pct"]), ([], 1, 0.0))

    def test_cancelled_and_skipped_runs_are_not_rejects(self):
        d = self.measure(more=[self.GATE_A], runs=[attempt("lead/gate-a", F, T + "01:05:00Z", T + "01:10:00Z", "cancelled"),
                                                   attempt("lead/gate-a", F, T + "01:06:00Z", T + "01:07:00Z", "skipped", 2),
                                                   attempt("lead/gate-a", F, T + "01:20:00Z", T + "01:40:00Z", "success", 3)])
        c = d["change_failure"]
        self.assertEqual((c["gate_rejected_lanes"], c["cancelled"], c["rerun_green_lanes"]), ([], 1, []))

    def test_a_red_after_enqueue_on_a_closed_pr_is_a_reject(self):
        closed = pr("lead/never", T + "00:00:00Z", None, None, enabled=[T + "01:00:00Z"])
        d = self.measure(more=[closed], runs=[attempt("lead/never", F, T + "01:05:00Z", T + "01:10:00Z", "timed_out")])
        self.assertEqual(d["change_failure"]["gate_rejected_lanes"], ["lead/never"])
        self.assertEqual((d["deployment_frequency"]["lanes"], d["change_failure"]["gate_reject_pct"]), (2, 33.3))

    def test_enqueue_is_the_last_auto_merge_enable(self):
        gated = pr("lead/q", T + "00:00:00Z", T + "02:00:00Z", E, enabled=[T + "00:10:00Z", T + "01:00:00Z"],
                   checks=[check("lint", T + "01:30:00Z", T + "01:31:00Z"), check("gate", T + "01:45:00Z", T + "01:50:00Z")])
        f = self.measure(prs=[gated])["flow"]
        self.assertEqual((f["gate_queue"], f["gate_run"]), (dict(n=1, median_min=40, p90_min=40), dict(n=1, median_min=20, p90_min=20)))

    def test_no_auto_merge_event_leaves_the_queue_unknown(self):
        by_hand = pr("lead/hand", T + "00:00:00Z", T + "02:00:00Z", E,
                     checks=[check("lint", T + "01:30:00Z", T + "01:31:00Z"), check("gate", T + "01:45:00Z", T + "01:50:00Z")])
        f = self.measure(more=[by_hand])["flow"]
        self.assertEqual((f["gate_queue"]["n"], f["gate_run"]["n"]), (1, 2))  # only lead/flow-a-1 has an enable event

    def test_a_revert_titled_pr_is_a_revert(self):
        d = self.measure(more=[
            pr("lead/focus", "2026-11-26T01:00:00Z", "2026-11-26T01:30:00Z", D, title="Composer takes focus"),
            pr("lead/undo-focus", "2026-11-26T02:00:00Z", "2026-11-26T02:30:00Z", E, title='Revert "Composer takes focus"'),
            pr("lead/again", "2026-11-26T03:00:00Z", "2026-11-26T03:30:00Z", F, title='Revert "Revert "Composer takes focus""'),
            pr("lead-revert1145", "2026-11-26T04:00:00Z", "2026-11-26T04:30:00Z", Z),
            pr("lead/scroll-1145", "2026-11-26T00:00:00Z", "2026-11-26T00:30:00Z", Z),
        ])
        self.assertEqual(d["change_failure"]["failed_lanes"], ["lead/flow-a-1", "lead/focus", "lead/scroll-1145"])
        # a revert of a revert lands the change again
        self.assertEqual((d["deployment_frequency"]["lanes"], d["rework"]["revert_landings"]), (5, 3))

    def test_runs_not_read_means_not_measured(self):
        keep = speed.subprocess.run
        self.addCleanup(lambda: setattr(speed.subprocess, "run", keep))
        speed.subprocess.run = lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, "", "gh: not logged in")
        d = self.measure(runs=None)
        self.assertEqual((d["change_failure"]["gate_reject_pct"], d["rework"]["rework_pct"]), (None, None))
        self.assertTrue(d["coverage"]["pull_request_checks"].startswith("not read"))

    def test_night_landings(self):
        nights = [pr(f"lead/n{d}", f"2026-11-2{d}T01:00:00Z", f"2026-11-2{d}T02:00:00Z", A) for d in (2, 3, 4)]
        d = self.measure(prs=nights + [pr("lead/day", "2026-11-25T07:00:00Z", "2026-11-25T08:00:00Z", B)])
        self.assertEqual(d["deployment_frequency"]["nights_with_a_landing"], 3)

    def test_no_gate_events_option(self):
        r = subprocess.run([sys.executable, "-B", str(ROOT / "scripts/measure-dev-speed.py"), "--events", "x", "--selftest"],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 2, r.stdout)
        self.assertFalse(hasattr(speed, "read_events") or hasattr(speed, "merges"))

    def test_installs_and_restore_come_from_the_main_ci_log(self):
        d = self.measure(log=CiLog.text(CiLog()))
        self.assertEqual(d["coverage"]["main_log_from"], "2026-11-24 22:00")
        f = d["deployment_frequency"]
        self.assertEqual((f["owner_installs"], f["installs_by_day"]["2026-11-26"]), (1, 1))
        r = d["time_to_restore"]
        self.assertEqual((r["median_min"], r["still_red"], len(r["episodes"])), (2 * 1440 + 42, False, 1))

    def test_the_flow_split_of_a_pull_request(self):
        f = self.measure()["flow"]
        self.assertEqual((f["build"]["median_min"], f["review"]["median_min"], f["review_to_enqueue"]["median_min"]), (300, 30, 30))
        self.assertEqual((f["gate_run"], f["gate_queue"], f["lanes_with_gate_events"]),
                         (dict(n=1, median_min=20, p90_min=20), dict(n=1, median_min=40, p90_min=40), 1))

    def test_journal_events_feed_seat_time_and_say_what_they_lack(self):
        at = lambda t: speed.iso(t) * 1000  # noqa: E731
        core = [dict(type="session_started", at=at("2026-11-27T00:00:00Z"), session="s1", state="working"),
                dict(type="state", at=at("2026-11-27T01:00:00Z"), session="s1", state="permission"),
                dict(type="send_dropped", at=at("2026-11-27T01:10:00Z"), session="s1", data=dict(mark="enter_dropped_dialog", requeued=True)),
                dict(type="room_message", at=at("2026-11-27T01:20:00Z")),  # the journal keeps no room data
                dict(type="session_ended", at=at("2026-11-27T01:30:00Z"), session="s1")]
        d = self.measure(core)
        self.assertEqual((d["seat_use"]["seat_hours"], d["seat_use"]["enter_dropped"]), (1.5, 1))
        self.assertEqual((d["owner"]["permission_waits"], d["owner"]["permission_wait_min"]), (1, 30))
        self.assertIn("not in the journal", d["coverage"]["room_messages"])

    def test_core_events_reads_the_journal_and_ends(self):
        seen = []

        def fake(cmd, **kw):
            seen.append(cmd)
            return subprocess.CompletedProcess(cmd, 0, '{"type":"core_started","at":1}\nnot json\n{"type":"state","at":2}\n', "")
        keep = speed.subprocess.run
        self.addCleanup(lambda: setattr(speed.subprocess, "run", keep))
        speed.subprocess.run = fake
        self.assertEqual([e["type"] for e in speed.core_events("/p", 7)], ["core_started", "state"])
        self.assertEqual(seen, [["nunchiro", "events", "--history", "8", "--project", "/p"]])


if __name__ == "__main__":
    unittest.main()
