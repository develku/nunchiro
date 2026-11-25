"""THIRD_PARTY_NOTICES.md names every lifted file that carries an upstream MIT notice (needs 141, 148): ticket 297 item 8
found `web/src/tree/AgentLogo.tsx` missing from the table."""
import json
import os
import re
import subprocess
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


def rows():
    with open(os.path.join(ROOT, "THIRD_PARTY_NOTICES.md"), encoding="utf-8") as f:
        return [l for l in f.read().splitlines() if l.startswith("| `")]


class Notices(unittest.TestCase):
    def test_third_party_notices_lists_agent_logo(self):
        # The row names the file, both Orca sources, the lift-map pin and the licence holder.
        row = next((r for r in rows() if r.startswith("| `web/src/tree/AgentLogo.tsx`")), None)
        self.assertIsNotNone(row, "no row for web/src/tree/AgentLogo.tsx")
        for want in ("status-bar/icons.tsx", "agent-catalog.tsx", "`2eb0bb63` (lift-map pin)", "MIT, Copyright (c) 2026 Lovecast Inc."):
            self.assertIn(want, row)
        self.assertEqual(len(re.findall(r"\|", row)) - len(re.findall(r"\\\|", row)), 6)  # five columns

    def test_tracked_plugin_manifests_name_mit(self):
        # A manifest without "license" ships the plugin with no stated terms (scorecard L1).
        out = subprocess.run(["git", "ls-files", "*plugin.json"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
        self.assertTrue(out, "no tracked plugin.json")
        for path in out:
            with open(os.path.join(ROOT, path), encoding="utf-8") as f:
                self.assertEqual(json.load(f).get("license"), "MIT", path)


if __name__ == "__main__":
    unittest.main()
