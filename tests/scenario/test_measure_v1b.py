"""V1B-24 memory figures: the deterministic 5,000-event workload and the --v1b compare rule against the v1a entry."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "scripts" / "measure"))
BIN = next((b for b in (ROOT / "target/release/nunchiro", ROOT / "target/debug/nunchiro") if b.is_file()), None)
if BIN:
    os.environ["NUNCHIRO_MEASURE_CORE"] = str(BIN)
sys.path.insert(0, str(ROOT / "scripts" / "scenario"))
import measurelib as ml  # noqa: E402
import release  # noqa: E402
import workload_v1b as w  # noqa: E402

# release.CORE is read from the env once, at release's first import; under discover another test module (baseline,
# paint) imports it first, so the env override above comes too late. The arms read the module global at call time.
if BIN:
    release.CORE = BIN

ARTIFACT_EXT = (".html", ".htm", ".md", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp")


def events_of(lines):
    """Independent count by README "Chat events": one event per text/thinking/tool_use/tool_result block or plain
    string message, one `edit` per structuredPatch, one `artifact` per successful artifact-extension Write."""
    n, artifacts, calls = 0, [], {}
    for line in lines:
        r = json.loads(line)
        c = r["message"]["content"]
        if isinstance(c, str):
            n += 1
            continue
        for b in c:
            n += 1
            if b["type"] == "tool_use":
                calls[b["id"]] = b
            elif b["type"] == "tool_result":
                call = calls[b["tool_use_id"]]
                if call["name"] == "Write" and call["input"]["file_path"].endswith(ARTIFACT_EXT) and not b.get("is_error"):
                    n += 1
                    artifacts.append(call["input"]["file_path"])
        if "structuredPatch" in r.get("toolUseResult", {}):
            n += 1
    return n, artifacts


class Workload(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = w.prepare(self.tmp.name)

    def lines(self):
        return Path(self.out["transcript"]).read_text(encoding="utf-8").splitlines()

    def test_exactly_5000_events_and_the_generator_agrees(self):
        n, _ = events_of(self.lines())
        self.assertEqual((n, self.out["events"]), (5000, 5000))

    def test_three_artifact_writes_with_files_on_disk(self):
        _, artifacts = events_of(self.lines())
        self.assertEqual(sorted(Path(a).name for a in artifacts), ["chart.svg", "notes.md", "report.html"])
        for a in artifacts:
            self.assertTrue(Path(a).is_file())
            self.assertEqual(Path(a).parent, Path(self.out["project"]))

    def test_korean_text_thinking_tool_and_edit_all_present(self):
        text = Path(self.out["transcript"]).read_text(encoding="utf-8")
        self.assertRegex(text, r"[가-힣]")
        for needle in ('"type": "thinking"', '"type": "tool_use"', '"structuredPatch"', '"name": "Edit"', '"name": "Bash"'):
            self.assertIn(needle, text)

    def test_same_bytes_twice_and_idempotent_on_rerun(self):
        first = {k: Path(self.out[k]).read_bytes() for k in ("transcript", "board")}
        mtime = Path(self.out["transcript"]).stat().st_mtime_ns
        self.assertEqual(w.prepare(self.tmp.name), self.out)
        self.assertEqual(first, {k: Path(self.out[k]).read_bytes() for k in ("transcript", "board")})
        self.assertEqual(mtime, Path(self.out["transcript"]).stat().st_mtime_ns)  # unchanged bytes are not rewritten

    def test_board_toml_has_the_default_columns(self):
        text = Path(self.out["board"]).read_text(encoding="utf-8")
        for col in ("working", "needs-decision", "review", "done"):
            self.assertIn(f'id = "{col}"', text)

    def test_wrapper_reports_the_tested_version_and_stays_under_dest(self):
        p = subprocess.run([self.out["bin"] + "/claude", "--version"], capture_output=True, text=True)
        self.assertEqual(p.stdout.strip(), w.VERSION)
        for k in ("bin", "config", "project", "transcript", "board"):
            self.assertTrue(self.out[k].startswith(os.path.realpath(self.tmp.name)), k)

    def test_bin_only_prepare_makes_no_transcript(self):
        with tempfile.TemporaryDirectory() as d:
            out = w.prepare(d, chat=False)
            self.assertNotIn("transcript", out)
            self.assertFalse(Path(d, "transcript.jsonl").exists())


class CoreServes(unittest.TestCase):
    @unittest.skipUnless(BIN, "no nunchiro binary built (cargo build -p nunchiro)")
    def test_core_projects_5000_events_and_detects_3_artifact_cards(self):
        """The count and the cards come from the core's own projection of the generated file, over the fixture CLI."""
        arm = release.Nunchiro(v1b="chat")
        try:
            sid = arm.start(0)
            arm.wait_ready([sid])
            arm.after_ready([sid])  # raises unless 5,000 events, 3 artifact cards, 0 skipped and no untested-version banner
            self.assertEqual(arm.served, {"events": 5000, "artifacts": 3})
            self.assertTrue(str(arm.chat_path).startswith(os.path.realpath(arm.home)))  # the arm's own home, never ~/.claude
        finally:
            arm.stop()


FIGURES = ('## 2026-10-25 12:51 footprint, Nunchiro x\n\n<!-- measure:footprint {"rows": {"nunchiro-open-3": 200.0, '
           '"nunchiro-closed-3": 20.0, "nunchiro-open-10": 250.0}} -->\n')


class CompareV1b(unittest.TestCase):
    def test_v1b_compare_flags_a_rise_over_the_v1a_entry(self):
        ok, lines = ml.compare_v1b(FIGURES, {"nunchiro-v1b-open-3": 300.0, "nunchiro-v1b-closed-3": 21.0}, ml.NOISE_BAND)
        self.assertFalse(ok)
        self.assertTrue(any("nunchiro-v1b-open-3: rose 200.0 -> 300.0" in l for l in lines))
        self.assertTrue(any("nunchiro-v1b-closed-3" in l and "within band" in l for l in lines))

    def test_v1b_compare_accepts_the_rise_with_a_reason(self):
        ok, lines = ml.compare_v1b(FIGURES, {"nunchiro-v1b-open-3": 300.0}, ml.NOISE_BAND, "chat view and artifacts add memory by design")
        self.assertTrue(ok)
        self.assertIn("rise accepted, reason: chat view and artifacts add memory by design", lines)

    def test_missing_v1a_entry_says_there_is_nothing_to_compare(self):
        ok, lines = ml.compare_v1b("# Release figures\n", {"nunchiro-v1b-open-3": 300.0}, ml.NOISE_BAND)
        self.assertTrue(ok)
        self.assertEqual(lines, ["no v1a entry in the record: nothing to compare, first v1b entry written"])

    def test_v1b_entries_do_not_shadow_the_v1a_entry(self):
        text = '<!-- measure:footprint_v1b {"rows": {"nunchiro-v1b-open-3": 999.0}} -->\n' + FIGURES
        self.assertTrue(ml.compare_v1b(text, {"nunchiro-v1b-open-3": 210.0}, ml.NOISE_BAND)[0])


class Spawned(unittest.TestCase):
    def test_spawned_process_is_its_own_responsible_process_and_stops(self):
        with tempfile.TemporaryFile() as out:
            p = ml.Spawned(["/bin/sleep", "30"], dict(os.environ), out)
            try:
                self.assertEqual(ml.responsible_pid(p.pid), p.pid)  # a plain child inherits its launcher's
                self.assertIsNone(p.poll())
            finally:
                p.terminate()
            self.assertEqual(p.wait(timeout=60), 0)  # generous: a demoted process can be slow to exit


class SpawnedFromExternalVolume(unittest.TestCase):
    @unittest.skipUnless(str(ROOT).startswith("/Volumes/"), "the checkout is on the internal disk")
    def test_a_binary_on_an_external_volume_runs_from_a_temp_copy_that_is_removed(self):
        (ROOT / ".scratch").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT / ".scratch") as d, tempfile.TemporaryFile() as out:
            exe = Path(d) / "sleep"
            exe.write_bytes(Path("/bin/sleep").read_bytes())
            exe.chmod(0o755)
            p = ml.Spawned([str(exe), "30"], dict(os.environ), out)
            try:
                ran = subprocess.run(["ps", "-o", "comm=", "-p", str(p.pid)], capture_output=True, text=True).stdout.strip()
                self.assertFalse(ran.startswith("/Volumes/"), ran)
                self.assertTrue(Path(p.copy).is_dir())
            finally:
                p.terminate()
            p.wait(timeout=60)
            self.assertFalse(Path(p.copy).exists())


class SpawnedSignals(unittest.TestCase):
    """No test here waits for a real child to exit: merge gates demote or pause other lanes' processes
    (gate-priority.sh), so a child can take far longer than any fixed timeout. The reaped state is faked."""

    @staticmethod
    def child(pid=999999):
        p = ml.Spawned.__new__(ml.Spawned)  # no process: only the pid bookkeeping is under test
        p.pid, p.code = pid, None
        return p

    def test_a_reaped_child_is_never_signalled_again(self):
        """Its pid may belong to an unrelated process by now (a live trading process runs on this host)."""
        p = self.child()
        with mock.patch.object(ml.os, "waitpid", return_value=(p.pid, 0)), mock.patch.object(ml.os, "kill") as kill:
            self.assertEqual(p.poll(), 0)  # reaped here
            p.terminate()
            p.kill()
        kill.assert_not_called()

    def test_an_unreaped_child_is_signalled_once_per_call(self):
        p = self.child()
        with mock.patch.object(ml.os, "waitpid", return_value=(0, 0)), mock.patch.object(ml.os, "kill") as kill:
            p.terminate()
            p.kill()
        self.assertEqual(kill.call_args_list, [mock.call(p.pid, 15), mock.call(p.pid, 9)])

    def test_a_live_child_is_stopped_by_kill(self):
        with tempfile.TemporaryFile() as out:
            p = ml.Spawned(["/bin/sleep", "30"], dict(os.environ), out)
            p.kill()  # SIGKILL: the cleanup below does not depend on how fast the child starts
            self.addCleanup(p.wait, 60)


class GhosttyRefused(unittest.TestCase):
    def test_v1b_with_ghostty_is_refused_before_anything_starts(self):
        r = subprocess.run([sys.executable, "-B", str(ROOT / "scripts/measure/release.py"), "footprint", "--v1b", "--ghostty"],
                           capture_output=True, text=True, timeout=30)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("--ghostty does not apply to --v1b", r.stderr)


class Delta(unittest.TestCase):
    def test_component_delta_is_v1b_minus_baseline_per_component(self):
        d = ml.component_delta({"core": 10.0, "app": 100.0, "webkit": 150.0}, {"core": 6.0, "app": 90.0, "webkit": 100.0})
        self.assertEqual(d, {"core": 4.0, "app": 10.0, "webkit": 50.0, "total": 64.0})


if __name__ == "__main__":
    unittest.main()
