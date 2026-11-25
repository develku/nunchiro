"""scripts/build-release.sh end to end against stub build, signing and upload tools (ticket 1130 B2). The script and
scripts/supply-chain.sh run in a temp git repo with a temp HOME; every outside tool (pnpm, cargo, codesign, xcrun, spctl,
hdiutil, gh) is a stub that logs its arguments. sandbox-exec is the real one. Nothing is built, signed, notarized or
uploaded, and nothing is fetched."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.nunchiro.app</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
</dict></plist>
"""

NPM_TREE = '[{"name":"web","dependencies":{"react":{"version":"19.0.0","dependencies":{"scheduler":{"version":"0.25.0"}}}}}]'

# Each stub appends "<name> <args>" to $STUB_LOG, then makes the files the real tool would make.
# $STUB_CYCLONEDX: "" writes every crate SBOM; "none" writes none (exit 0); "attack" also tries to read the update key
# into $STUB_LEAK and to replace the built CLI under $STUB_TARGET, as a compromised SBOM tool would.
STUBS = {
    "pnpm": r'''
case "$*" in
  --version) [ -n "$STUB_PNPM_VERSION_FAIL" ] && { echo version-failed >&2; exit 24; }; echo 10.33.0 ;;
  "list "*) echo "$STUB_NPM_TREE" ;;
  *"tauri signer generate"*)
    while [ $# -gt 0 ]; do [ "$1" = -w ] && { echo key > "$2"; echo pub > "$2.pub"; }; shift; done ;;
  *"tauri signer sign"*)
    for a; do f=$a; done; echo sig > "$f.sig" ;;
  *"tauri build"*)
    b=$CARGO_TARGET_DIR/release/bundle/macos/Nunchiro.app
    mkdir -p "$b/Contents/MacOS" "$b/Contents/Resources"
    cp "$STUB_PLIST" "$b/Contents/Info.plist"
    echo app > "$b/Contents/MacOS/nunchiro-app"
    echo licence > "$b/Contents/Resources/LICENSE"
    echo notices > "$b/Contents/Resources/THIRD_PARTY_NOTICES.md" ;;
esac
''',
    "cargo": r'''
case "$1" in
  build) mkdir -p "$CARGO_TARGET_DIR/release"; echo cli > "$CARGO_TARGET_DIR/release/nunchiro" ;;
  cyclonedx)
    [ "$2" = --version ] && exit 0
    if [ "$STUB_CYCLONEDX" = attack ]; then
      cat "$HOME/.config/nunchiro-release/updater.key" >> "$STUB_LEAK" 2>/dev/null
      echo evil > "$STUB_TARGET/release/nunchiro" 2>/dev/null
    fi
    [ "$STUB_CYCLONEDX" = none ] && exit 0
    m=$3
    if [ "$m" = Cargo.toml ]; then dirs="crates/nunchiro crates/nunchiro-core"; else dirs=$(dirname "$m"); fi
    for d in $dirs; do echo '{"bomFormat":"CycloneDX","components":[{"name":"serde"}]}' > "$d/supply-chain-sbom.json"; done ;;
esac
''',
    "xcrun": r'''
case "$1 $2" in
  "notarytool submit") echo "  id: sub-$$"; case "$*" in *--wait*) echo "  status: Accepted" ;; esac ;;
  "notarytool wait") echo "  status: Accepted" ;;
esac
''',
    "hdiutil": r'''
for a; do f=$a; done; echo dmg > "$f"
''',
    "npx": "exit 1", "codesign": "", "spctl": "", "gh": "",
    # $STUB_GIT_FAIL makes the Cargo.toml inventory fail; every other git call goes to the real git
    "git": r'''
[ "$1" = ls-files ] && [ -n "$STUB_GIT_FAIL" ] && { echo ls-files-failed >&2; exit 23; }
exec "$REAL_GIT" "$@"
''',
}


def read(path):
    with open(path) as f:
        return f.read()


def put(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def git(cwd, *args):
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=cwd, check=True, capture_output=True)


class Fixture:
    """A temp repo with both scripts, a temp HOME and the stubs; run() runs build-release.sh there."""

    def __init__(self, cyclonedx=""):
        self.tmp = tempfile.TemporaryDirectory()
        t = os.path.realpath(self.tmp.name)  # the script works on pwd -P paths; /var is a symlink on macOS
        self.repo, home, stubs = os.path.join(t, "repo"), os.path.join(t, "home"), os.path.join(t, "bin")
        os.makedirs(os.path.join(self.repo, "scripts"))
        for f in ("build-release.sh", "supply-chain.sh"):
            shutil.copy(os.path.join(ROOT, "scripts", f), os.path.join(self.repo, "scripts", f))
        put(os.path.join(self.repo, "app", "src-tauri", "tauri.conf.json"), '{"version": "0.1.0"}')
        put(os.path.join(self.repo, "Cargo.toml"), "[workspace]\n")
        for m in ("crates/nunchiro/Cargo.toml", "crates/nunchiro-core/Cargo.toml", "app/src-tauri/Cargo.toml"):
            put(os.path.join(self.repo, m), "[package]\n")
        put(os.path.join(self.repo, "pnpm-lock.yaml"), "")
        put(os.path.join(self.repo, ".gitignore"), ".scratch/\n")
        git(self.repo, "init", "-q")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-qm", "fixture")
        self.log_path, self.leak = os.path.join(t, "stub.log"), os.path.join(t, "leak")
        put(os.path.join(t, "Info.plist"), PLIST)
        for name, body in STUBS.items():
            p = os.path.join(stubs, name)
            put(p, '#!/bin/sh\necho "%s $*" >> "$STUB_LOG"\n%s' % (name, body))
            os.chmod(p, 0o755)
        os.makedirs(home)
        self.key = os.path.join(home, ".config", "nunchiro-release", "updater.key")
        env = {k: v for k, v in os.environ.items() if not k.startswith(("NUNCHIRO_", "CARGO_", "TAURI_", "APPLE_"))}
        env.update(HOME=home, PATH=stubs + os.pathsep + env["PATH"], STUB_LOG=self.log_path, STUB_LEAK=self.leak,
                   STUB_PLIST=os.path.join(t, "Info.plist"), STUB_NPM_TREE=NPM_TREE, STUB_CYCLONEDX=cyclonedx,
                   STUB_TARGET=os.path.join(self.repo, ".scratch", "release", "target"),
                   REAL_GIT=shutil.which("git"))
        self.env = env
        self.dest = os.path.join(self.repo, ".scratch", "release", "prerelease")

    def run(self, *args):
        return subprocess.run(["sh", "scripts/build-release.sh", "prerelease", *args], cwd=self.repo, env=self.env,
                              capture_output=True, text=True, timeout=120)

    def log(self):
        return read(self.log_path).splitlines() if os.path.exists(self.log_path) else []

    def close(self):
        self.tmp.cleanup()


class BuildRelease(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = Fixture()
        cls.run_ = cls.fx.run("--publish")
        cls.dest, cls.log = cls.fx.dest, cls.fx.log()

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def setUp(self):
        self.assertEqual(self.run_.returncode, 0, self.run_.stdout + self.run_.stderr)

    def upload(self):
        return [l for l in self.log if l.startswith("gh release create v")]

    def test_release_carries_sbom(self):
        """R2 (p29 SC4): the CycloneDX SBOMs sit beside the archive and are uploaded with it."""
        names = sorted(f for f in os.listdir(self.dest) if f.endswith(".cdx.json"))
        self.assertEqual(names, ["sbom-npm.cdx.json", "sbom-rust-app.cdx.json", "sbom-rust-nunchiro-core.cdx.json",
                                 "sbom-rust-nunchiro.cdx.json"])
        for n in names:
            self.assertTrue(json.loads(read(os.path.join(self.dest, n)))["components"], n)
        npm = json.loads(read(os.path.join(self.dest, "sbom-npm.cdx.json")))
        self.assertEqual(npm["bomFormat"], "CycloneDX")
        self.assertEqual([c["purl"] for c in npm["components"]], ["pkg:npm/react@19.0.0", "pkg:npm/scheduler@0.25.0"])
        # made from the built commit: after the build, before signing
        build = next(i for i, l in enumerate(self.log) if l.startswith("cargo build"))
        sbom = next(i for i, l in enumerate(self.log) if l.startswith("cargo cyclonedx --manifest-path"))
        sign = next(i for i, l in enumerate(self.log) if l.startswith("codesign"))
        self.assertLess(build, sbom)
        self.assertLess(sbom, sign)
        self.assertTrue(all(os.path.join(self.dest, n) in self.upload()[0] for n in names), self.upload())

    def test_no_tool_fetched_at_build_time(self):
        """Security review finding 1: no npx (or any download of an SBOM tool) in the release run."""
        self.assertEqual([l for l in self.log if l.startswith("npx")], [])

    def test_release_makes_dmg(self):
        """P3 (p02): a DMG of the stapled app, itself signed, notarized and stapled, uploaded with the release."""
        dmg = os.path.join(self.dest, "Nunchiro.dmg")
        self.assertTrue(os.path.isfile(dmg))
        create = [l for l in self.log if l.startswith("hdiutil create")]
        self.assertEqual(len(create), 1, self.log)
        self.assertTrue(create[0].endswith(" " + dmg), create)

        def at(prefix):
            return next(i for i, l in enumerate(self.log) if l.startswith(prefix))
        # the app is stapled before it goes into the DMG; the DMG is signed, notarized, then stapled
        self.assertLess(at("xcrun stapler staple " + os.path.join(self.dest, "Nunchiro.app")), at("hdiutil create"))
        self.assertLess(at("hdiutil create"), at("codesign --force --timestamp -s Developer ID Application " + dmg))
        self.assertLess(at("codesign --force --timestamp -s Developer ID Application " + dmg),
                        at("xcrun notarytool submit " + dmg))
        self.assertLess(at("xcrun notarytool submit " + dmg), at("xcrun stapler staple " + dmg))
        self.assertIn("--wait", self.log[at("xcrun notarytool submit " + dmg)])
        self.assertIn(dmg, self.upload()[0])
        self.assertFalse(os.path.exists(os.path.join(self.dest, "dmg")), "the DMG staging folder is left behind")


class FailClosed(unittest.TestCase):
    """Security review 1130: the SBOM step cannot reach signing material, and an incomplete SBOM set stops the release."""

    def fixture(self, **kw):
        fx = Fixture(**kw)
        self.addCleanup(fx.close)
        return fx

    def test_sbom_tool_cannot_read_key_or_change_binary(self):
        fx = self.fixture(cyclonedx="attack")
        r = fx.run()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(os.path.isfile(fx.key))
        self.assertNotIn("key", read(fx.leak) if os.path.exists(fx.leak) else "", "the SBOM step read the update key")
        self.assertEqual(read(os.path.join(fx.dest, "Nunchiro.app", "Contents", "MacOS", "nunchiro")), "cli\n",
                         "the SBOM step replaced the binary that is signed")

    def test_missing_rust_sbom_stops_release(self):
        fx = self.fixture(cyclonedx="none")
        r = fx.run("--publish")
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("sbom-rust-nunchiro.cdx.json: missing", r.stderr)
        log = fx.log()
        self.assertEqual([l for l in log if l.startswith(("codesign", "xcrun", "gh"))], [], log)

    def test_finish_checks_sbom_set(self):
        fx = self.fixture()
        r = fx.run()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        os.remove(os.path.join(fx.dest, "sbom-rust-app.cdx.json"))
        before = len(fx.log())
        r = fx.run("--finish", "--publish")
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("sbom-rust-app.cdx.json: missing", r.stderr)
        self.assertEqual([l for l in fx.log()[before:] if l.startswith(("xcrun", "gh", "hdiutil"))], [])

    def signed_or_uploaded(self, lines):
        return [l for l in lines if l.startswith(("codesign", "xcrun", "hdiutil", "gh"))]

    def test_failed_inventory_stops_release(self):
        """Security review 1130 round 2, finding 1: a failed git ls-files stops a fresh release before signing."""
        fx = self.fixture()
        fx.env["STUB_GIT_FAIL"] = "1"
        r = fx.run("--publish")
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("git ls-files Cargo.toml", r.stderr)
        self.assertEqual(self.signed_or_uploaded(fx.log()), [])

    def test_failed_inventory_stops_sbom_check_and_finish(self):
        """Finding 1: with every Rust SBOM gone and the inventory failing, --sbom-check and --finish both stop."""
        fx = self.fixture()
        r = fx.run()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        for n in os.listdir(fx.dest):
            if n.startswith("sbom-rust-"):
                os.remove(os.path.join(fx.dest, n))
        fx.env["STUB_GIT_FAIL"] = "1"
        r = subprocess.run(["sh", "scripts/supply-chain.sh", "--sbom-check", fx.dest], cwd=fx.repo, env=fx.env,
                           capture_output=True, text=True, timeout=60)
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("git ls-files Cargo.toml: exit 23", r.stderr)
        before = len(fx.log())
        r = fx.run("--finish", "--publish")
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("git ls-files Cargo.toml: exit 23", r.stderr)
        self.assertEqual(self.signed_or_uploaded(fx.log()[before:]), [])

    def test_failed_pnpm_version_stops_release(self):
        """Finding 2: a failed pnpm --version fails the npm SBOM and stops the release before signing."""
        fx = self.fixture()
        fx.env["STUB_PNPM_VERSION_FAIL"] = "1"
        r = fx.run("--publish")
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("pnpm --version: exit 24: version-failed", r.stderr)
        self.assertEqual(self.signed_or_uploaded(fx.log()), [])

    def test_shellcheck_clean(self):
        """Security review: SC2115 at the DMG cleanup; both release scripts stay ShellCheck clean."""
        if not shutil.which("shellcheck"):
            self.skipTest("shellcheck not installed")
        r = subprocess.run(["shellcheck", "--shell=sh", "scripts/build-release.sh", "scripts/supply-chain.sh"],
                           cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout)


if __name__ == "__main__":
    unittest.main()
