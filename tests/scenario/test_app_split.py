"""needs 183 (APPSPLIT): web/src/App.tsx is composition only, and the area modules split out of it exist and are
imported by it, so a UI lane edits its area's module instead of serialising on App.tsx."""

import os
import re
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.path.join(ROOT, "web", "src")
APP = os.path.join(SRC, "App.tsx")

# The modules of the split (needs 183 plan rows 1-17), relative to web/src.
MODULES = [
    "chrome/commands.ts",
    "chrome/useGlobalKeys.ts",
    "chrome/useTabs.ts",
    "chrome/CentreView.tsx",
    "chrome/StatusBar.tsx",
    "chrome/useCoreLink.ts",
    "layout/useRails.tsx",
    "layout/usePaneMode.ts",
    "split/useSplitGlue.ts",
    "chat/useComposerSend.ts",
    "chat/ComposerWidget.tsx",
    "chat/useSideChats.ts",
    "settings/useAppSettings.ts",
    "settings/lifetime/useLifetime.ts",
    "tree/useSessionStart.ts",
    "decisions/useDecisionJump.ts",
    "board/useBoardRail.ts",
]
MOVED = ("const send = async", "const composerWidget", "const terminalWidget")
MAX_LINES = 750


def memo_body_lines(text):
    """Lines in the body of an inline `const commands: Command[] = useMemo(() => {` block (0 when there is none)."""
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if "const commands: Command[] = useMemo(() => {" in line:
            for j in range(i + 1, len(lines)):
                if lines[j].lstrip().startswith("}, ["):
                    return j - i - 1
            return len(lines) - i - 1
    return 0


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


class AppTsxIsCompositionOnly(unittest.TestCase):
    def test_app_tsx_is_composition_only(self):
        app = read(APP)
        self.assertLess(app.count("\n"), MAX_LINES, "App.tsx grew past the split's bound")
        self.assertLessEqual(memo_body_lines(app), 10, "the command list's body is back in App.tsx")
        for moved in MOVED:
            self.assertNotIn(moved, app, f"{moved!r} is back in App.tsx")

    def test_detector_catches_an_inline_command_list(self):
        inline = "  const commands: Command[] = useMemo(() => {\n" + "    x,\n" * 11 + "  }, [a]);\n"
        self.assertEqual(memo_body_lines(inline), 11)
        self.assertEqual(memo_body_lines("  const commands: Command[] = useMemo(\n    () => buildCommands(d),\n    [a],\n  );\n"), 0)


class AppSplitModulesReferenced(unittest.TestCase):
    def test_app_split_modules_referenced(self):
        app = read(APP)
        for module in MODULES:
            with self.subTest(module=module):
                self.assertTrue(os.path.isfile(os.path.join(SRC, module)), f"{module} is missing")
                spec = "from './" + re.sub(r"\.tsx?$", "", module) + "'"
                self.assertIn(spec, app, f"App.tsx does not import {module}")


if __name__ == "__main__":
    unittest.main()
