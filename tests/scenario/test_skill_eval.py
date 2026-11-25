"""scripts/skill-eval.sh (scorecard p31 SK2, SK3; ticket 1130 C-C2 item 1.2), offline: a fake `claude` stands in for
`claude plugin eval` and a fake core for `nunchiro serve`, so no model runs and no real core starts. Checks the
arguments the eval gets; that every tasks run of every arm has its own core, home, trial project and worker label,
reached by the agent's Bash through the shell prefix, and stopped before the next starts; that it removes only what
it made; the kept result (with-skill and baseline scores); the exit codes."""
import json
import os
import subprocess
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
SCRIPT = os.path.join(ROOT, "scripts", "skill-eval.sh")

# One line per invocation in $log/calls: arm, what the agent's Bash sees, the trial project, the worker label, and
# whether the previous invocation's core still runs. The JSON: the with arm passes started and answer, the baseline
# arm only started; task-artifact is below 1.0 in both.
FAKE_CLAUDE = r"""#!/bin/sh
log=__LOG__
printf '%s\n' "$@" > "$log/argv"
target=$3
arm=without; [ -d "$target/skills" ] && arm=with
json=''; prev=''
for a in "$@"; do [ "$prev" = --json ] && json=$a; prev=$a; done
prompt=$(grep '^  prompt:' "$target/evals/task-worker/case.yaml")
project=$(printf '%s' "$prompt" | sed -n 's/.*project folder \([^,]*\),.*/\1/p')
label=$(printf '%s' "$prompt" | sed -n 's/.*worker named \([^ ]*\) .*/\1/p')
if [ -n "${CLAUDE_CODE_SHELL_PREFIX:-}" ]; then
  bash=$("$CLAUDE_CODE_SHELL_PREFIX" "nunchiro agent list; cat '$project/secret.txt'" 2>&1 | tr '\n' ' ')
  last=dead
  [ -f "$log/last-core-pid" ] && kill -0 "$(cat "$log/last-core-pid")" 2>/dev/null && last=alive
  echo "$arm|$bash|$project|$label|$last" >> "$log/calls"
  cp "$log/core-pid" "$log/last-core-pid"
fi
[ -n "${FAKE_NO_RESULT:-}" ] && exit 1
if [ $arm = with ]; then w=true; else w=false; fi
cat > "$json" <<EOF
{"schemaVersion": 1, "claudeVersion": "test", "costUsd": 0.25, "partial": false, "durationSeconds": 3,
 "aggregates": {"casesTotal": 2, "casesPassed": 1},
 "cases": [
  {"name": "task-worker", "arms": {"with": [{"score": 1.0, "error": null, "graders": [
     {"name": "started", "passed": true}, {"name": "answer", "passed": $w}, {"name": "skill-loaded", "passed": $w}]}]}},
  {"name": "task-artifact", "arms": {"with": [{"score": 0.5, "error": "timed out after 180s", "graders": [
     {"name": "published", "passed": $w}, {"name": "titled", "passed": false}]}]}}]}
EOF
exit "${FAKE_EXIT:-0}"
"""

FAKE_CORE = r"""#!/bin/sh
log=__LOG__
case "$1 ${2:-}" in
  "serve ")
    env > "$log/core-env"
    echo $$ > "$log/core-pid"
    exec /usr/bin/python3 -c 'import os, socket, time
s = socket.socket(socket.AF_UNIX); s.bind(os.environ["NUNCHIRO_HOME"] + "/core.sock"); time.sleep(600)' ;;
  "serve stop") echo stopped >> "$log/core-stop" ;;
  *) echo "core=$NUNCHIRO_HOME session=$NUNCHIRO_SESSION" ;;
esac
"""
KEEP = ["nunchiro-skill-trial", "skill-trial.keepme"]


class SkillEval(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self.addCleanup(self._t.cleanup)
        self.dir = os.path.realpath(self._t.name)
        self.log = os.path.join(self.dir, "log")
        os.mkdir(self.log)
        self.claude = self.fake("claude", FAKE_CLAUDE)
        self.core = self.fake("nunchiro", FAKE_CORE)
        self.out = os.path.join(self.dir, "evidence", "result.json")
        # Not this script's: a folder with the old fixed trial name and a look-alike; both must survive every run.
        for name in KEEP:
            os.makedirs(os.path.join(self.dir, name))
            with open(os.path.join(self.dir, name, "mine.txt"), "w") as f:
                f.write("owner data")

    def fake(self, name, text):
        path = os.path.join(self.dir, name)
        with open(path, "w") as f:
            f.write(text.replace("__LOG__", self.log))
        os.chmod(path, 0o755)
        return path

    def run_eval(self, mode, **env):
        full = dict(os.environ, CLAUDE_BIN=self.claude, NUNCHIRO_BIN=self.core, SKILL_EVAL_OUT=self.out,
                    TMPDIR=self.dir)
        for k in ("NUNCHIRO_SESSION", "NUNCHIRO_TOKEN", "NUNCHIRO_HOME", "SKILL_EVAL_MODEL", "SKILL_EVAL_RUNS",
                  "SKILL_EVAL_RAW", "CLAUDE_CODE_SHELL_PREFIX"):
            full.pop(k, None)
        full.update(env)
        return subprocess.run(["sh", SCRIPT, mode], env=full, capture_output=True, text=True, timeout=120)

    def read(self, name):
        with open(os.path.join(self.log, name)) as f:
            return f.read()

    def kept(self):
        with open(self.out) as f:
            return json.load(f)

    def calls(self):
        return [line.split("|") for line in self.read("calls").splitlines()]

    def left_in_tmp(self):
        return sorted(n for n in os.listdir(self.dir) if n not in ("log", "evidence", "claude", "nunchiro", "raw"))

    def test_trigger_runs_one_arm_on_a_copy_and_keeps_the_result(self):
        r = self.run_eval("trigger")
        self.assertEqual(r.returncode, 1, r.stderr)  # the fake's task-artifact case is below 1.0
        argv = self.read("argv").split("\n")
        self.assertEqual(argv[:2], ["plugin", "eval"])
        self.assertTrue(argv[2].startswith(self.dir) and argv[2] != os.path.join(ROOT, "plugin"))
        args = " ".join(argv)
        for want in ("--tag trigger", "--ablation none", "--model haiku", "--runs 1", "--max-cost-usd 5",
                     "--no-publish", "--trust-plugin"):
            self.assertIn(want, args)
        self.assertNotIn("--allow-tools", args)
        self.assertFalse(os.path.exists(os.path.join(self.log, "calls")), "trigger sets no shell prefix")
        self.assertFalse(os.path.exists(os.path.join(self.log, "core-env")), "trigger starts no core")
        self.assertEqual(self.left_in_tmp(), KEEP)
        kept = self.kept()
        self.assertEqual((kept["mode"], kept["model"], kept["costUsd"], kept["evals"]), ("trigger", "haiku", 0.25, 1))

    def test_each_arm_and_run_gets_its_own_core_trial_and_label(self):
        r = self.run_eval("tasks", SKILL_EVAL_RUNS="2")
        self.assertEqual(r.returncode, 1, r.stderr)  # task-artifact is below 1.0
        calls = self.calls()
        self.assertEqual([c[0] for c in calls], ["with", "without", "with", "without"])
        self.assertEqual([len({c[i] for c in calls}) for i in (1, 2, 3)], [4, 4, 4], "home, project, label")
        for arm, bash, project, label, last in calls:
            self.assertRegex(bash, r"core=" + self.dir + r"/ns-skill\.\w+ session=skill-trial kumquat-7731")
            self.assertTrue(project.startswith(self.dir + "/skill-trial.") and project.endswith("/project"))
            self.assertRegex(label, r"^w-\w+$")
            self.assertEqual(last, "dead", "the previous eval's core is stopped before the next starts")
        self.assertEqual(self.read("core-stop").count("stopped"), 4)
        args = " ".join(self.read("argv").split("\n"))
        for want in ("--tag task", "--ablation none", "--runs 1", "--model sonnet", "--allow-tools Bash"):
            self.assertIn(want, args)
        core = dict(line.split("=", 1) for line in self.read("core-env").splitlines() if "=" in line)
        home = core["NUNCHIRO_HOME"]
        self.assertEqual((core["HOME"], core["CLAUDE_CONFIG_DIR"]), (home + "/sentinel", home + "/claude-home"))
        self.assertEqual(core["NUNCHIRO_LOGIN_PATH"], "off")
        self.assertNotIn("NUNCHIRO_TOKEN", core)
        self.assertEqual(self.left_in_tmp(), KEEP, "only what the run made is removed")
        kept = self.kept()
        worker, artifact = kept["cases"]
        # skill-loaded is left out of both arms: with = started + answer, baseline = started only.
        self.assertEqual((worker["with_skill"], worker["baseline"], worker["delta"]), (1.0, 0.5, 0.5))
        self.assertEqual(len(worker["graders"]), 2)
        self.assertEqual((artifact["with_skill"], artifact["baseline"]), (0.5, 0.0))
        self.assertEqual(artifact["errors"].count("with: timed out after 180s"), 2)
        self.assertEqual((kept["evals"], kept["costUsd"], kept["aggregates"]["casesPassed"]), (4, 1.0, 1))

    def test_early_failure_removes_nothing_it_did_not_make(self):
        r = self.run_eval("tasks", NUNCHIRO_BIN=os.path.join(self.dir, "missing"))
        self.assertEqual(r.returncode, 3)
        self.assertEqual(self.left_in_tmp(), KEEP)

    def test_no_result_is_an_error_and_cleans_up(self):
        r = self.run_eval("tasks", FAKE_NO_RESULT="1")
        self.assertEqual(r.returncode, 3)
        self.assertIn("wrote no result", r.stderr)
        self.assertEqual(self.left_in_tmp(), KEEP)

    def test_cost_ceiling_and_raw_copies(self):
        raw = os.path.join(self.dir, "raw")
        r = self.run_eval("tasks", FAKE_EXIT="2", SKILL_EVAL_RAW=raw)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(sorted(os.listdir(raw)), ["1-with.json", "1-without.json"])

    def test_usage(self):
        self.assertEqual(self.run_eval("everything").returncode, 64)


if __name__ == "__main__":
    unittest.main()
