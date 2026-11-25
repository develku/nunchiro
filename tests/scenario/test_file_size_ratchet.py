"""scripts/file-size-ratchet.sh (ticket 1147) on a throwaway git repo: a listed file may shrink, never grow; an unlisted
source file may not pass 2,000 lines; tests and fixtures do not count, as the scorecard judge counts."""
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


class FileSizeRatchet(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="size-ratchet-")
        self.addCleanup(shutil.rmtree, self.dir)
        os.makedirs(os.path.join(self.dir, "scripts/measure"))
        shutil.copy(os.path.join(ROOT, "scripts/file-size-ratchet.sh"), os.path.join(self.dir, "scripts"))
        shutil.copy(os.path.join(ROOT, "scripts/measure/scorecard.py"), os.path.join(self.dir, "scripts/measure"))
        subprocess.run(["git", "init", "-q"], cwd=self.dir, check=True)
        self.put("src/big.rs", 2500)
        self.put("src/small.rs", 10)
        self.put("src/big/tests.rs", 9000)
        self.put("src/b_tests.rs", 9000)
        with open(os.path.join(self.dir, "scripts/file-sizes.baseline"), "w") as f:
            f.write("# header\n2500 src/big.rs\n")

    def put(self, path, lines):
        full = os.path.join(self.dir, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as f:
            f.write("x\n" * lines)
        subprocess.run(["git", "add", path], cwd=self.dir, check=True)

    def run_ratchet(self):
        return subprocess.run(["sh", "scripts/file-size-ratchet.sh"], cwd=self.dir, capture_output=True, text=True)

    def test_baseline_holds(self):
        r = self.run_ratchet()
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_listed_file_grows(self):
        self.put("src/big.rs", 2501)
        r = self.run_ratchet()
        self.assertEqual(r.returncode, 1)
        self.assertIn("src/big.rs: grew from 2500 to 2501", r.stderr)

    def test_listed_file_shrinks(self):
        self.put("src/big.rs", 1500)
        r = self.run_ratchet()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("lower the baseline", r.stdout)

    def test_new_file_passes_limit(self):
        self.put("src/small.rs", 2001)
        r = self.run_ratchet()
        self.assertEqual(r.returncode, 1)
        self.assertIn("src/small.rs: 2001 lines", r.stderr)

    def test_at_limit_passes(self):
        self.put("src/small.rs", 2000)
        self.assertEqual(self.run_ratchet().returncode, 0)


if __name__ == "__main__":
    unittest.main()
