"""scripts/repro-check.sh (ticket 1130 B3, scorecard p29 SC5): the comparison of two clean-clone builds, on a tiny fixture
tree, and the rule that it empties only a folder it made. No clone and no build here: the real run is weekly."""
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
SCRIPT = os.path.join(ROOT, "scripts", "repro-check.sh")


def run(*args, script=SCRIPT, env=None):
    return subprocess.run(["sh", script, *args], capture_output=True, text=True, timeout=60, env=env)


def git(d, *a):
    return subprocess.run(["git", "-C", d, *a], capture_output=True, text=True, check=True).stdout


class ReproCheck(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for side in ("a", "b"):
            out = os.path.join(self.tmp.name, side, "out")
            os.makedirs(os.path.join(out, "web-dist", "assets"))
            for name, data in (("web-dist/index.html", b"<html></html>"), ("web-dist/assets/app.js", b"x=1"),
                               ("nunchiro-app", b"\xcf\xfa\xed\xfe app"), ("nunchiro", b"\xcf\xfa\xed\xfe cli")):
                with open(os.path.join(out, name), "wb") as f:
                    f.write(data)

    def compare(self):
        return run("--compare", os.path.join(self.tmp.name, "a"), os.path.join(self.tmp.name, "b"))

    def test_same_trees_pass(self):
        r = self.compare()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("same build twice", r.stdout)

    def test_one_byte_fails_and_names_the_file(self):
        with open(os.path.join(self.tmp.name, "b", "out", "web-dist", "assets", "app.js"), "wb") as f:
            f.write(b"x=2")
        r = self.compare()
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("DIFFERENT web-dist", r.stdout)
        self.assertIn("same nunchiro-app", r.stdout)
        self.assertIn("./web-dist/assets/app.js", r.stdout)

    def test_missing_file_fails(self):
        os.remove(os.path.join(self.tmp.name, "b", "out", "nunchiro"))
        r = self.compare()
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("DIFFERENT nunchiro ", r.stdout)

    def own_repo_script(self):
        """The script in a repo of its own with origin/main set, so no test depends on the host checkout's refs."""
        repo = os.path.join(self.tmp.name, "repo")
        os.makedirs(os.path.join(repo, "scripts"))
        script = shutil.copy(SCRIPT, os.path.join(repo, "scripts", "repro-check.sh"))
        git(repo, "init", "-q", "-b", "main")
        git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base")
        git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
        return script

    def test_refuses_a_folder_it_did_not_make(self):
        keep = os.path.join(self.tmp.name, "a", "out", "nunchiro")
        r = run(os.path.join(self.tmp.name, "a"), script=self.own_repo_script())
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("was not made by repro-check.sh", r.stderr)
        self.assertTrue(os.path.exists(keep))

    def test_refuses_a_link_given_with_a_trailing_slash(self):
        victim = os.path.join(self.tmp.name, "victim")
        os.makedirs(victim)
        for name in (".repro-check-owned", "keep"):
            open(os.path.join(victim, name), "w").close()
        alias = os.path.join(self.tmp.name, "alias")
        os.symlink(victim, alias)
        r = run(alias + "/", script=self.own_repo_script())
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("is a link", r.stderr)
        self.assertTrue(os.path.exists(os.path.join(victim, "keep")))

    def test_a_failed_hash_exits_2_and_never_reports_same(self):
        # Different app bytes on each side; a shasum that fails only on ./nunchiro-app on both sides.
        with open(os.path.join(self.tmp.name, "b", "out", "nunchiro-app"), "wb") as f:
            f.write(b"other")
        shim = os.path.join(self.tmp.name, "bin")
        os.makedirs(shim)
        real = shutil.which("shasum")
        with open(os.path.join(shim, "shasum"), "w") as f:
            f.write(f'#!/bin/sh\ncase "$*" in *./nunchiro-app) exit 1 ;; esac\nexec {real} "$@"\n')
        os.chmod(os.path.join(shim, "shasum"), 0o755)
        env = dict(os.environ, PATH=shim + os.pathsep + os.environ["PATH"])
        r = run("--compare", os.path.join(self.tmp.name, "a"), os.path.join(self.tmp.name, "b"), env=env)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertNotIn("same build twice", r.stdout)


if __name__ == "__main__":
    unittest.main()
