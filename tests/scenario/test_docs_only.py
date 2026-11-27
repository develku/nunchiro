"""scripts/docs-only.sh on a throwaway git repo: a pull request whose every changed file is on the safe list gives exit 0
(CI may skip the Rust and web jobs); a mixed, code, unsafe-docs, deleted or empty change gives 1, and a bad ref an error,
so CI runs everything for any answer but 0."""
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


class DocsOnly(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="docs-only-")
        self.addCleanup(shutil.rmtree, self.dir)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "t")
        self.git("config", "user.email", "t@localhost")
        for p in ("README.md", "CHANGELOG.md", "docs/cli.md", "src/lib.rs"):
            self.put(p)
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
        return subprocess.run(["sh", os.path.join(ROOT, "scripts/docs-only.sh"), ref], cwd=self.dir,
                              capture_output=True, text=True).returncode

    def test_safe_docs_skip(self):
        self.commit("README.md", "CHANGELOG.md", "docs/product.md")
        self.assertEqual(self.detect(), 0)

    def test_design_book_skips(self):
        self.commit("docs/design/design-book/index.html", "docs/design/design-book/README.md")
        self.assertEqual(self.detect(), 0)

    def test_other_design_files_run(self):
        self.commit("docs/design/v25-threat-model.md")
        self.assertEqual(self.detect(), 1)

    def test_mixed_runs(self):
        self.commit("README.md", "src/lib.rs")
        self.assertEqual(self.detect(), 1)

    def test_code_runs(self):
        self.commit("src/lib.rs")
        self.assertEqual(self.detect(), 1)

    def test_unsafe_docs_run(self):
        for p in ("docs/cli.md", "docs/measure/rubric.md", "PRIVACY.md", "scripts/x.md", "tests/x.md", "crates/a/README.md"):
            with self.subTest(p):
                self.git("checkout", "-q", "-B", "pr", "main")
                self.commit(p)
                self.assertEqual(self.detect(), 1)

    def test_delete_runs(self):
        self.git("rm", "-q", "README.md")
        self.git("commit", "-qm", "gone")
        self.assertEqual(self.detect(), 1)

    def test_empty_diff_runs(self):
        self.assertEqual(self.detect(), 1)

    def test_detector_error_is_not_skip(self):
        self.commit("README.md")
        rc = self.detect("no-such-ref")
        self.assertNotIn(rc, (0, 1))


if __name__ == "__main__":
    unittest.main()
