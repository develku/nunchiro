"""Ticket 1130 C9 (p26 MD1): scripts/test.sh runs a check outside the session's process tree, and
scripts/cargo-test-gate.sh goes through it inside a session. No network, no cargo: a fake cargo stands in."""
import os
import signal
import subprocess
import tempfile
import time
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
TEST_SH = os.path.join(ROOT, "scripts", "test.sh")
GATE = os.path.join(ROOT, "scripts", "cargo-test-gate.sh")
SESSION = dict(NUNCHIRO_SESSION="s-1", NUNCHIRO_TOKEN="t-1", NUNCHIRO_ARTIFACTS="/nowhere", NUNCHIRO_HOME="/owner-home")
# What the command reports: the session variables it still sees, and its parent's parent (1: launchd).
PROBE = 'echo "session=${NUNCHIRO_SESSION:-none} token=${NUNCHIRO_TOKEN:-none} art=${NUNCHIRO_ARTIFACTS:-none} home=${NUNCHIRO_HOME:-none} keep=${KEEP:-none}"; echo "grandparent=$(ps -o ppid= -p $PPID | tr -d " ")"'


def env(**extra):
    e = {k: v for k, v in os.environ.items() if not k.startswith(("NUNCHIRO_", "GATE_"))}
    e.update(extra)
    return e


class TestSh(unittest.TestCase):
    def test_drops_the_session_and_leaves_its_process_tree(self):
        p = subprocess.run(["sh", TEST_SH, "sh", "-c", PROBE + "; exit 3"], env=env(KEEP="yes", **SESSION),
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(p.returncode, 3, p.stdout + p.stderr)
        self.assertIn("session=none token=none art=none home=none keep=yes", p.stdout)
        self.assertIn("grandparent=1\n", p.stdout)
        p = subprocess.run(["sh", TEST_SH, "sh", "-c", "echo out; echo err >&2"], env=env(), capture_output=True, text=True, timeout=30)
        self.assertEqual((p.stdout, p.stderr), ("out\n", "err\n"))

    def test_a_missing_command_is_127_and_no_command_is_usage(self):
        p = subprocess.run(["sh", TEST_SH, "no-such-command-1130"], env=env(), capture_output=True, text=True, timeout=30)
        self.assertEqual(p.returncode, 127)
        self.assertIn("no-such-command-1130", p.stderr)
        self.assertEqual(subprocess.run(["sh", TEST_SH], env=env(), capture_output=True).returncode, 2)

    def assert_gone(self, pid, why):
        # A zombie may wait a moment for launchd to reap it, hence the short poll.
        for _ in range(30):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.1)
        os.kill(pid, signal.SIGKILL)  # only our own probe
        self.fail(f"{pid} still ran {why}")

    def cancel(self, script, sig=signal.SIGTERM):
        p = subprocess.Popen(["sh", TEST_SH, "sh", "-c", script], env=env(), stdout=subprocess.PIPE, text=True)
        child = int(p.stdout.readline())
        os.kill(p.pid, sig)
        rc = p.wait(timeout=20)
        p.stdout.close()
        return rc, child

    def test_term_stops_its_own_command(self):
        rc, child = self.cancel("echo $$; exec sleep 60")
        self.assertEqual(rc, 128 + signal.SIGTERM)
        self.assert_gone(child, "after test.sh got TERM")

    def test_a_command_that_ignores_term_is_killed_before_test_sh_returns(self):
        t0 = time.monotonic()
        rc, child = self.cancel("trap '' TERM; echo $$; exec sleep 60")
        self.assertEqual(rc, 128 + signal.SIGTERM)
        self.assertGreaterEqual(time.monotonic() - t0, 4)  # it got the grace time, then KILL
        self.assert_gone(child, "after test.sh returned from TERM")

    def test_kill_of_test_sh_still_stops_the_command(self):
        rc, child = self.cancel("echo $$; exec sleep 60", signal.SIGKILL)
        self.assertEqual(rc, -signal.SIGKILL)
        self.assert_gone(child, "after test.sh was killed")

    def test_the_real_exit_counts_not_the_end_of_output(self):
        with tempfile.TemporaryDirectory() as d:
            pids = os.path.join(d, "pids")
            # A background child keeps the output open; the command closes its own and runs on.
            script = 'sleep 60 & echo "$$ $!" > "$1"; exec >&- 2>&-; sleep 2; exit 5'
            t0 = time.monotonic()
            p = subprocess.run(["sh", TEST_SH, "sh", "-c", script, "sh", pids], env=env(), capture_output=True, text=True,
                               timeout=30)
            self.assertEqual(p.returncode, 5, p.stderr)
            self.assertGreaterEqual(time.monotonic() - t0, 2)
            with open(pids) as f:
                for pid in map(int, f.read().split()):
                    self.assert_gone(pid, "after test.sh returned")


@unittest.skipUnless(os.path.isfile(GATE), "the public export has no scripts/cargo-test-gate.sh (ticket 1135)")
class GateInASession(unittest.TestCase):
    def run_gate(self, **extra):
        with tempfile.TemporaryDirectory() as d:
            b = os.path.join(d, "bin")
            os.mkdir(b)
            with open(os.path.join(b, "cargo"), "w") as f:
                f.write("#!/bin/sh\n" + PROBE + "\n")
            os.chmod(os.path.join(b, "cargo"), 0o755)
            e = env(GATE_RUNNER="cargo", GATE_ROOT=d, PATH=b + os.pathsep + os.environ["PATH"], **extra)
            return subprocess.run(["sh", GATE], env=e, capture_output=True, text=True, timeout=60)

    def test_the_gate_runs_outside_the_session_when_it_sees_one(self):
        p = self.run_gate(**SESSION)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("session=none token=none art=none home=none", p.stdout)
        self.assertIn("grandparent=1\n", p.stdout)

    def test_outside_a_session_the_gate_runs_in_place(self):
        p = self.run_gate()
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertNotIn("grandparent=1\n", p.stdout)  # a whole line: "grandparent=14480" is not pid 1


if __name__ == "__main__":
    unittest.main()
