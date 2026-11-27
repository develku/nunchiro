"""Ticket 1098 scorecard: anchors, the main CI log parser, peer task scores and the number + rubric mix."""
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


class MainLog(unittest.TestCase):
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
        r = s.parse_main_log(self.LOG)
        self.assertEqual((r["runs"], r["green"], r["green_pct"]), (2, 1, 50.0))
        self.assertEqual((r["min_min"], r["max_min"]), (10.0, 12.5))

    def test_owner_installs(self):
        i = s.parse_main_log(self.LOG)["installs"]
        self.assertEqual((i["n"], i["installed"], i["skipped"], i["failed"], i["landed_pct"]), (3, 1, 1, 1, 33.3))


class Peer(unittest.TestCase):
    """Rubric v2: a cell counts only when driven in the running app; the score is the lower of steps and seconds."""
    RUN = "2026-11-27"

    @staticmethod
    def cell(result, steps, seconds, driven):
        return {"result": result, "steps": steps, "seconds": seconds, "driven": driven}

    def test_the_lower_of_the_step_score_and_the_time_score(self):
        c = self.cell
        tasks = {"T1": {"Nunchiro": c("yes", 2, 30, self.RUN), "x": c("yes", 4, 10, "2026-11-02"), "y": c("partial", 4, 20, "2026-11-02"),
                        "z": c("no", None, None, "2026-11-02")}}
        got = s.peer_scores(tasks, ["Nunchiro", "x", "y", "z"], self.RUN)
        # ours: fewest steps (100) but three times the fastest time (33); x: 50 on steps; y: 50 on both, halved
        self.assertEqual(got, {"Nunchiro": {"T1": 33}, "x": {"T1": 50}, "y": {"T1": 25}, "z": {"T1": 0}})

    def test_our_cell_not_driven_in_this_run_scores_zero_and_is_not_skipped(self):
        c = self.cell
        for ours in (c("yes", 1, 5, None), c("yes", 1, 5, "2026-11-20"), {"result": "yes", "steps": 1}):
            tasks = {"T1": {"Nunchiro": ours, "x": c("yes", 4, 10, "d"), "y": c("yes", 4, 10, "d")}}
            got = s.peer_scores(tasks, ["Nunchiro", "x", "y"], self.RUN)
            self.assertEqual(got["Nunchiro"]["T1"], 0, ours)
            self.assertEqual(s.mean_known(got["Nunchiro"].values()), 0)
        self.assertEqual(s.peer_scores(tasks, ["Nunchiro", "x", "y"], None)["Nunchiro"]["T1"], 0)  # no run named

    def test_a_task_needs_two_driven_peers(self):
        c = self.cell
        tasks = {"T1": {"Nunchiro": c("yes", 2, 5, self.RUN), "x": c("yes", 4, 10, "d"), "y": {"result": "yes", "steps": 3}}}
        got = s.peer_scores(tasks, ["Nunchiro", "x", "y"], self.RUN)
        self.assertEqual((got["Nunchiro"]["T1"], got["y"]["T1"]), (0, None))  # no best to compare with; y was never driven

    def test_a_driven_cell_without_seconds_scores_zero(self):
        c = self.cell
        tasks = {"T1": {"Nunchiro": c("yes", 2, None, self.RUN), "x": c("yes", 4, 10, "d"), "y": c("yes", 4, 10, "d")}}
        self.assertEqual(s.peer_scores(tasks, ["Nunchiro", "x", "y"], self.RUN)["Nunchiro"]["T1"], 0)


class RubricV2(unittest.TestCase):
    """Ticket 1171: the stricter anchors and the rules "not measured is 0" and "green in this run"."""

    def test_the_approved_anchors(self):
        pt = lambda name, value: s.points(value, *s.ANCHORS[name])  # noqa: E731
        self.assertEqual([pt("term_paint_p95_ms", v) for v in (16, 33, 50)], [100, 50, 0])
        self.assertEqual([pt("launch_restored_s", v) for v in (0.3, 0.9, 1.5)], [100, 50, 0])
        self.assertEqual([pt("idle_mib_5", v) for v in (150, 375, 600)], [100, 50, 0])
        self.assertEqual([pt("idle_cpu_pct_5", v) for v in (0.3, 1.65, 3)], [100, 50, 0])
        self.assertEqual([pt("seats_lost_per_restart", v) for v in (0, 0.5, 17)], [100, 50, 0])
        self.assertEqual([pt("missed_prompts_per_1000", v) for v in (0, 2, 5)], [100, 60, 0])
        self.assertEqual([pt("soak_clean_hours", v) for v in (24, 12, 0)], [100, 50, 0])

    def test_no_anchor_is_easier_than_v1(self):
        v1 = {"launch_cold_s": (1.0, 5.0), "core_start_s": (0.1, 2.0), "mib_per_session": (1, 20), "gate_green_pct": (100, 70)}
        for name, (best, worst) in v1.items():
            for value in (best, (best + worst) / 2, worst):
                self.assertLessEqual(s.points(value, *s.ANCHORS[name]), s.points(value, best, worst), name)
        # the renamed figures against the v1 anchors of what they replace
        for new, old, values in (("launch_restored_s", (0.5, 3.0), (0.3, 0.4, 1.0, 2.0)), ("idle_mib_5", (150, 1100), (150, 200, 500, 900))):
            for value in values:
                self.assertLessEqual(s.points(value, *s.ANCHORS[new]), s.points(value, *old), new)

    def test_a_figure_that_was_not_measured_scores_zero_in_its_part(self):
        score, rows = s.score_numbers({"launch_cold_s": 1.0, "core_start_s": 0.1})["p15"]
        self.assertEqual(score, 50)  # two of four figures measured at their best: never the mean of the known ones
        self.assertEqual([p for _, _, p in rows], [0, 100, 100, 0])

    def test_rows_depth_and_log_breadth(self):
        rows = {"A": {"Nunchiro": "yes", "Orca": "yes"}, "B": {"Nunchiro": "partial"}, "C": {"Orca": "no", "T3": "yes"}}
        # ours 1.5; Orca yes + yes (nobody searched B) + no = 2; T3 counts yes on all three = 3
        self.assertEqual(s.rows_score(rows, ["Orca", "T3"]), (50, 50, None))
        score, depth, breadth = s.rows_score(rows, ["Orca", "T3"], [{"id": "agents", "Nunchiro": 2, "best": 45}])
        self.assertEqual((depth, breadth, score), (50, 29, 40))
        self.assertEqual(s.rows_score(rows, ["Orca", "T3"], [{"id": "agents", "best": 45}])[2], 0)  # ours not proven: 0
        self.assertEqual(s.rows_score(rows, ["Orca", "T3"], [{"id": "agents", "Nunchiro": 90, "best": 45}])[2], 100)

    def test_green_needs_exit_zero_and_a_test_that_ran(self):
        self.assertEqual(s.ran_green(0, "running 1 test\ntest result: ok. 1 passed; 0 failed; 0 ignored"), (True, 1))
        self.assertEqual(s.ran_green(0, "running 0 tests\ntest result: ok. 0 passed; 0 failed; 57 filtered out"), (False, 0))
        self.assertEqual(s.ran_green(101, "test result: FAILED. 3 passed; 1 failed"), (False, 0))
        self.assertEqual(s.ran_green(0, "Running 4 tests using 2 workers\n  4 passed (12.3s)"), (True, 4))
        self.assertEqual(s.ran_green(0, "  3 passed (9s)\n  1 flaky"), (False, 3))
        self.assertEqual(s.ran_green(0, "Ran 12 tests in 0.2s\n\nOK"), (True, 12))
        self.assertEqual(s.ran_green(1, "Ran 12 tests in 0.2s\n\nFAILED (failures=1)"), (False, 12))

    def test_a_command_that_names_a_missing_spec_is_not_green(self):
        # Playwright runs the specs it finds and ends 0: without this, half a check passes for the whole.
        pw = ["pnpm", "-C", "web", "exec", "playwright", "test"]
        self.assertEqual(s.missing_specs(pw + ["no-such-page.spec.ts", "inputs-one-style.spec.ts"]), ["no-such-page.spec.ts"])
        self.assertEqual(s.missing_specs(pw + ["inputs-one-style.spec.ts"]), [])
        self.assertEqual(s.missing_specs(["cargo", "test", "-p", "nunchiro", "x"]), [])
        row = s.run_test(pw + ["no-such-page.spec.ts", "inputs-one-style.spec.ts"], {})  # refused before anything runs
        self.assertEqual((row["green"], row["tests"], row["exit"]), (False, 0, None))
        self.assertIn("no-such-page.spec.ts", row["tail"])

    def test_a_test_check_counts_only_when_its_tests_ran_green_at_this_commit(self):
        cmd = ["cargo", "test", "-p", "nunchiro", "x"]
        doc = {"commit": "abc1234", "results": [{"cmd": cmd, "green": True}, {"cmd": ["other"], "green": False}]}
        green = s.green_commands(doc, "abc1234de")
        self.assertEqual(green, {"cargo test -p nunchiro x"})
        self.assertEqual(s.green_commands(doc, "fff0000"), set())  # the tests of another commit are not this run
        self.assertEqual(s.green_commands(None, "abc1234"), set())
        check = {"id": "ST1", "verdict": "pass", "evidence": "holder.rs", "tests": [cmd]}
        self.assertEqual(s.effective(check, green)["verdict"], "pass")
        for not_counted in (dict(check, tests=[cmd, ["other"]]), dict(check, tests=[]), {k: v for k, v in check.items() if k != "tests"}):
            got = s.effective(not_counted, green)
            self.assertEqual(got["verdict"], "fail", not_counted)
            self.assertIn("NOT COUNTED", got["evidence"])
        self.assertEqual(s.effective(check, set())["verdict"], "fail")  # no tests file: "a test exists" is not a pass
        other = {"id": "LI1", "verdict": "pass", "evidence": "LICENSE"}
        self.assertIs(s.effective(other, set()), other)  # a check that rests on no test is read as before

    def test_manual_figures_need_evidence_a_known_name_and_a_recent_file(self):
        doc = {"date": "2026-11-27", "figures": {"idle_mib_5": {"value": 300.5, "evidence": "weigh, 5 sessions"},
                                                 "idle_cpu_pct_5": {"value": 1.0, "evidence": " "},
                                                 "term_paint_p95_ms": {"value": "fast", "evidence": "x"},
                                                 "launch_cold_s": {"value": 0.1, "evidence": "by hand"}}}
        self.assertEqual(s.manual_figures(doc, "2026-11-28 10:00"), {"idle_mib_5": 300.5})
        self.assertEqual(s.manual_figures(doc, "2026-12-09 10:00"), {})  # older than the 7 days before the run
        self.assertEqual(s.manual_figures(None, "2026-11-28"), {})

    def test_the_delivery_record_reader(self):
        import record
        record.self_test()

    def test_holders_by_session_id_or_by_the_core_binary(self):
        a, b = "11111111-a6f0-4d70-ae77-123456789abc", "22222222-a6f0-4d70-ae77-123456789abc"
        args = {1: "/x/Nunchiro RC.app/Contents/MacOS/nunchiro serve", 2: f"/x/Nunchiro RC.app/Contents/MacOS/nunchiro hold {a}",
                3: f"/Users/o/Applications/Nunchiro.app/Contents/MacOS/nunchiro hold {b}", 4: "/bin/cat hold on"}
        self.assertEqual(s.holder_pids(args, ids={a}), [2])
        self.assertEqual(s.holder_pids(args, exe="/Users/o/Applications/Nunchiro.app/Contents/MacOS/nunchiro"), [3])

    def test_mib_per_session_is_never_negative(self):
        # the 11-26 run: a baseline sampled before the window settled read higher than 20 sessions later
        self.assertEqual(s.mib_per_session(280.0, 340.0, 4.0, 20, 20), 3.2)
        self.assertIsNone(s.mib_per_session(355.0, 340.0, 4.0, 20, 20))  # a negative cost is a bad baseline, refused
        self.assertIsNone(s.mib_per_session(280.0, 340.0, 4.0, 20, 19))  # a holder not found is refused, as before

    RES = {"date": "2026-11-27 10:00", "installs": {"ok": 5, "of": 5}, "launches": {"drawn": 10, "of": 10},
           "sessions_alive_pct": {"median": 100}, "figures": {"launch_restored_s": {"median": 0.6}, "mib_per_session": {"median": 3.0}}}

    def test_an_easier_condition_is_a_floor_not_the_figure(self):
        full = [{"sessions": 20, "chat_events": 5000}]
        self.assertEqual(s.flat(dict(self.RES, rubric=2, restored=full))["launch_restored_s"], 0.6)
        for restored in ([], [{"sessions": 20, "chat_events": 0}], full + [{"sessions": 0, "chat_events": 0, "error": "x"}]):
            self.assertIsNone(s.flat(dict(self.RES, rubric=2, restored=restored))["launch_restored_s"], restored)
        self.assertEqual(s.flat(dict(self.RES, rubric=2))["mib_per_session"], 3.0)
        self.assertIsNone(s.flat(self.RES)["mib_per_session"])  # a v1 results file: holders were not counted
        res = dict(self.RES, figures=dict(self.RES["figures"], idle_mib_5_shell={"median": 290.0}))
        self.assertEqual(s.figure_line("idle_mib_5", None, 0, res),
                         "idle_mib_5: not measured (0 pts); floor under an easier condition than the rubric names: 290.0")
        self.assertEqual(s.figure_line("soak_clean_hours", None, 0, res), "soak_clean_hours: not measured (0 pts)")
        self.assertEqual(s.figure_line("idle_mib_5", 300, 67, res), "idle_mib_5 = 300 (67 pts)")

    def test_manual_and_devspeed_figures_reach_the_anchors(self):
        manual = {"date": "2026-11-27", "figures": {"idle_mib_5": {"value": 375, "evidence": "weigh"}}}
        f = s.flat(dict(self.RES, rubric=2), {"devspeed": {"rework": {"first_pass_pct": 75.0}}}, manual)
        self.assertEqual((f["idle_mib_5"], f["first_pass_review_pct"]), (375, 75.0))
        self.assertEqual(s.points(f["first_pass_review_pct"], *s.ANCHORS["first_pass_review_pct"]), 50)


class Card(unittest.TestCase):
    """The committed parts.json and tasks.json fit rubric v2, and the page renders from them."""

    def setUp(self):
        import json
        self.parts = json.loads((s.OUT_DIR / "parts.json").read_text())
        self.tasks = json.loads((s.OUT_DIR / "tasks.json").read_text())

    def test_37_parts_and_every_number_part_is_listed(self):
        ids = [p["id"] for p in self.parts["parts"]]
        self.assertEqual(ids, sorted(f"p{i:02d}" for i in range(1, 38)))
        self.assertEqual(self.parts["version"], s.RUBRIC)
        self.assertLessEqual(set(s.NUMBER_PARTS), set(ids))

    def test_every_test_check_names_its_commands(self):
        checks = {c["id"]: c for p in self.parts["parts"] for c in p.get("checks", [])}
        for cid in sorted(s.TEST_CHECKS):
            self.assertTrue(checks[cid].get("tests"), cid)

    def test_every_spec_a_check_names_is_in_this_repository(self):
        for p in self.parts["parts"]:
            for c in p.get("checks", []):
                for cmd in c.get("tests", []):
                    self.assertEqual(s.missing_specs(cmd), [], c["id"])

    def test_the_page_renders_and_unmeasured_parts_are_zero(self):
        res = {"date": "2026-11-27 10:00", "commit": "abc1234", "host": "h", "macos": "m", "load": [1, 2], "repeats": 1,
               "installs": {"ok": 1, "of": 1}, "launches": {"drawn": 2, "of": 2}, "sessions_alive_pct": {"median": 100},
               "figures": {}, "owner_check": {}}
        page = s.render(res, self.parts, self.tasks, "results-x.json")
        self.assertIn("All 37 parts", page)
        for name in ("Usability", "First use", "Multi-agent accuracy", "Real-use speed and weight"):
            self.assertIn(f"<tr><td>{name}</td><td class=s>0</td>", page)
        self.assertIn("NOT COUNTED", page)  # no tests file: the checks that rest on tests are not counted


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
        # first-parent subjects of main: a revert lane of the local gate, and a pull request reverted with GitHub's button
        main = ["Merge lane lead-a (lead/a 8f4cac357467)", "Merge lane fable-revert-lead-b (fable/revert-lead-b 1a2b3c4d5e6f)",
                'Revert "ui: a change (#11)" (#12)', "ui: a change (#11)", 'Revert "Revert "ui: a change (#11)" (#12)" (#13)']
        self.assertEqual(s.reverts_landed(main), ["fable-revert-lead-b", 'Revert "ui: a change (#11)" (#12)'])

    def test_a_lead_revert_lane_and_a_plain_git_revert_are_reverts_landed(self):
        # Ticket 1157: lead-revert<ticket>, and a lane whose own commits all start "Revert " (not a revert of a revert)
        main = [f"Merge lane {x} (lead/{x} 8f4cac357467)" for x in ("lead-revert1145", "lead-undo", "lead-again", "lead-c")]
        subjects = {"lead-undo": ['Revert "Merge lane lead-c (lead/c 8f4cac357467)"'],
                    "lead-again": ['Revert "Revert lane lead-c: red main"'], "lead-c": ["c: a change"]}
        self.assertEqual(s.reverts_landed(main, subjects), ["lead-revert1145", "lead-undo"])
        self.assertEqual(s.revert_of("lead-undo", subjects["lead-undo"]), "lead-c")
        self.assertEqual(s.revert_of("lead-x", ["Revert ticket 1145 (composer takes focus)"]), "")


class Dev(unittest.TestCase):
    def test_largest_skips_tests_fixtures_and_catalogues(self):
        files = [("crates/a/src/sessions.rs", 14000), ("crates/a/src/sessions/tests.rs", 20000), ("crates/a/tests/x.rs", 9000),
                 ("web/src/i18n/areas/settings.ts", 3000), ("web/src/App.tsx", 2500), ("README.md", 9000)]
        self.assertEqual(s.largest(files), ([("crates/a/src/sessions.rs", 14000), ("web/src/App.tsx", 2500)], 2))

    def test_shared_files_need_two_lanes(self):
        self.assertEqual(s.shared_files({"a": ["x", "y"], "b": ["y"], "c": ["z"]}), {"y": ["a", "b"]})

    def test_the_dev_run_times_the_pr_gates_rust_tests(self):
        """The test stage is the PR gate's own nextest run; the retired local gate's scripts are named nowhere."""
        self.assertEqual(s.TEST_STAGE, ["cargo", "nextest", "run", "--workspace", "--config-file", "scripts/nextest.toml"])
        root = s.ROOT
        files = [p for p in (root / "scripts/measure").rglob("*") if p.is_file()] + [root / x for x in (
            "scripts/nextest.toml", "scripts/raw-literal-ratchet.sh", ".github/scripts/web-core.sh", ".gitattributes",
            "crates/nunchiro-core/src/http/browser_tests.rs")]
        for old in ("cargo-test-gate.sh", "BUILD_LOOP", "web-smoke.sh", "bin/land", "pre_gate"):
            self.assertEqual([str(p.relative_to(root)) for p in files if p.is_file() and old in p.read_text(errors="replace")], [], old)


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


class ChatOpenVerdict(unittest.TestCase):
    """p33's chatopen writes the figure only when every asked open has its chat-drawn mark."""

    def test_all_opens_marked_is_written(self):
        r, why = s.chat_open_verdict([[0.0, 120.0], [1000.0, 1080.0], [2000.0, 2100.0]], 3)
        self.assertEqual((r["median_ms"], r["n"], why), (100.0, 3, None))

    def test_a_miss_refuses(self):
        r, why = s.chat_open_verdict([[0.0, 120.0], [1000.0, None]], 2)
        self.assertEqual(r["misses"], 1)
        self.assertIn("1 opens with no chat-drawn mark", why)

    def test_fewer_opens_than_asked_refuses(self):
        _, why = s.chat_open_verdict([[0.0, 120.0]], 10)
        self.assertEqual(why, "1 marked opens of the 10 asked")


class Stream8Verdict(unittest.TestCase):
    """p33's stream8 writes the median of the repeats' worst frames, only from a whole, judged stream-8 row."""

    ROW = dict(terminals=8, painted=[8, 8, 8], worst_frame_ms=[400.0, 250.0, 1900.0], frames_valid=True,
               skipped_repeats=0)

    def test_a_whole_row_is_written(self):
        self.assertEqual(s.stream8_verdict(self.ROW), (400.0, None))

    def test_not_run_refuses(self):
        self.assertEqual(s.stream8_verdict(dict(not_run="not run: load")), (None, "not run: load"))

    def test_a_terminal_not_painted_refuses(self):
        _, why = s.stream8_verdict(dict(self.ROW, painted=[8, 7, 8]))
        self.assertIn("end markers painted [8, 7, 8]", why)

    def test_throttled_frames_or_a_skipped_repeat_refuse(self):
        self.assertIn("frames throttled", s.stream8_verdict(dict(self.ROW, frames_valid=False))[1])
        self.assertIn("1 repeats not run", s.stream8_verdict(dict(self.ROW, skipped_repeats=1))[1])


if __name__ == "__main__":
    unittest.main()
