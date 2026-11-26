"""ticket 291 items 3-4 (needs 210): the overlap and no-op click checks and the removal-round list.
The browser parts live in web/tests/overlap-check.spec.ts and web/tests/noop-click-check.spec.ts; these tests guard the scripts around
them, the removal-round generator, and (UX_CHECKS_OLD_BUILD=1) prove both checks on the bad build RC2c ff220558 in a worktree."""
import os
import subprocess
import tempfile
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
SCRIPTS = os.path.join(ROOT, "scripts")
RC2C = "ff220558"


def put(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def sh(*args, env=None):
    return subprocess.run(["sh", *args], capture_output=True, text=True, env={**os.environ, **(env or {})}, timeout=120)


class RatchetScripts(unittest.TestCase):
    def test_scripts_parse(self):
        for name in ("overlap-check.sh", "noop-click-check.sh", "duplicate-surfaces.sh"):
            self.assertEqual(sh("-n", os.path.join(SCRIPTS, name)).returncode, 0, name)

    def ratchet(self, script, base_text, found_text):
        with tempfile.TemporaryDirectory() as d:
            put(os.path.join(d, "base"), base_text)
            put(os.path.join(d, "found"), found_text)
            return sh(os.path.join(SCRIPTS, script), os.path.join(d, "base"), os.path.join(d, "found"))

    def test_overlap_ratchet_prints_only_a_new_offender(self):
        old = "chat|900|div.cview>button.btn|div.chat>div.skipped\n"
        new = "chat|1440|div.a|div.b\n"
        self.assertEqual(self.ratchet("overlap-check.sh", old, old).returncode, 0)
        r = self.ratchet("overlap-check.sh", old, old + new)
        self.assertEqual(r.returncode, 1)
        self.assertIn(new.strip(), r.stderr)
        self.assertNotIn("skipped", r.stderr)
        self.assertEqual(self.ratchet("overlap-check.sh", old, "").returncode, 0)  # a fixed offender is fine

    def test_noop_ratchet_prints_only_a_new_offender(self):
        old = "decisions|div.dline>button.btn|Answer in Decisions\n"
        new = "board|div.x>button|Go\n"
        self.assertEqual(self.ratchet("noop-click-check.sh", old, old).returncode, 0)
        r = self.ratchet("noop-click-check.sh", old, old + new)
        self.assertEqual(r.returncode, 1)
        self.assertIn(new.strip(), r.stderr)
        self.assertNotIn("Answer in Decisions", r.stderr)
        self.assertEqual(sh(os.path.join(SCRIPTS, "noop-click-check.sh"), "only-one-arg").returncode, 2)


class RemovalRound(unittest.TestCase):
    def run_gen(self, d, table, files):
        for name, text in files.items():
            put(os.path.join(d, "root", name), text)
        put(os.path.join(d, "table.tsv"), table)
        out = os.path.join(d, "out", "page.md")
        r = sh(os.path.join(SCRIPTS, "duplicate-surfaces.sh"), env={"DUP_TABLE": os.path.join(d, "table.tsv"), "DUP_OUT": out, "DUP_ROOT": os.path.join(d, "root")})
        return r, out

    TABLE = "# comment\nstate A\tTree row\tweb/a.tsx\tlabelA\nstate A\tBoard card\tweb/b.tsx\tlabelB\naction B\tPalette\tweb/c.ts\tlabelC\n"
    FILES = {"web/a.tsx": "x labelA y", "web/b.tsx": "labelB", "web/c.ts": "labelC"}

    def test_duplicate_surface_list_generated(self):
        with tempfile.TemporaryDirectory() as d:
            r, out = self.run_gen(d, self.TABLE, self.FILES)
            self.assertEqual(r.returncode, 0, r.stderr)
            page = open(out).read()
            self.assertIn("## state A (2 places)", page)
            self.assertIn("## action B (1 places)", page)
            self.assertIn("- [ ] Tree row — `web/a.tsx` (`labelA`)", page)
            self.assertNotIn("STALE", page)

    def test_duplicate_surface_table_is_current(self):
        """The checked-in table: every file and label it names exists in this checkout, and the page lists every row."""
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "page.md")
            r = sh(os.path.join(SCRIPTS, "duplicate-surfaces.sh"), env={"DUP_OUT": out})
            self.assertEqual(r.returncode, 0, r.stderr)
            rows = [l for l in open(os.path.join(SCRIPTS, "duplicate-surfaces.tsv")) if l.strip() and not l.startswith("#")]
            self.assertGreaterEqual(len(rows), 10)
            self.assertEqual(sum(1 for l in open(out) if l.startswith("- [ ] ")), len(rows))

    def test_duplicate_surface_stale_row_fails(self):
        with tempfile.TemporaryDirectory() as d:
            r, out = self.run_gen(d, self.TABLE, {**self.FILES, "web/b.tsx": "the label was renamed"})
            self.assertEqual(r.returncode, 1)
            self.assertIn("stale row, web/b.tsx no longer holds 'labelB'", r.stderr)
            self.assertIn("**STALE**", open(out).read())
        with tempfile.TemporaryDirectory() as d:
            files = dict(self.FILES)
            del files["web/c.ts"]
            r, _ = self.run_gen(d, self.TABLE, files)
            self.assertEqual(r.returncode, 1)
            self.assertIn("stale row, web/c.ts is gone", r.stderr)
        with tempfile.TemporaryDirectory() as d:
            r, _ = self.run_gen(d, "state A\tonly three fields\tweb/a.tsx\n", self.FILES)
            self.assertEqual(r.returncode, 1)


@unittest.skipUnless(os.environ.get("UX_CHECKS_OLD_BUILD"), "UX_CHECKS_OLD_BUILD=1 builds RC2c in a worktree under .scratch/ and runs both specs there (about 15 minutes)")
class OldBuild(unittest.TestCase):
    """The overlap check, run against an empty baseline on the RC2c tree ff220558, lists the transcript note over the mode button (the no-op
    check's Answer-in-Decisions case could not be reproduced on that build, see REPORT; its test is synthetic, in the spec). The worktree
    is .scratch/rc2c-ux (made once, never the integration checkout); the specs and scripts are copied into it."""

    PORT = os.environ.get("UX_CHECKS_PORT", "4392")

    @classmethod
    def setUpClass(cls):
        cls.wt = os.path.join(ROOT, ".scratch", "rc2c-ux")
        if not os.path.isdir(cls.wt):
            subprocess.run(["git", "-C", ROOT, "worktree", "add", "--detach", cls.wt, RC2C], check=True, capture_output=True)
        web = os.path.join(cls.wt, "web")
        if not os.path.exists(os.path.join(web, "node_modules")):
            os.symlink(os.path.join(os.path.abspath(ROOT), "web", "node_modules"), os.path.join(web, "node_modules"))
        for rel in ("web/tests/ux-states.ts", "web/tests/overlap-check.spec.ts", "web/tests/noop-click-check.spec.ts", "scripts/overlap-check.sh", "scripts/noop-click-check.sh"):
            put(os.path.join(cls.wt, rel), open(os.path.join(ROOT, rel)).read())
        put(os.path.join(cls.wt, ".scratch", "empty.baseline"), "")
        cls.empty = os.path.join(cls.wt, ".scratch", "empty.baseline")

    def play(self, spec, grep, **env):
        env = {**os.environ, "NUNCHIRO_WEB_PORT": self.PORT, **env}
        env.pop("CARGO_TARGET_DIR", None)
        subprocess.run(["pnpm", "exec", "playwright", "test", "--project=chromium", "--workers=2", "--retries=0", spec, "-g", grep],
                       cwd=os.path.join(self.wt, "web"), env=env, capture_output=True, text=True, timeout=1500)

    def found(self, name):
        path = os.path.join(self.wt, ".scratch", name)
        return open(path).read().splitlines() if os.path.exists(path) else []

    def test_overlap_check_catches_transcript_note_over_mode_button(self):
        self.play("tests/overlap-check.spec.ts", "overlap_gate", OVERLAP_BASELINE=self.empty)
        lines = [l for l in self.found("overlap.found") if l.startswith("session-note|") and "div.skipped" in l and "div.cview>button.btn" in l]
        self.assertEqual({l.split("|")[1] for l in lines}, {"900", "1440"}, lines)


if __name__ == "__main__":
    unittest.main()
