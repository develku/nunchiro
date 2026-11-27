"""Real-agent scenario homes and projects live outside any git repository: Claude Code asks whether to trust an
--add-dir folder (the core adds <home>/artifacts) or a project that sits in a repo, and scenarios never answer."""
import os
import re
import shutil
import subprocess
import sys
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
sys.path.insert(0, os.path.join(ROOT, "scripts", "scenario"))
import lib  # noqa: E402

SCRIPTS = ["scripts/scenario/v1b-chat.sh", "scripts/scenario/v1b-images.sh", "scripts/scenario/v1b-artifact-skill.sh",
           "scripts/scenario/v1b_full.py", "scripts/measure/accuracy.py"]


def in_repo(path):
    return subprocess.run(["git", "-C", path, "rev-parse", "--git-dir"], capture_output=True).returncode == 0


class Homes(unittest.TestCase):
    def test_scenario_home_is_private_and_outside_any_repo(self):
        home = lib.scenario_home("t")
        self.addCleanup(shutil.rmtree, home, True)
        self.assertTrue(os.path.isdir(home))
        self.assertEqual(os.stat(home).st_mode & 0o777, 0o700)
        self.assertFalse(in_repo(str(home)), home)
        self.assertLess(len(str(home / "core.sock").encode()), 104)

    def test_trusted_project_root_is_outside_any_repo(self):
        os.makedirs(lib.TRUSTED_CWD, exist_ok=True)
        self.assertFalse(in_repo(lib.TRUSTED_CWD), lib.TRUSTED_CWD)

    def test_real_agent_scripts_use_them(self):
        for rel in SCRIPTS:
            with open(os.path.join(ROOT, rel)) as f:
                text = f.read()
            self.assertTrue("scenario_home(" in text, rel)
            # No throwaway home or default project root under the checkout's .scratch.
            self.assertIsNone(re.search(r"""\.scratch['"]\)?\s*/\s*\(['"]\w+['"]\s*\+""", text), rel)
            self.assertIsNone(re.search(r"""PROJECT_ROOT['"],\s*str\(root / ['"]\.scratch""", text), rel)
            self.assertNotIn('"--project-root", default=str(ROOT / ".scratch")', text, rel)


if __name__ == "__main__":
    unittest.main()
