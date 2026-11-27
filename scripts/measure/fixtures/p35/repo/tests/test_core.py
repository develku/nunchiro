import unittest

from calc import core


class Ops(unittest.TestCase):
    def test_add(self):
        self.assertEqual(core.apply("add", "1", "2"), 3)

    def test_sub(self):
        self.assertEqual(core.apply("sub", "5", "3"), 2)

    def test_div(self):
        self.assertEqual(core.apply("div", "7", "2"), 3.5)
