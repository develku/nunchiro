"""`footprint.sh --compare` rule (ticket 11 Must not break): a rise above the noise band fails unless a
reason is given."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "measure"))
import measurelib as ml  # noqa: E402

PREV = {"nunchiro-open-3": 200.0, "nunchiro-closed-3": 20.0}


class Compare(unittest.TestCase):
    def test_within_band_passes(self):
        ok, _ = ml.compare(PREV, {"nunchiro-open-3": 200.0 * (1 + ml.NOISE_BAND), "nunchiro-closed-3": 18.0}, ml.NOISE_BAND)
        self.assertTrue(ok)

    def test_rise_above_band_fails(self):
        ok, lines = ml.compare(PREV, {"nunchiro-open-3": 260.0, "nunchiro-closed-3": 20.0}, ml.NOISE_BAND)
        self.assertFalse(ok)
        self.assertTrue(any("nunchiro-open-3: rose 200.0 -> 260.0" in l for l in lines))

    def test_reason_accepts_the_rise_and_is_recorded(self):
        ok, lines = ml.compare(PREV, {"nunchiro-open-3": 260.0}, ml.NOISE_BAND, reason="xterm.js 6 upgrade")
        self.assertTrue(ok)
        self.assertIn("rise accepted, reason: xterm.js 6 upgrade", lines)

    def test_first_entry_and_new_rows(self):
        self.assertTrue(ml.compare(None, {"a": 1.0}, ml.NOISE_BAND)[0])
        ok, lines = ml.compare(PREV, {"nunchiro-open-10": 900.0}, ml.NOISE_BAND)
        self.assertTrue(ok)
        self.assertIn("nunchiro-open-10: no previous value", lines)

    def test_reads_previous_entry_from_the_record(self):
        text = '## x\n\n<!-- measure:footprint {"rows": {"nunchiro-open-3": 200.0}} -->\n'
        prev = ml.last_entry(text, "footprint")["rows"]
        self.assertFalse(ml.compare(prev, {"nunchiro-open-3": 260.0}, ml.NOISE_BAND)[0])


if __name__ == "__main__":
    unittest.main()
