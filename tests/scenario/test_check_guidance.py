"""scripts/check-guidance.sh: the shipped guidance names only documented commands and flags (scorecard p31 SK1), and
the instruction files name only paths that exist (p31 SK5, p26 MD3). Fake repo trees, plus one run on this checkout."""
import os
import subprocess
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
SCRIPT = os.path.join(ROOT, "scripts", "check-guidance.sh")
DOCS = """# CLI
### `nunchiro agent start --kind claude|codex|shell [--wait]`
### `nunchiro agent read <id> [--json]`
### `nunchiro task list`
`nunchiro task list [--all]` and `nunchiro task show <id>`.
### `nunchiro browser open <url>`
### `nunchiro skill get <name> [--file <file>]`
"""
SKILL = """---
name: fake
---
Start one: `nunchiro agent start --kind shell --wait`, then `nunchiro task show <id>`.

```
nunchiro agent read <id> --json
```
`nunchiro browser` drives a browser. Plain prose: the nunchiro window is not a command.
"""
AGENTS = """# Agent instructions

- Tests: `scripts/run.sh`.

| Request | Skill | Read first |
|---|---|---|
| Next | none | `docs/goal.md`, then [the map](docs/map.md) |
| Hand off | handoff | `.scratch/run/handoff.md` |
"""
BRIEF = "Write `REPORT.md` from `nunchiro skill get orchestration --file report-template.md`.\n"


class CheckGuidance(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self.addCleanup(self._t.cleanup)
        self.root = self._t.name
        files = {
            "docs/cli.md": DOCS,
            "docs/goal.md": "",
            "docs/map.md": "",
            "scripts/run.sh": "",
            "plugin/skills/fake/SKILL.md": SKILL,
            "crates/nunchiro/guides/orchestration/guide.md": "Run `nunchiro task list`.\n",
            "crates/nunchiro/guides/orchestration/brief-template.md": BRIEF,
            "crates/nunchiro/guides/orchestration/report-template.md": "STATUS: done\n",
            "AGENTS.md": AGENTS,
        }
        for rel, text in files.items():
            self.put(rel, text)

    def put(self, rel, text):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(text)

    def run_check(self, root=None):
        env = {k: v for k, v in os.environ.items() if k != "CLI_DOCS"}
        env["GUIDANCE_ROOT"] = root or self.root
        return subprocess.run(["sh", SCRIPT], env=env, capture_output=True, text=True)

    def test_clean_tree_passes(self):
        r = self.run_check()
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_unknown_command_in_skill_fails(self):
        self.put("plugin/skills/fake/SKILL.md", SKILL + "Then `nunchiro agent vanish <id>`.\n")
        r = self.run_check()
        self.assertEqual(r.returncode, 1)
        self.assertIn("plugin/skills/fake/SKILL.md: nunchiro agent vanish", r.stderr)

    def test_unknown_command_in_guide_code_block_fails(self):
        self.put("crates/nunchiro/guides/orchestration/guide.md", "```\nnunchiro task explode 3\n```\n")
        r = self.run_check()
        self.assertEqual(r.returncode, 1)
        self.assertIn("nunchiro task explode", r.stderr)

    def test_group_alone_does_not_cover_an_unknown_subcommand(self):
        # "task" is a documented group, but "task vanish" is not a command.
        self.put("plugin/skills/fake/SKILL.md", "`nunchiro task vanish <id>`\n")
        self.assertEqual(self.run_check().returncode, 1)

    def test_unknown_flag_fails(self):
        self.put("plugin/skills/fake/SKILL.md", "`nunchiro agent read <id> --yaml`\n")
        r = self.run_check()
        self.assertEqual(r.returncode, 1)
        self.assertIn("nunchiro agent read --yaml", r.stderr)

    def test_no_agents_md_passes_but_a_missing_template_fails(self):
        # Ticket 1135: the public export has no AGENTS.md; the templates ship and stay required.
        os.remove(os.path.join(self.root, "AGENTS.md"))
        self.assertEqual(self.run_check().returncode, 0)
        os.remove(os.path.join(self.root, "crates/nunchiro/guides/orchestration/report-template.md"))
        r = self.run_check()
        self.assertEqual(r.returncode, 1)
        self.assertIn("report-template.md: missing", r.stderr)

    def test_missing_path_in_agents_md_fails(self):
        self.put("AGENTS.md", AGENTS + "| Old | old-skill | `.agents/gone.toml` |\n")
        r = self.run_check()
        self.assertEqual(r.returncode, 1)
        self.assertIn("AGENTS.md: path .agents/gone.toml does not exist", r.stderr)

    def test_missing_link_target_in_brief_template_fails(self):
        self.put("crates/nunchiro/guides/orchestration/brief-template.md", BRIEF + "See [rules](docs/rules.md).\n")
        r = self.run_check()
        self.assertEqual(r.returncode, 1)
        self.assertIn("brief-template.md: path docs/rules.md does not exist", r.stderr)

    def test_missing_cli_docs_is_an_error_not_a_pass(self):
        os.remove(os.path.join(self.root, "docs/cli.md"))
        r = self.run_check()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("cli.md not found", r.stderr)


@unittest.skipUnless(os.path.isfile(os.path.join(ROOT, "AGENTS.md")), "the public export has no AGENTS.md or docs/goal.md")
class RepoGuidance(unittest.TestCase):
    """This checkout's own guidance (ticket 1130 C1, items 1.4 and 3.3)."""

    def agents_lines(self):
        with open(os.path.join(ROOT, "AGENTS.md"), encoding="utf-8") as f:
            return f.read().splitlines()

    def test_repo_guidance_passes(self):
        env = {k: v for k, v in os.environ.items() if k not in ("CLI_DOCS", "GUIDANCE_ROOT")}
        r = subprocess.run(["sh", SCRIPT], env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_agents_md_routes_to_no_retired_skill(self):
        # build-loop and KF were retired on 2026-11-25; docs/goal.md has no "Next:" line.
        for row in (l for l in self.agents_lines() if l.startswith("| ")):
            self.assertNotIn("build-loop |", row)
            self.assertNotIn("build-loop record", row)
            self.assertNotIn("build-loop.toml", row)
            self.assertNotIn("Next:", row)

    def test_agents_md_names_the_rust_test_runner_and_stays_short(self):
        # Scorecard p26 MD3: under 40 lines; MD1: AGENTS.md says how to run the Rust tests.
        lines = self.agents_lines()
        self.assertLess(len(lines), 40)
        runner = [l for l in lines if l.startswith("- Rust tests: `scripts/")]
        self.assertEqual(len(runner), 1, "AGENTS.md needs one '- Rust tests: `scripts/...`' line")
        self.assertTrue(os.path.isfile(os.path.join(ROOT, runner[0].split("`")[1])))

    def test_goal_md_names_no_retired_flow(self):
        # AGENTS.md routes "What is next" here; it must not send an agent to build-loop or a KF goal.
        with open(os.path.join(ROOT, "docs", "goal.md"), encoding="utf-8") as f:
            text = f.read()
        self.assertNotIn("goal_file", text)
        self.assertNotIn("KF goal", text)
        self.assertIn("## Next", text)


if __name__ == "__main__":
    unittest.main()