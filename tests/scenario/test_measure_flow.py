"""Ticket 1148, the flow record on the PR flow: scripts/measure/ci-log.py (Actions runs and owner installs in the
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


def pr(head, created, merged, sha, first=None, checks=()):
    return dict(headRefName=head, createdAt=created, mergedAt=merged, mergeCommit=dict(oid=sha),
                commits=[dict(authoredDate=first or created)], statusCheckRollup=list(checks))


def check(name, start, end, workflow="CI"):
    return dict(workflowName=workflow, name=name, startedAt=start, completedAt=end)


class DevSpeed(UtcClock):
    def measure(self, core=(), more=(), log="", events=None):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(tmp))
        ms = lambda at: speed.iso(at) * 1000  # noqa: E731
        tasks = dict(tasks=[dict(id="t1", created=ms("2026-11-26T19:00:00Z"), updated=ms("2026-11-27T02:00:00Z"),
                                 review={"pass": True, "at": ms("2026-11-27T00:30:00Z")},
                                 seats=[dict(session="s1", role="builder", at=ms("2026-11-26T19:00:00Z"), worktree="/w/flow-a-1"),
                                        dict(session="s2", role="reviewer", at=ms("2026-11-27T00:00:00Z"))])])
        (tmp / "tasks.json").write_text(json.dumps(tasks))
        prs = [
            pr("lead/flow-a-1", "2026-11-27T01:00:00Z", "2026-11-27T02:00:00Z", A, first="2026-11-26T20:00:00Z", checks=[
                check("lint", "2026-11-27T01:30:00Z", "2026-11-27T01:32:00Z"), check("gate", "2026-11-27T01:49:55Z", "2026-11-27T01:50:00Z"),
                check("scan", "2026-11-27T01:00:00Z", "2026-11-27T01:01:00Z", workflow="Other")]),
            pr("revert-1-lead/flow-a-1", "2026-11-27T04:00:00Z", "2026-11-27T05:00:00Z", B),
            pr("lead/flow-b-2", "2026-11-27T15:00:00Z", "2026-11-27T16:00:00Z", C),
            pr("lead/too-old-3", "2026-11-01T15:00:00Z", "2026-11-01T16:00:00Z", D),
        ]
        old = [dict(lane="lead-old9", branch="lead/old-9", sha=E, at=int(speed.iso("2026-11-25T10:00:00Z")),
                    first_commit=int(speed.iso("2026-11-25T08:00:00Z")))] + list(more)
        keep = (speed.merges, speed.git)
        self.addCleanup(lambda: (setattr(speed, "merges", keep[0]), setattr(speed, "git", keep[1])))
        speed.merges, speed.git = (lambda since: old), (lambda *a: "abc1234\n")
        (tmp / "ci-main.log").write_text(log)
        if events is not None:
            (tmp / "events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))
        return speed.measure(7, tasks_file=tmp / "tasks.json", events_path=events is not None and tmp / "events.jsonl",
                             log_path=tmp / "ci-main.log", now=speed.iso("2026-11-28T12:00:00Z"), core=list(core), prs=prs)

    def test_pull_requests_are_landings_beside_the_old_merges(self):
        d = self.measure()
        self.assertEqual(sorted(r["lane"] for r in d["lanes"]), ["lead-old9", "lead/flow-a-1", "lead/flow-b-2"])
        self.assertEqual(d["deployment_frequency"]["lanes"], 3)
        self.assertEqual(d["lead_time"]["commit_to_main"], dict(n=3, median_h=2.0, p90_h=6.0))
        self.assertEqual((d["coverage"]["git_merges_from"], d["coverage"]["pull_requests_from"]), ("2026-11-25 10:00", "2026-11-27 02:00"))

    def test_a_github_revert_marks_the_lane_and_is_not_a_second_landing(self):
        d = self.measure()
        self.assertEqual((d["change_failure"]["failed_lanes"], d["change_failure"]["change_failure_pct"]), (["lead/flow-a-1"], 33.3))
        self.assertEqual((d["rework"]["revert_landings"], d["rework"]["repeat_landings"]), (1, 0))
        # the PR flow has no gate events: rejects and rework are not measured, not 0
        self.assertEqual((d["change_failure"]["gate_reject_pct"], d["rework"]["rework_pct"]), (None, None))

    def test_history_gate_events_still_count(self):
        ev = [dict(ts="2026-11-25T09:00:00Z", kind="eject", lane="lead-old9"),
              dict(ts="2026-11-25T09:30:00Z", kind="receipt", review_kind="review", lane="lead-old9", patch_id="p1")]
        d = self.measure(events=ev)
        self.assertEqual(d["change_failure"]["gate_rejected_lanes"], ["lead-old9"])
        self.assertEqual((d["rework"]["rejected_then_landed"], d["rework"]["first_pass_pct"]), (["lead-old9"], 100.0))
        self.assertEqual(d["rework"]["rework_pct"], 50.0)  # 1 rejected then landed + 1 revert over 4 merges

    def test_installs_and_restore_come_from_the_main_ci_log(self):
        d = self.measure(log=CiLog.text(CiLog()))
        self.assertEqual(d["coverage"]["main_log_from"], "2026-11-24 22:00")
        f = d["deployment_frequency"]
        self.assertEqual((f["owner_installs"], f["installs_by_day"]["2026-11-26"]), (1, 1))
        r = d["time_to_restore"]
        self.assertEqual((r["median_min"], r["still_red"], len(r["episodes"])), (2 * 1440 + 42, False, 1))

    def test_a_lead_revert_lane_and_a_plain_git_revert_are_reverts(self):
        # Ticket 1157: lane lead-revert1145 reverted ticket 1145 with "Revert ticket 1145 ..."; a lane whose own
        # commits are all git's default revert names the lane; a revert of a revert lands the change again.
        merge = lambda lane, at, *subjects: dict(lane=lane, branch="lead/" + lane, sha=None, at=int(speed.iso(at)),  # noqa: E731
                                                 first_commit=int(speed.iso(at)), subjects=list(subjects))
        d = self.measure(more=[
            merge("lead-focus1145", "2026-11-26T01:00:00Z", "composer: takes focus (ticket 1145)"),
            merge("lead-revert1145", "2026-11-26T02:00:00Z", "Revert ticket 1145 (composer takes focus): it steals focus"),
            merge("lead-undo", "2026-11-26T03:00:00Z", 'Revert "Merge lane lead-old9 (lead/old-9 8f4cac357467)"'),
            merge("lead-again", "2026-11-26T04:00:00Z", 'Revert "Revert lane lead-old9: red main"', "lead-old9 with its fix"),
        ])
        self.assertEqual(d["change_failure"]["failed_lanes"], ["lead-focus1145", "lead-old9", "lead/flow-a-1"])
        self.assertEqual((d["deployment_frequency"]["lanes"], d["rework"]["revert_landings"]), (5, 3))

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
