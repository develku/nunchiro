"""scripts/skill-eval.sh (scorecard p31 SK2, SK3; ticket 1130 C-C2 item 1.2, C-C2b), offline: a fake `claude` stands
in for `claude plugin eval` (trigger) and `claude -p` (tasks), and a fake core for `nunchiro serve`, so no model runs
and no real core starts. Checks the arguments each gets; that every tasks run of every case and arm has its own run
folder, core copy, home, trial project and worker label, reached by the agent's Bash through PATH and the session
variables, with only the run's own settings (sandbox allowing that core's socket), no session persistence, and the
plugin only on the with arm; that it grades the transcript with the case's graders; that it removes only what it
made; the kept result (with-skill and baseline scores); the exit codes."""
import json
import os
import subprocess
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
SCRIPT = os.path.join(ROOT, "scripts", "skill-eval.sh")

# trigger: writes a `claude plugin eval` JSON. tasks (-p): appends one JSON line per call to $log/calls with what the
# run sees, then prints a stream-json transcript: the with arm does every step of its case, the baseline only starts.
FAKE_CLAUDE = r"""#!/usr/bin/python3 -I
import json, os, re, shutil, subprocess, sys
log = "__LOG__"
argv = sys.argv[1:]
def opt(name):
    return argv[argv.index(name) + 1] if name in argv else None
with open(log + "/argv", "w") as f:
    f.write("\n".join(argv))
if argv[:2] == ["plugin", "eval"]:
    with open(opt("--json"), "w") as f:
        json.dump({"claudeVersion": "test", "costUsd": 0.25, "partial": False, "durationSeconds": 3, "cases": [
            {"name": "trigger-x", "arms": {"with": [{"score": 1.0, "graders": [{"name": "t", "passed": True}]}]}},
            {"name": "trigger-y", "arms": {"with": [{"score": 0.0, "graders": [{"name": "t", "passed": False}]}]}}]}, f)
    sys.exit(0)
prompt, plugin, cwd = opt("-p"), opt("--plugin-dir"), os.getcwd()
worker = prompt.startswith("Start a Nunchiro")
project = re.search(r"project folder (\S+),", prompt).group(1) if worker else ""
label = re.search(r"worker named (\S+) ", prompt).group(1) if worker else ""
nunchiro = shutil.which("nunchiro")
home = os.environ["NUNCHIRO_HOME"]
for name in ("core-env", "core-pid", "core-writes"):  # the sandboxed core can write only inside its run folder
    shutil.copy(f"{home}/{name}", f"{log}/{name}")
seen = subprocess.run(["/bin/sh", "-c", "nunchiro agent list" + (f"; cat '{project}/secret.txt'" if worker else "")],
                      capture_output=True, text=True).stdout.split()
last = "dead"
if os.path.exists(log + "/last-core-pid"):
    try:
        os.kill(int(open(log + "/last-core-pid").read()), 0)
        last = "alive"
    except OSError:
        pass
shutil.copy(log + "/core-pid", log + "/last-core-pid")
call = {"arm": "with" if plugin else "without", "case": "worker" if worker else "artifact", "cwd": cwd,
        "seen": seen, "project": project, "label": label, "last": last,
        "bin_inside": nunchiro.startswith(cwd + "/") and not os.path.islink(nunchiro),
        "settings": json.loads(opt("--settings")), "sources": opt("--setting-sources"),
        "flags": [a for a in ("--no-session-persistence", "--strict-mcp-config") if a in argv],
        "tools": opt("--tools"), "model": opt("--model"), "budget": opt("--max-budget-usd"),
        "plugin_skills": bool(plugin) and os.path.isdir(plugin + "/skills"),
        "plugin_evals": bool(plugin) and os.path.exists(plugin + "/evals"),
        "token": "NUNCHIRO_TOKEN" in os.environ, "prefix": "CLAUDE_CODE_SHELL_PREFIX" in os.environ,
        "config": os.environ.get("CLAUDE_CONFIG_DIR"), "core_writes": open(log + "/core-writes").read().split()}
with open(log + "/calls", "a") as f:
    f.write(json.dumps(call) + "\n")
def say(ev):
    print(json.dumps(ev))
def bash(cmd):
    say({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {"command": cmd}}]}})
# What an agent could do: replace the copy of the core in its run folder. The supervisor must never run it; if it
# did, the copy would stop the test's canary (a signal, since writes outside the run folder are refused).
with open(nunchiro, "w") as f:
    f.write("#!/bin/sh\nkill " + os.environ["FAKE_CANARY"] + "\n")
say({"type": "system", "subtype": "init", "claude_code_version": "test"})
if os.environ.get("FAKE_HANG"):
    sys.stdout.flush()
    child = subprocess.Popen(["/bin/sleep", "300"])
    open(log + "/child-pid", "w").write(str(child.pid))
    os.execv("/bin/sleep", ["sleep", "300"])
if os.environ.get("FAKE_NO_RESULT"):
    sys.exit(1)
if worker:
    bash(f"nunchiro agent start {label} --kind shell --project {project}")
    if plugin:
        say({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Skill", "input": {"skill": "nunchiro:nunchiro"}}]}})
        bash(f"nunchiro agent prompt {label} 'cat secret.txt' --wait --until done")
        bash(f"nunchiro agent read {label} --lines 20")
    text = "The word is " + seen[-1] if plugin else "I could not finish."
else:
    text = "```nunchiro-artifact html\n<html><title>Fruit prices</title></html>\n```" if plugin else "Here it is."
over = bool(os.environ.get("FAKE_OVER"))
say({"type": "result", "subtype": "error_max_budget_usd" if over else "success", "is_error": over, "result": text,
     "total_cost_usd": 0.25, "duration_ms": 3000})
"""

FAKE_CORE = r"""#!/bin/sh
log=__LOG__
case "$1 ${2:-}" in
  "serve ")
    env > "$NUNCHIRO_HOME/core-env"
    echo $$ > "$NUNCHIRO_HOME/core-pid"
    w=refused t=refused
    touch "$log/outside-$$" 2>/dev/null && w=allowed
    touch "$TMPDIR/inside" 2>/dev/null && t=allowed
    echo "$w $t" > "$NUNCHIRO_HOME/core-writes"
    exec /usr/bin/python3 -c 'import os, socket, time
s = socket.socket(socket.AF_UNIX); s.bind(os.environ["NUNCHIRO_HOME"] + "/core.sock"); time.sleep(600)' ;;
  "serve stop") ;;
  *) echo "core=$NUNCHIRO_HOME session=$NUNCHIRO_SESSION" ;;
esac
"""
KEEP = ["nunchiro-skill-trial", "se.keepme", "skill-trial.keepme"]


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
        self.canary = subprocess.Popen(["/bin/sleep", "600"])
        self.addCleanup(self.canary.wait)
        self.addCleanup(self.canary.kill)
        # Not this script's: folders with old and look-alike trial names; all must survive every run.
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

    def run_eval(self, mode, *args, script=SCRIPT, **env):
        full = dict(os.environ, CLAUDE_BIN=self.claude, NUNCHIRO_BIN=self.core, SKILL_EVAL_OUT=self.out,
                    TMPDIR=self.dir, NUNCHIRO_TOKEN="owner-token", CLAUDE_CODE_SHELL_PREFIX="/owner/prefix")
        for k in ("NUNCHIRO_SESSION", "NUNCHIRO_HOME", "SKILL_EVAL_MODEL", "SKILL_EVAL_RUNS", "SKILL_EVAL_RAW",
                  "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "SKILL_EVAL_TIMEOUT"):
            full.pop(k, None)
        full.update(env)
        full["FAKE_CANARY"] = str(self.canary.pid)
        return subprocess.run(["sh", script, mode, *args], env=full, capture_output=True, text=True, timeout=120)

    def read(self, name):
        with open(os.path.join(self.log, name)) as f:
            return f.read()

    def kept(self):
        with open(self.out) as f:
            return json.load(f)

    def calls(self):
        return [json.loads(line) for line in self.read("calls").splitlines()]

    def left_in_tmp(self):
        return sorted(n for n in os.listdir(self.dir)
                      if n not in ("log", "evidence", "claude", "nunchiro", "raw", "root"))

    def test_trigger_runs_one_arm_on_a_copy_and_keeps_the_result(self):
        r = self.run_eval("trigger")
        self.assertEqual(r.returncode, 1, r.stderr)  # the fake's trigger-y case is below 1.0
        argv = self.read("argv").split("\n")
        self.assertEqual(argv[:2], ["plugin", "eval"])
        self.assertTrue(argv[2].startswith(self.dir) and argv[2] != os.path.join(ROOT, "plugin"))
        args = " ".join(argv)
        for want in ("--tag trigger", "--ablation none", "--model haiku", "--runs 1", "--max-cost-usd 5",
                     "--no-publish", "--trust-plugin"):
            self.assertIn(want, args)
        self.assertFalse(os.path.exists(os.path.join(self.log, "calls")), "trigger runs no claude -p")
        self.assertFalse(os.path.exists(os.path.join(self.log, "core-env")), "trigger starts no core")
        self.assertEqual(self.left_in_tmp(), KEEP)
        kept = self.kept()
        self.assertEqual((kept["mode"], kept["model"], kept["costUsd"], kept["evals"]), ("trigger", "haiku", 0.25, 1))

    def test_each_case_arm_and_run_gets_its_own_folder_core_and_label(self):
        r = self.run_eval("tasks", SKILL_EVAL_RUNS="2")
        self.assertEqual(r.returncode, 0, r.stderr)
        calls = self.calls()
        self.assertEqual([(c["case"], c["arm"]) for c in calls],
                         [("artifact", "with"), ("artifact", "without"), ("worker", "with"), ("worker", "without")] * 2)
        self.assertEqual(len({c["cwd"] for c in calls}), 8)
        worker = [c for c in calls if c["case"] == "worker"]
        self.assertEqual([len({c[k] for c in worker}) for k in ("project", "label")], [4, 4])
        for c in calls:
            cwd = c["cwd"]
            self.assertRegex(cwd, "^" + self.dir + r"/se\.\w+$")
            self.assertEqual(c["seen"][:2], ["core=" + cwd + "/ns-h", "session=skill-trial"])
            self.assertTrue(c["bin_inside"], "the core binary is a copy inside the run folder")
            self.assertEqual(c["last"], "dead", "the previous run's core is stopped before the next starts")
            self.assertEqual(c["sources"], "", "no user, project or local settings")
            self.assertEqual(c["flags"], ["--no-session-persistence", "--strict-mcp-config"])
            sandbox = c["settings"]["sandbox"]
            self.assertTrue(sandbox["enabled"])
            self.assertFalse(sandbox["allowUnsandboxedCommands"])
            self.assertEqual(sandbox["network"]["allowUnixSockets"], [cwd + "/ns-h/core.sock"])
            self.assertFalse(c["settings"]["autoMemoryEnabled"])
            hidden = sandbox["filesystem"]["denyRead"]
            self.assertIn(ROOT, hidden, "the repository with its cases and graders is hidden")
            self.assertTrue(any(h.startswith(self.dir + "/skill-eval.") and h.endswith("/c") for h in hidden))
            self.assertEqual(c["settings"]["permissions"]["deny"], ["Read(/" + h + "/**)" for h in hidden])
            self.assertEqual(c["core_writes"], ["refused", "allowed"], "the core writes only inside its run folder")
            self.assertIsNone(c["config"], "no credential given: the caller's Claude home")
            self.assertEqual((c["model"], c["budget"]), ("sonnet", "5"))
            self.assertFalse(c["token"] or c["prefix"], "the caller's token and shell prefix stay out")
            self.assertEqual((c["plugin_skills"], c["plugin_evals"]), (c["arm"] == "with", False))
        for c in worker:
            self.assertEqual(c["seen"][-1], "kumquat-7731")
            self.assertEqual(c["project"], c["cwd"] + "/project")
            self.assertRegex(c["label"], r"^w-\w+$")
            self.assertEqual(c["tools"], "Skill,Bash")
        self.assertIsNone(self.canary.poll(), "the run folder's copy of the core is never run")
        core = dict(line.split("=", 1) for line in self.read("core-env").splitlines() if "=" in line)
        home = core["NUNCHIRO_HOME"]
        self.assertEqual((core["HOME"], core["CLAUDE_CONFIG_DIR"]), (home + "/sentinel", home + "/claude-home"))
        self.assertEqual(core["NUNCHIRO_LOGIN_PATH"], "off")
        self.assertNotIn("NUNCHIRO_TOKEN", core)
        self.assertEqual(self.left_in_tmp(), KEEP, "only what the run made is removed")
        kept = self.kept()
        artifact, worker = kept["cases"]
        # skill-loaded is left out of both arms: with = all five task graders, baseline = started only.
        self.assertEqual((worker["name"], worker["with_skill"], worker["baseline"], worker["delta"]),
                         ("task-worker", 1.0, 0.2, 0.8))
        self.assertEqual(worker["graders"][0], {"started": True, "prompted": True, "waited": True, "read": True,
                                                "answer": True, "skill-loaded": True})
        self.assertEqual((artifact["name"], artifact["with_skill"], artifact["baseline"]), ("task-artifact", 1.0, 0.0))
        self.assertEqual((kept["evals"], kept["costUsd"], kept["aggregates"]["casesPassed"]), (8, 2.0, 2))

    def test_one_case_by_name_and_raw_transcripts(self):
        raw = os.path.join(self.dir, "raw")
        r = self.run_eval("tasks", "task-worker", SKILL_EVAL_RAW=raw)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual([(c["case"], c["arm"]) for c in self.calls()], [("worker", "with"), ("worker", "without")])
        self.assertEqual(sorted(os.listdir(raw)), ["1-with-task-worker.json", "1-with-task-worker.jsonl",
                                                   "1-without-task-worker.json", "1-without-task-worker.jsonl"])

    def test_credential_in_env_gets_its_own_claude_home(self):
        r = self.run_eval("tasks", "task-artifact", CLAUDE_CODE_OAUTH_TOKEN="test-value")
        self.assertEqual(r.returncode, 0, r.stderr)
        for c in self.calls():
            self.assertRegex(c["config"], "^" + self.dir + r"/skill-eval\.\w+/claude-home\.")
        self.assertEqual(self.left_in_tmp(), KEEP)

    def test_timeout_stops_the_whole_process_group(self):
        r = self.run_eval("tasks", "task-artifact", FAKE_HANG="1", SKILL_EVAL_TIMEOUT="2")
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertEqual(self.kept()["cases"][0]["errors"], ["with: timed out after 2s", "without: timed out after 2s"])
        child = int(self.read("child-pid"))
        with self.assertRaises(ProcessLookupError):
            os.kill(child, 0)

    def fake_root(self, case_text):
        root = os.path.join(self.dir, "root")
        os.makedirs(os.path.join(root, "scripts"))
        subprocess.run(["cp", SCRIPT, os.path.join(root, "scripts")], check=True)
        subprocess.run(["cp", "-R", os.path.join(ROOT, "plugin"), root], check=True)
        os.makedirs(os.path.join(root, "plugin", "evals", "task-odd"))
        with open(os.path.join(root, "plugin", "evals", "task-odd", "case.yaml"), "w") as f:
            f.write(case_text)
        return os.path.join(root, "scripts", "skill-eval.sh")

    def test_yaml_object_tags_are_refused(self):
        script = self.fake_root("--- !ruby/object:Gem::Requirement\nname: task-odd\n")
        r = self.run_eval("tasks", "task-odd", script=script)
        self.assertEqual(r.returncode, 3)
        self.assertIn("DisallowedClass", r.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.log, "calls")), "no run for a refused case")
        self.assertEqual(self.left_in_tmp(), KEEP)

    def test_case_schema_is_checked(self):
        bad = ("name: task-odd\nexecution:\n  prompt: hi\n  allowed_tools: [Bash]\n"
               "graders:\n  - name: g\n    type: shell\n    command: rm -rf /\n")
        r = self.run_eval("tasks", "task-odd", script=self.fake_root(bad))
        self.assertEqual(r.returncode, 3)
        self.assertIn("grader g", r.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.log, "calls")), "no run for a refused case")

    def test_unknown_case_is_usage(self):
        self.assertEqual(self.run_eval("tasks", "trigger-nunchiro").returncode, 64)
        self.assertEqual(self.left_in_tmp(), KEEP)

    def test_early_failure_removes_nothing_it_did_not_make(self):
        r = self.run_eval("tasks", NUNCHIRO_BIN=os.path.join(self.dir, "missing"))
        self.assertEqual(r.returncode, 3)
        self.assertEqual(self.left_in_tmp(), KEEP)

    def test_no_result_is_an_error_and_cleans_up(self):
        r = self.run_eval("tasks", FAKE_NO_RESULT="1")
        self.assertEqual(r.returncode, 3)
        self.assertIn("wrote no result", r.stderr)
        self.assertEqual(self.left_in_tmp(), KEEP)

    def test_cost_ceiling(self):
        r = self.run_eval("tasks", "task-artifact", FAKE_OVER="1")
        self.assertEqual(r.returncode, 2)
        self.assertEqual(self.kept()["cases"][0]["errors"], ["with: error_max_budget_usd",
                                                             "without: error_max_budget_usd"])

    def test_usage(self):
        self.assertEqual(self.run_eval("everything").returncode, 64)


if __name__ == "__main__":
    unittest.main()
