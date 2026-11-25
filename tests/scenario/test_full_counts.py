"""Ticket 1152: the weekly full run's counting script (.github/workflows/full.yml summary job) passes its self-test."""
import os
import subprocess
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


class FullCounts(unittest.TestCase):
    def test_self_test(self):
        r = subprocess.run(["python3", "-I", ".github/scripts/full-counts.py", "--self-test"], cwd=ROOT,
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
