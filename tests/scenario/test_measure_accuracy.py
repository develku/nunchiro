"""p34's trial (scripts/measure/accuracy.py): its figures, the screen readings and when a run is counted."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "measure"))
import accuracy as a  # noqa: E402

BOX = "─" * 20


def records(where):
    return dict(sends=[dict(where=where, submitted=True, draft=False), dict(where=where, submitted=False, draft=True)],
                readings=[dict(where=where, shown="blocked", true=["needs_you"]), dict(where=where, shown="idle", true=["working"])],
                cards=[dict(where=where, latency_s=0.4, ids=1), dict(where=where, latency_s=6.0, ids=1), dict(where=where, latency_s=1.0, ids=2)],
                outward=[dict(where=where, sent=True, allowed=True), dict(where=where, sent=True, allowed=False),
                         dict(where=where, sent=False, allowed=False)],
                startup=[dict(where=where, raised=True, latency_s=0.2, ids=1), dict(where=where, raised=True, latency_s=None, ids=0)])


def run(**over):
    full = {k: [dict(r) for r in v * (n // 2 + 1)] for (k, v), n in zip(records("local").items(), a.FULL.values())}
    full["sends"] += [dict(where="remote", submitted=True, draft=False)]
    res = dict(self_test=False, machine="mini", guard_problems=[], seats=[dict(where="remote", machine="mini")],
               agents=[dict(where="local", kind="claude", version="2.1"), dict(where="remote", kind="claude", version="2.1")])
    res.update(over)
    res.setdefault("figures", a.figures(full))
    return res


class Figures(unittest.TestCase):
    def test_four_figures_per_side_and_in_the_total(self):
        f = a.figures({k: v + records("remote")[k] for k, v in records("local").items()})
        self.assertEqual(f["local"]["delivery_missed_per_1000"], 500.0)
        self.assertEqual(f["local"]["missed_with_draft"], 1)
        self.assertEqual(f["remote"]["state_match_pct"], 50.0)
        self.assertEqual(f["remote"]["cards_shown_pct"], 33.3)  # late and doubled cards fail
        self.assertEqual(f["total"]["outward_unapproved"], 2)
        self.assertEqual(f["total"]["startup_cards_pct"], 50.0)  # a start dialog with no card fails
        self.assertEqual(f["total"]["counts"], dict(sends=4, readings=4, cards=6, outward=6, startup=4))

    def test_a_start_dialog_that_never_showed_is_not_scored_but_blocks_the_count(self):
        rec = dict(sends=[], readings=[], cards=[], outward=[], startup=[dict(where="local", raised=False, latency_s=None, ids=0)])
        self.assertIsNone(a.figures(rec)["total"]["startup_cards_pct"])
        res = run()
        res["figures"]["total"]["startup_not_raised"] = 1
        self.assertIn("start dialogs not raised: 1", a.verdict(res)[1])

    def test_waited_minutes_per_day(self):
        lone = dict(waiting=True, cards=0)
        carded, busy = dict(waiting=True, cards=1), dict(waiting=False, cards=0)
        # 2 samples 30 s apart = 1 min of samples; one lone wait of 30 s in it
        samples = [dict(t=0, sessions=[lone, carded]), dict(t=30, sessions=[busy])]
        self.assertEqual(a.waited(samples, 30), round(0.5 / (60 / 86400), 2))
        self.assertIsNone(a.waited([], 30))

    def test_a_side_with_no_records_has_no_figure(self):
        self.assertIsNone(a.figures(records("local"))["remote"]["delivery_missed_per_1000"])


class Counted(unittest.TestCase):
    def test_a_full_real_run_with_the_second_mac_counts(self):
        self.assertEqual(a.verdict(run()), (True, []))

    def test_a_self_test_never_counts(self):
        counted, why = a.verdict(run(self_test=True))
        self.assertFalse(counted)
        self.assertIn("self-test on the fixture agent", why)

    def test_the_fixture_agent_never_counts(self):
        counted, why = a.verdict(run(agents=[dict(where="remote", kind="claude", version="2.1", fake=True)]))
        self.assertFalse(counted)

    def test_no_second_mac_no_count(self):
        for over in (dict(machine=None), dict(seats=[]), dict(seats=[dict(where="remote", machine=None)])):
            counted, why = a.verdict(run(**over))
            self.assertFalse(counted, over)
            self.assertTrue(any("second Mac" in w for w in why), why)

    def test_short_sizes_and_a_config_change_do_not_count(self):
        self.assertFalse(a.verdict(run(guard_problems=[".claude/settings.json changed"]))[0])
        self.assertFalse(a.verdict(run(guard_problems=None))[0])
        res = run()
        res["figures"]["total"]["counts"]["cards"] = 49
        self.assertIn("below the rubric's sizes: cards 49 of 50", a.verdict(res)[1])


class Screen(unittest.TestCase):
    def test_submitted_is_above_the_box_and_exact(self):
        sent = f"> reply ok #3\nok\n{BOX}\n❯ \n{BOX}\n  ⏸ manual mode on"
        self.assertEqual(a.submitted(sent, "reply ok #3"), (True, []))
        typed = f"> reply ok #2\n{BOX}\n❯ reply ok #3\n{BOX}"
        self.assertEqual(a.submitted(typed, "reply ok #3")[0], False)
        glued = f"› half typed reply ok #3\nok\n› Ask Codex to do anything"
        self.assertEqual(a.submitted(glued, "reply ok #3"), (False, ["› half typed reply ok #3"]))

    def test_box_line_is_the_last_prompt_line(self):
        self.assertEqual(a.box_line(f"> reply ok #2\n{BOX}\n❯ half typed reply ok #3\n{BOX}\n  ⏸ manual mode on"),
                         "❯ half typed reply ok #3")

    def test_screen_state(self):
        self.assertEqual(a.screen_state("Bash command\n Do you want to proceed?\n ❯ 1. Yes"), {"needs_you"})
        self.assertEqual(a.screen_state("✻ Thinking…\n  esc to interrupt"), {"working"})
        self.assertEqual(a.screen_state(f"{BOX}\n❯ \n{BOX}"), {"idle", "done"})


if __name__ == "__main__":
    unittest.main()
