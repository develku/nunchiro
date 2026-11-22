"""Baseline memory of bare `claude` / `codex` in a PTY: idle and during a turn.

Reports macOS `footprint` (phys_footprint, the number Activity Monitor shows as Memory) for the
agent process alone and for the agent plus all its descendants (MCP servers, hooks, helpers).
Usage: footprint.py [claude|codex] [--samples N]"""
import json, os, re, subprocess, sys, time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scenario"))
from lib import CODEX_MODEL, OUT, Session, TRUSTED_CWD, clean_env, descendants  # noqa: E402

ARGV = {"claude": ["claude", "--model", "haiku"],
        "codex": ["codex", "--no-daemon", "-m", CODEX_MODEL, "-c", 'model_reasoning_effort="low"', "-s", "read-only"]}
READY = {"claude": r"❯ +Try|manual mode on|for shortcuts", "codex": r"Ask Codex to do anything"}


def fp(pids):
    """Total footprint in MiB over pids (one footprint call so shared pages are not double counted)."""
    pids = [p for p in pids if p]
    out = subprocess.run(["footprint", "-f", "bytes", "--noCategories"] + [str(p) for p in pids], capture_output=True, text=True).stdout
    m = re.findall(r"Footprint:\s+([\d,]+) B", out)
    return round(int(m[-1].replace(",", "")) / 2**20, 1) if m else None


def agent_pid(s):
    # claude/codex may be a launcher that execs or spawns the real binary; take the session pid
    return s.pid


def sample(s, n, gap):
    own, tree = [], []
    for _ in range(n):
        kids = descendants(s.pid)
        own.append(fp([s.pid]))
        tree.append(fp([s.pid] + kids))
        time.sleep(gap)
    return dict(own_mib=max(x for x in own if x), tree_mib=max(x for x in tree if x), tree_procs=len(descendants(s.pid)) + 1)


def main():
    agent = sys.argv[1] if len(sys.argv) > 1 else "claude"
    s = Session(ARGV[agent], TRUSTED_CWD, clean_env())
    try:
        s.wait_for(READY[agent], 60)
        time.sleep(15)  # let MCP servers and plugins settle
        idle = sample(s, 3, 2)
        s.type("Write the numbers from 1 to 300 as English words, one per line. Do not use any tools.")
        time.sleep(4)
        turn = sample(s, 5, 2)
        r = dict(agent=agent, idle=idle, turn=turn, version=subprocess.run([ARGV[agent][0], "--version"], capture_output=True, text=True).stdout.strip())
        print(json.dumps(r))
        os.makedirs(os.path.join(OUT, "measure"), exist_ok=True)
        open(os.path.join(OUT, "measure", "footprint.jsonl"), "a").write(json.dumps(dict(r, t=time.time())) + "\n")
    finally:
        s.send(b"\x1b")
        s.kill()


if __name__ == "__main__":
    main()
