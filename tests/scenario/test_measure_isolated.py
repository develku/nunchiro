"""measure_copy_isolated (ticket 179): a measure run starts its app copy under its own bundle id and ad-hoc signature,
leaves the owner's WebKit store (dev.nunchiro.app) untouched, and removes the folders made for its id. A stand-in
executable (a copy of /usr/bin/true) takes the app's place; the real-app run is in the REPORT."""
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "measure"))
import measurelib as ml  # noqa: E402

OWNER = Path.home() / "Library/WebKit/dev.nunchiro.app"


class Isolated(unittest.TestCase):
    def test_copy_has_own_id_signature_and_cleanup(self):
        src = Path(tempfile.mkdtemp(prefix="ns-iso-")) / "nunchiro-app"
        shutil.copy("/usr/bin/true", src)
        before = OWNER.stat().st_mtime_ns if OWNER.exists() else None
        own = ml.OwnApp(src)
        try:
            self.assertNotEqual(own.bundle_id, "dev.nunchiro.app")
            plist = plistlib.loads((own.bundle / "Contents/Info.plist").read_bytes())
            self.assertEqual(plist["CFBundleIdentifier"], own.bundle_id)
            subprocess.run(["codesign", "--verify", "--deep", str(own.bundle)], check=True, capture_output=True)
            self.assertEqual(subprocess.run([str(own.exe)]).returncode, 0)
            self.assertTrue(all(own.bundle_id in str(d) for d in own.owned_dirs))
            made = own.owned_dirs[0]
            made.mkdir(parents=True)
        finally:
            own.remove()
            shutil.rmtree(src.parent, ignore_errors=True)
        self.assertFalse(made.exists())
        self.assertFalse(own.tmp.exists())
        self.assertEqual(OWNER.stat().st_mtime_ns if OWNER.exists() else None, before)

    def test_remove_ends_processes_started_from_the_copy(self):
        """w21-a: an app a script relaunched itself, or a core's holder, is not a child the script tracks; remove()
        still ends it before the copy goes."""
        src = Path(tempfile.mkdtemp(prefix="ns-iso-")) / "nunchiro-app"
        shutil.copy("/bin/sleep", src)
        own = ml.OwnApp(src)
        try:
            p = subprocess.Popen([str(own.exe), "30"], start_new_session=True)
            self.assertIn(p.pid, own._running())
        finally:
            own.remove()
            shutil.rmtree(src.parent, ignore_errors=True)
        self.assertEqual(p.wait(timeout=5), -15)
        self.assertFalse(own.tmp.exists())


if __name__ == "__main__":
    unittest.main()
