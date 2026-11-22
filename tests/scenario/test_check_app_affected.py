"""check-app.sh --affected <ref>: skips only when no app input changed; otherwise it reaches the real check."""
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
# Every input the app check reads (scripts/check-app.sh APP_INPUTS): one file per entry.
INPUTS = ["app/src-tauri/a.rs", "scripts/gen-notices.sh", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml",
          "licenses/x.txt", "LICENSE", "THIRD_PARTY_NOTICES.md", "web/package.json", "pnpm-lock.yaml",
          "pnpm-workspace.yaml"]


def git(d, *a):
    subprocess.run(["git", "-C", d, *a], check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                        "GIT_COMMITTER_EMAIL": "t@t"})


class CheckAppAffected(unittest.TestCase):
    def repo(self):
        d = tempfile.mkdtemp(dir=os.path.join(ROOT, ".scratch"), prefix="cappaff-")
        self.addCleanup(shutil.rmtree, d, True)
        os.makedirs(os.path.join(d, "scripts"))
        shutil.copy(os.path.join(ROOT, "scripts", "check-app.sh"), os.path.join(d, "scripts", "check-app.sh"))
        for p in INPUTS + ["README.md", "web/dist/index.html"]:
            os.makedirs(os.path.dirname(os.path.join(d, p)) or d, exist_ok=True)
            with open(os.path.join(d, p), "w") as f:
                f.write("x\n")
        git(d, "init", "-q", "-b", "main")
        git(d, "add", "-A")
        git(d, "commit", "-qm", "base")
        git(d, "branch", "base")
        # A stub cargo on PATH leaves a marker: proof the real check was reached, without building anything.
        b = os.path.join(d, ".bin")
        os.makedirs(b)
        with open(os.path.join(b, "cargo"), "w") as f:
            f.write(f"#!/bin/sh\necho reached > {d}/.reached\nexit 1\n")
        os.chmod(os.path.join(b, "cargo"), 0o755)
        return d

    def run_check(self, d):
        env = {"PATH": f"{d}/.bin:/usr/bin:/bin", "HOME": d}
        return subprocess.run(["sh", "scripts/check-app.sh", "--affected", "base"], cwd=d, capture_output=True,
                              text=True, env=env, timeout=60)

    def test_every_listed_input_exists_in_the_repo(self):
        # A misspelt entry (web/pnpm-lock.yaml, review r4) silently skips the check for that input.
        import re
        s = open(os.path.join(ROOT, "scripts", "check-app.sh")).read()
        listed = re.search(r'APP_INPUTS="([^"]+)"', s).group(1).split()
        for p in listed:
            self.assertTrue(os.path.exists(os.path.join(ROOT, p)), f"APP_INPUTS lists a missing path: {p}")

    def test_no_app_input_change_skips(self):
        d = self.repo()
        with open(os.path.join(d, "README.md"), "a") as f:
            f.write("more\n")
        git(d, "commit", "-qam", "docs")
        r = self.run_check(d)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("skipped", r.stdout)
        self.assertFalse(os.path.exists(os.path.join(d, ".reached")))

    def test_each_input_change_reaches_the_check(self):
        for p in INPUTS:
            with self.subTest(p=p):
                d = self.repo()
                with open(os.path.join(d, p), "a") as f:
                    f.write("y\n")
                git(d, "commit", "-qam", "change")
                r = self.run_check(d)
                self.assertNotIn("skipped", r.stdout, p)
                self.assertTrue(os.path.exists(os.path.join(d, ".reached")), p + r.stderr)

    def test_untracked_app_file_reaches_the_check(self):
        d = self.repo()
        with open(os.path.join(d, "app", "src-tauri", "new.rs"), "w") as f:
            f.write("n\n")
        r = self.run_check(d)
        self.assertTrue(os.path.exists(os.path.join(d, ".reached")), r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
