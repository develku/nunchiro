"""scripts/check-messages.sh: pull request text that names a ticket number, a personal path or an owner-decision date
is refused; plain text passes. The --pr mode is run against a fake gh."""
import os
import stat
import subprocess
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "check-messages.sh")

GOOD = [
    "composer: a shown chat takes the message box",
    "Fixes the crash from #12; the owner sees 3 cards and one /home page link.",
    "Red first: t_update_keeps_sessions failed at 0b610fc7f",
    "Co-Authored-By: Someone <someone@example.com>",
]
BAD = [
    "bots: the face and the Bots view (ticket " + "1168)",
    "Ticket-" + "77 again",
    "tickets " + "12 and 13",
    "read /Users/" + "sam/notes.md first",
    "built on /Volumes/" + "work/target",
    "logs in /home/" + "ci/run",
    "owner rule " + "11-25: stale tests are deleted",
    "approved by the owner on 2026-" + "11-21",
]


class CheckMessages(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="check-messages-")
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", self.dir]))

    def check(self, text):
        path = os.path.join(self.dir, "message")
        with open(path, "w") as f:
            f.write(text + "\n")
        return subprocess.run(["sh", SCRIPT, path], capture_output=True, text=True)

    def test_plain_text_passes(self):
        r = self.check("\n".join(GOOD))
        self.assertEqual((r.returncode, r.stderr), (0, ""))

    def test_each_private_word_is_refused(self):
        for line in BAD:
            with self.subTest(line=line):
                r = self.check("a fine first line\n" + line)
                self.assertEqual(r.returncode, 1, r.stderr)
                self.assertIn(":2:" + line, r.stderr)

    def test_pr_mode_reads_title_body_and_commits(self):
        # fake gh: the pull request answer has a clean title and body, the commit list one bad message
        gh = os.path.join(self.dir, "gh")
        with open(gh, "w") as f:
            f.write('#!/bin/sh\ncase "$*" in\n'
                    '  *pulls/7/commits*) echo "commit 123456789: core: a fix (ticket " "9)" ;;\n'
                    '  *pulls/7*) echo "core: a fix"; echo "What and why." ;;\n'
                    '  *) exit 1 ;;\nesac\n')
        os.chmod(gh, os.stat(gh).st_mode | stat.S_IXUSR)
        env = dict(os.environ, PATH=self.dir + os.pathsep + os.environ["PATH"])
        r = subprocess.run(["sh", SCRIPT, "--pr", "7"], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("commit-messages:1:commit 123456789", r.stderr)
        self.assertNotIn("title-and-body", r.stderr)
        r = subprocess.run(["sh", SCRIPT, "--pr", "8"], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 2, r.stderr)

    def test_usage(self):
        self.assertEqual(subprocess.run(["sh", SCRIPT], capture_output=True).returncode, 2)
        self.assertEqual(subprocess.run(["sh", SCRIPT, os.path.join(self.dir, "none")], capture_output=True).returncode, 2)


if __name__ == "__main__":
    unittest.main()
