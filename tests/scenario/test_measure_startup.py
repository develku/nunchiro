"""Ticket 549 startup measure: cold/warm split, CPU share, the S9 verdict, and the launch timer on a stand-in app."""
import os
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "measure"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "scenario"))
import startup as s  # noqa: E402


class Summary(unittest.TestCase):
    def test_run_one_is_cold_and_the_rest_give_the_warm_median(self):
        r = s.summarize([1.9, 0.8, 0.6, None, 0.7])
        self.assertEqual((r["cold_s"], r["warm_median_s"], r["missed"]), (1.9, 0.7, 1))

    def test_one_run_has_no_warm_figure(self):
        self.assertEqual(s.summarize([1.2])["warm_median_s"], None)

    def test_cpu_share_of_the_wall_time(self):
        self.assertEqual(s.cpu_pct(10.0, 10.3, 60), 0.5)

    def test_s9_needs_both_times_under_2_s_and_idle_under_half_a_percent(self):
        ok = dict(cold_s=1.5, warm_median_s=0.9, idle_core_cpu_pct=0.3, idle_window_cpu_pct=0.4)
        self.assertEqual(s.verdict(ok), "pass")
        self.assertEqual(s.verdict(dict(ok, cold_s=2.1)), "fail")
        self.assertEqual(s.verdict(dict(ok, warm_median_s=None)), "fail")
        self.assertEqual(s.verdict(dict(ok, idle_core_cpu_pct=1.33)), "fail")
        self.assertEqual(s.verdict(dict(ok, idle_window_cpu_pct=5.26)), "fail")  # ticket 549's gate-mode window

    def test_a_normal_launch_drops_only_the_gate_switch(self):
        self.assertEqual(s.normal_env({"NUNCHIRO_GATE_RUN": "1", "HOME": "/h"}), {"HOME": "/h"})


class Timer(unittest.TestCase):
    def stand_in(self, body):
        d = tempfile.mkdtemp()
        exe = os.path.join(d, "app")
        with open(exe, "w") as f:
            f.write("#!/bin/sh\n" + body + "\n")
        os.chmod(exe, stat.S_IRWXU)
        return exe

    def test_times_launch_to_the_drawn_line_and_keeps_the_rest_in_the_log(self):
        exe = self.stand_in(f"echo other >&2; sleep 0.3; echo '{s.DRAWN.decode()}' >&2; sleep 5")
        log = tempfile.TemporaryFile()
        run = s.Run(exe, dict(os.environ), log)
        secs = run.wait()
        run.proc.kill()
        run.proc.wait()
        self.assertGreaterEqual(secs, 0.3)
        self.assertLess(secs, 3)
        log.seek(0)
        self.assertIn(b"other", log.read())

    def test_a_window_that_never_draws_is_none(self):
        exe = self.stand_in("exit 0")
        s.WAIT_S, old = 1, s.WAIT_S
        try:
            self.assertIsNone(s.Run(exe, dict(os.environ), tempfile.TemporaryFile()).wait())
        finally:
            s.WAIT_S = old


class OwnDirs(unittest.TestCase):
    def test_a_linked_parent_is_refused_and_its_target_kept(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            os.mkdir(os.path.join(root, ".scratch"))
            os.symlink(outside, os.path.join(root, ".scratch", "startup"))
            keep = os.path.join(outside, s.NAME)
            os.mkdir(keep)
            s.ROOT, old = s.Path(root), s.ROOT
            try:
                with self.assertRaises(SystemExit):
                    s.own_dirs(s.ROOT / ".scratch/startup" / s.NAME)
            finally:
                s.ROOT = old
            self.assertTrue(os.path.isdir(keep))


if __name__ == "__main__":
    unittest.main()
