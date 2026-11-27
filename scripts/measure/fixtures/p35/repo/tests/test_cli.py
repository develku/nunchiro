import contextlib
import io
import unittest

from calc.cli import main


def out(*argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        main(list(argv))
    return buf.getvalue().strip()


class Cli(unittest.TestCase):
    def test_op(self):
        self.assertEqual(out("add", "1", "2"), "3")

    def test_whole_float(self):
        self.assertEqual(out("div", "6", "2"), "3")

    def test_mean(self):
        self.assertEqual(out("mean", "1", "2"), "1.5")
