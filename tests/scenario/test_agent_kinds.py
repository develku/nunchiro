"""scripts/scenario/agent-kinds.sh --self-test: the real-turn runner against the fake ACP agent on a temp home. The record
says self_test: true and counts nothing, so a fake run can never stand in for a real kind."""
import json
import os
import re
import subprocess
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
BINARY = os.environ.get("NUNCHIRO_BIN") or os.path.join(os.environ.get("CARGO_TARGET_DIR") or os.path.join(ROOT, "target"), "debug", "nunchiro")


@unittest.skipUnless(os.access(BINARY, os.X_OK), "build first: cargo build -p nunchiro")
class AgentKinds(unittest.TestCase):
    def test_self_test_passes_and_is_marked(self):
        out = subprocess.run(["sh", os.path.join(ROOT, "scripts/scenario/agent-kinds.sh"), "--self-test"], cwd=ROOT,
                             capture_output=True, text=True, timeout=180, env={**os.environ, "NUNCHIRO_BIN": BINARY})
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertRegex(out.stdout, r"fake\s+.*yes\s+yes\s+yes\s+.*PASS")
        path = re.search(r"record: (\S+)", out.stdout).group(1)
        self.assertNotIn("docs/measure/evidence", path)
        with open(path) as f:
            record = json.load(f)
        os.remove(path)
        self.assertTrue(record["self_test"])
        self.assertEqual(record["counted"], 0)
        self.assertEqual(record["kinds"][0]["text"], "ready")


if __name__ == "__main__":
    unittest.main()
