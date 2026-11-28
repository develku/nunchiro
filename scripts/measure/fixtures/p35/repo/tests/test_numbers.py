import unittest

from calc.numbers import parse_number


class ParseNumber(unittest.TestCase):
    def test_int(self):
        self.assertEqual(parse_number(" 42 "), 42)
        self.assertIsInstance(parse_number("42"), int)

    def test_float(self):
        self.assertEqual(parse_number("2.5"), 2.5)
        self.assertEqual(parse_number("1e3"), 1000.0)
