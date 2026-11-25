#!/bin/sh
# Skill evals for the shipped plugin (scorecard p31 SK2, SK3; ticket 1130 C-C2, C-C2b). Keeps a short result in
# docs/measure/evidence/skill-eval-<date>-<mode>.json.
#   trigger  plugin/evals/trigger-*/: `claude plugin eval` on a throwaway copy of plugin/, 8 should-load and 8
#            should-not prompts per skill, one arm (no baseline).
#   tasks    plugin/evals/task-*/: start a worker, prompt, wait, read (a shell worker on a trial core), and publish
#            an artifact. Not `claude plugin eval`: its Bash sandbox refuses to run files outside its own run folder
#            (exit 126), so the agent could not reach a trial core (C-C2). Each case, arm and run is one `claude -p`
#            in its own throwaway folder that holds a copy of the core binary for the agent's Bash, the core's
#            temporary NUNCHIRO_HOME and a fresh trial project; the core (started from the original binary, under
#            sandbox-exec: writes only inside that folder) is stopped and the folder removed after it, so no run sees
#            another's workers. --setting-sources '' keeps the caller's user, project and local settings (plugins,
#            hooks, permissions) out; the run's only settings are a Bash sandbox that may reach this core's socket,
#            read denies on this repository's checkouts and the eval's case files, and no auto memory;
#            --no-session-persistence keeps it out of the caller's history; --strict-mcp-config drops MCP servers.
#            The with arm gets --plugin-dir on a copy of plugin/ (evals removed); the baseline gets no plugin. Each
#            claude runs in its own process group, stopped whole after it or on timeout. Graded from the stream-json
#            transcript with the graders the case declares (safe YAML, schema checked); scores leave out the
#            skill-loaded indicator, so both arms are scored on the task alone.
# Limits (tasks): run only the checked-in cases, on a machine state you could throw away; never untrusted cases.
#   The core and its workers may read anything the caller can, and reach the network; only their writes are held
#   to the run folder. The agent's Bash reads outside the denied paths too. Claude Code itself (not its Bash) runs
#   as the caller: unless CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY is set (then it gets an empty Claude home of
#   its own), it signs in from the caller's Claude home and reads its credentials and app state like any session,
#   with settings sources and session persistence off.
# Costs model tokens, so it is not a gate stage: run it on demand and before a scorecard run. It runs on the caller's
# own Claude credential; nothing here writes ~/.claude settings or ~/.nunchiro, and it removes only the folders it
# made. Exit: 0 every case passed (with skill), 1 a case below 1.0, 2 a cost ceiling hit, 3 no result or setup
# failed, 64 usage.
# Env: SKILL_EVAL_MODEL (default haiku for trigger, sonnet for tasks), SKILL_EVAL_RUNS (default 1),
#      SKILL_EVAL_MAX_COST (USD ceiling per eval invocation or per tasks run, default 5), SKILL_EVAL_OUT (result
#      path), SKILL_EVAL_RAW (a folder: also copy each full result, with grader detail, and each tasks transcript
#      there), CLAUDE_BIN (default claude), NUNCHIRO_BIN (tasks: the core to trial; default: cargo build -p nunchiro
#      and use its debug binary), SKILL_EVAL_TIMEOUT (tasks: seconds per run, overrides the case).
# trigger: extra arguments go to `claude plugin eval` unchanged (e.g. --case 'trigger-nunchiro-load-0*').
# tasks: extra arguments name the task cases to run (default every plugin/evals/task-*).
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
mode=${1:-}
case $mode in
  trigger) tag=trigger model=${SKILL_EVAL_MODEL:-haiku} ;;
  tasks) model=${SKILL_EVAL_MODEL:-sonnet} ;;
  *) echo "usage: scripts/skill-eval.sh trigger [claude plugin eval options] | tasks [case...]" >&2; exit 64 ;;
esac
shift
claude=${CLAUDE_BIN:-claude}
runs=${SKILL_EVAL_RUNS:-1}
budget=${SKILL_EVAL_MAX_COST:-5}
tmp=${TMPDIR:-/tmp}
tmp=${tmp%/}
out=${SKILL_EVAL_OUT:-$root/docs/measure/evidence/skill-eval-$(date +%Y-%m-%d)-$mode.json}
if [ "$mode" = tasks ]; then
  cases=${*:-$(cd "$root/plugin/evals" && echo task-*)}
  for name in $cases; do
    case $name in task-*) [ -f "$root/plugin/evals/$name/case.yaml" ] && continue ;; esac
    echo "skill-eval: no task case $name" >&2
    exit 64
  done
fi
work=$(mktemp -d "$tmp/skill-eval.XXXXXX") || exit 3
run_dir='' home='' serve_pid=''

# Stops this run's core (our own child only) and removes the run folder this run made.
stop_core() {
  if [ -n "$serve_pid" ]; then
    # The original binary, outside the run folder: nothing in the folder the agent could write is executed.
    (core_env "$bin" serve stop --yes) >/dev/null 2>&1
    kill -0 "$serve_pid" 2>/dev/null && kill "$serve_pid" 2>/dev/null
    wait "$serve_pid" 2>/dev/null
  fi
  [ -n "$run_dir" ] && rm -rf "$run_dir"
  serve_pid='' home='' run_dir=''
}
cleanup() {
  stop_core
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# The trial core never sees the caller's home, Claude or Codex config, or login shell, and it and every worker it starts
# run under sandbox-exec: file writes only inside the run folder (its TMPDIR included) and to terminal devices. Reads
# and the network stay open. Call it in a subshell: it execs, so a background start's $! is the core's own pid.
core_env() {
  exec env -i NUNCHIRO_HOME="$home" HOME="$home/sentinel" CLAUDE_CONFIG_DIR="$home/claude-home" \
    CODEX_HOME="$home/codex-home" TMPDIR="$run_dir/tmp" PATH=/usr/bin:/bin SHELL=/bin/sh NUNCHIRO_LOGIN_PATH=off \
    /usr/bin/sandbox-exec -p "(version 1)(allow default)(deny file-write*)(allow file-write* (subpath \"$run_dir\")
      (literal \"/dev/null\") (literal \"/dev/tty\") (literal \"/dev/ptmx\") (regex #\"^/dev/ttys[0-9]+$\")
      (literal \"/dev/dtracehelper\"))" "$@"
}

# A fresh run folder for one task run: a copy of the core binary for the agent's own Bash (Claude's sandbox may
# execute it there), the core's home and a trial project, and the core started on that home from the original binary. Short names: the core's socket path must stay under 104 bytes.
start_core() {
  run_dir=$(mktemp -d "$tmp/se.XXXXXX") && run_dir=$(cd "$run_dir" && pwd -P) || return 1
  # ns- prefix: scripts/check-serve-leak.sh reports a serve left behind on such a home.
  home=$run_dir/ns-h
  mkdir -p "$home/bin" "$home/sentinel" "$run_dir/project" "$run_dir/tmp" || return 1
  echo kumquat-7731 >"$run_dir/project/secret.txt" || return 1
  cp "$bin" "$home/bin/nunchiro" || return 1
  (core_env "$bin" serve) </dev/null >/dev/null 2>"$home/core.log" &
  serve_pid=$!
  i=0
  until [ -S "$home/core.sock" ]; do
    i=$((i + 1))
    [ $i -gt 100 ] && { echo "skill-eval: trial core did not start; its log:" >&2; cat "$home/core.log" >&2; return 1; }
    sleep 0.1
  done
}

cp -R "$root/plugin" "$work/with" || exit 3
results=''
status=0
if [ "$mode" = trigger ]; then
  "$claude" plugin eval "$work/with" --tag "$tag" --ablation none --model "$model" --max-cost-usd "$budget" \
    --no-publish --trust-plugin --runs "$runs" "$@" --json "$work/with.json"
  [ -s "$work/with.json" ] || { echo "skill-eval: claude plugin eval wrote no result" >&2; exit 3; }
  results="with=$work/with.json"
else
  rm -rf "$work/with/evals" && mkdir "$work/c" || exit 3
  if [ -n "${NUNCHIRO_BIN:-}" ]; then
    bin=$NUNCHIRO_BIN
  else
    (cd "$root" && cargo build -q -p nunchiro) || exit 3
    bin=${CARGO_TARGET_DIR:-$root/target}/debug/nunchiro
  fi
  [ -x "$bin" ] || { echo "skill-eval: no core binary at $bin" >&2; exit 3; }
  # One `claude -p` run of one case and arm, graded into the shape `claude plugin eval --json` writes, so the summary
  # below reads both modes alike. Args: case JSON, run folder, core home, plugin dir ('' = baseline), claude, model,
  # budget, transcript, result, the folder of case files and results (hidden from the agent), repository root.
  cat >"$work/run_case.py" <<'EOF'
import json, os, re, signal, subprocess, sys, tempfile

case_json, run_dir, home, plugin, claude, model, budget, transcript, result, cases_dir, root = sys.argv[1:]


def need(ok, what):
    if not ok:
        raise SystemExit(f"skill-eval: {os.path.basename(case_json)}: {what}")


# The case is data: only these keys and types, so an odd file is refused instead of half-run.
case = json.load(open(case_json))
need(isinstance(case, dict) and set(case) <= {"schema_version", "name", "description", "tags", "runs", "execution",
                                              "graders"}, "unknown top-level key")
need(isinstance(case.get("name"), str) and re.fullmatch(r"task-[\w-]+", case["name"]), "name")
ex = case.get("execution")
need(isinstance(ex, dict) and set(ex) <= {"prompt", "append_system_prompt", "allowed_tools", "max_turns",
                                          "timeout_seconds"}, "execution keys")
need(isinstance(ex.get("prompt"), str) and ex["prompt"], "execution.prompt")
need(isinstance(ex.get("append_system_prompt", ""), str), "execution.append_system_prompt")
need(isinstance(ex.get("allowed_tools"), list) and ex["allowed_tools"]
     and all(isinstance(t, str) and re.fullmatch(r"[A-Za-z]+", t) for t in ex["allowed_tools"]), "allowed_tools")
for k in ("max_turns", "timeout_seconds"):
    need(type(ex.get(k, 1)) is int and ex.get(k, 1) > 0, k)
need(isinstance(case.get("graders"), list) and case["graders"], "graders")
for g in case["graders"]:
    need(isinstance(g, dict) and isinstance(g.get("name"), str), "grader name")
    if g.get("type") == "tool_used":
        need(set(g) <= {"name", "type", "tool", "input_match"} and isinstance(g.get("tool"), str)
             and isinstance(g.get("input_match", ""), str), f"grader {g['name']}")
    else:
        need(g.get("type") == "regex" and set(g) <= {"name", "type", "target", "pattern", "flags"}
             and g.get("target", "last_message") == "last_message" and isinstance(g.get("pattern"), str)
             and g.get("flags", "") in ("", "i"), f"grader {g['name']} (tool_used or regex on last_message only)")

# Hidden from the agent's Bash (sandbox denyRead) and its Read, Glob and Grep (Read deny rules): the case files and
# results of this eval, and every checkout of this repository with its git store, where the cases and graders live.
hide = [cases_dir, root]
git = subprocess.run(["git", "-C", root, "worktree", "list", "--porcelain"], capture_output=True, text=True).stdout
hide += [line[9:] for line in git.splitlines() if line.startswith("worktree ")]
common = subprocess.run(["git", "-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
                        capture_output=True, text=True).stdout.strip()
hide += [common] if common else []
hide = sorted(set(hide))
tools = ",".join(ex["allowed_tools"])
settings = {
    "sandbox": {"enabled": True, "autoAllowBashIfSandboxed": True, "allowUnsandboxedCommands": False,
                "network": {"allowUnixSockets": [home + "/core.sock"]}, "filesystem": {"denyRead": hide}},
    "permissions": {"deny": [f"Read(/{h}/**)" for h in hide]},
    "autoMemoryEnabled": False,
}
argv = [claude, "-p", ex["prompt"], "--setting-sources", "", "--settings", json.dumps(settings),
        "--strict-mcp-config", "--no-session-persistence", "--model", model, "--max-budget-usd", budget,
        "--max-turns", str(ex.get("max_turns", 20)), "--output-format", "stream-json", "--verbose",
        "--tools", tools, "--allowed-tools", tools, "--permission-prompts", "none"]
if ex.get("append_system_prompt"):
    argv += ["--append-system-prompt", ex["append_system_prompt"]]
if plugin:
    argv += ["--plugin-dir", plugin]
env = {k: v for k, v in os.environ.items()
       if k not in ("NUNCHIRO_TOKEN", "NUNCHIRO_ARTIFACTS", "CLAUDE_CODE_SHELL_PREFIX")}
env.update(NUNCHIRO_HOME=home, NUNCHIRO_SESSION="skill-trial", PATH=home + "/bin:" + env.get("PATH", ""))
# A credential given in the environment lets the run use an empty Claude home of its own. Without one, the run signs
# in from the caller's Claude home (its keychain entry is tied to that folder), which it reads like any session.
if env.get("CLAUDE_CODE_OAUTH_TOKEN") or env.get("ANTHROPIC_API_KEY"):
    env["CLAUDE_CONFIG_DIR"] = tempfile.mkdtemp(prefix="claude-home.", dir=os.path.dirname(cases_dir))
error = None
limit = int(os.environ.get("SKILL_EVAL_TIMEOUT") or ex.get("timeout_seconds", 300))
# Its own process group, so a timeout or anything left running afterwards is stopped with all its children.
proc = subprocess.Popen(argv, cwd=run_dir, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                        start_new_session=True)
try:
    out = proc.communicate(timeout=limit)[0]
except subprocess.TimeoutExpired:
    os.killpg(proc.pid, signal.SIGKILL)
    out, error = proc.communicate()[0], f"timed out after {limit}s"
try:
    os.killpg(proc.pid, signal.SIGKILL)
except (ProcessLookupError, PermissionError):
    pass
with open(transcript, "wb") as f:
    f.write(out)

uses, texts, end, version = [], [], None, None
for line in out.decode(errors="replace").splitlines():
    try:
        ev = json.loads(line)
    except ValueError:
        continue
    if ev.get("type") == "system" and ev.get("subtype") == "init":
        version = ev.get("claude_code_version")
    elif ev.get("type") == "assistant":
        for block in ev.get("message", {}).get("content", []):
            if block.get("type") == "tool_use":
                uses.append(block)
            elif block.get("type") == "text":
                texts.append(block.get("text", ""))
    elif ev.get("type") == "result":
        end = ev
if end is None and error is None:
    print(f"skill-eval: claude -p wrote no result ({case['name']}, {'with' if plugin else 'without'})",
          file=sys.stderr)
    sys.exit(3)
end = end or {}
last = end.get("result") if isinstance(end.get("result"), str) else (texts[-1] if texts else "")


def passed(g):
    if g["type"] == "tool_used":
        return any(u.get("name") == g["tool"] and re.search(g.get("input_match", ""), json.dumps(u.get("input", {})))
                   for u in uses)
    if g["type"] == "regex" and g.get("target", "last_message") == "last_message":
        return re.search(g["pattern"], last, re.I if "i" in g.get("flags", "") else 0) is not None
    raise SystemExit(f"skill-eval: grader {g['name']}: type {g['type']} is not supported in tasks mode")


graders = [{"name": g["name"], "passed": passed(g)} for g in case["graders"]]
over = end.get("subtype") == "error_max_budget_usd"
if end.get("is_error") and not error:
    error = end.get("subtype") or "error"
with open(result, "w") as f:
    json.dump({"claudeVersion": version, "costUsd": end.get("total_cost_usd") or 0,
               "durationSeconds": (end.get("duration_ms") or 0) / 1000, "partial": over,
               "partialReason": "cost ceiling" if over else None,
               "cases": [{"name": case["name"], "arms": {"with": [{"graders": graders, "error": error}]}}]}, f)
EOF
  r=0
  while [ $r -lt "$runs" ]; do
    r=$((r + 1))
    for name in $cases; do
      for arm in with without; do
        start_core || exit 3
        plugin=''
        [ $arm = with ] && plugin=$work/with
        f=$work/c/$r-$arm-$name
        # Case files and results stay out of the run folder, in a folder the run may not read. Safe YAML: plain data
        # only, no Ruby objects.
        sed -e "s|@TRIAL_PROJECT@|$run_dir/project|g" -e "s|@WORKER@|w-${run_dir##*.}|g" \
          "$root/plugin/evals/$name/case.yaml" >"$f.yaml" &&
          /usr/bin/ruby -rpsych -rjson -e \
            'puts JSON.dump(Psych.safe_load(File.read(ARGV[0]), permitted_classes: [], aliases: false))' \
            "$f.yaml" >"$f.case" || exit 3
        python3 -I "$work/run_case.py" "$f.case" "$run_dir" "$home" "$plugin" "$claude" "$model" "$budget" \
          "$f.jsonl" "$f.json" "$work/c" "$root"
        rc=$?
        stop_core
        [ $rc -eq 0 ] && [ -s "$f.json" ] || exit 3
        results="$results $arm=$f.json"
      done
    done
  done
fi

mkdir -p "$(dirname "$out")" || exit 3
if [ -n "${SKILL_EVAL_RAW:-}" ]; then
  mkdir -p "$SKILL_EVAL_RAW" && for f in "$work"/*.json "$work"/c/*.json "$work"/c/*.jsonl; do [ -f "$f" ] && cp "$f" "$SKILL_EVAL_RAW/"; done
fi
# shellcheck disable=SC2086  # $results is a list of arm=path words with no spaces inside (paths under mktemp dirs)
python3 -I - "$out" "$mode" "$model" $results <<'EOF'
import json, sys

try:
    dst, mode, model, *pairs = sys.argv[1:]
    docs = [(arm, json.load(open(path))) for arm, path in (p.split("=", 1) for p in pairs)]

    def run_score(run):
        # The skill-loaded indicator can never pass without the plugin, so tasks scores leave it out (as a two-arm
        # `claude plugin eval` does); trigger cases are scored on their one Skill grader.
        gs = [g for g in run.get("graders", []) if mode == "trigger" or g.get("name") != "skill-loaded"]
        if not gs:
            return run.get("score", 0)
        total = sum(g.get("weight", 1) for g in gs)
        return sum(g.get("weight", 1) for g in gs if g.get("passed")) / total

    def mean(xs):
        return round(sum(xs) / len(xs), 3) if xs else None

    rows = {}
    for arm, d in docs:
        for c in d.get("cases", []):
            row = rows.setdefault(c["name"], {"with": [], "without": [], "graders": [], "errors": []})
            for run in c.get("arms", {}).get("with", []):
                row[arm].append(run_score(run))
                if arm == "with":
                    row["graders"].append({g["name"]: g.get("passed") for g in run.get("graders", [])})
                if run.get("error"):
                    row["errors"].append(f"{arm}: {run['error']}")
    cases = []
    for name, row in rows.items():
        out = {"name": name, "with_skill": mean(row["with"])}
        if row["without"]:
            out["baseline"] = mean(row["without"])
            out["delta"] = round(out["with_skill"] - out["baseline"], 3) if out["with_skill"] is not None else None
        out["graders"], out["errors"] = row["graders"], row["errors"]
        cases.append(out)
    passed = sum(1 for c in cases if (c["with_skill"] or 0) >= 1.0)
    partial = [d.get("partialReason") for _, d in docs if d.get("partial")]
    summary = {
        "mode": mode, "model": model, "claudeVersion": docs[0][1].get("claudeVersion"),
        "startedAt": docs[0][1].get("startedAt"), "evals": len(docs),
        "durationSeconds": round(sum(d.get("durationSeconds") or 0 for _, d in docs), 1),
        "costUsd": round(sum(d.get("costUsd") or 0 for _, d in docs), 6),
        "partial": bool(partial), "partialReason": partial[0] if partial else None,
        "aggregates": {"casesTotal": len(cases), "casesPassed": passed,
                       "overallScore": mean([c["with_skill"] or 0 for c in cases])},
        "cases": cases,
    }
    with open(dst, "w") as f:
        json.dump(summary, f, indent=1)
        f.write("\n")
    print(f"skill-eval {mode}: {passed}/{len(cases)} cases passed, ${summary['costUsd']}; {dst}")
    sys.exit(2 if partial else 0 if passed == len(cases) and cases else 1)
except SystemExit:
    raise
except Exception as e:  # noqa: BLE001 - any unreadable result is "no result"
    print(f"skill-eval: cannot read the eval result: {e!r}", file=sys.stderr)
    sys.exit(3)
EOF
code=$?
[ $status -eq 2 ] && [ $code -lt 2 ] && code=2
exit $code
