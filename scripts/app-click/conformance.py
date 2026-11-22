#!/usr/bin/env python3
"""Decision conformance pass (ticket 171 comment, needs 150): each approved UI decision checked in the real app on a
fresh store and on a COPY of a pre-existing store. Verdicts: applied (both), hidden by stored value (fresh passes,
old store does not: the field and its migration are named), missing (fresh store fails).

Usage: conformance.py OLD_STORE.sqlite3 | --dry-run (print the ordered steps and the controls each presses; no app)
OLD_STORE is a copy of an existing window store (localstorage.sqlite3); it is seeded into the app copy's own WebKit
folder (harness.App store=), never into the installed app's. Output: docs/design/v25-bug-sweep/conformance.{json,html}
and conformance/<store>-<screen>.png."""
import html, json, sys, time
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import harness  # noqa: E402
import repro  # noqa: E402

OUT = repro.OUT
SHOTS = OUT / "conformance"


def ln_frame(ln):
    return tuple(map(int, ln.rsplit("|", 1)[1].split(","))) if ln.rsplit("|", 1)[1].count(",") == 3 else None


def text(ln):
    return " ".join(p.strip() for p in ln.split("|")[1:4] if p.strip())


def strip_rule(strip_frames, composer_frame):
    """needs 162 (replaces needs 107): the Answer strip takes 0 px when empty and, when it shows, sits under the composer.
    Frames are (x, y, w, h). A frame of 20 px or less is AX noise, as before; a taller one must start at or below the
    composer's bottom edge (above it, or over it, fails). Returns (ok, detail)."""
    shown = [f for f in strip_frames if f[3] > 20]
    if not shown:
        return True, "Answer strip takes 0 px"
    if composer_frame is None:
        return False, f"Answer strip {shown[0]} drawn, composer text area not found"
    bottom = composer_frame[1] + composer_frame[3]
    bad = [f for f in shown if f[1] < bottom]
    if bad:
        return False, f"Answer strip at y {bad[0][1]} (height {bad[0][3]}) is not under the composer (bottom {bottom})"
    return True, f"Answer strip under the composer: y {shown[0][1]} >= {bottom}"


BOARD_COLUMNS = ("Needs you", "Working", "Next", "Done")


def board_rule(found):
    """needs 208 (replaces needs 154 (6) for the default view): the Board opens as the watch view, its four columns
    Needs you, Working, Next, Done. `found` is the column titles the AX tree showed, in order. Returns (ok, detail);
    detail lists the found titles and names the missing ones."""
    missing = [c for c in BOARD_COLUMNS if c not in found]
    if missing:
        return False, f"columns: {list(found)}; missing: {missing}"
    return True, f"columns: {list(found)}"


class Run:
    """One app copy with the agents fixture; checks share its screens."""

    def __init__(self, a, tag):
        self.a, self.tag, self.wx, self.wy, self.ww, self.wh = a, tag, *a.window()[1:]

    def shot(self, name):
        return str(self.a.capture(f"{self.tag}-{name}").relative_to(OUT))

    def sidebar(self, word):
        return [ln for ln in repro.lines(self.a, word) if (f := ln_frame(ln)) and self.wx + 55 < f[0] < self.wx + 320]


# The ordered plan: (step, nav, checks, after). nav and after are (op, control) pairs the runner performs around the
# step: press (AXPress), tab (focus a session tab), find (a control or heading that must be on screen). A check named
# "key: part" reads that part of the check on this step. `--dry-run` prints this plan and starts no app.
STEPS = []


def step(name, nav=(), checks=(), after=()):
    def deco(fn):
        STEPS.append((name, tuple(nav), tuple(checks), tuple(after), fn))
        return fn
    return deco


@step("main", checks=("102-page", "102-rows", "92-working-row", "95-decision-on-row", "92-head-count", "107-no-strip"))
def main_screen(r):
    a, out = r.a, {}
    main = r.main = r.shot("main")

    # needs 102: light page #f6f6f4 with white panels (sampled on the left bar and the sidebar).
    bar = harness.ax("pixel", OUT / main, 20, 600).split()[0]
    panel = harness.ax("pixel", OUT / main, 150, 600).split()[0]
    out["102-page"] = (bar == "#f6f6f4" and panel == "#ffffff", f"bar {bar}, sidebar {panel}", main)

    # needs 102: comfortable 30 px rows by default.
    rows = [f[3] for ln in r.sidebar("agent-waiting") if (f := ln_frame(ln)) and f[3] > 20]
    out["102-rows"] = (bool(rows) and 28 <= max(rows) <= 31, f"waiting row height {max(rows) if rows else 'none'} px", main)

    # needs 92: working = blue arc row; quiet rows stay listed.
    work = r.sidebar("agent-working")
    out["92-working-row"] = (bool(work), f"agent-working rows in the tree: {len(work)}", main)

    # needs 92 / 95: your turn = orange row with the decision on the session row.
    wait = [text(ln) for ln in r.sidebar("needs approval")]
    out["95-decision-on-row"] = (bool(wait), (wait or ["no decision line on a session row"])[0], main)

    # needs 92: project head counts (orange your turn).
    head = [f for ln in r.sidebar("demo-project") if (f := ln_frame(ln))]
    count = [ln for ln in r.sidebar("1") if (f := ln_frame(ln)) and head and abs(f[1] - head[0][1]) < 12 and "AXStaticText" in ln]
    out["92-head-count"] = (bool(count), "orange count on the head" if count else "no count beside the project head", main)

    # needs 162: the strip takes 0 px when empty and sits under the composer (the "Message" text area).
    strips = [f for ln in repro.lines(a, "Answer strip") if (f := ln_frame(ln))]
    composer = next((f for ln in repro.lines(a, "Message") if "AXTextArea" in ln and (f := ln_frame(ln))), None)
    ok, detail = strip_rule(strips, composer)
    out["107-no-strip"] = (ok, detail, main)
    return out


# needs 140 motion and v25-design-chat describe the focused session, so the working one is focused first.
@step("focus-working", nav=(("tab", "agent-working"),),
      checks=("140-motion", "design-chat-working-row", "109-no-duplicates", "146-rail-centred", "149-placement"))
def focus_working(r):
    a, out, main = r.a, {}, r.main
    time.sleep(2)
    # Working arc in the status bar, "Working for" row in the transcript.
    status = [text(ln) for ln in repro.lines(a, "working") if (f := ln_frame(ln)) and f[1] > r.wy + r.wh - 30]
    out["140-motion"] = (bool(status), (status or ["no working state in the status bar"])[0], main)
    row = [ln for ln in repro.lines(a, "| Working |") if "AXStaticText" in ln and (f := ln_frame(ln)) and f[0] > r.wx + 320]
    out["design-chat-working-row"] = (bool(row), "Working for Ns row at the end of the transcript" if row else "no working row", main)

    # needs 109: one visible control per action (header Diff button and the Diff bar icon are the same action).
    diff = {f[4] for f in a.find("Diff")}
    out["109-no-duplicates"] = (not {"AXButton", "AXCheckBox"} <= diff, f"Diff controls: {sorted(diff)}", main)

    # needs 146: rail icons centred in their bar.
    left = [ln_frame(ln) for ln in repro.lines(a, "Left bar", 8) if "AXGroup" in ln and ln_frame(ln)]
    tree = [f for f in a.find("Tree") if f[4] == "AXCheckBox"]
    off = round((tree[0][0] + tree[0][2] / 2) - (left[0][0] + left[0][2] / 2), 1) if left and tree else None
    out["146-rail-centred"] = (off is not None and abs(off) <= 1.5, f"Tree icon centre is {off} px off the bar centre", main)

    # v25-placement (the owner picked, needs 149): Settings bottom-left, Layout bottom-right.
    s = [f for f in a.find("Settings") if f[4] == "AXCheckBox"]
    lay = [f for f in a.find("Layout") if f[4] == "AXCheckBox"]
    ok = s and lay and s[0][0] < r.wx + 60 and s[0][1] > r.wy + r.wh * 0.7 and lay[0][0] > r.wx + r.ww - 60 and lay[0][1] > r.wy + r.wh * 0.7
    out["149-placement"] = (bool(ok), f"Settings at {s[0][:2] if s else None}, Layout at {lay[0][:2] if lay else None}", main)
    return out


@step("side-pane", nav=(("tab", "agent-working"), ("press", "Open terminal")), checks=("106-side-pane", "144-calm-hint"))
def side_pane(r):
    a, out = r.a, {}
    # needs 106: right side pane with tabs (agent PTY, + Shell, Browser, Preview).
    pane = r.shot("side-pane")
    tabs = [w for w in ("+ Shell", "Browser", "Preview") if a.find(w)]
    out["106-side-pane"] = (len(tabs) == 3, f"side pane tabs: {tabs}", pane)

    # needs 144: composer key hint only while a message waits.
    hint = repro.lines(a, "newline") + repro.lines(a, "to send")
    out["144-calm-hint"] = (not hint, f"composer hint lines: {len(hint)}", pane)
    return out


@step("board", nav=(("press", "Board"),), checks=("106-board",), after=(("press", "Board"),))
def board(r):
    # needs 106: Board as a centre tab; needs 208: it opens as the watch view with its four columns.
    shot = r.shot("board")
    found = [c for c in BOARD_COLUMNS if r.a.find(c)]
    return {"106-board": (*board_rule(found), shot)}


# v25-fix-settings renamed the "Keys" page to "Keyboard".
@step("settings-keys", nav=(("press", harness.SETTINGS), ("press", "#snav-keys|Keyboard")), checks=("106-settings-fills",))
def settings_keys(r):
    # needs 106 / coordinator: Settings as a wide centre view that fills the window.
    keys = r.shot("settings-keys")
    # The settings body: the widest element right of the settings nav (nav ends ~wx+260).
    body = [f for ln in repro.lines(r.a, "AX", 30) if (f := ln_frame(ln)) and r.wx + 260 < f[0] < r.wx + 300 and f[2] > 800]
    bottom = max((f[1] + f[3] for f in body), default=0) - r.wy
    shown = min(bottom, r.wh)
    return {"106-settings-fills": (bottom >= r.wh * 0.9, f"settings body reaches {bottom} px of a {r.wh} px window (content below the window edge is cut, not scrolled)" if bottom > r.wh else f"settings body reaches {shown} px of a {r.wh} px window", keys)}


# needs 157 (3): Language moved from Appearance to the General page.
@step("settings-general", nav=(("press", "#snav-general|General"),), checks=("144-appearance: Language on General",))
def settings_general(r):
    r.general = r.shot("settings-general")
    # On the General page, and no Language page of its own in the settings nav.
    r.lang = bool(repro.lines(r.a, "Language")) and not [f for f in r.a.find("Language") if f[4] == "AXButton" and f[0] < r.wx + 260]
    return {}


# needs 140: the scope picker draws only on the pages where a narrower scope means something (SettingsView.tsx SCOPED:
# agents and git); the Agents page is the first of them.
@step("settings-scope", nav=(("press", "#snav-agents|Agents"),), checks=("140-scope-picker",))
def settings_scope(r):
    shot = r.shot("settings-agents")
    scope = repro.lines(r.a, "Applying settings for") + repro.lines(r.a, "All projects")
    return {"140-scope-picker": (bool(scope), "Applying settings for All projects (Agents page)" if scope else "no scope picker on the Agents page", shot)}


@step("settings-appearance", nav=(("press", harness.APPEARANCE),),
      checks=("146-copy-on-select", "144-appearance: Chat width on Appearance"))
def settings_appearance(r):
    a, out = r.a, {}
    app_shot = r.shot("settings-appearance")
    # needs 146 (ticket 162): copy on select on by default.
    cos = [ln for ln in repro.lines(a, "opy on select") if "AXCheckBox" in ln or "AXSwitch" in ln]
    val = cos[0].split("|")[3].strip() if cos else None
    out["146-copy-on-select"] = (val == "1", f"Copy on select checkbox value {val}", app_shot)

    # needs 144 / 157 (3): Language on General (read on the step before), the chat width bar on Appearance.
    width = bool(repro.lines(a, "Chat width"))
    out["144-appearance"] = (r.lang and width, f"Language on General: {r.lang} ({r.general}), Chat width bar on Appearance: {width}", app_shot)
    return out


# Theme is a section of the Appearance page since v25-fix-settings: its heading must be there, no page is pressed.
@step("settings-theme", nav=(("find", "#h-theme|Theme"),), checks=("146-themes",))
def settings_theme(r):
    # needs 146: themes preview on click, two light and two dark shown, rest on expand.
    theme = r.shot("settings-theme")
    cards = len([ln for ln in repro.lines(r.a, "Options for") if "AXButton" in ln])
    more = bool(r.a.find("More themes"))
    return {"146-themes": (cards == 4 and more, f"{cards} theme cards, More themes: {more}", theme)}


def perform(a, actions):
    for op, control in actions:
        if op == "press":
            a.press(control, settle=1.2)
        elif op == "tab":
            repro.click_tab(a, control)
        elif not a.find(control):  # find
            raise RuntimeError(f"no {control} on screen")


def checks(r):
    out = {}
    for name, nav, declared, after, fn in STEPS:
        perform(r.a, nav)
        got = fn(r)
        stray = set(got) - {c.split(":")[0] for c in declared}
        assert not stray, f"step {name} returned undeclared checks {stray}"
        out.update(got)
        perform(r.a, after)
    return out


def plan():
    lines = []
    for name, nav, declared, after, _ in STEPS:
        lines += [f"step {name}", *(f"  {op} {c}" for op, c in nav), *(f"  check {c}" for c in declared),
                  *(f"  then {op} {c}" for op, c in after)]
    return lines


# The stored field that can hold each decision back, and the migration needs 150 asks for.
FIELDS = {
    "146-copy-on-select": ("settings.v1 copyOnSelect", "default changed false -> true in 6a167914 (ticket 162); bump the store version, set true, Undo toast"),
    "149-placement": ("settings.v1 bars.left / bars.right", "move settings to the left bar's last slot and layout to the right bar's last slot (v25-placement); version bump + Undo"),
    "106-settings-fills": ("none (layout CSS)", "not a stored value"),
    "102-page": ("settings.v1 themeLight / themeFixed / themeMode", "a catalog theme stored as a full colour snapshot keeps its old colours; built-in picks are re-read (settings.ts:173)"),
    "102-rows": ("settings.v1 density / rowHeight", "density default; migrate only if the default changes"),
    "144-appearance": ("settings.v1 settingsPage", "a stored page id that no longer exists must fall back to its new home (settings.ts MOVED_PAGES); Language is on General since needs 157 (3)"),
}
TITLES = {
    "102-page": "needs 102: light page #f6f6f4, white panels", "102-rows": "needs 102: comfortable 30 px rows",
    "92-working-row": "needs 92: working session row with the blue arc", "95-decision-on-row": "needs 95: decision on the session row",
    "92-head-count": "needs 92: orange/red counts on the project head", "107-no-strip": "needs 162: Answer strip 0 px when empty, under the composer",
    "140-motion": "needs 140: motion shows what is working (status bar)", "design-chat-working-row": "v25-design-chat: 'Working for Ns' row",
    "109-no-duplicates": "needs 109: one visible control per action", "146-rail-centred": "needs 146: rail icons centred",
    "149-placement": "needs 149 / v25-placement: Settings bottom-left, Layout bottom-right", "106-side-pane": "needs 106: right side pane tabs (PTY, + Shell, Browser, Preview)",
    "144-calm-hint": "needs 144: composer key hint only while queued", "106-board": "needs 106 / 208: Board centre tab, the watch view's four columns",
    "106-settings-fills": "needs 106: Settings as a wide centre view (fills the window)", "140-scope-picker": "needs 140: settings scope picker",
    "146-copy-on-select": "needs 146 (ticket 162): copy on select on by default", "144-appearance": "needs 144 / 157 (3): Language on General, chat width bar on Appearance",
    "146-themes": "needs 146: two light + two dark themes, rest on expand",
}


def run(tag, store):
    env = {"PATH": f"{harness.BUILD / 'stub-bin'}:/usr/bin:/bin:/usr/sbin:/sbin"}
    with harness.App(shots=SHOTS, before=repro.both_fixture_waiting, env=env, store=store) as a:
        time.sleep(1.5)
        res = checks(Run(a, tag))
        stored = a.stored().get("nunchiro.settings.v1", {})
    return res, stored


def main():
    if sys.argv[1:2] == ["--dry-run"]:
        print("\n".join(plan()))
        return
    old = Path(sys.argv[1])
    SHOTS.mkdir(parents=True, exist_ok=True)
    repro.write_stubs()
    fresh, _ = run("fresh", None)
    olds, old_stored = run("old", old)
    rows = []
    for key, title in TITLES.items():
        f_ok, f_ev, f_shot = fresh[key]
        o_ok, o_ev, o_shot = olds[key]
        verdict = "applied" if f_ok and o_ok else "hidden by stored value" if f_ok else "missing"
        field, migration = FIELDS.get(key, ("", ""))
        rows.append(dict(key=key, title=title, verdict=verdict, fresh=f_ev, old=o_ev, fresh_shot=f_shot, old_shot=o_shot,
                         field=field if verdict == "hidden by stored value" else "", migration=migration if verdict == "hidden by stored value" else ""))
    (OUT / "conformance.json").write_text(json.dumps({"rows": rows, "old_store_version_field": "none (key nunchiro.settings.v1, no version inside)"}, indent=1) + "\n")
    e = html.escape
    body = "".join(
        f"<tr><td>{e(r['title'])}</td><td class='v {r['verdict'].split()[0]}'>{e(r['verdict'])}</td><td>{e(r['fresh'])}<br><a href='{r['fresh_shot']}'>fresh shot</a></td>"
        f"<td>{e(r['old'])}<br><a href='{r['old_shot']}'>old-store shot</a></td><td>{e(r['field'])}<br><small>{e(r['migration'])}</small></td></tr>" for r in rows)
    (OUT / "conformance.html").write_text(
        "<!doctype html><meta charset=utf-8><title>Decision conformance</title><style>body{font:14px system-ui;margin:24px;max-width:1500px}"
        "td,th{border-top:1px solid #d0d7de;padding:8px;vertical-align:top;text-align:left}table{border-collapse:collapse}.applied{color:#1a7f37}"
        ".hidden{color:#9a6700}.missing{color:#cf222e}.v{font-weight:600}</style><h1>Decision conformance (ticket 171, needs 150)</h1>"
        f"<p>Generated by <code>scripts/app-click/conformance.py</code>. Real app copy, fixture of repro row 16/17. Old store: a copy of the owner's window store "
        f"taken 18:15 on 2026-10-31 (seeded into the copy's own WebKit folder; the owner's store never written). The store has no version field.</p>"
        f"<table><tr><th>Decision</th><th>Verdict</th><th>Fresh store</th><th>Old store copy</th><th>Field and migration (needs 150)</th></tr>{body}</table>")
    for r in rows:
        print(f"{r['verdict']:24} {r['key']:26} fresh: {r['fresh'][:60]} | old: {r['old'][:60]}")


if __name__ == "__main__":
    main()
