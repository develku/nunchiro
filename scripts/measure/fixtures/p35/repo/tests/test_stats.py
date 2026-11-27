import unittest

from calc import stats


class Mean(unittest.TestCase):
    def test_mean(self):
        self.assertEqual(stats.mean(["1", "2", "3", "4"]), 2.5)
