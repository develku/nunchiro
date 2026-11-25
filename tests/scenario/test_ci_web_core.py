"""Ticket 1134: the CI web stage (.github/scripts/web-core.sh) runs the same Playwright core set as the owner's gate
(scripts/web-smoke.sh --core): same --grep, project and retries (workers follow the machine). Both commands are printed, nothing runs."""
import os
import shlex
import stat
import subprocess
import tempfile
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
SMOKE = os.path.join(ROOT, "scripts", "web-smoke.sh")


@unittest.skipUnless(os.path.isfile(SMOKE), "the public export has no scripts/web-smoke.sh")
class CiWebCore(unittest.TestCase):
    def test_same_command_as_the_gate(self):
        env = dict(os.environ, WEB_SMOKE_DRY="1", WEB_SMOKE_FILES="web/src/x.ts", WEB_SMOKE_LOADAVG="0")
        gate = subprocess.run(["sh", SMOKE, "--core"], cwd=ROOT, capture_output=True, text=True, env=env)
        self.assertEqual(gate.returncode, 0, gate.stdout + gate.stderr)
        line = next(l for l in gate.stdout.splitlines() if "playwright test" in l)
        want = shlex.split(line.split("&&", 1)[1].rstrip(")"))
        # the gate also names the core files as path filters; the --grep already holds only tests of those files
        want = [w for w in want[want.index("playwright"):] if not w.startswith("/tests/")]
        with tempfile.TemporaryDirectory() as d:
            shim = os.path.join(d, "pnpm")  # prints its arguments instead of running Playwright
            with open(shim, "w") as f:
                f.write('#!/bin/sh\nfor a; do printf "%s\\n" "$a"; done\n')
            os.chmod(shim, stat.S_IRWXU)
            ci = subprocess.run(["sh", ".github/scripts/web-core.sh"], cwd=ROOT, capture_output=True, text=True,
                                env=dict(os.environ, PATH=d + os.pathsep + os.environ["PATH"]))
        self.assertEqual(ci.returncode, 0, ci.stdout + ci.stderr)
        # --workers follows the machine's cores (the gate MacBook prints 8, a 3-core runner 2): compare without it,
        # and check only that CI names a worker count.
        got = ci.stdout.splitlines()[1:]
        drop = lambda args: [a for a in args if not a.startswith("--workers=")]
        self.assertEqual(drop(got), drop(want))
        self.assertTrue(any(a.startswith("--workers=") for a in got))


if __name__ == "__main__":
    unittest.main()
