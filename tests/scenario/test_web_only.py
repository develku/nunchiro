"""scripts/web-only.sh on a throwaway git repo: a pull request whose every changed file is window code or a window test
that no Rust file names gives exit 0 (CI may skip the Rust build and test jobs); a file Rust reads, web/index.html, a
package or config file, anything outside web/src and web/tests, a delete or an empty change gives 1, and a bad ref an
error, so CI runs everything for any answer but 0."""
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


class WebOnly(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="web-only-")
        self.addCleanup(shutil.rmtree, self.dir)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "t")
        self.git("config", "user.email", "t@localhost")
        for p in ("web/index.html", "web/package.json", "web/src/a.css", "web/src/settings.ts", "web/tests/a.spec.ts",
                  "src/lib.rs"):
            self.put(p)
        # A Rust file that reads a window file, as crates/nunchiro-core does with include_str!.
        self.put("crates/core/src/lib.rs", 'const S: &str = include_str!("../../../web/src/settings.ts");\n')
        self.git("commit", "-qm", "base")
        self.git("checkout", "-qb", "pr")

    def git(self, *args):
        subprocess.run(["git", *args], cwd=self.dir, check=True, capture_output=True)

    def put(self, path, text="x\n"):
        full = os.path.join(self.dir, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "a") as f:
            f.write(text)
        self.git("add", path)

    def commit(self, *paths):
        for p in paths:
            self.put(p, "more\n")
        self.git("commit", "-qm", "change")

    def detect(self, ref="main"):
        return subprocess.run(["sh", os.path.join(ROOT, "scripts/web-only.sh"), ref], cwd=self.dir,
                              capture_output=True, text=True).returncode

    def test_window_code_and_tests_skip(self):
        self.commit("web/src/a.css", "web/tests/a.spec.ts", "web/src/themes/new.ts")
        self.assertEqual(self.detect(), 0)

    def test_file_rust_reads_runs(self):
        self.commit("web/src/settings.ts")
        self.assertEqual(self.detect(), 1)

    def test_unsafe_web_files_run(self):
        for p in ("web/index.html", "web/package.json", "web/vite.config.ts", "web/tsconfig.json", "pnpm-lock.yaml"):
            with self.subTest(p):
                self.git("checkout", "-q", "-B", "pr", "main")
                self.commit(p)
                self.assertEqual(self.detect(), 1)

    def test_mixed_with_rust_runs(self):
        self.commit("web/src/a.css", "src/lib.rs")
        self.assertEqual(self.detect(), 1)

    def test_delete_runs(self):
        self.git("rm", "-q", "web/src/a.css")
        self.git("commit", "-qm", "gone")
        self.assertEqual(self.detect(), 1)

    def test_empty_diff_runs(self):
        self.assertEqual(self.detect(), 1)

    def test_detector_error_is_not_skip(self):
        self.commit("web/src/a.css")
        rc = self.detect("no-such-ref")
        self.assertNotIn(rc, (0, 1))


if __name__ == "__main__":
    unittest.main()
