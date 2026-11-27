"""The 24 h soak (scripts/measure/soak.py): which figures a run's samples give, and when they are written."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "measure"))
import soak  # noqa: E402

DAY = 24 * 3600


def run(sessions, ticks, self_test=False):
    head = dict(start="2026-11-27 22:00", sessions=sessions, hours=24, every=600, self_test=self_test)
    return [head] + [dict(dict(t=t, app=app, agents=1, core=True, lost=[], stuck=[]), **extra) for t, app, extra in ticks]


def clean_day(sessions):
    return run(sessions, [(120, 100, {}), (DAY // 2, 110, {}), (DAY + 120, 120, {})])


class Figures(unittest.TestCase):
    def test_a_clean_day_of_5_sessions_gives_the_memory_ratio_only(self):
        f = soak.figures(clean_day(5))
        self.assertEqual(f["written"], dict(mem_growth_24h_ratio=1.2))
        self.assertIn("soak_clean_hours needs exactly 20 sessions, ran 5", f["not_written"])

    def test_a_clean_day_of_20_sessions_gives_the_clean_hours_only(self):
        f = soak.figures(clean_day(20))
        self.assertEqual(f["written"], dict(soak_clean_hours=24))
        self.assertIn("mem_growth_24h_ratio needs exactly 5 sessions, ran 20", f["not_written"])

    def test_another_count_gives_neither(self):
        f = soak.figures(clean_day(6))
        self.assertEqual(f["written"], {})
        self.assertIn("soak_clean_hours needs exactly 20 sessions, ran 6", f["not_written"])

    def test_the_first_failure_ends_the_clean_hours_and_the_ratio(self):
        f = soak.figures(run(20, [(120, 100, {}), (10 * 3600, 105, dict(stuck=["c3"])), (11 * 3600, 106, dict(core=False))]))
        self.assertEqual(f["written"], dict(soak_clean_hours=10.0))
        self.assertEqual(f["failure"], "stuck terminal c3 at 10.0 h")
        f = soak.figures(run(5, [(120, 100, {}), (10 * 3600, 105, dict(stuck=["c3"]))]))
        self.assertIn("mem_growth_24h_ratio: the run failed at 10.0 h", f["not_written"])

    def test_a_stopped_run_writes_nothing(self):
        f = soak.figures(run(20, [(120, 100, {}), (5 * 3600, 101, {})]))
        self.assertEqual(f["written"], {})
        self.assertEqual(f["clean_hours"], 5.0)

    def test_a_self_test_writes_nothing(self):
        day = clean_day(20)
        f = soak.figures([dict(day[0], self_test=True)] + day[1:])
        self.assertEqual(f["written"], {})
        self.assertEqual(f["growth"], 1.2)


if __name__ == "__main__":
    unittest.main()
