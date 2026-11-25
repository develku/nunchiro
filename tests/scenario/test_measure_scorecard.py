"""Ticket 1098 scorecard: anchors, the mainwatch parser, peer task scores and the number + rubric mix."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "measure"))
import scorecard as s  # noqa: E402

A = "a" * 40
B = "b" * 40


class Points(unittest.TestCase):
    def test_lower_is_better_is_clamped(self):
        self.assertEqual([s.points(v, 0.5, 3.0) for v in (0.2, 0.5, 1.75, 3.0, 9)], [100, 100, 50, 0, 0])

    def test_higher_is_better(self):
        self.assertEqual([s.points(v, 100, 70) for v in (100, 85, 60)], [100, 50, 0])

    def test_a_missing_figure_scores_zero(self):
        self.assertEqual(s.points(None, 1, 2), 0)

    def test_every_number_part_figure_has_an_anchor(self):
        for names in s.NUMBER_PARTS.values():
            for n in names:
                self.assertIn(n, s.ANCHORS)


class Mainwatch(unittest.TestCase):
    LOG = "\n".join([
        f"23:55:00 testing {A}",
        f"00:05:00 GREEN {A}",
        f"00:06:00 owner install {A}: owner-install: skipped, 3 session(s) running",
        f"01:00:00 testing {B}",
        f"01:12:30 RED {B}: some_test ",
        "01:13:00 culprit " + B,
        f"02:00:00 owner build of {B} FAILED",
        f"03:00:00 owner install {A}: owner-install: installed {A} (backup /x), core connected",
    ])

    def test_runs_cross_midnight_and_count_green(self):
        r = s.parse_mainwatch(self.LOG)
        self.assertEqual((r["runs"], r["green"], r["green_pct"]), (2, 1, 50.0))
        self.assertEqual((r["min_min"], r["max_min"]), (10.0, 12.5))

    def test_owner_installs(self):
        i = s.parse_mainwatch(self.LOG)["installs"]
        self.assertEqual((i["n"], i["installed"], i["skipped"], i["failed"], i["landed_pct"]), (3, 1, 1, 1, 33.3))


class Peer(unittest.TestCase):
    def test_best_app_is_100_partial_halves_no_is_zero(self):
        tasks = {"T1": {"x": {"result": "yes", "steps": 2}, "y": {"result": "partial", "steps": 4}, "z": {"result": "no", "steps": None}}}
        self.assertEqual(s.peer_scores(tasks, ["x", "y", "z"]), {"x": {"T1": 100}, "y": {"T1": 25}, "z": {"T1": 0}})

    def test_unknown_is_left_out_of_the_best_and_the_mean(self):
        tasks = {"T1": {"x": {"result": "yes", "steps": 2}, "y": {"result": "unknown", "steps": None}},
                 "T2": {"x": {"result": "yes", "steps": 4}, "y": {"result": "yes", "steps": 2}}}
        p = s.peer_scores(tasks, ["x", "y"])
        self.assertEqual((p["y"]["T1"], s.mean_known(p["y"].values()), s.mean_known(p["x"].values())), (None, 100, 75))

    def test_steps_unknown_scores_zero(self):
        tasks = {"T1": {"x": {"result": "yes", "steps": 1}, "y": {"result": "partial", "steps": None}}}
        self.assertEqual(s.peer_scores(tasks, ["x", "y"])["y"]["T1"], 0)


class Within(unittest.TestCase):
    def test_second_median_inside_or_outside_the_first_range(self):
        f = lambda med, lo, hi: {"median": med, "min": lo, "max": hi}  # noqa: E731
        first = {"figures": {"a": f(2, 1, 3), "b": f(2, 1, 3), "c": f(None, None, None)}}
        second = {"figures": {"a": f(3, 0, 9), "b": f(3.5, 3, 4), "c": f(1, 1, 1)}}
        self.assertEqual(s.within(first, second), {"a": (3, 1, 3, True), "b": (3.5, 1, 3, False)})


class Merge(unittest.TestCase):
    def test_values_join_and_counts_add(self):
        def run(vals, ok, same):
            return {"date": "d", "repeats": len(vals), "load": [1, 2], "figures": {"x": s.stats(vals)},
                    "installs": {"ok": ok, "of": 2}, "launches": {"drawn": 4, "of": 4}, "sessions_alive_pct": s.stats([100]),
                    "owner_check": {"same": same, "owner_files_open_by_our_processes": [], "owner_core_before": ["1"]}}
        m = s.merge([run([1, 3], 2, True), run([5, 7], 1, False)])
        self.assertEqual((m["figures"]["x"]["median"], m["figures"]["x"]["min"], m["figures"]["x"]["max"]), (4, 1, 7))
        self.assertEqual((m["repeats"], m["installs"]["ok"], m["owner_check"]["same"]), (4, 3, False))


class OwnFolder(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ns-own-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_a_new_folder_is_made_with_the_marker_and_emptied_on_reuse(self):
        p = s.own_folder(os.path.join(self.tmp, "t"))
        self.assertTrue((p / s.MARK).is_file())
        (p / "old").write_text("x")
        p = s.own_folder(p)
        self.assertEqual(sorted(x.name for x in p.iterdir()), [s.MARK])

    def test_a_folder_without_the_marker_is_refused_and_kept(self):
        d = os.path.join(self.tmp, "theirs")
        os.mkdir(d)
        open(os.path.join(d, "keep"), "w").close()
        with self.assertRaises(SystemExit):
            s.own_folder(d)
        self.assertTrue(os.path.exists(os.path.join(d, "keep")))

    def test_roots_homes_checkouts_and_links_are_refused(self):
        os.makedirs(os.path.join(self.tmp, "repo", ".git"))
        os.symlink(self.tmp, os.path.join(self.tmp, "link"))
        for p in ("/", os.path.expanduser("~"), os.path.dirname(os.path.expanduser("~")), str(s.ROOT), str(s.ROOT / "target"),
                  str(s.OWNER_HOME / "x"), os.path.join(self.tmp, "repo"), os.path.join(self.tmp, "link")):
            with self.assertRaises(SystemExit, msg=p):
                s.own_folder(p)


class Deploys(unittest.TestCase):
    LOG = "\n".join([f"22:00:00 testing {A}", f"22:10:00 GREEN {A}", f"23:50:00 testing {B}", f"00:05:00 RED {B}: t",
                      f"00:09:00 culprit {B}", f"00:20:00 RED {B}: t", f"01:00:00 testing {A}", f"01:35:00 GREEN {A}",
                      f"02:00:00 red at {A} with no named failure (rc 1): infra or unnamed"])

    def test_one_episode_across_midnight_and_failure_rate(self):
        import datetime
        d = s.parse_deploys(self.LOG, datetime.date(2026, 11, 20))
        self.assertEqual([(e["red_at"], e["green_at"], e["minutes"]) for e in d["episodes"]],
                         [("2026-11-21 00:05", "2026-11-21 01:35", 90)])
        self.assertEqual((d["tested"], d["failures"], d["change_failure_pct"], d["still_red"]), (3, 1, 33.3, False))

    def test_reverts_landed(self):
        text = '{"landed": ["lead-a", "fable-revert-lead-b"], "x": 1}\n{"landed": []}'
        self.assertEqual(s.reverts_landed(text), ["fable-revert-lead-b"])


class Dev(unittest.TestCase):
    def test_largest_skips_tests_fixtures_and_catalogues(self):
        files = [("crates/a/src/sessions.rs", 14000), ("crates/a/src/sessions/tests.rs", 20000), ("crates/a/tests/x.rs", 9000),
                 ("web/src/i18n/areas/settings.ts", 3000), ("web/src/App.tsx", 2500), ("README.md", 9000)]
        self.assertEqual(s.largest(files), ([("crates/a/src/sessions.rs", 14000), ("web/src/App.tsx", 2500)], 2))

    def test_shared_files_need_two_lanes(self):
        self.assertEqual(s.shared_files({"a": ["x", "y"], "b": ["y"], "c": ["z"]}), {"y": ["a", "b"]})


class Combine(unittest.TestCase):
    def test_each_figure_and_each_check_is_one_item(self):
        rows = [("f1", 1, 100), ("f2", 2, 40)]
        checks = [{"verdict": "pass"}, {"verdict": "fail"}]
        self.assertEqual(s.combine(rows, checks), 60)


class FreshWorktree(unittest.TestCase):
    """Ticket 1130 C9 (MD2): the timed run happens in a fresh worktree of HEAD, with its own target, and is cleaned up."""

    def test_runs_in_a_fresh_worktree_and_removes_it(self):
        d = tempfile.mkdtemp()
        try:
            repo = os.path.join(d, "repo")
            os.mkdir(repo)
            git = lambda *a: subprocess.run(["git", *a], cwd=repo, check=True, capture_output=True, text=True).stdout  # noqa: E731
            git("init", "-q")
            open(os.path.join(repo, "marker"), "w").close()
            git("add", "marker")
            git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "m")
            target = os.path.join(d, "target")
            cmd = ["sh", "-c", 'test -f marker && [ "$CARGO_TARGET_DIR" = "$1" ]', "sh", target]
            r = s.fresh_worktree_test(dict(os.environ), s.Path(target), root=repo, cmd=cmd)
            self.assertEqual((r["exit"], r["steps"], r["copy"]), (0, 1, False), r)
            self.assertGreaterEqual(r["seconds"], 0)
            self.assertEqual(len(git("worktree", "list").splitlines()), 1)
            r = s.fresh_worktree_test(dict(os.environ), s.Path(target), root=repo, cmd=["sh", "-c", "exit 4"])
            self.assertEqual(r["exit"], 4)
            r = s.fresh_worktree_test(dict(os.environ), s.Path(target), root=d, cmd=["true"])  # d is no repo
            self.assertNotEqual(r["exit"], 0, r)
            self.assertIn("git", r["tail"].lower(), r)
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
