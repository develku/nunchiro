"""v1b-full manifest and aggregator (ticket v1b-25). Temp homes and fake scripts only; no agent runs."""
import json
import os
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "scripts", "scenario"))
import v1b_full  # noqa: E402


class Home(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self.home = self._t.name
        self.addCleanup(self._t.cleanup)
        for rel, body in {".claude/settings.json": "{}", ".claude.json": json.dumps({"projects": {"/a": {"hasTrustDialogAccepted": True}}}),
                          ".codex/config.toml": "model = 'x'\n", ".claude/skills/one/SKILL.md": "# one\n"}.items():
            self.put(rel, body)

    def put(self, rel, body):
        p = os.path.join(self.home, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(body)
        return p

    def diff(self, before, ours=()):
        return v1b_full.manifest_diff(before, v1b_full.manifest(self.home), ours)


class Manifest(Home):
    def test_manifest_detects_added_skill_file(self):
        before = v1b_full.manifest(self.home)
        self.put(".codex/skills/two/SKILL.md", "# two\n")
        problems, _ = self.diff(before)
        self.assertTrue(any(".codex/skills/two/SKILL.md" in p for p in problems), problems)

    def test_manifest_ignores_transcripts_and_history(self):
        before = v1b_full.manifest(self.home)
        for rel in (".claude/projects/-x/abc.jsonl", ".claude/history.jsonl", ".claude/sessions/1.json", ".claude/todos/t.json",
                    ".claude/shell-snapshots/s.sh", ".codex/sessions/2026/10/26/rollout-1.jsonl", ".codex/history.jsonl",
                    ".codex/log/codex-tui.log", ".claude/plugins/cache/p/x.js", ".claude/plugins/plugin-catalog-cache.json",
                    ".codex/logs_2.sqlite"):
            self.put(rel, "x")
        with open(os.path.join(self.home, ".claude.json")) as f:
            cj = json.load(f)
        cj["numStartups"] = 9  # bookkeeping, not a trust key
        self.put(".claude.json", json.dumps(cj))
        self.assertEqual(self.diff(before), ([], []))

    def test_manifest_detects_changed_settings_and_hooks(self):
        for rel in (".claude/settings.json", ".claude/settings.local.json", ".codex/hooks.json", ".claude/hooks/pre.sh",
                    ".codex/AGENTS.md", ".claude/CLAUDE.md", ".codex/rules/default.rules", ".claude/agents/a.md",
                    ".claude/commands/c.md", ".claude/plugins/marketplaces/m/skills/s/SKILL.md"):
            with self.subTest(rel):
                before = v1b_full.manifest(self.home)
                self.put(rel, '{"changed": "%s"}' % time.time())
                problems, _ = self.diff(before)
                self.assertTrue(any(rel in p for p in problems), problems)

    def test_trust_granted_to_our_path_is_a_problem_elsewhere_foreign(self):
        before = v1b_full.manifest(self.home)
        self.put(".claude.json", json.dumps({"projects": {"/a": {"hasTrustDialogAccepted": True}, "/scratch/run": {"hasTrustDialogAccepted": True},
                                                           "/other": {"hasTrustDialogAccepted": True}}}))
        problems, foreign = self.diff(before, ours=["/scratch/run"])
        self.assertTrue(any("/scratch/run" in p for p in problems), problems)
        self.assertTrue(any("/other" in f for f in foreign), foreign)
        self.assertFalse(any("/other" in p for p in problems), problems)

    def test_config_toml_change_is_left_to_the_guard(self):
        before = v1b_full.manifest(self.home)
        self.put(".codex/config.toml", "model = 'y'\n")
        problems, foreign = self.diff(before)
        self.assertEqual(problems, [])
        self.assertTrue(any("config.toml" in f for f in foreign), foreign)

    def marketplaces(self, names, stamp):
        self.put(".claude/plugins/known_marketplaces.json", json.dumps(
            {n: {"source": {"source": "github", "repo": f"o/{n}"}, "installLocation": f"/m/{n}", "lastUpdated": stamp, "autoUpdate": True} for n in names}))

    def test_marketplace_last_updated_only_change_passes(self):
        self.marketplaces(["ponytail", "typesafe-ai"], "2026-10-02T00:25:29.079Z")
        before = v1b_full.manifest(self.home)
        self.marketplaces(["ponytail", "typesafe-ai"], "2026-10-25T15:13:19.264Z")
        self.assertEqual(self.diff(before), ([], []))

    def test_marketplace_added_fails(self):
        self.marketplaces(["ponytail"], "2026-10-02T00:25:29.079Z")
        before = v1b_full.manifest(self.home)
        self.marketplaces(["ponytail", "evil"], "2026-10-02T00:25:29.079Z")
        problems, _ = self.diff(before)
        self.assertTrue(any("known_marketplaces.json" in p for p in problems), problems)

    def test_sync_round_markers_are_ignored(self):
        before = v1b_full.manifest(self.home)
        for rel in (".claude/plugins/synced/a_b/.last-complete-round", ".claude/skills/synced/a_b/.last-complete-round"):
            self.put(rel, "86bba794 1f0cfb20")
        self.assertEqual(self.diff(before), ([], []))

    def test_claude_sync_bookkeeping_is_ignored_but_its_siblings_are_not(self):
        marketplaces = ".claude/plugins/synced/a_b/.marketplaces.json"
        sibling = ".claude/plugins/synced/a_b/plugin.json"
        self.put(marketplaces, "a")
        self.put(sibling, "a")
        self.put(".claude/skills/synced/a_b/SKILL.md", "a")
        before = v1b_full.manifest(self.home)
        self.put(marketplaces, "b")
        self.assertEqual(self.diff(before), ([], []))
        self.put(sibling, "b")
        self.put(".claude/skills/synced/a_b/SKILL.md", "b")
        problems, _ = self.diff(before)
        self.assertTrue(any(sibling in p for p in problems), problems)
        self.assertTrue(any("skills/synced/a_b/SKILL.md" in p for p in problems), problems)

    def test_claude_run_markers_are_ignored_but_their_neighbours_are_not(self):
        plugin = ".claude/plugins/synced/a_b/pdf-viewer"
        before = v1b_full.manifest(self.home)
        for rel in (plugin + "/.in_use/22555", ".claude/plugins/.last_inuse_sweep",
                    ".claude/plugins/store/cc-plugin-diff_builtin-3903e77c01b1.json"):
            self.put(rel, '{"pid":22555,"procStart":"Fri Nov 27 09:16:10 2026"}')  # a Claude process starts
        self.assertEqual(self.diff(before), ([], []))
        for rel in (plugin + "/.in_use/hook.sh", plugin + "/.in_use/22555/hook.sh", plugin + "/.mcp.json",
                    ".claude/skills/s/.in_use/22555", ".claude/plugins/marketplaces/m/p/.in_use/22555",
                    ".claude/plugins/store/mine_local-1.json", ".claude/plugins/x/.last_inuse_sweep"):
            with self.subTest(rel):
                before = v1b_full.manifest(self.home)
                self.put(rel, "a")
                problems, _ = self.diff(before)
                self.assertTrue(any(rel in p for p in problems), problems)

    def test_cache_named_config_is_not_hidden(self):
        for rel in (".claude/hooks/cache-guard.sh", ".claude/skills/s/cache/SKILL.md", ".codex/skills/s/caches/x.md",
                    ".claude/skills/s/logs/x.md", ".claude/plugins/marketplaces/m/src/proxyCache.ts", ".claude/skills/s/run.log",
                    ".claude/skills/x/.last-complete-round", ".claude/skills/s/.git/HEAD"):
            with self.subTest(rel):
                self.put(rel, "a")
                before = v1b_full.manifest(self.home)
                self.put(rel, "b")
                problems, _ = self.diff(before)
                self.assertTrue(any(rel in p for p in problems), problems)

    def test_agent_owned_caches_still_ignored(self):
        before = v1b_full.manifest(self.home)
        for rel in (".codex/plugins/cache/p/x.js", ".claude/plugins/plugin-directory-cache-v2.json",
                    ".claude/plugins/marketplaces/m/.git/FETCH_HEAD", ".codex/plugins/.marketplace-plugin-source-staging/m/.git/HEAD"):
            self.put(rel, "x")
        self.assertEqual(self.diff(before), ([], []))

    def test_unreadable_manifest_file_fails_closed(self):
        if os.geteuid() == 0:
            self.skipTest("chmod 000 does not block root")
        p = self.put(".claude/skills/one/SKILL.md", "# one\n")
        os.chmod(p, 0)
        self.addCleanup(os.chmod, p, 0o600)
        snap = v1b_full.manifest(self.home)
        problems, _ = v1b_full.manifest_diff(snap, snap, ())
        self.assertTrue(any("SKILL.md" in x for x in problems), problems)


class Aggregate(unittest.TestCase):
    def row(self, name, status):
        return {"name": name, "status": status, "runs": 1}

    def test_aggregate_fails_when_any_row_fails(self):
        ok, _ = v1b_full.aggregate([self.row("chat-claude", "pass"), self.row("diff-card", "FAIL")], [])
        self.assertFalse(ok)

    def test_aggregate_passes_with_skipped_codex_rows_listed(self):
        ok, lines = v1b_full.aggregate([self.row("chat-claude", "pass"), self.row("chat-codex", "not run")], [])
        self.assertTrue(ok)
        self.assertTrue(any("chat-codex" in l and "not run" in l for l in lines), lines)

    def test_aggregate_fails_on_manifest_problem_or_nothing_run(self):
        self.assertFalse(v1b_full.aggregate([self.row("chat-claude", "pass")], ["x changed"])[0])
        self.assertFalse(v1b_full.aggregate([self.row("chat-codex", "not run")], [])[0])

    def test_aggregate_fails_closed_when_script_missing(self):
        with tempfile.TemporaryDirectory() as d:
            row = v1b_full.run_row("diff-card", [os.path.join(d, "absent.sh")], env=dict(os.environ), log=os.path.join(d, "log"))
        self.assertEqual(row["status"], "FAIL")
        self.assertIn("missing", row["error"])
        self.assertFalse(v1b_full.aggregate([row], [])[0])


class Rows(unittest.TestCase):
    def test_row_that_leaves_a_process_behind_fails_and_it_is_stopped(self):
        with tempfile.TemporaryDirectory() as d:
            script = os.path.join(d, "leak.sh")
            with open(script, "w") as f:
                f.write("#!/bin/sh\nsleep 60 &\necho $! > %s/pid\nsleep 1.5\n" % d)
            os.chmod(script, 0o755)
            row = v1b_full.run_row("leak", [script], env=dict(os.environ), log=os.path.join(d, "log"))
            with open(os.path.join(d, "pid")) as f:
                pid = int(f.read())
        self.assertEqual(row["status"], "FAIL")
        self.assertIn(pid, row["leftover_pids"])
        deadline = time.time() + 5  # the kill is delivered at once; poll the condition instead of sleeping a fixed 0.2 s
        while time.time() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.01)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_clean_row_passes_with_its_exit_code(self):
        with tempfile.TemporaryDirectory() as d:
            ok = v1b_full.run_row("ok", ["/bin/sh", "-c", "exit 0"], env=dict(os.environ), log=os.path.join(d, "a"))
            bad = v1b_full.run_row("bad", ["/bin/sh", "-c", "exit 3"], env=dict(os.environ), log=os.path.join(d, "b"))
        self.assertEqual((ok["status"], ok["leftover_pids"]), ("pass", []))
        self.assertEqual((bad["status"], bad["exit"]), ("FAIL", 3))

    def test_second_concurrent_run_refuses(self):
        with tempfile.TemporaryDirectory() as d:
            first = v1b_full.lock(os.path.join(d, "v1b-full.lock"))
            self.assertIsNotNone(first)
            self.addCleanup(first.close)
            self.assertIsNone(v1b_full.lock(os.path.join(d, "v1b-full.lock")))


class Guard(unittest.TestCase):
    def test_guard_unchanged(self):
        suite = unittest.defaultTestLoader.loadTestsFromName("test_guard")
        with open(os.devnull, "w") as null:
            result = unittest.TextTestRunner(stream=null).run(suite)
        self.assertTrue(result.wasSuccessful(), result.failures + result.errors)
        self.assertGreater(result.testsRun, 10)


if __name__ == "__main__":
    unittest.main()
