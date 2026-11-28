"""docs/agents.md equals the text scripts/gen-agents-doc.py makes from known.toml (the doc cannot drift from the app)."""
import os
import subprocess
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


class AgentsDoc(unittest.TestCase):
    def test_doc_matches_known_list(self):
        out = subprocess.run(["python3", "-B", os.path.join(ROOT, "scripts/gen-agents-doc.py"), "--check"],
                             capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)


if __name__ == "__main__":
    unittest.main()
