"""scripts/check-serve-leak.sh against canned `ps` output (NS_LEAK_PS_FILE). No real process is touched."""
import os
import subprocess
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "check-serve-leak.sh")
BIN = "/w/herdr-x/target/debug/nunchiro"


class CheckServeLeak(unittest.TestCase):
    def run_ps(self, text):
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, "ps.txt")
            with open(f, "w") as h:
                h.write(text)
            return subprocess.run(
                ["sh", SCRIPT], env={**os.environ, "NS_LEAK_PS_FILE": f}, capture_output=True, text=True
            )

    def test_leaked_serve_with_a_temp_ns_home_fails_and_names_its_pid(self):
        r = self.run_ps(f"  4242     1 {BIN} serve PATH=/usr/bin NUNCHIRO_HOME=/var/folders/x/T/ns-foo-123-0 HOME=/h\n")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("4242", r.stdout)
        self.assertIn("/var/folders/x/T/ns-foo-123-0", r.stdout)

    def test_serve_whose_parent_is_alive_is_a_running_test_not_a_leak(self):
        r = self.run_ps(f"  4242 {os.getpid()} {BIN} serve NUNCHIRO_HOME=/var/folders/x/T/ns-foo-123-0\n")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_serve_whose_parent_is_gone_fails(self):
        gone = subprocess.Popen(["true"])
        gone.wait()
        r = self.run_ps(f"  4242 {gone.pid} {BIN} serve NUNCHIRO_HOME=/var/folders/x/T/ns-foo-123-0\n")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)

    def test_serve_with_a_home_under_scratch_passes(self):
        r = self.run_ps(f"  4242     1 {BIN} serve NUNCHIRO_HOME=/w/herdr-x/.scratch/ns-foo-1-0\n")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_other_process_with_an_ns_home_passes(self):
        r = self.run_ps("  4243  4242 /bin/sh -c sleep NUNCHIRO_HOME=/var/folders/x/T/ns-foo-123-0\n")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_empty_ps_passes(self):
        self.assertEqual(self.run_ps("").returncode, 0)

    def test_syntax(self):
        self.assertEqual(subprocess.run(["sh", "-n", SCRIPT]).returncode, 0)


if __name__ == "__main__":
    unittest.main()
