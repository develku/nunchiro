"""Guard (snapshot + guard_check) fails closed. Temp home only; never touches the real ~/.claude or ~/.codex."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "scenario"))
import lib  # noqa: E402


class Home(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self.home = self._t.name
        self.addCleanup(self._t.cleanup)
        self.addCleanup(setattr, lib, "RETRY_WAIT", lib.RETRY_WAIT)
        lib.RETRY_WAIT = 0.05
        for rel, body in {".claude/settings.json": "{}", ".claude.json": json.dumps({"projects": {}}),
                          ".codex/config.toml": "model = 'x'\n"}.items():
            self.put(rel, body)

    def put(self, rel, body):
        p = os.path.join(self.home, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(body)
        return p

    def check(self, before, after):
        return lib.guard_check(before, after, ours=["/scenario/cwd"])


class FailClosed(Home):
    def test_clean_run_has_no_problems(self):
        self.assertEqual(self.check(lib.snapshot(self.home), lib.snapshot(self.home)), ([], []))

    def test_half_written_claude_json_is_a_problem(self):
        before = lib.snapshot(self.home)
        self.put(".claude.json", '{"projects": {')
        problems, _ = self.check(before, lib.snapshot(self.home))
        self.assertTrue(any(".claude.json" in p for p in problems), problems)

    def test_missing_settings_json_is_a_problem_not_a_crash(self):
        os.unlink(os.path.join(self.home, ".claude/settings.json"))
        problems, _ = self.check(lib.snapshot(self.home), lib.snapshot(self.home))
        self.assertTrue(any("settings.json" in p for p in problems), problems)

    def test_missing_config_toml_is_a_problem_not_a_crash(self):
        os.unlink(os.path.join(self.home, ".codex/config.toml"))
        problems, _ = self.check(lib.snapshot(self.home), lib.snapshot(self.home))
        self.assertTrue(any("config.toml" in p for p in problems), problems)

    def test_read_retries_once_to_ride_out_another_writer(self):
        p = self.put(".claude.json", '{"projects": {')
        # The other writer finishes during the retry wait; done inside the wait, not on a timer, so load cannot reorder it.
        real_sleep = lib.time.sleep
        lib.time.sleep = lambda _s: self.put(".claude.json", json.dumps({"projects": {}}))
        self.addCleanup(setattr, lib.time, "sleep", real_sleep)
        snap = lib.snapshot(self.home)
        self.assertEqual(snap["error"], {})
        self.assertEqual(self.check(snap, lib.snapshot(self.home)), ([], []))


@unittest.skipIf(os.geteuid() == 0, "chmod 000 does not block root")
class Unreadable(Home):
    def test_unreadable_file_is_a_problem_not_an_exception(self):
        self.put(".claude/settings.local.json", "{}")
        self.put(".codex/hooks.json", "{}")
        for rel in (".claude/settings.json", ".claude.json", ".codex/config.toml", ".claude/settings.local.json", ".codex/hooks.json"):
            with self.subTest(rel):
                p = os.path.join(self.home, rel)
                os.chmod(p, 0)
                self.addCleanup(os.chmod, p, 0o600)
                snap = lib.snapshot(self.home)
                self.assertIn(p, snap["error"])
                problems, _ = self.check(snap, snap)
                self.assertTrue(any(rel in x for x in problems), problems)
                os.chmod(p, 0o600)


class WrongShape(Home):
    def test_wrong_shaped_claude_json_is_a_problem_not_an_exception(self):
        p = os.path.join(self.home, ".claude.json")
        for body in ("[]", "5", '{"projects": []}', '{"projects": null}', '{"projects": {"/a": null}}', '{"projects": {"/a": "x"}}'):
            with self.subTest(body):
                self.put(".claude.json", body)
                snap = lib.snapshot(self.home)
                self.assertIn(p, snap["error"])
                problems, _ = self.check(snap, snap)
                self.assertTrue(any(".claude.json" in x for x in problems), problems)

    def test_valid_shapes_are_not_errors(self):
        for body in ("{}", '{"projects": {}}', '{"projects": {"/a": {}}}'):
            with self.subTest(body):
                self.put(".claude.json", body)
                self.assertEqual(lib.snapshot(self.home)["error"], {})


class OneRead(Home):
    def test_hash_and_text_come_from_the_same_read(self):
        import hashlib
        snap = lib.snapshot(self.home)
        p = os.path.join(self.home, ".codex/config.toml")
        self.assertEqual(snap[p], hashlib.sha256(snap["text"][p].encode()).hexdigest())


class ExtraFiles(Home):
    def test_settings_local_json_created_is_a_problem(self):
        before = lib.snapshot(self.home)
        self.put(".claude/settings.local.json", "{}")
        problems, _ = self.check(before, lib.snapshot(self.home))
        self.assertTrue(any("settings.local.json" in p for p in problems), problems)

    def test_codex_hooks_json_changed_is_a_problem(self):
        self.put(".codex/hooks.json", "{}")
        before = lib.snapshot(self.home)
        self.put(".codex/hooks.json", '{"hooks": 1}')
        problems, _ = self.check(before, lib.snapshot(self.home))
        self.assertTrue(any("hooks.json" in p for p in problems), problems)

    def test_absent_before_and_after_is_fine(self):
        self.assertEqual(self.check(lib.snapshot(self.home), lib.snapshot(self.home)), ([], []))


class SockPath(unittest.TestCase):
    def test_short_unique_unix_socket_paths(self):
        a, b = lib.sock_path(), lib.sock_path("nv1a-relay")
        self.assertNotEqual(a, b)
        self.assertLess(len(a.encode()), 104)
        self.assertIn("nv1a-relay", b)


if __name__ == "__main__":
    unittest.main()
