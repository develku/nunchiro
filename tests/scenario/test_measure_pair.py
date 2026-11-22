"""Round 2 (owner: compare under load): Nunchiro and herdr measured interleaved in one run, paired per row."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "measure"))
import measurelib as ml  # noqa: E402


class Order(unittest.TestCase):
    def test_interleaved_a_b_per_repeat(self):
        self.assertEqual(ml.order([3, 10], 2), [
            (3, 0, "nunchiro"), (3, 0, "herdr"), (3, 1, "nunchiro"), (3, 1, "herdr"),
            (10, 0, "nunchiro"), (10, 0, "herdr"), (10, 1, "nunchiro"), (10, 1, "herdr")])


class Pair(unittest.TestCase):
    def test_medians_ratio_and_spread(self):
        p = ml.pair([200.0, 210.0, 190.0], [400.0, 380.0, 420.0])
        self.assertEqual((p["nunchiro"], p["herdr"], p["ratio"]), (200.0, 400.0, 0.5))
        self.assertAlmostEqual(p["spread_nunchiro"], 0.1)
        self.assertAlmostEqual(p["spread_herdr"], 0.1)

    def test_missing_or_zero_side_has_no_ratio(self):
        self.assertIsNone(ml.pair([200.0], [])["ratio"])
        self.assertIsNone(ml.pair([200.0], [])["herdr"])
        self.assertIsNone(ml.pair([200.0], [0.0])["ratio"])


class Load(unittest.TestCase):
    def test_range_and_extreme_mark(self):
        self.assertEqual(ml.load_range([12.5, 9.0, 17.25]), [9.0, 17.25])
        self.assertIsNone(ml.load_mark([9.0, 17.25]))
        self.assertIn("extreme", ml.load_mark([30.0, ml.LOAD_CAP + 1]))
        self.assertIsNone(ml.load_mark([30.0, ml.LOAD_CAP]))


class Echo(unittest.TestCase):
    def test_reads_only_complete_lines_and_matches_the_window(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "echo.log")
            log = ml.EchoLog(path)
            self.assertIsNone(log.read_between("51", 0, 10**18))  # target not started yet
            with open(path, "w") as f:
                f.write("100 51\n200 eb88")  # second line still being written
            self.assertEqual(log.read_between("51", 50, 150), 100)
            self.assertIsNone(log.read_between("51", 150, 300))  # read before the key was sent: not this key's echo
            self.assertIsNone(log.read_between("eb8888", 0, 10**18))
            with open(path, "a") as f:
                f.write("88\n")
            self.assertEqual(log.read_between("eb8888", 150, 250), 200)


if __name__ == "__main__":
    unittest.main()
