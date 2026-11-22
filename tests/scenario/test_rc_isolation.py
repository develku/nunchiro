"""V2.5-34 (owner 2026-11-05, safety-cost ledger P3): the release-candidate build runs next to the owner's own Nunchiro.app and
never shares its data. WebKit keeps storage under ~/Library/WebKit/<CFBundleIdentifier>, so a bundle id of its own
isolates localStorage and IndexedDB; the core home comes from the compiled identifier in app/src-tauri/src/main.rs
(`home_for`, unit tests `rc_home_is_not_owner_home` and `normal_build_identity_unchanged`, run by scripts/check-app.sh).
The *_built_app tests check an RC made by scripts/build-rc.sh and skip without one."""
import json
import os
import plistlib
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TAURI = ROOT / "app/src-tauri"
SCRIPT = ROOT / "scripts/build-rc.sh"
RC_APP = ROOT / ".scratch/rc/Nunchiro RC.app"
OWNER_ID = "dev.nunchiro.app"
RC_ID = "dev.nunchiro.app.rc"


def conf(name):
    return json.loads((TAURI / name).read_text())


class RcIsolation(unittest.TestCase):
    def test_rc_bundle_identifier_differs(self):
        rc = conf("tauri.rc.conf.json")
        self.assertEqual(rc["identifier"], RC_ID)
        self.assertEqual(rc["productName"], "Nunchiro RC")
        # The script builds with this overlay, nothing else changes the identity.
        self.assertIn("--config src-tauri/tauri.rc.conf.json", SCRIPT.read_text())

    def test_rc_bundle_identifier_differs_in_built_app(self):
        plist = RC_APP / "Contents/Info.plist"
        if not plist.is_file():
            self.skipTest("no RC build; run scripts/build-rc.sh")
        info = plistlib.loads(plist.read_bytes())
        self.assertEqual(info["CFBundleIdentifier"], RC_ID)
        self.assertEqual(info["CFBundleName"], "Nunchiro RC")

    def test_rc_home_is_not_owner_home_in_built_app(self):
        """The window binary picks its home from the identifier it was compiled with: it must be the RC's, and it must
        carry its own CLI, since a CLI found on PATH is the owner's install."""
        macos = RC_APP / "Contents/MacOS"
        if not (macos / "nunchiro-app").is_file():
            self.skipTest("no RC build; run scripts/build-rc.sh")
        self.assertIn(RC_ID.encode(), (macos / "nunchiro-app").read_bytes())
        self.assertTrue(os.access(macos / "nunchiro", os.X_OK))

    def test_normal_build_identity_unchanged(self):
        base = conf("tauri.conf.json")
        self.assertEqual(base["identifier"], OWNER_ID)
        self.assertEqual(base["productName"], "Nunchiro")
        self.assertFalse(base["bundle"]["active"])
        # The overlay is identity and bundling only, so the RC is the same app otherwise.
        self.assertEqual(set(conf("tauri.rc.conf.json")), {"identifier", "productName", "bundle", "plugins"})

    def test_build_rc_refuses_owner_app_path(self):
        """A .scratch or .scratch/rc that leads to where the owner's app lives is refused before anything is built or made.
        The script runs from a copy in a fake checkout, with a PATH that has no pnpm or cargo, so it cannot build."""
        (ROOT / ".scratch").mkdir(exist_ok=True)
        owner_dirs = [Path("/Applications"), Path.home() / "Applications"]
        for link in (".scratch", ".scratch/rc"):
            for target in owner_dirs:
                with self.subTest(link=link, target=str(target)):
                    fake = Path(tempfile.mkdtemp(prefix="rc-refuse-", dir=ROOT / ".scratch"))
                    try:
                        (fake / "scripts").mkdir()
                        shutil.copy2(SCRIPT, fake / "scripts/build-rc.sh")
                        (fake / link).parent.mkdir(parents=True, exist_ok=True)
                        (fake / link).symlink_to(target)
                        before = target.exists()
                        p = subprocess.run(["/bin/sh", str(fake / "scripts/build-rc.sh")], capture_output=True,
                                           text=True, env={"PATH": "/usr/bin:/bin", "HOME": str(Path.home())},
                                           timeout=30)
                        self.assertNotEqual(p.returncode, 0, p.stdout)
                        self.assertIn("refused", p.stderr)
                        self.assertEqual(p.stdout, "")
                        self.assertEqual(target.exists(), before)  # a missing ~/Applications was not made
                    finally:
                        shutil.rmtree(fake)


if __name__ == "__main__":
    unittest.main()
