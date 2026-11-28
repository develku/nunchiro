"""The seconds of a computer-use peer task drive (scripts/measure/drive.py): a fixed user time per step plus the app's waits."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "measure"))
import drive  # noqa: E402


class Drive(unittest.TestCase):
    def test_a_step_costs_the_keystroke_level_model_time(self):
        self.assertAlmostEqual(drive.user_seconds("click"), 2.73)
        self.assertAlmostEqual(drive.user_seconds("key"), 1.63)
        self.assertAlmostEqual(drive.user_seconds("key", 2), 1.91)  # Shift+Tab: two keys
        self.assertAlmostEqual(drive.user_seconds("type", 57), 17.31)
        for kind, n in (("drag", 1), ("type", 0)):
            with self.assertRaises(ValueError):
                drive.user_seconds(kind, n)

    def test_a_drive_is_user_time_plus_every_wait_in_full(self):
        steps = [{"kind": "click", "sent": 100.0, "ready": 100.6}, {"kind": "type", "n": 10, "sent": 130.0, "ready": 131.25},
                 {"kind": "key", "sent": 150.0, "ready": 153.0}]
        self.assertEqual(drive.drive_seconds(steps), (13.4, 8.51, [0.6, 1.25, 3.0]))
        # The driver's own pace (30 s and 20 s between the steps above) is in no figure; a picture older than the stamp is no wait.
        self.assertEqual(drive.drive_seconds([{"kind": "click", "sent": 10.0, "ready": 9.9}]), (2.7, 2.73, [0.0]))
        with self.assertRaises(ValueError):
            drive.drive_seconds([])


if __name__ == "__main__":
    unittest.main()
