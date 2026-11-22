"""scripts/app-click step plans (ticket 181 harness gaps): conformance.py and capture.py --dry-run list the ordered steps
and the controls each presses without starting an app; harness.App keeps the window frontmost around click and move."""
import os
import subprocess
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
CLICK = os.path.join(HERE, "..", "..", "scripts", "app-click")


def dry(script, *args):
    p = subprocess.run([sys.executable, os.path.join(CLICK, script), "--dry-run", *args], capture_output=True, text=True,
                       timeout=60, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
    if p.returncode:
        raise AssertionError(p.stderr)
    return p.stdout.splitlines()


def step(lines, name):
    """The plan lines of one step: its header line `step NAME` up to the next header."""
    start = lines.index(f"step {name}")
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("step ")), len(lines))
    return lines[start + 1:end]


class ConformancePlan(unittest.TestCase):
    def setUp(self):
        self.lines = dry("conformance.py")

    def test_conformance_steps_current(self):
        presses = [ln for ln in self.lines if ln.strip().startswith("press ")]
        self.assertTrue(any("Keyboard" in ln for ln in presses), presses)
        self.assertFalse([ln for ln in presses if "Keys" in ln.split("|")[-1] or ln.strip().endswith("Theme")], presses)
        theme = step(self.lines, "settings-theme")
        self.assertIn("find #h-theme|Theme", [ln.strip() for ln in theme])
        self.assertFalse([ln for ln in theme if ln.strip().startswith("press ")], "Theme is a section of Appearance, not a page")
        self.assertIn("check 146-themes", [ln.strip() for ln in theme])
        # The Theme section is reached on the Appearance page, so the step before it opened Appearance.
        names = [ln for ln in self.lines if ln.startswith("step ")]
        self.assertEqual(names[names.index("step settings-theme") - 1], "step settings-appearance")

    def test_checks_follow_needs_157(self):
        general = [ln.strip() for ln in step(self.lines, "settings-general")]
        appearance = [ln.strip() for ln in step(self.lines, "settings-appearance")]
        self.assertIn("press #snav-general|General", general)
        self.assertIn("check 144-appearance: Language on General", general)
        self.assertIn("check 144-appearance: Chat width on Appearance", appearance)
        self.assertFalse([ln for ln in appearance if "Language" in ln])
        scope = [ln.strip() for ln in step(self.lines, "settings-scope")]
        # SettingsView.tsx SCOPED = agents, git: the picker draws only there.
        self.assertIn("press #snav-agents|Agents", scope)
        self.assertIn("check 140-scope-picker", scope)

    def test_plan_names_every_check_once(self):
        checks = {ln.strip().split()[1].rstrip(":") for ln in self.lines if ln.strip().startswith("check ")}
        sys.path.insert(0, CLICK)
        try:
            import conformance
        finally:
            sys.path.remove(CLICK)
        self.assertEqual(checks, set(conformance.TITLES))


class CapturePlan(unittest.TestCase):
    def test_capture_browser_focuses_session(self):
        lines = dry("capture.py", "light", "/nonexistent-out")
        browser = [ln.strip() for ln in step(lines, "browser")]
        select = next(i for i, ln in enumerate(browser) if ln.startswith("select session agent-working"))
        click = next(i for i, ln in enumerate(browser) if ln.startswith("click Browser"))
        self.assertLess(select, click)
        self.assertIn("activate", browser[click])
        hover = [ln.strip() for ln in step(lines, "hover")]
        moves = [ln for ln in hover if ln.startswith("move ")]
        self.assertTrue(moves and all("activate" in ln for ln in moves), hover)
        self.assertFalse(os.path.exists("/nonexistent-out"), "dry run writes nothing")


class HarnessFocus(unittest.TestCase):
    """The pointer reaches the app only while its window is frontmost (the RC lost focus after the Browser click)."""

    def setUp(self):
        sys.path.insert(0, CLICK)
        try:
            import harness
        finally:
            sys.path.remove(CLICK)
        self.harness = harness
        self.calls = []
        self.app = object.__new__(harness.App)
        self.app.pid = 4242

        def ax(*args, timeout=30):
            self.calls.append(args[0])
            return "ok\n"
        for patch in (mock.patch.object(harness, "ax", ax), mock.patch.object(harness.time, "sleep", lambda s: None)):
            patch.start()
            self.addCleanup(patch.stop)

    def test_move_activates_first(self):
        self.app.move(10, 20)
        self.assertEqual(self.calls, ["activate", "move"])

    def test_click_activates_before_and_after(self):
        self.app.click(10, 20)
        self.assertEqual(self.calls, ["activate", "click", "activate", "ping"])


class StripRule(unittest.TestCase):
    """needs 162 (replaces needs 107): the Answer strip takes 0 px when empty and, when it shows, sits under the composer."""
    COMPOSER = (350, 492, 506, 98)  # x, y, w, h: bottom at 590

    def rule(self, strips):
        sys.path.insert(0, CLICK)
        try:
            import conformance
        finally:
            sys.path.remove(CLICK)
        return conformance.strip_rule(strips, self.COMPOSER)

    def test_empty_strip_is_ok(self):
        self.assertTrue(self.rule([(350, 300, 506, 0)])[0])
        self.assertTrue(self.rule([])[0])

    def test_strip_under_the_composer_is_ok(self):
        self.assertTrue(self.rule([(350, 600, 506, 40)])[0])
        self.assertTrue(self.rule([(350, 590, 506, 40)])[0])  # touching the composer's bottom edge

    def test_strip_above_the_composer_fails(self):
        ok, detail = self.rule([(350, 440, 506, 40)])
        self.assertFalse(ok)
        self.assertIn("440", detail)

    def test_strip_over_the_composer_fails(self):
        self.assertFalse(self.rule([(350, 560, 506, 60)])[0])

    def test_strip_without_a_composer_cannot_be_placed(self):
        sys.path.insert(0, CLICK)
        try:
            import conformance
        finally:
            sys.path.remove(CLICK)
        self.assertFalse(conformance.strip_rule([(350, 600, 506, 40)], None)[0])
        self.assertTrue(conformance.strip_rule([], None)[0])

    def test_check_id_stays_in_the_plan(self):
        self.assertIn("check 107-no-strip", [ln.strip() for ln in dry("conformance.py")])


class BoardWatchViewRule(unittest.TestCase):
    """needs 208 (replaces needs 154 (6) for the default view): the Board opens as the watch view, four columns by name."""
    WATCH = ["Needs you", "Working", "Next", "Done"]

    def conformance(self):
        sys.path.insert(0, CLICK)
        try:
            import conformance
        finally:
            sys.path.remove(CLICK)
        return conformance

    def rule(self, found):
        return self.conformance().board_rule(found)

    def test_conformance_106_board_watch_view(self):
        self.assertTrue(self.rule(self.WATCH)[0])
        # The five old columns are not the watch view: only Working and Done of them are found, so the rule names the rest.
        ok, detail = self.rule(["To do", "Working", "Needs decision", "Review", "Done"])
        self.assertFalse(ok)
        self.assertIn("Needs you", detail)
        self.assertIn("Next", detail)

    def test_missing_watch_column_is_named(self):
        ok, detail = self.rule(["Needs you", "Working", "Done"])
        self.assertFalse(ok)
        self.assertIn("Next", detail)

    def test_the_board_step_looks_for_the_watch_names(self):
        self.assertEqual(self.conformance().BOARD_COLUMNS, tuple(self.WATCH))


if __name__ == "__main__":
    unittest.main()
