"""Ticket 1130 A2 (TR1): Rust tests leave the default suite through a feature, never through #[ignore], and every one of
them runs in scripts/extended-tests.sh (the weekly run), so a slow or real-agent test is scheduled, not forgotten."""
import os
import pathlib
import re
import subprocess
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
# Only test functions count: a gated helper (owner_hardening refill, search_sessions rss_kib) has no #[test].
GATED = re.compile(r'#\[cfg\(feature = "(measure|live)"\)\]\s*(?:#\[[^\]]*\]\s*)*?#\[test\]\s*(?:#\[[^\]]*\]\s*)*fn (\w+)')
TARGET = re.compile(r'name = "(\w+)"\s*\npath = "[^"]*"\s*\nrequired-features = \["(measure|live)"\]')


def rust_files():
    out = subprocess.run(["git", "ls-files", "*.rs"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return [f for f in out.split() if os.path.isfile(os.path.join(ROOT, f))]


class RustNoIgnored(unittest.TestCase):
    def test_at_most_two_ignored(self):
        hits = [f"{f}:{n}" for f in rust_files() for n, l in enumerate(pathlib.Path(ROOT, f).read_text().splitlines(), 1)
                if l.lstrip().startswith("#[ignore")]
        self.assertLessEqual(len(hits), 2, hits)

    def test_every_gated_test_is_in_the_weekly_run(self):
        dry = subprocess.run(["sh", "scripts/extended-tests.sh"], cwd=ROOT, capture_output=True, text=True,
                             env=dict(os.environ, EXTENDED_DRY="1"))
        self.assertEqual(dry.returncode, 0, dry.stdout + dry.stderr)
        names = [(feat, name) for f in rust_files() for feat, name in GATED.findall(pathlib.Path(ROOT, f).read_text())]
        for toml in ("crates/nunchiro/Cargo.toml", "crates/nunchiro-core/Cargo.toml"):
            names += [(feat, name) for name, feat in TARGET.findall(pathlib.Path(ROOT, toml).read_text())]
        # The 11 tests of ticket 1130: 7 gated test functions and 2 whole targets (idle_cpu holds 3, chat_performance 1).
        self.assertGreaterEqual(len(names), 9, names)
        lines = dry.stdout.splitlines()
        # Whole name token, so a renamed test cannot match through a longer name.
        missing = [n for feat, n in names
                   if not any(re.search(rf"\b{n}\b", l) and f"--features {feat}" in l for l in lines)]
        self.assertEqual(missing, [], dry.stdout)

    def test_the_cli_is_built_before_the_tests_that_start_it(self):
        # search_sessions_perf_500mb runs cli::path(), the release nunchiro next to the test binary (ticket 1152 r2).
        lines = subprocess.run(["sh", "scripts/extended-tests.sh"], cwd=ROOT, capture_output=True, text=True,
                               env=dict(os.environ, EXTENDED_DRY="1")).stdout.splitlines()
        build = [i for i, l in enumerate(lines) if "cargo build --release --locked -p nunchiro" in l]
        user = [i for i, l in enumerate(lines) if "search_sessions_perf_500mb" in l]
        self.assertTrue(build and user and build[0] < user[0], lines)


if __name__ == "__main__":
    unittest.main()
