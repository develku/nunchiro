"""scripts/measure/measurelib.py over fixture outputs: footprint parsing, WebKit helper attribution,
percentiles, the figures record and the measure lock (ticket 11 edge cases)."""
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "measure"))
import measurelib as ml  # noqa: E402

# macOS 27.0.1 `footprint -f bytes --noCategories 84723 84630 999999`, names changed.
FOOTPRINT = """footprint: Unable to find pid for process matching '999999'
======================================================================
nunchiro-app [84630]: 64-bit    Footprint: 286082728 B (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 286082728 B
    phys_footprint_peak: 585123520 B

======================================================================
com.apple.WebKit.WebContent [84723]: 64-bit    Footprint: 29115448 B (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 29115448 B
    phys_footprint_peak: 29180984 B

======================================================================
Summary Footprint: 315181792 B
======================================================================
"""

# `ps -A -o pid=,comm=`: the WebKit helpers are launchd children (ppid 1), so the tree cannot find them.
PS = """    1 /sbin/launchd
  500 /Volumes/x/target/release/nunchiro
  501 /Users/k/.local/bin/claude
  600 /Volumes/x/target/release/nunchiro-app
  601 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent
  602 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking
  603 /Volumes/x/target/release/nunchiro
  700 /Applications/Safari.app/Contents/MacOS/Safari
  701 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent
"""
RESPONSIBLE = {1: 1, 500: 500, 501: 500, 600: 600, 601: 600, 602: 600, 603: 600, 700: 700, 701: 700}


class Footprint(unittest.TestCase):
    def test_parses_each_process(self):
        self.assertEqual(ml.parse_footprint(FOOTPRINT), {84630: 286082728, 84723: 29115448})

    def test_newer_format_is_refused_with_the_raw_line(self):
        changed = FOOTPRINT.replace("Footprint: 29115448 B", "Footprint: 27.8 MB")
        with self.assertRaises(ml.FormatError) as e:
            ml.parse_footprint(changed)
        self.assertIn("27.8 MB", str(e.exception))

    def test_bare_footprint_line_of_an_exited_process_is_not_a_figure(self):
        text = FOOTPRINT + "\n    Footprint: 278912 B (16384 bytes per page)\n"
        self.assertEqual(ml.parse_footprint(text), {84630: 286082728, 84723: 29115448})

    def test_diagnostic_lines_are_ignored_but_figure_lines_stay_strict(self):
        noisy = "Warnings were encountered while examining the process.\n" + FOOTPRINT
        self.assertEqual(ml.parse_footprint(noisy), {84630: 286082728, 84723: 29115448})
        for bad in ("    phys_footprint: 12 MB", "nunchiro-app [84630]: arm64e    Footprint: 286082728 B"):
            with self.assertRaises(ml.FormatError):
                ml.parse_footprint(FOOTPRINT + bad + "\n")

    def test_helper_that_exited_is_skipped_not_zero(self):
        found = ml.parse_footprint(FOOTPRINT)
        total, skipped = ml.sum_footprint(found, [84630, 84723, 999999], required=[84630])
        self.assertEqual((total, skipped), (286082728 + 29115448, [999999]))

    def test_process_exiting_during_the_read_is_skipped(self):
        # Seen live: an agent's short-lived `bash` child exited while footprint read it.
        gone = FOOTPRINT.replace("Summary Footprint", "bash [30481]: 64-bit\nSummary Footprint")
        # Seen live too, the last one without the tool's prefix:
        gone = ("footprint: Unable to analyze process with pid 65987 (try as root?)\n"
                "Unable to find pid for process matching '28828'\n" + gone)
        gone += "sleep [19873]: Unable to retrieve ledger entry info - No such process\nsleep [19874]: vm.get_owned_vmobjects - No such process\n"  # seen live 2026-11-20
        gone = gone.replace("Summary Footprint: ", "Summary Footprint: 1 B (may be invalid due to errors)\nSummary Footprint: ")
        found = ml.parse_footprint(gone)
        self.assertNotIn(19873, found)
        self.assertNotIn(30481, found)
        self.assertEqual(ml.sum_footprint(found, [84723, 30481])[1], [30481])

    def test_header_broken_over_two_lines_keeps_its_figure(self):
        # Seen live (light-2): the tool wrapped a header, the figure alone on the next line.
        wrapped = FOOTPRINT.replace("Summary Footprint", "bash [30481]: 64-bit\n    Footprint: 295320 B (16384 bytes per page)\nSummary Footprint")
        self.assertEqual(ml.parse_footprint(wrapped)[30481], 295320)
        self.assertEqual(ml.parse_footprint(FOOTPRINT + "    Footprint: 295320 B (16384 bytes per page)\n"), ml.parse_footprint(FOOTPRINT))

    def test_core_or_app_gone_is_an_error(self):
        with self.assertRaises(RuntimeError):
            ml.sum_footprint(ml.parse_footprint(FOOTPRINT), [1], required=[1])

    def test_live_footprint_output_still_parses(self):
        # The real tool on this host, own pid: guards the parser against an OS update.
        out = subprocess.run(["footprint", "-f", "bytes", "--noCategories", str(os.getpid())], capture_output=True, text=True)
        if out.returncode:
            self.skipTest("footprint not available")
        self.assertIn(os.getpid(), ml.parse_footprint(out.stdout + out.stderr))


class Attribution(unittest.TestCase):
    def test_helpers_by_responsible_pid(self):
        procs = ml.parse_ps(PS)
        pids, webkit = ml.attribute(procs, RESPONSIBLE, 600, exclude={500, 501})
        # 603 (the app's own `nunchiro` CLI child) counts; Safari's WebContent (701) does not.
        self.assertEqual(pids, [601, 602, 603])
        self.assertEqual(webkit, [601, 602])

    def test_no_helpers_found(self):
        self.assertEqual(ml.attribute(ml.parse_ps(PS), RESPONSIBLE, 999), ([], []))

    def test_responsibility_call_works_unprivileged(self):
        self.assertEqual(ml.responsible_pid(os.getpid()) > 0, True)


class Stats(unittest.TestCase):
    def test_percentile_nearest_rank(self):
        v = list(range(1, 301))
        self.assertEqual((ml.pct(v, 50), ml.pct(v, 95), ml.pct(v, 100)), (151, 285, 300))

    def test_spread(self):
        self.assertAlmostEqual(ml.spread([90, 100, 110]), 0.2)


class Record(unittest.TestCase):
    def test_fresh_checkout_writes_first_entry_then_newest_first(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "figures.md")
            self.assertIsNone(ml.last_entry("", "footprint"))
            ml.prepend_entry(p, "## one footprint", "footprint", {"rows": {"a": 1}})
            ml.prepend_entry(p, "## two latency", "latency", {"rows": {"l": 5}})
            ml.prepend_entry(p, "## three footprint", "footprint", {"rows": {"a": 2}})
            text = open(p).read()
            self.assertTrue(text.startswith(ml.HEADER.rstrip()))
            self.assertLess(text.index("## three"), text.index("## two"))
            self.assertLess(text.index("## two"), text.index("## one"))
            self.assertEqual(ml.last_entry(text, "footprint"), {"rows": {"a": 2}})
            self.assertEqual(ml.last_entry(text, "latency"), {"rows": {"l": 5}})

    def test_second_lock_refuses(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "measure.lock")
            held = ml.Lock(p)  # noqa: F841
            code = "import sys; sys.path.insert(0, %r); import measurelib as ml; ml.Lock(%r)" % (os.path.dirname(ml.__file__), p)
            r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("refusing to start", r.stderr)


if __name__ == "__main__":
    unittest.main()
