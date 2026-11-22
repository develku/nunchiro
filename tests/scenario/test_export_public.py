"""scripts/export-public.sh: the public snapshot leaves out the excluded paths, puts back the "+" ones, refuses a
non-empty folder and writes the same files twice. Reads HEAD with git archive; writes only under a temp dir."""
import os
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(ROOT, "scripts", "export-public.sh")


def export(out):
    return subprocess.run(["sh", SCRIPT, out], capture_output=True, text=True)


class ExportPublic(unittest.TestCase):
    def test_export_leaves_out_and_puts_back(self):
        with tempfile.TemporaryDirectory() as d:
            a, b = os.path.join(d, "a"), os.path.join(d, "b")
            self.assertEqual(export(a).returncode, 0)
            for gone in ("docs/tickets", "docs/needs.md", ".agents", "AGENTS.md", "docs/release", "scripts/launchd"):
                self.assertFalse(os.path.exists(os.path.join(a, gone)), gone)
            for kept in ("README.md", "LICENSE", "docs/cli.md", "docs/design/v25-threat-model.md", "plugin"):
                self.assertTrue(os.path.exists(os.path.join(a, kept)), kept)
            self.assertEqual(os.listdir(os.path.join(a, "docs", "design")), ["v25-threat-model.md"])
            self.assertEqual(export(b).returncode, 0)
            self.assertEqual(subprocess.run(["diff", "-r", a, b], capture_output=True).returncode, 0)

    def test_refuses_a_non_empty_folder(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "x"), "w").close()
            run = export(d)
            self.assertEqual(run.returncode, 2)
            self.assertIn("not an empty folder", run.stderr)
            self.assertEqual(os.listdir(d), ["x"])

    def test_a_failed_archive_fails_the_export(self):
        # `git archive | tar -x` gave tar's status: a failed archive read as a good (empty or half) export. A git on PATH
        # whose first or second `archive` fails (the tree, then the "+" paths) and is the real git otherwise.
        real = subprocess.run(["sh", "-c", "command -v git"], capture_output=True, text=True).stdout.strip()
        for fail_at in ("1", "2"):
            with self.subTest(archive=fail_at), tempfile.TemporaryDirectory() as d:
                shim = os.path.join(d, "bin", "git")
                os.mkdir(os.path.dirname(shim))
                with open(shim, "w") as f:
                    f.write(
                        "#!/bin/sh\n"
                        'for a in "$@"; do\n'
                        '  if [ "$a" = archive ]; then\n'
                        f'    n=$(($(cat "{d}/n" 2>/dev/null || echo 0) + 1)); echo "$n" > "{d}/n"\n'
                        f'    [ "$n" = {fail_at} ] && {{ echo "fatal: archive failed (test)" >&2; exit 128; }}\n'
                        "  fi\n"
                        "done\n"
                        f'exec "{real}" "$@"\n'
                    )
                os.chmod(shim, 0o755)
                env = dict(os.environ, PATH=os.path.dirname(shim) + os.pathsep + os.environ["PATH"])
                run = subprocess.run(["sh", SCRIPT, os.path.join(d, "out")], capture_output=True, text=True, env=env)
                self.assertNotEqual(run.returncode, 0, run.stdout)
                self.assertNotIn("files from", run.stdout)
                with open(os.path.join(d, "n")) as n:
                    self.assertEqual(n.read().strip(), fail_at)  # it stopped at the failed archive


if __name__ == "__main__":
    unittest.main()
