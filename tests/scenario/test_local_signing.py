"""scripts/test-local-signing.sh in the gate (needs 213, ticket 295 review SHOULD 2): `create` and `sign` of
scripts/local-signing.sh against stub security, codesign and openssl. The script builds its sandboxes under .scratch/ and
removes them on success; it never touches a real keychain."""
import os
import subprocess
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


class LocalSigning(unittest.TestCase):
    def test_local_signing(self):
        r = subprocess.run(["sh", os.path.join(ROOT, "scripts", "test-local-signing.sh")], capture_output=True, text=True,
                           timeout=300)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotIn("FAIL", r.stdout)


if __name__ == "__main__":
    unittest.main()
