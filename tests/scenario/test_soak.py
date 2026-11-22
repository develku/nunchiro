"""scripts/soak/soak.sh (ticket 751): refuses a home outside the worktree's .scratch, and sets HOME, NUNCHIRO_HOME and
NUNCHIRO_TEST_OPENER on every call even when the caller exported other values. A fake binary stands in for nunchiro."""
import os
import shutil
import subprocess
import tempfile
import unittest
import uuid

ROOT = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
SCRIPT = os.path.join(ROOT, "scripts", "soak", "soak.sh")

FAKE = """#!/bin/sh
{ printf '%s\\n' "$*"; env; } >"$NUNCHIRO_HOME/call.$$"  # one file per call: the background serve runs alongside
case "$*" in
"serve status") if [ -f "$NUNCHIRO_HOME/stopped" ]; then echo '{"core": false}'; else echo '{"core": true}'; fi ;;
"serve stop") : >"$NUNCHIRO_HOME/stopped" ;;
"session start"*) echo "{\\"id\\": \\"s$$\\"}" ;;
"snapshot --json") echo '{"sessions": []}' ;;
esac
"""


class Soak(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.scratch = os.path.join(ROOT, ".scratch", "soak-test-" + uuid.uuid4().hex[:6])
        os.makedirs(self.scratch)

    def tearDown(self):
        shutil.rmtree(self.tmp)
        shutil.rmtree(self.scratch)

    def run_soak(self, home, **env):
        env = {**os.environ, "SOAK_HOME": home, "SOAK_BUILD": "0", "MINUTES": "0", "BIN": "/nonexistent", **env}
        return subprocess.run(["sh", SCRIPT], env=env, capture_output=True, text=True, timeout=60)

    def assert_refused(self, home):
        r = self.run_soak(home)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("refused", r.stderr)
        self.assertNotIn("no binary", r.stderr)  # refused before anything else

    def test_home_outside_scratch_is_refused(self):
        self.assert_refused(os.path.join(self.tmp, "h"))
        self.assertEqual(os.listdir(self.tmp), [])

    def test_nunchiro_named_home_in_scratch_is_refused(self):
        # A `.nunchiro*` folder makes the core open links for real (opener.rs), so the record opener would not hold.
        self.assert_refused(os.path.join(self.scratch, ".nunchiro-x"))

    def test_dot_dot_out_of_scratch_is_refused(self):
        self.assert_refused(".scratch/../soak-escape")
        self.assertFalse(os.path.exists(os.path.join(ROOT, "soak-escape")))

    def test_symlink_in_scratch_to_outside_is_refused(self):
        link = os.path.join(self.scratch, "link")
        os.symlink(self.tmp, link)
        self.assert_refused(os.path.join(link, "h"))
        self.assertEqual(os.listdir(self.tmp), [])

    def test_scratch_itself_is_refused(self):
        self.assert_refused(".scratch")

    def test_every_call_gets_the_isolated_env(self):
        fake = os.path.join(self.tmp, "nunchiro")
        with open(fake, "w") as f:
            f.write(FAKE)
        os.chmod(fake, 0o755)
        home = os.path.join(self.scratch, "h")
        if len(os.path.realpath(home)) >= 90:  # soak.sh refuses a home whose core.sock would not fit (its own rule)
            self.assertIn("too long for core.sock", self.run_soak(home, BIN=fake).stderr)
            self.skipTest("checkout path too deep for soak.sh's home rule; the refusal above was checked")
        r = self.run_soak(home, BIN=fake, RUNNING="2", HOME="/elsewhere", NUNCHIRO_HOME="/elsewhere/.nunchiro",
                          NUNCHIRO_TOKEN="t", NUNCHIRO_SESSION="s")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        calls = [open(os.path.join(home, f)).read() for f in os.listdir(home) if f.startswith("call.")]
        self.assertGreaterEqual(len(calls), 6, calls)  # serve, status, 2 starts, snapshot, 2 closes, stop, status
        for call in calls:
            lines = call.splitlines()
            self.assertIn("HOME=" + os.path.join(home, "home"), lines, lines[0])
            self.assertIn("NUNCHIRO_HOME=" + home, lines, lines[0])
            self.assertIn("NUNCHIRO_TEST_OPENER=record", lines, lines[0])
            self.assertFalse([l for l in lines if l.startswith(("NUNCHIRO_TOKEN=", "NUNCHIRO_SESSION="))], lines[0])
        self.assertIn("| 0 |", r.stdout)

    def test_syntax(self):
        self.assertEqual(subprocess.run(["sh", "-n", SCRIPT]).returncode, 0)


if __name__ == "__main__":
    unittest.main()
