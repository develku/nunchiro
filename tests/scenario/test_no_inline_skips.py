"""Ticket 1144 (TR1): skipped tests are counted with the scorecard judge's own greps and stay at 5 or fewer.
An opt-in or one-browser test leaves the default run by a Playwright tag and a project filter (web/playwright.config.ts:
@shots, @live, @chromium, @webkit), never by an inline .skip/.fixme; a Rust test leaves by a Cargo feature run weekly
(tests/scenario/test_rust_no_ignored.py), never by #[ignore]."""
import os
import re
import subprocess
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
WEB = re.compile(r"\.(skip|fixme)\(")  # the judge: grep -rnE '\.(skip|fixme)\(' web/tests
LIMIT = 5


def hits(paths, keep):
    files = subprocess.run(["git", "ls-files", "--", *paths], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
    out = []
    for f in files:
        p = os.path.join(ROOT, f)
        if os.path.isfile(p):
            out += [f"{f}:{n}" for n, line in enumerate(open(p, encoding="utf-8", errors="replace"), 1) if keep(line)]
    return out


class NoInlineSkips(unittest.TestCase):
    def test_skips_at_most_five(self):
        web = hits(["web/tests"], WEB.search)
        rust = hits(["*.rs"], lambda line: line.lstrip().startswith("#[ignore"))
        self.assertLessEqual(len(web) + len(rust), LIMIT, "\n".join(web + rust))


if __name__ == "__main__":
    unittest.main()
