"""scripts/check-cli-docs.sh compares `nunchiro --help` with docs/cli.md. Fake binary and docs only."""
import os
import stat
import subprocess
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "check-cli-docs.sh")
HELP = """nunchiro serve [stop]
nunchiro session start --kind claude|codex|shell --project DIR [-- ARGS...]
nunchiro session list|read
nunchiro snapshot --json
nunchiro --machine <m> ...
other text that is not a command line
"""
DOCS = """# CLI
### `nunchiro serve`
### `nunchiro session start --kind claude|codex|shell --project <dir>`
### `nunchiro session list`
### `nunchiro session read <id>`
### `nunchiro snapshot --json`
### `nunchiro --machine <m> <command>`
"""


class CheckCliDocs(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self.addCleanup(self._t.cleanup)
        self.dir = self._t.name
        self.bin = os.path.join(self.dir, "nunchiro")
        with open(self.bin, "w") as f:
            f.write(f"#!/bin/sh\ncat <<'EOF'\n{HELP}EOF\n")
        os.chmod(self.bin, os.stat(self.bin).st_mode | stat.S_IXUSR)

    def run_check(self, docs, binary=None):
        path = os.path.join(self.dir, "cli.md")
        with open(path, "w") as f:
            f.write(docs)
        env = {**os.environ, "NUNCHIRO_BIN": binary or self.bin, "CLI_DOCS": path}
        return subprocess.run(["sh", SCRIPT], env=env, capture_output=True, text=True)

    def test_matching_docs_pass(self):
        r = self.run_check(DOCS)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_removed_entry_fails_and_is_named(self):
        r = self.run_check(DOCS.replace("### `nunchiro session read <id>`\n", ""))
        self.assertEqual(r.returncode, 1)
        self.assertIn("session read", r.stderr)

    def test_alternation_in_help_is_expanded(self):
        r = self.run_check(DOCS.replace("### `nunchiro session list`\n", ""))
        self.assertEqual(r.returncode, 1)
        self.assertIn("session list", r.stderr)

    def test_extra_entry_for_unknown_command_fails(self):
        r = self.run_check(DOCS + "### `nunchiro session gone <id>`\n")
        self.assertEqual(r.returncode, 1)
        self.assertIn("session gone", r.stderr)

    def test_pending_entry_is_allowed_until_help_lists_it(self):
        pending = "### `nunchiro machine status [<label>]` <!-- pending: help -->\n"
        self.assertEqual(self.run_check(DOCS + pending).returncode, 0)
        self.assertEqual(self.run_check(DOCS + pending.replace("machine status", "snapshot")).returncode, 1)

    def test_missing_binary_is_a_clear_error_not_a_pass(self):
        r = self.run_check(DOCS, binary=os.path.join(self.dir, "absent"))
        self.assertEqual(r.returncode, 2)
        self.assertIn("cargo build", r.stderr)

    def test_help_that_lists_nothing_is_an_error(self):
        empty = os.path.join(self.dir, "empty")
        with open(empty, "w") as f:
            f.write("#!/bin/sh\necho nothing\n")
        os.chmod(empty, 0o755)
        self.assertEqual(self.run_check(DOCS, binary=empty).returncode, 2)


if __name__ == "__main__":
    unittest.main()
