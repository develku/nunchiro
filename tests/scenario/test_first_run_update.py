"""docs/first-run.md "Update" matches the app (scorecard p02 RR4, ticket 1130 P1). Since ticket 1082 the installed app
updates itself from the update folder; the guide said "It is a manual reinstall; nothing updates itself."
"""
import os
import re
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


def read(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as f:
        return f.read()


def section():
    m = re.search(r"^## Update\n(.*?)(?=^## )", read("docs/first-run.md"), re.S | re.M)
    assert m, "docs/first-run.md has no '## Update' section"
    return m.group(1)


class FirstRunUpdate(unittest.TestCase):
    def test_update_section_describes_self_update(self):
        text = section()
        self.assertNotIn("nothing updates itself", text)
        self.assertIn("Settings > About", text)
        # The labels the guide quotes are the app's own English strings, so a renamed label fails here.
        strings = read("web/src/i18n/areas/self-update.ts")
        for key in ("selfUpdate.folder", "selfUpdate.install"):
            label = re.search(r"'%s': '([^']+)'" % re.escape(key), strings).group(1)
            self.assertIn(label, text, key)
        ready = re.search(r"'selfUpdate.ready': '([^']+)'", strings).group(1).replace("{version}", "<version>")
        self.assertIn(ready, text)


if __name__ == "__main__":
    unittest.main()
