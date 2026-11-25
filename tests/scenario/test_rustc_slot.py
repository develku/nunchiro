"""scripts/rustc-slot.py (ticket 1133, overload fixes): the machine-wide limit on parallel crate compiles."""
import os
import subprocess
import tempfile
import time
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
WRAPPER = os.path.join(ROOT, "scripts", "rustc-slot.py")
# A fake rustc: notes start and end times, holds its slot for 0.6 s.
FAKE = 'echo "start $(python3 -c "import time;print(time.time())")" >> "$LOG"; sleep 0.6; ' \
       'echo "end $(python3 -c "import time;print(time.time())")" >> "$LOG"'


class RustcSlot(unittest.TestCase):
    def run_many(self, args, count, slots):
        with tempfile.TemporaryDirectory() as t:
            log = os.path.join(t, "log")
            fake = os.path.join(t, "rustc")
            with open(fake, "w") as f:
                f.write("#!/bin/sh\n" + FAKE + "\n")
            os.chmod(fake, 0o755)
            env = dict(os.environ, LOG=log, NUNCHIRO_RUSTC_SLOTS=str(slots), NUNCHIRO_RUSTC_SLOT_DIR=os.path.join(t, "slots"))
            procs = [subprocess.Popen([WRAPPER, fake] + args, env=env) for _ in range(count)]
            for p in procs:
                self.assertEqual(p.wait(timeout=30), 0)
            events = sorted((float(ts), kind) for kind, ts in (l.split() for l in open(log)))
        running = peak = 0
        for _, kind in events:
            running += 1 if kind == "start" else -1
            peak = max(peak, running)
        return peak

    def test_compiles_wait_for_a_slot(self):
        self.assertEqual(self.run_many(["--crate-name", "nunchiro_core", "src/lib.rs"], 5, 2), 2)

    def test_probes_do_not_wait(self):
        self.assertEqual(self.run_many(["-", "--crate-name", "___", "--print=file-names"], 4, 1), 4)

    def test_slot_freed_when_rustc_is_killed(self):
        with tempfile.TemporaryDirectory() as t:
            env = dict(os.environ, NUNCHIRO_RUSTC_SLOTS="1", NUNCHIRO_RUSTC_SLOT_DIR=os.path.join(t, "slots"))
            hold = subprocess.Popen([WRAPPER, "sh", "-c", "sleep 30", "x", "--crate-name", "a"], env=env)
            time.sleep(0.5)
            hold.kill()
            hold.wait()
            start = time.time()
            r = subprocess.run([WRAPPER, "true", "--crate-name", "b"], env=env, timeout=10)
            self.assertEqual(r.returncode, 0)
            self.assertLess(time.time() - start, 2)


    def test_a_foreign_or_open_slot_dir_is_not_used(self):
        # A slot dir others may write is refused: rustc runs without a slot instead of waiting on a lock it cannot trust.
        with tempfile.TemporaryDirectory() as t:
            slots = os.path.join(t, "slots")
            os.mkdir(slots)
            os.chmod(slots, 0o777)
            env = dict(os.environ, NUNCHIRO_RUSTC_SLOTS="1", NUNCHIRO_RUSTC_SLOT_DIR=slots)
            r = subprocess.run([WRAPPER, "true", "--crate-name", "b"], env=env, timeout=10)
            self.assertEqual(r.returncode, 0)
            self.assertEqual(os.listdir(slots), [], "no slot file made in an open dir")


if __name__ == "__main__":
    unittest.main()
