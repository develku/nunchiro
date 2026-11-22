"""Footprint of the measure browser's web-content processes (V1A-44). Usage: paint_fp.py <pid> <webkit|chromium> <root>
<root> is the Playwright process paint.py spawned with its responsibility disclaimed, so the browser and its XPC
helpers name it as responsible; <pid> (the spec's own) must name it too, or the run refuses (a spec run outside
paint.py would otherwise count the terminal app's helpers). Prints {"pids", "bytes", "skipped"}; an empty set is
refused instead of reported as zero."""
import json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scenario"))
import measurelib as ml  # noqa: E402
from lib import descendants  # noqa: E402


def main():
    pid, engine, root = int(sys.argv[1]), sys.argv[2], int(sys.argv[3])
    if ml.responsible_pid(pid) != root:
        raise SystemExit(f"pid {pid} is not under the measure root {root}; run through scripts/measure/paint.sh")
    procs = ml.parse_ps(subprocess.run(["ps", "-A", "-o", "pid=,comm="], capture_output=True, text=True).stdout)
    pids = ml.web_content(procs, {p: ml.responsible_pid(p) for p in procs}, descendants(root), root, engine)
    if not pids:
        raise SystemExit(f"no {engine} web-content process under root {root}; refusing to report a sum")
    out = subprocess.run(["footprint", "-f", "bytes", "--noCategories", *map(str, pids)], capture_output=True, text=True).stdout
    total, skipped = ml.sum_footprint(ml.parse_footprint(out), pids)
    print(json.dumps(dict(pids=pids, bytes=total, skipped=skipped)))


if __name__ == "__main__":
    main()
