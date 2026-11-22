"""V1A-44 paint figures over fixture data: frame and stall counting, stuck terminals, the growth bound, the
read-log rule for painted echoes, web-content process selection, quiet windows, the pass bars, and the
seeded stream generator (byte-identical across runs)."""
import datetime as dt
import hashlib
import os
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
sys.path.insert(0, os.path.join(ROOT, "scripts", "measure"))
sys.path.insert(0, os.path.join(ROOT, "scripts", "measure", "workload"))
import measurelib as ml  # noqa: E402
import stream_agent  # noqa: E402
import stream_gen  # noqa: E402


class Frames(unittest.TestCase):
    def test_late_frames_and_stalls_from_timestamps(self):
        # intervals: 16, 17, 40 (late), 16, 250 (late and stall), 16
        ts = [0, 16, 33, 73, 89, 339, 355]
        s = ml.frame_stats(ts)
        self.assertEqual((s["frames"], s["late"], s["stalls"], s["worst_ms"]), (7, 2, 1, 250))

    def test_exactly_on_the_threshold_is_not_late(self):
        s = ml.frame_stats([0, 33, 66, 266])
        self.assertEqual((s["late"], s["stalls"]), (1, 0))

    def test_fewer_than_two_frames_is_no_figure(self):
        self.assertEqual(ml.frame_stats([5])["worst_ms"], None)
        self.assertEqual(ml.frame_stats([])["frames"], 0)

    def test_throttled_idle_rate_marks_the_frames_invalid(self):
        self.assertTrue(ml.frames_valid(58.5))
        self.assertTrue(ml.frames_valid(43))  # headed Chromium under load 11: slow, still measured
        self.assertTrue(ml.frames_valid(30))
        self.assertFalse(ml.frames_valid(29.9))
        self.assertFalse(ml.frames_valid(12))  # headless Chromium
        self.assertFalse(ml.frames_valid(None))


class Stuck(unittest.TestCase):
    def test_gap_over_the_limit_is_stuck(self):
        painted = {"s0": [1, 3, 5, 7, 9], "s1": [1, 3, 9.5]}
        self.assertEqual(ml.stuck(painted, ["s0", "s1"], start=0, end=10), {"s1": 6.5})

    def test_terminal_that_never_painted_a_heartbeat_is_stuck(self):
        self.assertEqual(ml.stuck({}, ["s0"], start=0, end=10), {"s0": 10})

    def test_last_heartbeat_too_old_at_the_end_is_stuck(self):
        self.assertEqual(ml.stuck({"s0": [1, 3]}, ["s0"], start=0, end=10), {"s0": 7})

    def test_boundary_five_seconds_is_not_stuck_five_and_a_half_is(self):
        self.assertEqual(ml.stuck({"s0": [2, 7, 9], "s1": [2, 7.5, 9]}, ["s0", "s1"], start=0, end=10), {"s1": 5.5})

    def test_first_heartbeat_late_after_start_is_stuck(self):
        self.assertEqual(ml.stuck({"s0": [6, 8, 10]}, ["s0"], start=0, end=10), {"s0": 6})


class Growth(unittest.TestCase):
    def test_end_within_the_bound_of_minute_two(self):
        self.assertEqual(ml.growth([(0, 90), (1, 100), (2, 100), (3, 110), (10, 125)]), (True, 1.25))

    def test_end_above_the_bound_fails(self):
        self.assertEqual(ml.growth([(2, 100), (10, 126)]), (False, 1.26))

    def test_bound_is_compared_before_rounding(self):
        self.assertEqual(ml.growth([(2, 10000), (10, 12501)]), (False, 1.25))

    def test_no_minute_two_sample_is_not_judged(self):
        self.assertEqual(ml.growth([(0, 90), (1, 100)]), (None, None))


class PerTerminal(unittest.TestCase):
    def test_increase_over_baseline_divided_by_terminals(self):
        self.assertEqual(ml.per_terminal(100 * 2**20, 260 * 2**20, 8), 20.0)


class EchoReadRule(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.log = os.path.join(self.dir.name, "echo.log")
        with open(self.log, "w") as f:
            f.write("1000 51\n2000 58\n")  # 'Q' read at 1000 ns, 'X' at 2000 ns

    def tearDown(self):
        self.dir.cleanup()

    def test_painted_and_read_counts_painted_without_read_is_missed(self):
        keys = [dict(hex="51", send_ns=900, done_ns=1500, ms=12.5),   # read inside its window: counts
                dict(hex="58", send_ns=2100, done_ns=2500, ms=9.0),   # read before it was sent: not this key
                dict(hex="5a", send_ns=3000, done_ns=4000, ms=None)]  # never painted
        judged, misses, unread = ml.judge_keys(keys, ml.EchoLog(self.log))
        self.assertEqual((judged, misses, unread), ([12.5, 2000.0, 2000.0], 2, 1))


class WebContent(unittest.TestCase):
    PS = """    1 /sbin/launchd
  100 /opt/homebrew/bin/node
  101 /Users/k/Library/Caches/ms-playwright/webkit-2370/Playwright.app/Contents/MacOS/Playwright
  102 /Users/k/Library/Caches/ms-playwright/webkit-2370/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent.Development
  103 /Users/k/Library/Caches/ms-playwright/webkit-2370/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU.Development
  104 /Users/k/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
  105 /Users/k/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/156/Helpers/Google Chrome for Testing Helper (Renderer).app/Contents/MacOS/Google Chrome for Testing Helper (Renderer)
  106 /Users/k/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/156/Helpers/Google Chrome for Testing Helper (GPU).app/Contents/MacOS/Google Chrome for Testing Helper (GPU)
  200 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent
  201 /Users/k/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/156/Helpers/Google Chrome for Testing Helper (Renderer).app/Contents/MacOS/Google Chrome for Testing Helper (Renderer)
"""
    # 105 disclaims its own responsibility (seen live) but is a child of the browser; 200 and 201 are another run's.
    RESP = {100: 100, 101: 100, 102: 100, 103: 100, 104: 100, 105: 105, 106: 100, 200: 431, 201: 900}

    def test_only_this_runs_web_content_processes(self):
        procs = ml.parse_ps(self.PS)
        tree = [101, 104, 105, 106]
        self.assertEqual(ml.web_content(procs, self.RESP, tree, 100, "webkit"), [102])
        self.assertEqual(ml.web_content(procs, self.RESP, tree, 100, "chromium"), [105])

    def test_unknown_engine_is_refused(self):
        with self.assertRaises(ValueError):
            ml.web_content({}, {}, [], 1, "firefox")


class QuietWindows(unittest.TestCase):
    def at(self, h, m):
        return dt.datetime(2026, 10, 26, h, m, tzinfo=dt.timezone.utc)

    def test_a_phase_that_would_enter_a_window_is_refused(self):
        self.assertEqual(ml.quiet(self.at(19, 40), 10), "19:45-20:15Z")
        self.assertEqual(ml.quiet(self.at(0, 10), 1), "23:30-00:30Z")
        self.assertEqual(ml.quiet(self.at(23, 20), 12), "23:30-00:30Z")

    def test_outside_the_windows_runs(self):
        self.assertIsNone(ml.quiet(self.at(20, 15), 60))
        self.assertIsNone(ml.quiet(self.at(10, 0), 15))
        self.assertIsNone(ml.quiet(self.at(19, 30), 15))


class Bars(unittest.TestCase):
    def test_paint_bar(self):
        self.assertTrue(ml.paint_bar(dict(p95_ms=49.9, n=300, misses=0))[0])
        self.assertFalse(ml.paint_bar(dict(p95_ms=50.0, n=300, misses=0))[0])
        self.assertFalse(ml.paint_bar(dict(p95_ms=10, n=299, misses=0))[0])
        self.assertFalse(ml.paint_bar(dict(p95_ms=10, n=300, misses=1))[0])

    def test_stream_bar_only_judges_stalls_and_probe_at_eight(self):
        ok = dict(painted=[4, 4, 4], terminals=4, stalls=[3, 0, 0], probe_max_ms=900)
        self.assertTrue(ml.stream_bar(ok)[0])
        self.assertFalse(ml.stream_bar(dict(ok, painted=[4, 3, 4]))[0])
        eight = dict(painted=[8], terminals=8, stalls=[0], probe_max_ms=249.9)
        self.assertTrue(ml.stream_bar(eight)[0])
        self.assertFalse(ml.stream_bar(dict(eight, stalls=[1]))[0])
        self.assertFalse(ml.stream_bar(dict(eight, probe_max_ms=250))[0])
        self.assertFalse(ml.stream_bar(dict(eight, probe_max_ms=None))[0])  # no probe painted: not passed

    def test_mem_and_soak_bars(self):
        self.assertTrue(ml.mem_bar(39.9)[0])
        self.assertFalse(ml.mem_bar(40)[0])
        good = dict(minutes=10, crashes=0, stuck={}, growth=(True, 1.1))
        self.assertTrue(ml.soak_bar(good)[0])
        self.assertFalse(ml.soak_bar(dict(good, stuck={"s3": 7.0}))[0])
        self.assertFalse(ml.soak_bar(dict(good, crashes=1))[0])
        self.assertFalse(ml.soak_bar(dict(good, growth=(False, 1.3)))[0])
        self.assertFalse(ml.soak_bar(dict(good, minutes=1, growth=(None, None)))[0])  # a short soak is not a pass


class Generator(unittest.TestCase):
    def test_byte_identical_across_runs_and_pinned(self):
        a, b = stream_gen.generate(256 * 1024), stream_gen.generate(256 * 1024)
        self.assertEqual(a, b)
        self.assertEqual(len(a), 256 * 1024)
        # Pinned: a change to the generator changes every recorded stream; record a new entry that says why.
        self.assertEqual(hashlib.sha256(a).hexdigest(), PINNED_256K)

    def test_cli_writes_the_same_bytes_in_a_fresh_interpreter(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "s.bin")
            p = subprocess.run([sys.executable, "-I", os.path.join(ROOT, "scripts/measure/workload/stream_gen.py"), out,
                                "--size", str(256 * 1024)], capture_output=True, text=True, check=True)
            self.assertEqual(p.stdout.split()[0], PINNED_256K)
            self.assertEqual(open(out, "rb").read(), stream_gen.generate(256 * 1024))

    def test_mix_has_every_kind_and_nothing_that_escapes_its_record(self):
        s = stream_gen.generate(512 * 1024).decode("utf-8")
        self.assertRegex(s, r"\x1b\[38;5;\d+m")           # 256-colour SGR
        self.assertRegex(s, r"\x1b\[1;38;2;\d+;\d+;\d+m")  # truecolour bold
        self.assertRegex(s, r"\r\x1b\[2K")                # line rewrite
        self.assertRegex(s, r"\x1b\[1A\r\x1b\[\d+C")       # cursor up, forward
        self.assertRegex(s, "[가-힣]")
        self.assertRegex(s, "[\U0001F300-\U0001FAFF]")      # emoji
        self.assertRegex(s, "[一-鿿！-～]")  # wide CJK and fullwidth
        # No absolute moves, scroll regions, saved cursor, alternate screen or reset: the agent's status row stays put.
        for bad in (r"\x1b\[\d*(;\d*)?[Hf]", r"\x1b\[\d*;?\d*r", r"\x1b[78]", r"\x1b\[\?", r"\x1bc", "@@"):
            self.assertNotRegex(s, bad)
        # Every cursor-up returns down inside the same record, and records end on a line boundary.
        self.assertEqual(len(re.findall(r"\x1b\[1A", s)), len(re.findall(r"\x1b\[1B", s)))
        self.assertTrue(s.endswith("\r\n"))

    def test_fill_lines_fill_the_width(self):
        lines = stream_gen.fill_lines(50, 120)
        self.assertEqual(len(lines), 50)
        for line in lines:
            text = re.sub(r"\x1b\[[\d;]*m", "", line.decode())
            self.assertLessEqual(stream_gen.cells(text), 120)
            self.assertGreaterEqual(stream_gen.cells(text), 118)


class Chunks(unittest.TestCase):
    def test_chunks_end_on_line_boundaries_and_cover_everything(self):
        data = stream_gen.generate(300_000)
        parts = list(stream_agent.chunks(data, 4096))
        self.assertEqual(b"".join(parts), data)
        self.assertTrue(all(p.endswith(b"\n") for p in parts))
        self.assertTrue(all(len(p) <= 4096 + 4096 for p in parts))

    def test_status_row_keeps_the_cursor_and_the_scroll_region_above_it(self):
        self.assertEqual(stream_agent.status("HB s0 3", 24), b"\x1b7\x1b[1;23r\x1b[24;1H\x1b[0m\x1b[2KHB s0 3\x1b8")
        self.assertEqual(stream_agent.status("x", 2), b"")  # too small for a status row


class Delivery(unittest.TestCase):
    def test_each_byte_counts_once_and_skips_are_gaps(self):
        frames = [[0, 100], [100, 50], [100, 50], [400, 10]]  # the third repeats the second; 150..400 never sent
        self.assertEqual(ml.delivery(frames), dict(bytes=160, skipped=250, frames=3))

    def test_overlapping_frame_counts_only_its_new_bytes(self):
        self.assertEqual(ml.delivery([[0, 100], [50, 100]]), dict(bytes=150, skipped=0, frames=2))


class Round2Analysis(unittest.TestCase):
    """paint.py's round-2 rules over fixture results: the load retry, long tasks at 8 terminals, received bytes."""

    def setUp(self):
        import paint
        self.P = paint
        self.dir = tempfile.TemporaryDirectory()
        self.log = os.path.join(self.dir.name, "echo.log")
        with open(self.log, "w") as f:
            f.write("1000 51\n")

    def tearDown(self):
        self.dir.cleanup()

    def run_job_with(self, results, load_ok=True):
        calls = []
        P = self.P
        saved = P.run_once, P.wait_load
        P.run_once = lambda name, *a: (calls.append(name), dict(results[len(calls) - 1]))[1]
        P.wait_load = lambda *a: load_ok
        try:
            return P.run_job("echo-r0", "webkit", "echo", 5, None, None), calls
        finally:
            P.run_once, P.wait_load = saved

    def test_load_stop_retries_once_then_records_not_run_load(self):
        stop = dict(not_run="not run: load 21 > 20", loads=[21])
        r, calls = self.run_job_with([stop, dict(stop, not_run="not run: load 23 > 20")])
        self.assertEqual(calls, ["echo-r0", "echo-r0-retry"])
        self.assertEqual((r["not_run"], r["retried_after"]), ("not run: load 23 > 20", "not run: load 21 > 20"))

    def test_retry_that_runs_replaces_the_stopped_result(self):
        r, calls = self.run_job_with([dict(not_run="not run: load 21 > 20"), dict(idle_fps=59)])
        self.assertEqual((len(calls), r.get("not_run"), r["retried_after"]), (2, None, "not run: load 21 > 20"))

    def test_no_retry_when_load_never_falls_or_the_stop_was_not_load(self):
        self.assertEqual(self.run_job_with([dict(not_run="not run: load 21 > 20")], load_ok=False)[1], ["echo-r0"])
        self.assertEqual(self.run_job_with([dict(not_run="not run: quiet window 19:45-20:15Z")])[1], ["echo-r0"])

    def stream(self, engine, long=(), delivered=None):
        labels = [f"s{i}" for i in range(8)]
        r = dict(engine=engine, idle_fps=59.0, browser="x", loads=[10, 11], tails=8, echo_log=self.log,
                 recorded=dict(t0=0, frames=list(range(0, 520, 16)), long=[list(x) for x in long]),
                 ends={lb: 500 for lb in labels}, probes=[dict(hex="51", send_ns=900, done_ns=1500, ms=20.0)])
        if delivered is not None:
            r["delivered"] = delivered
        return r

    def test_chromium_long_task_over_200_ms_misses_the_eight_terminal_bar(self):
        self.assertTrue(self.P.stream_row(8, [self.stream("chromium", long=[(100, 200)])], 2**20)["passed"])
        row = self.P.stream_row(8, [self.stream("chromium", long=[(100, 250)])], 2**20)
        self.assertEqual((row["stalls"], row["passed"]), ([1], False))

    def test_received_is_the_mean_per_counted_terminal_in_mib(self):
        got = {"s0": dict(bytes=2 * 2**20), "s1": dict(bytes=4 * 2**20), "s2": None}
        self.assertEqual(self.P.stream_row(8, [self.stream("webkit", delivered=got)], 20 * 2**20)["delivered_mib"], [3.0])
        frames = {"s0": [[0, 2**20], [0, 2**20]], "s1": [[0, 3 * 2**20]]}  # spec's raw frames: a repeat counts once
        r = dict(self.stream("webkit"), wsframes=frames)
        self.assertEqual(self.P.stream_row(8, [r], 20 * 2**20)["delivered_mib"], [2.0])

    def test_webgl_rows_show_a_retry(self):
        run = dict(n=1, renderer="dom", rep=0, idle_fps=59, wall_ms=1000, frames=[0, 16], t0=0, context_lost=0)
        w = self.P.webgl_rows(dict(runs=[run], loads=[9], browser="x", retried_after="not run: load 21 > 20"))
        self.assertEqual(w["retried"], 1)


class MeasurePage(unittest.TestCase):
    def test_measure_page_mounts_xterm_with_the_windows_options(self):
        window = open(os.path.join(ROOT, "web/src/Terminal.tsx"), encoding="utf-8").read()
        page = open(os.path.join(ROOT, "web/measure/page/main.ts"), encoding="utf-8").read()
        self.assertIn("const SCROLLBACK = TERM_DEFAULTS.scrollback;", page)
        self.assertIn("scrollback: SCROLLBACK,", page)
        self.assertIn("...xtermOptions(tp),", window)
        for opt in ("lineHeight: 1.2,", "allowProposedApi: true,"):
            self.assertIn(opt, window)
            self.assertIn(opt, page)
        # The shipped window renders with the DOM renderer by default: GPU rendering (ticket 251) is opt-in, and the
        # WebGL addon is only imported, on demand, behind that setting.
        opts = open(os.path.join(ROOT, "web/src/terminal/options.ts"), encoding="utf-8").read()
        defaults = re.search(r"export const TERM_DEFAULTS: TermPrefs = \{(.*?)\n\};", opts, re.S)[1]
        self.assertRegex(defaults, r"\n  gpu: false,")
        self.assertRegex(defaults, r"\n  scrollback: 5000,")
        self.assertIn("scrollback: p.scrollback,", opts)
        self.assertIn("webgl: p.gpu,", opts)
        self.assertNotIn("from '@xterm/addon-webgl'", window)  # no static import
        self.assertEqual(window.count("addon-webgl"), 1)
        gate = window.index("if (!term || !want.webgl || !ready) return;")
        self.assertLess(gate, window.index("import('@xterm/addon-webgl')"))
        self.assertEqual(window.count("useEffect(", gate, window.index("import('@xterm/addon-webgl')")), 0)
        # The measure page mounts the window's default options; WebGL only inside its own 'webgl' comparison row.
        self.assertNotIn("gpu", page)
        gated = re.findall(r"if \(renderer === 'webgl'\) \{\s*(?:try \{\s*)?const gl = new WebglAddon\(\);", page)
        self.assertEqual(page.count("new WebglAddon()"), len(gated))

    def test_default_suite_does_not_load_the_measure_specs(self):
        cfg = open(os.path.join(ROOT, "web/playwright.config.ts"), encoding="utf-8").read()
        self.assertIn("testDir: 'tests'", cfg)
        self.assertFalse(os.path.exists(os.path.join(ROOT, "web/tests/paint.spec.ts")))


PINNED_256K = "518f32c401419696924ee7aa57f6e0c15c68e4a49be2ea5d52f85377e8bf1e08"

if __name__ == "__main__":
    unittest.main()
