"""The ratchets of scripts/ run in the pull-request gate (.github/scripts/ratchets.py from the lint job of ci.yml): no
baseline may gain a line or a higher count, and no count may rise above the larger of its baseline and the base
commit's own count. Fixtures on a throwaway git repo; no network."""
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COPY = ["scripts/raw-literals.sh", "scripts/raw-literal-ratchet.sh", "scripts/file-size-ratchet.sh",
        "scripts/measure/scorecard.py", ".github/scripts/ratchets.py"]


class Wired(unittest.TestCase):
    def test_every_baseline_is_guarded_by_a_gate_job(self):
        ci = (ROOT / ".github/workflows/ci.yml").read_text()
        lint = ci.split("\n  lint:", 1)[1].split("\n  rust-build:", 1)[0]
        self.assertIn("git show HEAD^:.github/scripts/ratchets.py", lint, "the lint job runs the base commit's ratchets")
        self.assertIn("fetch-depth: 0", lint, "the ratchets read the base commit")
        script = (ROOT / ".github/scripts/ratchets.py").read_text()
        for base in sorted((ROOT / "scripts").glob("*.baseline")):
            self.assertIn(f"scripts/{base.name}", script, f"{base.name} is not guarded in the gate")
        # the browser ratchets run inside the web job's core set; their baselines only shrink (above)
        core = (ROOT / "web/tests/core-set.txt").read_text()
        for spec in ("dead-click.spec.ts", "overlap-check.spec.ts"):
            self.assertRegex(core, re.compile(rf"^{re.escape(spec)}$", re.M))


class Ratchets(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="ci-ratchets-"))
        self.addCleanup(shutil.rmtree, self.dir)
        for rel in COPY:
            (self.dir / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(ROOT / rel, self.dir / rel)
        self.git("init", "-q")
        self.git("config", "user.email", "t@localhost")
        self.git("config", "user.name", "t")
        # main is already over its baselines: a.css has 2 hex (baseline 1), big.rs 2,600 lines (baseline 2,500)
        self.put("web/src/a.css", "a { color: #fff; background: #000; }\n")
        self.put("src/big.rs", "x\n" * 2600)
        self.put("src/mid.rs", "x\n" * 1700)  # listed under the limit, also over its number
        self.put("scripts/raw-literals.baseline", "hex a.css 1\n")
        self.put("scripts/file-sizes.baseline", "# header\n2500 src/big.rs\n1500 src/mid.rs\n")
        self.put("scripts/dead-click.baseline", "s|div.a|A\n")
        self.commit("base")
        self.git("tag", "base")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.dir, check=True, capture_output=True, text=True).stdout

    def put(self, rel, text):
        (self.dir / rel).parent.mkdir(parents=True, exist_ok=True)
        (self.dir / rel).write_text(text)

    def commit(self, msg):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", msg)

    def check(self, ref="base"):
        """As the lint job runs it: the base commit's copy of the script."""
        script = self.dir.parent / (self.dir.name + "-ratchets.py")
        self.addCleanup(lambda: script.unlink(missing_ok=True))
        script.write_text(self.git("show", "base:.github/scripts/ratchets.py"))
        r = subprocess.run(["python3", "-B", str(script), ref], cwd=self.dir, capture_output=True, text=True)
        return r.returncode, r.stdout + r.stderr

    def test_a_change_cannot_loosen_its_own_gate(self):
        # the counter, the source-file pattern and this script all come from the base commit
        for rel, text in (("scripts/raw-literals.sh", "exit 0\n"),
                          ("scripts/measure/scorecard.py", 'import re\nSOURCE = re.compile("^$")\nNOT_SOURCE = SOURCE\n'),
                          (".github/scripts/ratchets.py", "print('ok')\n")):
            self.put(rel, text)
            self.put("web/src/a.css", "a { color: #fff; background: #000; border-color: #111; }\n")
            self.put("src/big.rs", "x\n" * 2601)
            self.commit("loosen " + rel)
            code, out = self.check()
            self.assertEqual(code, 1, rel)
            self.assertIn("a.css", out, rel)
            self.assertIn("src/big.rs", out, rel)
            self.git("reset", "-q", "--hard", "base")

    def test_no_base_commit_says_so_in_one_line(self):
        code, out = self.check("no-such-ref")
        self.assertEqual(code, 2)
        self.assertEqual(out.strip().count("\n"), 0, out)
        self.assertIn("no base commit", out)

    def test_main_over_its_baseline_does_not_block_an_unrelated_change(self):
        self.put("README.md", "hi\n")
        self.commit("docs")
        self.assertEqual(self.check()[0], 0, self.check()[1])

    def test_a_count_above_the_base_fails(self):
        self.put("web/src/a.css", "a { color: #fff; background: #000; border-color: #111; }\n")
        self.commit("one more hex")
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn("a.css", out)

    def test_a_new_file_with_a_literal_fails(self):
        self.put("web/src/b.css", "b { color: #abc; }\n")
        self.commit("new literal")
        self.assertEqual(self.check()[0], 1)

    def test_a_file_that_grows_fails_and_one_that_shrinks_passes(self):
        self.put("src/big.rs", "x\n" * 2601)
        self.commit("grow")
        self.assertEqual(self.check()[0], 1)
        self.put("src/big.rs", "x\n" * 2400)
        self.commit("shrink")
        self.assertEqual(self.check()[0], 0, self.check()[1])

    def test_a_new_file_over_the_limit_fails(self):
        self.put("src/new.rs", "x\n" * 2001)
        self.commit("big new file")
        self.assertEqual(self.check()[0], 1)

    def test_a_baseline_may_shrink_but_never_grow(self):
        self.put("scripts/dead-click.baseline", "")
        self.put("scripts/raw-literals.baseline", "")
        self.put("web/src/a.css", "a { }\n")
        self.commit("fixed")
        self.assertEqual(self.check()[0], 0, self.check()[1])
        for rel, text in (("scripts/dead-click.baseline", "s|div.b|B\n"), ("scripts/raw-literals.baseline", "hex a.css 5\n"),
                          ("scripts/file-sizes.baseline", "2700 src/big.rs\n")):
            self.git("checkout", "-q", "base", "--", ".")
            self.put(rel, text)
            self.commit("loosen " + rel)
            code, out = self.check()
            self.assertEqual(code, 1, rel)
            self.assertIn(rel, out)
            self.git("reset", "-q", "--hard", "base")


if __name__ == "__main__":
    unittest.main()
