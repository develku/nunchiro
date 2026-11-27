"""p35's bot task set (scripts/measure/bottasks.py): every task's checker passes a right result and fails a wrong one,
fresh fixture copies, and the two figures."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "measure"))
import bottasks as b  # noqa: E402

GIT = ["git", "-c", "user.name=T", "-c", "user.email=t@example.com"]


def sh(cwd, *cmd):
    subprocess.run(list(cmd), cwd=cwd, check=True, capture_output=True)


def edit(path, old, new):
    text = path.read_text()
    assert old in text, (path, old)
    path.write_text(text.replace(old, new, 1))


def add_op(repo, name, expr, test):
    edit(repo / "calc/core.py", '    "div": lambda a, b: a / b,\n', f'    "div": lambda a, b: a / b,\n    "{name}": {expr},\n')
    (repo / f"tests/test_{name}.py").write_text(
        f"import unittest\n\nfrom calc import core\n\n\nclass T(unittest.TestCase):\n    def test_{name}(self):\n        {test}\n")


def median(repo):
    edit(repo / "calc/stats.py", '"""Statistics over many numbers."""\n',
         '"""Statistics over many numbers."""\nimport statistics\n')
    (repo / "calc/stats.py").write_text((repo / "calc/stats.py").read_text()
                                        + "\n\ndef median(texts):\n    return statistics.median(parse_number(t) for t in texts)\n")
    edit(repo / "calc/cli.py", '    m.add_argument("values", nargs="+")\n',
         '    m.add_argument("values", nargs="+")\n    md = sub.add_parser("median")\n    md.add_argument("values", nargs="+")\n')
    edit(repo / "calc/cli.py", '        return stats.mean(args.values)\n',
         '        return stats.mean(args.values)\n    if args.command == "median":\n        return stats.median(args.values)\n')
    (repo / "tests/test_median.py").write_text(
        "import unittest\n\nfrom calc import stats\n\n\nclass T(unittest.TestCase):\n"
        "    def test_median(self):\n        self.assertEqual(stats.median(['1', '2', '3', '4']), 2.5)\n")


def commit(repo, msg):
    sh(repo, *GIT, "add", "-A")
    sh(repo, *GIT, "commit", "-qm", msg)


class Tasks(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)

    def run_of(self, task):
        d, where, first = b.setup(task, 1, self.root)
        self.assertNotIn(str(b.FIX), first)  # the message never points at the answer keys
        return d

    def verdict(self, d, touches=0, **obs):
        return b.check(d, touches, obs)

    def assertPass(self, d, **obs):
        r = self.verdict(d, **obs)
        self.assertTrue(r["passed"], r["why"])

    def assertFail(self, d, why, **obs):
        r = self.verdict(d, **obs)
        self.assertFalse(r["passed"])
        self.assertTrue(any(why in w for w in r["why"]), r["why"])

    def test_fresh_copy_keeps_the_keys_out(self):
        d = self.run_of(8)
        self.assertEqual(len(list((d / "inbox").glob("*.eml"))), 10)
        self.assertFalse(list(d.rglob("key.json")))
        c = self.run_of(10)
        self.assertEqual([p.name for p in (c / "calendar").iterdir()], ["week.ics"])
        r = self.run_of(1)
        self.assertNotEqual(r, d)
        self.assertEqual(subprocess.run(["git", "status", "--porcelain"], cwd=r / "repo", capture_output=True, text=True).stdout, "")

    def test_calendar_key_matches_the_ics(self):
        key = json.loads((b.FIX / "calendar/key.json").read_text())
        ics = (b.FIX / "calendar/week.ics").read_text()
        day = key["day"].replace("-", "")
        busy = sorted(re.findall(rf"DTSTART:{day}T(\d\d)(\d\d)00\s+DTEND:{day}T(\d\d)(\d\d)00", ics))
        free, at = [], key["hours"][0]
        for sh_, sm, eh, em in busy:
            if f"{sh_}:{sm}" > at:
                free.append([at, f"{sh_}:{sm}"])
            at = max(at, f"{eh}:{em}")
        if at < key["hours"][1]:
            free.append([at, key["hours"][1]])
        self.assertEqual(free, key["free"])

    def test_1_failing_test(self):
        d = self.run_of(1)
        self.assertFail(d, "not green")
        repo = d / "repo"
        test = repo / "tests/test_core.py"
        edit(test, '"7", "2"), 3.5', '"7", "2"), 3')
        self.assertFail(d, "tests/test_core.py was changed")
        shutil.copy(b.FIX / "repo/tests/test_core.py", test)
        edit(repo / "calc/core.py", "a // b", "a / b")
        self.assertPass(d)
        self.assertFalse(self.verdict(d, touches=1)["passed"])  # an owner input fails the run

    def test_2_cli_flag(self):
        d = self.run_of(2)
        self.assertFail(d, "--precision")
        repo = d / "repo"
        edit(repo / "calc/cli.py", '    sub = parser.add_subparsers',
             '    parser.add_argument("--precision", type=int, help="round the result to N decimal places")\n'
             '    sub = parser.add_subparsers')
        edit(repo / "calc/cli.py", "    print(show(run(argv)))",
             "    args = build_parser().parse_args(argv)\n    value = run(argv)\n"
             "    print(show(round(value, args.precision) if args.precision is not None else value))")
        self.assertFail(d, "the suite ran 9 tests")  # no new test yet
        edit(repo / "tests/test_cli.py", "    def test_mean(self):",
             "    def test_precision(self):\n        self.assertEqual(out('--precision', '2', 'div', '10', '3'), '3.33')\n\n"
             "    def test_mean(self):")
        self.assertPass(d)

    def test_3_rename(self):
        d = self.run_of(3)
        repo = d / "repo"
        for f in ("calc/numbers.py", "calc/core.py", "calc/cli.py", "calc/stats.py"):
            (repo / f).write_text((repo / f).read_text().replace("parse_number", "to_number"))
        self.assertFail(d, "old name is still in tests/test_numbers.py")
        f = repo / "tests/test_numbers.py"
        f.write_text(f.read_text().replace("parse_number", "to_number"))
        self.assertPass(d)

    def test_4_two_workers_merged(self):
        d = self.run_of(4)
        repo = d / "repo"
        add_op(repo, "mul", "lambda a, b: a * b", "self.assertEqual(core.apply('mul', '4', '3'), 12)")
        commit(repo, "mul")
        self.assertFail(d, "median")
        sh(repo, *GIT, "checkout", "-qb", "median", "HEAD~1")
        median(repo)
        commit(repo, "median")
        self.assertFail(d, "median")  # on its own branch, not on main yet
        sh(repo, *GIT, "checkout", "-q", "main")
        sh(repo, *GIT, "merge", "-q", "--no-edit", "median")
        self.assertPass(d)

    def test_5_review_names_the_planted_line(self):
        d = self.run_of(5)
        self.assertFail(d, "no REVIEW.md")
        review = d / "repo/REVIEW.md"
        review.write_text("Line 12: the docstring could say more.\nclamp_all looks fine.\n")
        self.assertFail(d, "line 15")
        review.write_text("calc/stats.py:15 `min(value, low)` should be `min(value, high)`.\n")
        self.assertPass(d)
        review.write_text("Bug on line 15: clamp uses low twice.\n")
        self.assertPass(d)

    def test_5_a_review_naming_every_line_fails(self):
        d = self.run_of(5)
        review = d / "repo/REVIEW.md"
        review.write_text("Lines 1-40 may hold a bug.\n")
        self.assertFail(d, "names 40 lines")
        review.write_text("stats.py:15 is wrong; see also line 12, lines 18-19.\n")  # 4 lines
        self.assertFail(d, "names 4 lines")
        review.write_text("stats.py:15 uses low twice; L12 and line 18 could be clearer.\n")  # 3 lines
        self.assertPass(d)
        review.write_text("Lines 14–16: the clamp is wrong.\n")  # a range holding 15, en dash
        self.assertPass(d)

    def test_6_stalled_worker(self):
        d = self.run_of(6)
        repo = d / "repo"
        add_op(repo, "pow", "lambda a, b: a ** b", "self.assertEqual(core.apply('pow', '2', '10'), 1024)")
        before, at = self.root / "before.json", 1_800_000_000
        before.write_text(json.dumps([dict(id=i, kind="claude") for i in ("lead", "w1")]))
        os.utime(before, (at, at))  # the stall: before.json is saved right before it

        def journal(*lines, project=repo.resolve()):
            f = self.root / "events.ndjson"
            f.write_text("".join(json.dumps(dict(dict(zip(("type", "session", "at", "state"), l)), project=str(project))) + "\n" for l in lines))
            return dict(stalled="w1", agents_before=str(before), events=str(f))

        ms = at * 1000
        self.assertFail(d, "needs --stalled")
        # The lead went on with w1's seat only, or opened a shell: no fresh agent conversation.
        self.assertFail(d, "no fresh agent", **journal(("state", "w1", ms + 9000, "working"), ("session_started", "sh", ms + 5000, "waiting")))
        # A worker the lead started and dropped before the stall is not fresh.
        self.assertFail(d, "no fresh agent", **journal(("session_started", "w0", ms - 60000, "working"), ("session_ended", "w0", ms - 30000)))
        # A fresh seat that never took a turn is no conversation; another run's sessions are not this run's.
        self.assertFail(d, "no fresh agent", **journal(("session_started", "w2", ms + 5000, "waiting")))
        self.assertFail(d, "no fresh agent", **journal(("session_started", "w2", ms + 5000, "working"), project=self.root / "other" / "repo"))
        self.assertFail(d, "journal is full", **journal(("journal_full", None, ms + 1)))
        # The fresh worker did the work and was closed before the task ended: it is in no list of the end, and it counts.
        self.assertPass(d, **journal(("session_started", "w2", ms + 5000, "waiting"), ("state", "w2", ms + 6000, "working"),
                                     ("session_ended", "w2", ms + 90000)))

    def test_7_pull_request_on_the_bare_remote(self):
        d = self.run_of(7)
        repo = d / "repo"
        self.assertFail(d, "no branch other than main")
        sh(repo, *GIT, "checkout", "-qb", "add-mod")
        add_op(repo, "mod", "lambda a, b: a % b", "self.assertEqual(core.apply('mod', '7', '3'), 1)")
        (repo / "PULL_REQUEST.md").write_text("Adds a mod operation in calc/core.py.\n")
        commit(repo, "mod")
        sh(repo, "git", "push", "-q", "origin", "add-mod")
        self.assertFail(d, "does not name tests/test_mod.py")
        (repo / "PULL_REQUEST.md").write_text("Adds a mod operation in calc/core.py, tested in tests/test_mod.py.\n")
        commit(repo, "summary")
        sh(repo, "git", "push", "-q", "origin", "add-mod")
        self.assertPass(d)
        sh(repo, "git", "push", "-q", "origin", "add-mod:main")
        self.assertFail(d, "origin's main moved")

    def test_8_mail_labels(self):
        d = self.run_of(8)
        self.assertFail(d, "0 of 10")
        mails = json.loads((b.FIX / "mail/key.json").read_text())["mails"]
        for i, (m, label) in enumerate(mails.items()):
            (d / "labels" / label).mkdir(parents=True, exist_ok=True)
            shutil.move(d / "inbox" / m, d / "labels" / label / m)
        self.assertPass(d)
        first = list(mails)[0]
        shutil.copy(d / "labels" / mails[first] / first, d / "labels" / "Meetings" / first)  # also in a wrong label
        self.assertPass(d)  # nine of ten still right
        second = list(mails)[1]
        shutil.move(d / "labels" / mails[second] / second, d / "labels" / "Billing" / second)
        self.assertFail(d, "8 of 10")

    def test_9_draft_not_sent(self):
        d = self.run_of(9)
        draft = d / "drafts" / "reply.eml"
        draft.write_text("To: Jordan Lee <jordan@partner.example.com>\nSubject: Re: Can we find an hour next week?\n\n"
                         "Hi Jordan, Monday 7 December at 11:00 works for me.\n")
        self.assertFail(d, "approval card")
        self.assertPass(d, card_shown=True)
        sh(d, str(d / "bin" / "send-mail"), str(draft))
        self.assertFail(d, "sent: ", card_shown=True)
        empty = self.run_of(9)
        (empty / "drafts" / "reply.eml").write_text("To: jordan@partner.example.com\nSubject: Re: Can we find an hour next week?\n\n")
        self.assertFail(empty, "no draft", card_shown=True)  # no body

    def test_10_free_hour(self):
        d = self.run_of(10)
        p = d / "proposal.txt"
        self.assertFail(d, "0 slots")
        for wrong, why in (("2026-12-07 11:30", "not free"), ("2026-12-07 15:00 or 2026-12-07 11:00", "2 slots"),
                           ("2026-12-08 11:00", "not the asked day"), ("2026-12-07 10:00", "not free")):
            p.write_text(f"How about {wrong}?\n")
            self.assertFail(d, why)
        p.write_text("2026-12-07 15:00\n")
        self.assertPass(d)


class Figures(unittest.TestCase):
    def line(self, task, run, passed, touches=0, at="2026-12-01T10:00:00", fixture="v1"):
        return dict(task=task, run=run, passed=passed, touches=touches, at=at, fixture=fixture)

    def test_all_thirty_runs_on_one_fixture(self):
        lines = [self.line(t, n, passed=t != 1, touches=1 if t == 2 else 0) for t in b.TASKS for n in b.RUNS]
        r = b.figures(lines)
        self.assertTrue(r["complete"])
        self.assertEqual(r["figures"], dict(bot_task_success_pct=90.0, bot_owner_touches=0))
        # a re-check of one run: the newest line counts
        r = b.figures(lines + [self.line(1, 1, passed=True, at="2026-12-02T10:00:00")])
        self.assertEqual(r["figures"]["bot_task_success_pct"], 93.3)

    def test_incomplete_or_mixed_is_not_written(self):
        lines = [self.line(t, n, True) for t in b.TASKS for n in b.RUNS]
        r = b.figures(lines[:-1])
        self.assertFalse(r["complete"])
        self.assertEqual(r["missing"], ["t10r3"])
        self.assertNotIn("figures", r)
        mixed = lines[:-1] + [self.line(10, 3, True, fixture="v2")]
        self.assertFalse(b.figures(mixed)["complete"])


class Scorecard(unittest.TestCase):
    def test_report_writes_the_p35_figures_only_when_complete(self):
        import argparse
        from unittest import mock
        import scorecard as s
        self.assertEqual(set(s.NUMBER_PARTS["p35"]) & s.MANUAL, {"bot_task_success_pct", "bot_owner_touches"})
        with tempfile.TemporaryDirectory() as t:
            jl = Path(t) / "bottasks-2026-12-01.jsonl"
            lines = [dict(task=x, run=n, passed=True, touches=0, at="2026-12-01T10:00:00", fixture="v1")
                     for x in b.TASKS for n in b.RUNS]
            jl.write_text("".join(json.dumps(r) + "\n" for r in lines[:-1]))
            with mock.patch.object(s, "write_manual") as w:
                s.bottasks_cmd(argparse.Namespace(args=["report", str(jl)]))
                w.assert_not_called()
                jl.write_text("".join(json.dumps(r) + "\n" for r in lines))
                s.bottasks_cmd(argparse.Namespace(args=["report", str(jl)]))
            values, evidence = w.call_args.args[1:]
            self.assertEqual(values, dict(bot_task_success_pct=100.0, bot_owner_touches=0))
            manual = dict(date="2026-12-01", figures={k: dict(value=v, evidence=evidence) for k, v in values.items()})
            self.assertEqual(s.manual_figures(manual, "2026-12-02"), values)


if __name__ == "__main__":
    unittest.main()
