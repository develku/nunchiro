"""V2-4b scenario drivers (acp_problem_cards, acp_real_agent_turn) against the fake ACP agent: the row list, one fast
sub-case that needs no card (a changed entry) and one that does (a refused Claude entry), and the real-agent script run
against the fake agent. Real `nunchiro serve` on homes under .scratch; no real agent, no ~/.nunchiro."""
import os
import subprocess
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
BINARY = os.path.join(ROOT, "target", "debug", "nunchiro")


def run(script, *args, **env):
    return subprocess.run(["sh", os.path.join(ROOT, "scripts", "scenario", script), *args], cwd=ROOT, capture_output=True,
                          text=True, timeout=180, env={**os.environ, **env})


@unittest.skipUnless(os.access(BINARY, os.X_OK), "build first: cargo build -p nunchiro")
class AcpScenarios(unittest.TestCase):
    def test_every_acp_card_has_a_row(self):
        rows = run("acp-problems.sh", "--list").stdout.split()
        self.assertEqual(rows, ["not_installed", "logged_out", "no_answer", "refused", "changed", "quiet"])

    def test_refused_and_changed_rows_pass(self):
        out = run("acp-problems.sh", SUBCASES="refused changed")
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("PASS refused", out.stdout)
        self.assertIn("PASS changed", out.stdout)
        self.assertIn("acp_problem_cards: PASS (0 failed)", out.stdout)

    def test_real_agent_script_runs_against_the_fake_agent(self):
        out = run("acp-real-agent.sh")
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn('"kind": "edit"', out.stdout)
        self.assertIn("acp_real_agent_turn: PASS (fake agent)", out.stdout)


if __name__ == "__main__":
    unittest.main()
