"""A web spec that writes under docs/ must be opt-in (UPDATE_DESIGN_SHOTS or a test.skip), so a gate run leaves tracked shots alone."""
import glob
import os
import re
import unittest

TESTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "web", "tests")
WRITES = re.compile(r"screenshot\(|writeFileSync|writeFile\(")
DOCS = re.compile(r"(?i)\b(out|dir|design|shots)\w*\s*=.*docs/design")
OPT_IN = re.compile(r"UPDATE_DESIGN_SHOTS|[sS]kip\(")


def code(text):
    return "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("//"))


class DesignShotsOptIn(unittest.TestCase):
    def test_specs_writing_under_docs_are_opt_in(self):
        bad = []
        for f in sorted(glob.glob(os.path.join(TESTS, "*.ts"))):
            c = code(open(f).read())
            # shortcut: file-level scan, an output dir under docs/design plus any write call; tighten if a spec legitimately mixes both
            if WRITES.search(c) and DOCS.search(c) and not OPT_IN.search(c):
                bad.append(os.path.basename(f))
        self.assertEqual(bad, [], "write to docs/design without an opt-in env check (use UPDATE_DESIGN_SHOTS=1): %s" % bad)

    # test_guard_sees_the_machines_spec_without_its_opt_in removed: machines_matches_draft (ticket 336) was the last spec using UPDATE_DESIGN_SHOTS, so it has nothing to look at.
