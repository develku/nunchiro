#!/bin/sh
# Skill evals for the shipped plugin (scorecard p31 SK2, SK3; ticket 1130 C-C2). Runs `claude plugin eval` on
# throwaway copies of plugin/ and keeps a short result in docs/measure/evidence/skill-eval-<date>-<mode>.json.
#   trigger  plugin/evals/trigger-*/: 8 should-load and 8 should-not prompts per skill, one arm (no baseline).
#   tasks    plugin/evals/task-*/: start a worker, prompt, wait, read (a shell worker on a trial core), and publish
#            an artifact. Each run of each arm is its own eval: a fresh core on its own temporary NUNCHIRO_HOME, a
#            fresh trial project and worker label, then the core is stopped and both are removed, so no arm sees
#            another's workers. The baseline arm is the plugin with its skills removed. Scores leave out the
#            skill-loaded indicator, so both arms are scored on the task alone.
# Known (2026-11-25, Claude Code 2.1.332): the eval's Bash sandbox refuses to run the trial's shell prefix outside the
# run's workspace ("Operation not permitted"), so task-worker cannot pass in `claude plugin eval` yet.
# Costs model tokens, so it is not a gate stage: run it on demand and before a scorecard run. Each eval run is a
# `claude -p` child in its own temporary home and config, on the caller's own Claude credential; nothing here writes
# ~/.claude settings or ~/.nunchiro, and it removes only the folders it made. Exit: 0 every case passed (with skill),
# 1 a case below 1.0, 2 a cost ceiling hit, 3 no result or setup failed, 64 usage.
# Env: SKILL_EVAL_MODEL (default haiku for trigger, sonnet for tasks), SKILL_EVAL_RUNS (default 1),
#      SKILL_EVAL_MAX_COST (USD ceiling per eval invocation, default 5), SKILL_EVAL_OUT (result path),
#      SKILL_EVAL_RAW (a folder: also copy each full result, with grader detail, there), CLAUDE_BIN (default claude),
#      NUNCHIRO_BIN (tasks: the core to trial; default: cargo build -p nunchiro and use its debug binary).
# Extra arguments go to `claude plugin eval` unchanged (e.g. --case 'trigger-nunchiro-load-0*', --keep-temp to keep
# each run's transcript for a failed case).
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
mode=${1:-}
case $mode in
  trigger) tag=trigger model=${SKILL_EVAL_MODEL:-haiku} ;;
  tasks) tag=task model=${SKILL_EVAL_MODEL:-sonnet} ;;
  *) echo "usage: scripts/skill-eval.sh trigger|tasks [claude plugin eval options]" >&2; exit 64 ;;
esac
shift
claude=${CLAUDE_BIN:-claude}
runs=${SKILL_EVAL_RUNS:-1}
tmp=${TMPDIR:-/tmp}
tmp=${tmp%/}
out=${SKILL_EVAL_OUT:-$root/docs/measure/evidence/skill-eval-$(date +%Y-%m-%d)-$mode.json}
work=$(mktemp -d "$tmp/skill-eval.XXXXXX") || exit 3
home='' trial='' serve_pid='' bin=''

# Stops this run's core (our own child only) and removes the home and trial folder this run made.
stop_core() {
  if [ -n "$serve_pid" ]; then
    (core_env "$bin" serve stop --yes) >/dev/null 2>&1
    kill -0 "$serve_pid" 2>/dev/null && kill "$serve_pid" 2>/dev/null
    wait "$serve_pid" 2>/dev/null
  fi
  [ -n "$home" ] && rm -rf "$home"
  [ -n "$trial" ] && rm -rf "$trial"
  serve_pid='' home='' trial=''
}
cleanup() {
  stop_core
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# The trial core never sees the caller's home, Claude or Codex config, or login shell. Call it in a subshell: it execs,
# so a background start's $! is the core's own pid.
core_env() {
  exec env -i NUNCHIRO_HOME="$home" HOME="$home/sentinel" CLAUDE_CONFIG_DIR="$home/claude-home" \
    CODEX_HOME="$home/codex-home" PATH=/usr/bin:/bin SHELL=/bin/sh NUNCHIRO_LOGIN_PATH=off "$@"
}

# A fresh core, home and trial project for one eval run, and its worker case filled in for the plugin copy $1.
start_core() {
  # ns- prefix: scripts/check-serve-leak.sh reports a serve left behind on such a home.
  home=$(mktemp -d "$tmp/ns-skill.XXXXXX") || return 1
  trial=$(mktemp -d "$tmp/skill-trial.XXXXXX") || return 1
  mkdir -p "$home/bin" "$home/sentinel" "$trial/project" || return 1
  echo kumquat-7731 >"$trial/project/secret.txt" || return 1
  (core_env "$bin" serve) </dev/null >/dev/null 2>"$home/core.log" &
  serve_pid=$!
  i=0
  until [ -S "$home/core.sock" ]; do
    i=$((i + 1))
    [ $i -gt 100 ] && { echo "skill-eval: trial core did not start; its log:" >&2; cat "$home/core.log" >&2; return 1; }
    sleep 0.1
  done
  ln -s "$bin" "$home/bin/nunchiro" || return 1
  # An eval run passes only an allowlist of variables to the agent, so the trial's `nunchiro` and its session
  # variables reach each Bash command through Claude Code's shell prefix instead.
  cat >"$home/bin/trial-shell" <<EOF || return 1
#!/bin/sh
export NUNCHIRO_HOME='$home' NUNCHIRO_SESSION=skill-trial PATH='$home/bin':"\$PATH"
unset NUNCHIRO_TOKEN
if [ \$# -eq 1 ]; then exec /bin/sh -c "\$1"; else exec "\$@"; fi
EOF
  chmod +x "$home/bin/trial-shell"
  export CLAUDE_CODE_SHELL_PREFIX="$home/bin/trial-shell"
  sed -e "s|@TRIAL_PROJECT@|$trial/project|g" -e "s|@WORKER@|w-${trial##*.}|g" \
    "$root/plugin/evals/task-worker/case.yaml" >"$1/evals/task-worker/case.yaml"
}

cp -R "$root/plugin" "$work/with" || exit 3
set -- --tag "$tag" --ablation none --model "$model" --max-cost-usd "${SKILL_EVAL_MAX_COST:-5}" \
  --no-publish --trust-plugin "$@"
results=''
status=0
if [ "$mode" = trigger ]; then
  "$claude" plugin eval "$work/with" --runs "$runs" "$@" --json "$work/with.json"
  [ -s "$work/with.json" ] || { echo "skill-eval: claude plugin eval wrote no result" >&2; exit 3; }
  results="with=$work/with.json"
else
  cp -R "$root/plugin" "$work/without" && rm -rf "$work/without/skills" || exit 3
  if [ -n "${NUNCHIRO_BIN:-}" ]; then
    bin=$NUNCHIRO_BIN
  else
    (cd "$root" && cargo build -q -p nunchiro) || exit 3
    bin=${CARGO_TARGET_DIR:-$root/target}/debug/nunchiro
  fi
  [ -x "$bin" ] || { echo "skill-eval: no core binary at $bin" >&2; exit 3; }
  # Plain Bash: the skill's own first step is a `test -n` check. Every eval Bash command runs in Claude Code's sandbox.
  set -- "$@" --allow-tools Bash
  r=0
  while [ $r -lt "$runs" ]; do
    r=$((r + 1))
    for arm in with without; do
      start_core "$work/$arm" || exit 3
      "$claude" plugin eval "$work/$arm" --runs 1 "$@" --json "$work/$r-$arm.json"
      [ $? -eq 2 ] && status=2
      stop_core
      [ -s "$work/$r-$arm.json" ] || { echo "skill-eval: claude plugin eval wrote no result ($arm, run $r)" >&2; exit 3; }
      results="$results $arm=$work/$r-$arm.json"
    done
  done
fi

mkdir -p "$(dirname "$out")" || exit 3
if [ -n "${SKILL_EVAL_RAW:-}" ]; then
  mkdir -p "$SKILL_EVAL_RAW" && for f in "$work"/*.json; do cp "$f" "$SKILL_EVAL_RAW/"; done
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
