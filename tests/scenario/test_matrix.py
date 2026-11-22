"""passed() scoring for the waiting matrix: pure Python, no agent started."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "scenario"))
from matrix import passed, rescore  # noqa: E402


class ListenerRows(unittest.TestCase):
    def test_fast_hook_passes(self):
        self.assertTrue(passed(dict(row="C1", screen=0.0, hook=0.3, transcript=None, file_created=False)))

    def test_hook_before_screen_passes(self):
        self.assertTrue(passed(dict(row="C1", screen=0.0, hook=-0.4, file_created=False)))

    def test_slow_hook_alone_fails_the_1s_bound(self):
        self.assertFalse(passed(dict(row="C1", screen=0.0, hook=1.5, transcript=None, file_created=False)))

    def test_slow_hook_but_fast_transcript_passes(self):
        self.assertTrue(passed(dict(row="C1", screen=0.0, hook=1.5, transcript=0.5, file_created=False)))

    def test_no_listener_source_fails_even_though_screen_showed(self):
        self.assertFalse(passed(dict(row="C1", screen=0.0, hook=None, transcript=None, file_created=False)))

    def test_auto_approve_fails_a_fast_run(self):
        self.assertFalse(passed(dict(row="C1", screen=0.0, hook=0.1, file_created=True)))

    def test_not_elicited_is_none(self):
        self.assertIsNone(passed(dict(row="C1", error="not elicited")))


    def test_missing_file_created_is_not_a_pass(self):
        self.assertFalse(passed(dict(row="C1", screen=0.0, hook=0.1)))


class ScreenOnlyRows(unittest.TestCase):
    def test_fast_screen_reader_passes(self):
        self.assertTrue(passed(dict(row="C3", screen=0.0, screen_delay=0.04, file_created=False)))

    def test_slow_screen_reader_fails(self):
        self.assertFalse(passed(dict(row="X3", screen=0.0, screen_delay=1.2, file_created=False)))

    def test_missing_timing_fails(self):
        self.assertFalse(passed(dict(row="C3", screen=0.0, file_created=False)))

    def test_file_created_fails(self):
        self.assertFalse(passed(dict(row="C3", screen=0.0, screen_delay=0.04, file_created=True)))


class CoreKilledRows(unittest.TestCase):
    ok = dict(hook_returned_after_kill=0.01, own_prompt_after_hook=True, file_created=False,
              restored_from_screen_on_core_start=True)

    def test_all_conditions_pass(self):
        self.assertTrue(passed(dict(row="K", **self.ok)))

    def test_auto_approve_fails(self):
        self.assertFalse(passed(dict(row="XK", **dict(self.ok, file_created=True))))

    def test_missing_file_created_is_not_a_pass(self):
        self.assertFalse(passed(dict(row="K", **{k: v for k, v in self.ok.items() if k != "file_created"})))


class Rescore(unittest.TestCase):
    def rows(self, *recs):
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
            f.write("\n".join(json.dumps(r) for r in recs) + "\n\n")
        self.addCleanup(os.unlink, f.name)
        return rescore([f.name])

    def test_recomputes_pass_ignoring_the_stored_value(self):
        out = self.rows(dict(row="C1", hook=1.5, file_created=False, **{"pass": True}),
                        dict(row="C1", hook=0.1, file_created=False, **{"pass": False}),
                        dict(row="C1", error="not elicited"))
        self.assertEqual([r["pass"] for r in out], [False, True, None])

    def test_missing_row_key_is_reported_not_a_keyerror(self):
        out = self.rows(dict(hook=0.1, file_created=False))
        self.assertIs(out[0]["pass"], False)
        self.assertIn("row", out[0]["problem"])


if __name__ == "__main__":
    unittest.main()
