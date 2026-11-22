"""perf-baseline helpers: CPU seconds read from ps and the five-run summary."""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "measure"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "scenario"))
import baseline as b  # noqa: E402


class Cpu(unittest.TestCase):
    def test_cputime_grows_while_this_process_burns_cpu(self):
        before = b.cputime([os.getpid()])
        end = time.process_time() + 0.3
        while time.process_time() < end:
            pass
        self.assertGreater(b.cputime([os.getpid()]) - before, 0.1)

    def test_a_vanished_pid_counts_zero(self):
        self.assertEqual(b.cputime([2**22 - 1]), 0.0)


class Summary(unittest.TestCase):
    def test_median_range_and_failed_runs_dropped(self):
        s = b.summary([10, None, 30, 20])
        self.assertEqual((s["median"], s["min"], s["max"]), (20, 10, 30))
        self.assertEqual(b.summary([None]), {})


if __name__ == "__main__":
    unittest.main()
