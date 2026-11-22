#!/usr/bin/env python3
"""Review-page captures of the real app (lifted from the v25-rc-check lane's .scratch/rc/capture.py, ticket 181): one
app copy (harness.App on APP_CLICK_APP) on a temp home with the conformance fixture plus a seeded board. Each state is
captured independently; a failed state is recorded and the rest still run. Writes OUTDIR/TAG.json, TAG-<state>.png and
TAG-<state>.ax.txt.

Usage: APP_CLICK_APP=<built .app> capture.py [--dry-run] TAG OUTDIR [STORE.sqlite3]
STORE is an optional copy of a window store (fixture or copied store; seeded into the copy's own WebKit folder, never
the installed app's). --dry-run prints the ordered steps and the controls each presses, starts no app, writes nothing."""
import json, sys, time, traceback
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import harness  # noqa: E402
import repro  # noqa: E402

# Pointer actions go through harness.App, which activates the window first (and again after a click), so the click
# lands and the hover draws: the RC run lost focus after the Browser click and never drew the tooltip.
POINTER = {"click": "App.click: activate, click, activate", "move": "App.move: activate, move"}

# (state, actions before the capture, actions after it). Actions: (press, control), (key, code), (select session, label),
# (click, control, AX role), (move, row:<label> or window:<dx>,<dy>, dx, seconds to rest).
STEPS = [
    ("main", (), ()),
    ("hover", (("move", "row:agent-waiting", 10, 0.3), ("move", "row:agent-waiting", 40, 1.0),
               ("move", "row:agent-waiting", 42, 3.0)), ()),
    ("folded", (("press", "Collapse demo-project"), ("move", "window:800,500", 0, 0.3)), (("press", "Expand demo-project"),)),
    ("palette", (("press", "Open command palette"),), (("key", 53),)),
    ("layout", (("press", "Layout"),), (("press", "Done"),)),
    # The placement promise (v25-placement item 4) is for a session's Browser pane: focus an agent session first.
    ("browser", (("select session", "agent-working"), ("click", "Browser", "AXCheckBox")), ()),
    ("board", (("press", "Board"),), ()),
    ("board-done", (("press", "History of Composer agent chip"),), (("press", "Board"),)),
    ("accounts", (("press", harness.SETTINGS), ("press", "Accounts & Usage")), ()),
]


def describe(action):
    op, *args = action
    tail = f"  ({POINTER[op]})" if op in POINTER else ""
    return f"{op} {' '.join(map(str, args[:2] if op == 'click' else args[:1]))}{tail}"


def plan():
    lines = []
    for name, before, after in STEPS:
        lines += [f"step {name}", *(f"  {describe(x)}" for x in before), "  capture",
                  *(f"  then {describe(x)}" for x in after)]
    return lines


def seed(a):
    repro.both_fixture_waiting(a)
    snap = json.loads(a.cli("snapshot", "--json"))
    ids = {s.get("label"): s["id"] for s in snap.get("sessions", []) if s.get("label")}

    def add(*args):
        out = json.loads(a.cli("board", "add", *args, "--json"))
        return str(out.get("card", out).get("id"))
    c1 = add("Composer agent chip", "--attach", ids.get("agent-working"), "--role", "builder")
    c2 = add("Worktree name display")
    add("Tidy panel", "--waits-on", c2)
    a.cli("board", "move", c2, "Review")
    a.cli("board", "done", c1, "--receipt", "ead49ed · cargo test --workspace · 412 passed")


def perform(a, action):
    op, *args = action
    if op == "press":
        a.press(args[0], settle=1.2)
    elif op == "key":
        a.key(args[0])
    elif op == "select session":
        repro.click_tab(a, args[0])
    elif op == "click":
        f = [f for f in a.find(args[0]) if f[4] == args[1]][0]
        a.click(f[0] + f[2] // 2, f[1] + f[3] // 2, settle=2.0)
    elif op == "move":
        target, dx, rest = args
        _, wx, wy, _, _ = a.window()
        if target.startswith("row:"):
            row = [f for f in a.find(target[4:]) if wx + 55 < f[0] < wx + 320][0]
            x, y = row[0] + dx, row[1] + row[3] // 2
        else:
            ox, oy = map(int, target[7:].split(","))
            x, y = wx + ox + dx, wy + oy
        a.move(x, y)
        time.sleep(rest)
    else:
        raise ValueError(f"unknown action {op}")


def main(argv):
    if argv[:1] == ["--dry-run"]:
        print("\n".join(plan()))
        return
    tag, out, store = argv[0], Path(argv[1]), (argv[2] if len(argv) > 2 else None)
    out.mkdir(parents=True, exist_ok=True)
    res = {}
    env = {"PATH": f"{repro.write_stubs()}:/usr/bin:/bin:/usr/sbin:/sbin"}
    with harness.App(shots=out, before=seed, env=env, store=store) as a:
        time.sleep(2)
        for name, before, after in STEPS:
            try:
                for x in before:
                    perform(a, x)
                time.sleep(0.8)
                res[name] = str(a.capture(f"{tag}-{name}").name)
            except Exception as e:  # noqa: BLE001  one state's failure is recorded, the rest still run
                res[name] = f"FAIL {type(e).__name__}: {e}"
                traceback.print_exc()
            (out / f"{tag}-{name}.ax.txt").write_text(a.tree(40))
            for x in after:
                try:
                    perform(a, x)
                except Exception:  # noqa: BLE001  a failed reset is visible in the next state's capture
                    traceback.print_exc()
    (out / f"{tag}.json").write_text(json.dumps(res, indent=1) + "\n")
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main(sys.argv[1:])
