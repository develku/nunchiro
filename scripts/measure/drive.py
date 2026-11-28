"""Peer task drives by computer use (docs/measure/tasks.md, "Seconds of a computer-use drive").

  drive.py record --window ID --out DIR [--fps 4] [--max 300]
      Pictures of one window (its CGWindowID), also while it is behind other windows: DIR/<unix time>.jpg, 1280 px wide.
      Stops on SIGTERM or after --max seconds. A drive's waits are read from these.
  drive.py seconds FILE
      The seconds of one drive. FILE holds its steps in order: [{"kind": "click" | "key" | "type", "n": keys in the
      chord or characters typed (1 for a click), "sent": the unix time stamped right before the step's input,
      "ready": the unix time in the name of the first picture that shows the screen ready for the next step, or
      the task's done state after the last step}, ...].

A step costs a practised user's time plus the app's wait. The user's time is the Keystroke-Level Model's (Card, Moran
and Newell, "The keystroke-level model for user performance time with interactive systems", 1980): M 1.35 s to
prepare, P 1.1 s to point, K 0.28 s per key or button press. The wait counts in full. macOS only; stdlib only."""
import argparse, json, pathlib, signal, subprocess, sys, time

M, P, K = 1.35, 1.1, 0.28


def user_seconds(kind, n=1):
    """A click is M + P + K; a key or chord M + K per key; a typed field M + K per character."""
    if kind == "click":
        return M + P + K
    if kind in ("key", "type") and n >= 1:
        return M + K * n
    raise ValueError(f"not a step: {kind!r} with n={n!r}")


def drive_seconds(steps):
    """(seconds, user part, waits) of one drive; a wait is never negative and a drive has at least one step."""
    if not steps:
        raise ValueError("a drive has at least one step")
    user = sum(user_seconds(s["kind"], s.get("n", 1)) for s in steps)
    waits = [round(max(0.0, s["ready"] - s["sent"]), 2) for s in steps]
    return round(user + sum(waits), 1), round(user, 2), waits


def record(window, out, fps, limit):
    out.mkdir(parents=True, exist_ok=True)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    end = time.time() + limit
    while (t := time.time()) < end:
        f = out / f"{t:.3f}.jpg"
        subprocess.run(["screencapture", "-x", "-o", f"-l{window}", "-t", "jpg", str(f)], check=True, capture_output=True)
        subprocess.run(["sips", "-Z", "1280", str(f)], check=True, capture_output=True)  # a full-size picture is 0.4 MB
        time.sleep(max(0.0, 1 / fps - (time.time() - t)))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("record")
    r.add_argument("--window", type=int, required=True)
    r.add_argument("--out", type=pathlib.Path, required=True)
    r.add_argument("--fps", type=float, default=4)
    r.add_argument("--max", type=float, default=300, help="seconds after which the recording stops by itself")
    s = sub.add_parser("seconds")
    s.add_argument("file", type=pathlib.Path)
    a = ap.parse_args()
    if a.cmd == "record":
        record(a.window, a.out, a.fps, a.max)
    else:
        total, user, waits = drive_seconds(json.loads(a.file.read_text()))
        print(json.dumps(dict(seconds=total, user=user, waits=waits)))
