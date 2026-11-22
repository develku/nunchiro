"""perf-baseline: composer keystroke-to-paint in the shipped web bundle on a release core with N fixture sessions. Usage:
  composer.py [--repeats 5] [--sessions 5] [--n 100] [--engines webkit,chromium] [--profile] [--no-build]
One scratch core, one `vite preview`, one Playwright browser per run (composer.mjs); every PID started is stopped here.
--profile adds a Chromium CPU profile of the typing (top self-time functions). Result: .scratch/perf-baseline/composer.json."""
import argparse, json, os, shutil, socket, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "scripts/scenario"))
import measurelib as ml  # noqa: E402
import release as rel  # noqa: E402

OUT = ROOT / ".scratch/perf-baseline"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repeats", type=int, default=5)
    ap.add_argument("--sessions", type=int, default=5)
    ap.add_argument("--n", type=int, default=100)
    ap.add_argument("--engines", default="webkit,chromium")
    ap.add_argument("--profile", action="store_true")
    ap.add_argument("--no-build", action="store_true")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    pnpm = shutil.which("pnpm")
    if not rel.CORE.is_file() or not pnpm:
        raise SystemExit(f"needs the release core {rel.CORE} (scripts/measure/build.sh) and pnpm on PATH")
    if rel.load() >= ml.PAINT_LOAD_START:
        raise SystemExit(f"1-min load {rel.load()} >= {ml.PAINT_LOAD_START:g}; not measuring")
    web, port = ROOT / "web", free_port()
    os.environ["NUNCHIRO_WINDOW_ORIGINS"] = f"http://127.0.0.1:{port}"  # the scratch core accepts the preview's origin
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", os.path.expanduser("~/Library/Caches/ms-playwright"))
    if not a.no_build:
        subprocess.run([pnpm, "-C", str(web), "exec", "vite", "build", "--logLevel", "error"], check=True)
    arm, preview, res = rel.Nunchiro(v1b="plain"), None, {}
    try:
        sids = [arm.start(i) for i in range(a.sessions)]
        arm.wait_ready(sids)
        arm.after_ready(sids)
        auth = arm.call({"op": "window_auth"})
        auth = auth.get("WindowAuth", auth)
        preview = subprocess.Popen([pnpm, "-C", str(web), "exec", "vite", "preview", "--port", str(port), "--strictPort"],
                                   stdout=open(OUT / "preview.log", "ab"), stderr=subprocess.STDOUT)
        for _ in range(100):
            with socket.socket() as s:
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.2)
        for engine in a.engines.split(","):
            runs = []
            for r in range(a.repeats):
                job = OUT / f"composer-{engine}-{r}.job.json"
                job.write_text(json.dumps(dict(engine=engine, url=f"http://127.0.0.1:{port}/", port=auth["port"], token=auth["token"],
                                               n=a.n, keys=list(rel.WORK["keys"]), out=str(OUT / f"composer-{engine}-{r}.json"),
                                               profile=a.profile and r == 0)))
                subprocess.run(["node", str(HERE / "composer.mjs"), str(job)], check=True, timeout=300)
                got = json.loads((OUT / f"composer-{engine}-{r}.json").read_text())
                ms = got["ms"]
                runs.append(dict(p50=round(ml.pct(ms, 50), 2), p95=round(ml.pct(ms, 95), 2), max=round(max(ms), 1),
                                 misses=sum(x == 2000 for x in ms), load=rel.load(), top=got["top"]))
                print(f"composer {engine} repeat {r + 1}: p50 {runs[-1]['p50']} p95 {runs[-1]['p95']} ms", flush=True)
            res[engine] = dict(runs=runs, p50=ml.median([x["p50"] for x in runs]), p95=ml.median([x["p95"] for x in runs]),
                               p95_min=min(x["p95"] for x in runs), p95_max=max(x["p95"] for x in runs))
    finally:
        if preview is not None:
            preview.terminate()
        arm.stop()
    res["versions"] = rel.versions()
    (OUT / "composer.json").write_text(json.dumps(res, indent=1))
    print(json.dumps({k: {x: y for x, y in v.items() if x != "runs"} for k, v in res.items() if k != "versions"}, indent=1))


if __name__ == "__main__":
    main()
