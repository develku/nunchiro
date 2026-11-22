"""The herdr + Ghostty arm's attribution (release.py HerdrGhostty.parts -> measurelib.window_parts)."""
import os, sys, unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../scripts/measure"))
import measurelib as ml  # noqa: E402

# 10 herdr server (pane shell 11 -> claude 12); 20 Ghostty (client 21 under login 22; GPU helper 23 is a
# launchd child answering to Ghostty); 30 another user's Ghostty window and its client, which must never count.
PROCS = {10: "herdr", 11: "zsh", 12: "claude", 20: "ghostty", 21: "herdr", 22: "login", 23: "GhosttyHelper",
         30: "ghostty", 31: "herdr"}
RESPONSIBLE = {10: 10, 11: 10, 12: 10, 20: 20, 21: 20, 22: 20, 23: 20, 30: 30, 31: 30}
SERVER_TREE = {10, 11, 12}


class WindowParts(unittest.TestCase):
    def test_client_and_helpers_count_once_and_the_server_tree_never(self):
        got = ml.window_parts([21, 22], PROCS, RESPONSIBLE, 20, SERVER_TREE)
        self.assertEqual(got, [21, 22, 23])

    def test_another_ghostty_window_is_not_ours(self):
        self.assertNotIn(30, ml.window_parts([21, 22], PROCS, RESPONSIBLE, 20, SERVER_TREE))
        self.assertNotIn(31, ml.window_parts([21, 22], PROCS, RESPONSIBLE, 20, SERVER_TREE))

    def test_a_pane_process_reported_under_the_window_is_not_double_counted(self):
        got = ml.window_parts([21, 12], PROCS, {**RESPONSIBLE, 12: 20}, 20, SERVER_TREE)
        self.assertNotIn(12, got)
        self.assertNotIn(20, got)


if __name__ == "__main__":
    unittest.main()
