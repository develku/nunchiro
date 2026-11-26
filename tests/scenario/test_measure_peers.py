"""Ticket 1171: the peer app measure (scripts/measure/peers.py), its pure parts."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "measure"))
import peers  # noqa: E402


class Peers(unittest.TestCase):
    def test_ps_lines_keep_a_command_with_spaces(self):
        text = "  10     1 /Applications/T3 Code (Beta).app/Contents/MacOS/T3 Code (Beta)\n  11    10 /x/Helper\nbad line\n"
        self.assertEqual(peers.parse_ps3(text), {10: (1, "/Applications/T3 Code (Beta).app/Contents/MacOS/T3 Code (Beta)"), 11: (10, "/x/Helper")})

    def test_tree_is_the_root_and_everything_under_it(self):
        table = {1: (0, "launchd"), 10: (1, "app"), 11: (10, "helper"), 12: (11, "gpu"), 20: (1, "other")}
        self.assertEqual(sorted(peers.tree(table, 10)), [10, 11, 12])

    def test_summary_keeps_the_first_launch_apart(self):
        self.assertEqual(peers.summary([3503, 1390, None, 1458]),
                         {"first_ms": 3503, "warm_median_ms": 1424, "warm_ms": [1390, None, 1458], "missed": 1})
        self.assertEqual(peers.summary([900]), {"first_ms": 900, "warm_median_ms": None, "warm_ms": [], "missed": 0})


if __name__ == "__main__":
    unittest.main()
