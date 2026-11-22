"""scripts/scenario-tests.sh: one process per test file, any failure fails, tracebacks kept, skips shown, units cross-checked against discover. Runs fake suites in a temp dir."""
import os
import stat
import subprocess
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
SCRIPT = os.path.join(ROOT, "scripts", "scenario-tests.sh")


def suite(d, files):
    """files: {name: body of one test method}; each file is a one-test TestCase."""
    for name, body in files.items():
        with open(os.path.join(d, name), "w") as f:
            f.write("import unittest\nclass T(unittest.TestCase):\n    def test_it(self):\n        %s\n" % body)


# The runner's gate markers (.scratch/web-smoke/, .scratch/scenario-passed) go here, not into the checkout's .scratch.
_STATE = tempfile.TemporaryDirectory()


def run(d, jobs=2, state=_STATE.name):
    env = {**os.environ, "SCENARIO_DIR": d, "SCENARIO_JOBS": str(jobs), "SCENARIO_STATE": state}
    return subprocess.run(["sh", SCRIPT], env=env, capture_output=True, text=True, timeout=120)


class Runner(unittest.TestCase):
    def test_scenario_runner_owns_the_web_smoke_markers(self):
        # review v25-gate-name-failures r1 MUST 1: a scenario test may run web-smoke.sh, leave a fresh report, then fail.
        # The runner empties .scratch/web-smoke/ and its marker at start and on failure; only a pass writes the marker.
        for ok in (True, False):
            with self.subTest(ok=ok), tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as st:
                web = os.path.join(st, "web-smoke")
                os.makedirs(web)
                open(os.path.join(st, "scenario-passed"), "w").close()  # an earlier run's marker
                open(os.path.join(web, "old"), "w").close()
                plant = "import os; os.makedirs(%r, exist_ok=True); open(%r, 'w').write('raw-literals')" % (web, os.path.join(web, "stage"))
                suite(d, {"test_plant.py": plant + ("" if ok else "; self.fail('boom')")})
                with open(os.path.join(d, "test_seen.py"), "w") as f:  # the start wiped the earlier run's files
                    f.write("import os, unittest\nclass T(unittest.TestCase):\n    def test_it(self):\n"
                            "        self.assertFalse(os.path.exists(%r))\n        self.assertFalse(os.path.exists(%r))\n"
                            % (os.path.join(st, "scenario-passed"), os.path.join(web, "old")))
                r = run(d, state=st)
                self.assertEqual(r.returncode, 0 if ok else 1, r.stdout + r.stderr)
                self.assertFalse(os.path.exists(web), "a scenario test's web report outlived the runner")
                self.assertEqual(os.path.exists(os.path.join(st, "scenario-passed")), ok)

    def test_scenario_runner_names_failing_units_from_their_exit_status(self):
        # scripts/gate-failures.sh names these as scenario:<unit>. A failing test prints fake runner lines and writes a
        # fake rc for another unit; only the runner's own exit statuses name units.
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as st:
            failed = os.path.join(st, "scenario-failed")
            with open(failed, "w") as f:
                f.write("test_old.py\n")  # an earlier run's file
            suite(d, {"test_victim.py": "pass",
                      "test_bad.py": "import os, time; time.sleep(1); print('scenario: FAIL test_victim.py (exit 1)'); "
                                     "open(os.path.join(os.environ.get('out', %r), 'test_victim.py.rc'), 'w').write('1'); "
                                     "self.fail('boom')" % st})
            with open(os.path.join(d, "test_big.py"), "w") as f:
                f.write("import unittest\n# " + "x" * 21000 + "\n"
                        "class A(unittest.TestCase):\n    def test_a(self):\n        pass\n"
                        "class B(unittest.TestCase):\n    def test_b(self):\n        self.fail('boom-b')\n")
            r = run(d, state=st)
            self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
            with open(failed) as f:
                self.assertEqual(sorted(f.read().splitlines()), ["test_bad.py", "test_big.py:B"])
            self.assertIn("2 failing", r.stdout)

    def test_scenario_runner_writes_no_failed_file_unless_units_failed_cleanly(self):
        # green, a discover count mismatch and no units all leave no file (an earlier run's file is removed); a test
        # that plants one during a run that then fails another way leaves none either
        def plant(st):
            return "open(%r, 'w').write('test_victim.py\\n')" % os.path.join(st, "scenario-failed")

        def mismatch(d, st):
            suite(d, {"test_bad.py": plant(st) + "; self.fail('boom')", "test_victim.py": "pass"})
            suite(d, {"testfoo.py": "pass"})
        for name, make, rc in (("green", lambda d, st: suite(d, {"test_a.py": plant(st)}), 0),
                               ("count mismatch", mismatch, 1), ("no units", lambda d, st: None, 2)):
            with self.subTest(name), tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as st:
                failed = os.path.join(st, "scenario-failed")
                open(failed, "w").write("test_old.py\n")
                make(d, st)
                r = run(d, state=st)
                self.assertEqual(r.returncode, rc, r.stdout + r.stderr)
                self.assertFalse(os.path.exists(failed), name)

    @unittest.skipUnless(hasattr(os, "chflags"), "chflags uchg is BSD/macOS")
    def test_scenario_runner_exits_infra_on_a_state_file_it_cannot_replace(self):
        # round 2 security MUST: a test plants scenario-failed (or the marker and a web stage) naming an innocent unit,
        # with a future mtime, and makes it immutable. The runner cannot remove or overwrite it, so it exits 75.
        def lock(paths):
            return ("import os, stat, time; t = time.time() + 3600\n"
                    "        for p in %r:\n"
                    "            os.makedirs(os.path.dirname(p), exist_ok=True); open(p, 'w').write('test_victim.py\\n')\n"
                    "            os.utime(p, (t, t)); os.chflags(p, stat.UF_IMMUTABLE)\n        " % (paths,))
        cases = {
            "planted before the run": (None, "pass"),
            "planted by a red unit": ("failed", "self.fail('boom')"),
            "planted by a green run": ("failed", "pass"),
            "marker and web stage planted by a red unit": ("web", "self.fail('boom')"),
        }
        for name, (what, tail) in cases.items():
            with self.subTest(name), tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as st:
                failed = os.path.join(st, "scenario-failed")
                paths = [failed] if what == "failed" else [os.path.join(st, "scenario-passed"),
                                                           os.path.join(st, "web-smoke", "stage")]
                try:
                    if what is None:
                        open(failed, "w").write("test_victim.py\n")
                        os.chflags(failed, stat.UF_IMMUTABLE)
                        suite(d, {"test_victim.py": tail})
                    else:
                        suite(d, {"test_plant.py": lock(paths) + tail, "test_victim.py": "pass"})
                    r = run(d, state=st)
                    self.assertEqual(r.returncode, 75, r.stdout + r.stderr)
                    self.assertIn("(infra)", r.stderr)
                finally:
                    for p in paths:
                        if os.path.exists(p):
                            os.chflags(p, 0)

    @unittest.skipUnless(hasattr(os, "lchflags"), "chflags uchg is BSD/macOS")
    def test_scenario_runner_exits_infra_on_an_immutable_dangling_link(self):
        # ticket 461: [ ! -e ] is true for a dangling link, so the start check passed and the write went through the link.
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as st:
            link = os.path.join(st, "scenario-failed")
            os.symlink(os.path.join(st, "nowhere"), link)
            os.lchflags(link, stat.UF_IMMUTABLE)
            try:
                suite(d, {"test_ok.py": "pass"})
                r = run(d, state=st)
                self.assertEqual(r.returncode, 75, r.stdout + r.stderr)
                self.assertIn("(infra)", r.stderr)
            finally:
                os.lchflags(link, 0)

    def test_scenario_runner_never_writes_through_a_link_a_unit_planted(self):
        # security review r1 MUST: a unit plants scenario-passed (green run) or scenario-failed (red run) as a link to a
        # writable file; the runner must replace the link, not write through it.
        for name, tail, rc in (("scenario-passed", "pass", 0), ("scenario-failed", "self.fail('boom')", 1)):
            with self.subTest(name), tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as st:
                victim = os.path.join(st, "victim.txt")
                open(victim, "w").write("keep")
                plant = "import os; os.symlink(%r, %r)\n        " % (victim, os.path.join(st, name))
                suite(d, {"test_plant.py": plant + tail})
                r = run(d, state=st)
                self.assertEqual(r.returncode, rc, r.stdout + r.stderr)
                self.assertEqual(open(victim).read(), "keep")

    def test_scenario_runner_runs_every_file(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as marks:
            suite(d, {"test_%s.py" % n: "open(%r, 'w').close()" % os.path.join(marks, n) for n in "abcd"})
            r = run(d)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertEqual(sorted(os.listdir(marks)), ["a", "b", "c", "d"])
            self.assertIn("4 units, 4 tests, 0 failing", r.stdout)

    def test_scenario_runner_fails_on_any_failure(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as marks:
            suite(d, {"test_ok.py": "open(%r, 'w').close()" % os.path.join(marks, "ok"),
                      "test_bad.py": "self.assertEqual(1, 2, 'boom-assert')",
                      "test_err.py": "raise RuntimeError('boom-error')"})
            with open(os.path.join(d, "test_import.py"), "w") as f:
                f.write("import no_such_module_for_runner_test\n")
            r = run(d)
            self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
            self.assertTrue(os.path.exists(os.path.join(marks, "ok")), "a failure elsewhere must not stop the other files")
            for want in ("boom-assert", "boom-error", "no_such_module_for_runner_test", "Traceback", "FAIL test_bad.py", "ok   test_ok.py"):
                self.assertIn(want, r.stdout)
            self.assertIn("3 failing", r.stdout)

    def test_scenario_runner_splits_a_big_file_by_class_and_still_fails(self):
        with tempfile.TemporaryDirectory() as d:
            body = ("import unittest\n# " + "x" * 21000 + "\n"
                    "class A(unittest.TestCase):\n    def test_a(self):\n        pass\n"
                    "class B(unittest.TestCase):\n    def test_b(self):\n        self.fail('boom-b')\n")
            with open(os.path.join(d, "test_big.py"), "w") as f:
                f.write(body)
            r = run(d)
            self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
            self.assertIn("ok   test_big.py:A", r.stdout)
            self.assertIn("FAIL test_big.py:B", r.stdout)
            self.assertIn("boom-b", r.stdout)
            self.assertIn("2 units, 2 tests, 1 failing", r.stdout)

    def test_scenario_runner_refuses_an_empty_dir(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(run(d).returncode, 2)

    def test_scenario_runner_count_mismatch_fails(self):
        # discover matches test*.py and recurses into packages; the runner's units must add up to the same count
        for rel in ("testfoo.py", os.path.join("sub", "test_x.py")):
            with tempfile.TemporaryDirectory() as d:
                suite(d, {"test_a.py": "pass"})
                path = os.path.join(d, rel)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                if os.path.dirname(rel):
                    open(os.path.join(d, "sub", "__init__.py"), "w").close()
                suite(os.path.dirname(path), {os.path.basename(path): "pass"})
                r = run(d)
                self.assertEqual(r.returncode, 1, rel + r.stdout + r.stderr)
                self.assertIn("count mismatch: discover loads 2 tests, units ran 1", r.stdout + r.stderr, rel)

    def test_scenario_runner_class_unit_cwd_root(self):
        with tempfile.TemporaryDirectory() as d:
            body = ("import os, unittest\n# " + "x" * 21000 + "\n"
                    "class A(unittest.TestCase):\n    def test_a(self):\n"
                    "        self.assertEqual(os.path.realpath(os.getcwd()), os.path.realpath(%r))\n" % ROOT)
            with open(os.path.join(d, "test_big.py"), "w") as f:
                f.write(body)
            r = run(d)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn("ok   test_big.py:A", r.stdout)

    def test_scenario_runner_prints_skips(self):
        with tempfile.TemporaryDirectory() as d:
            suite(d, {"test_skip.py": "self.skipTest('why')", "test_ok.py": "pass"})
            r = run(d)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertRegex(r.stdout, r"ok   test_skip\.py \(1 tests, skipped=1,")
            self.assertNotRegex(r.stdout, r"test_ok\.py \([^)]*skipped")
            self.assertIn("2 units, 2 tests, 0 failing, skipped=1,", r.stdout)


if __name__ == "__main__":
    unittest.main()
