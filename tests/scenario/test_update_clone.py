"""scripts/test-update-clone.sh in the gate (ticket 1082 part B, round 2): the clone takes main from the named repository
and reads no git config or hook of the caller's. Throwaway repositories only; no network, key or keychain."""
import os
import subprocess
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


class UpdateClone(unittest.TestCase):
    def test_update_clone(self):
        r = subprocess.run(["sh", os.path.join(ROOT, "scripts", "test-update-clone.sh")], capture_output=True,
                           text=True, timeout=300)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotIn("FAIL", r.stdout)


if __name__ == "__main__":
    unittest.main()