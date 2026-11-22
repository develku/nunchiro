#!/usr/bin/env python3
"""Ticket 171: reproduce the owner's 2026-10-31 findings (needs 149) in the real app, one scenario each.

Usage: repro.py [NN ...]   (default: all 25; 16-25 were added through the coordinator). Captures land in docs/design/v25-bug-sweep/shots/NN-*.png and the
observations each scenario measures (AX frames, counts, hang checks) in docs/design/v25-bug-sweep/results.json.
Verdicts and clues are written on the page by a person reading these, not guessed here.

Fixture: a temp git project with a live shell session and a closed one (a Done card). Account scenario 09 puts stub
`claude` / `codex` first on PATH (stub-claude.py), so login, logout and agent runs never reach the owner's real agents,
config or keychain and spend no tokens."""
import json, os, subprocess, sys, time
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import harness  # noqa: E402

OUT = HERE.parent.parent / "docs/design/v25-bug-sweep"
SHOTS = OUT / "shots"
STUB = "#!/bin/sh\necho \"stub $(basename \"$0\") $*\"\nexit 0\n"  # codex: login/logout only


def fixture(a):
    proj = a.tmp / "demo-project"
    proj.mkdir()
    subprocess.run(["git", "init", "-q", str(proj)], check=True)
    (proj / "README.md").write_text("demo\n")
    subprocess.run(["git", "-C", str(proj), "add", "."], check=True)
    subprocess.run(["git", "-C", str(proj), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], check=True)
    done = json.loads(a.cli("session", "start", "--kind", "shell", "--project", proj, "--label", "worker-done"))["session"]["id"]
    a.cli("session", "start", "--kind", "shell", "--project", proj, "--label", "worker-live")
    time.sleep(1)
    a.cli("session", "close", done)
    a.project = proj


def bar_frames(a):
    """Every bar icon: label -> (x, y, w, h), from the left and right bars' AX checkboxes."""
    out = {}
    for line in a.tree(8).splitlines():
        parts = [p.strip() for p in line.split("|")]
        if parts[0].endswith("AXCheckBox") and parts[4].count(",") == 3:
            x, y, w, h = map(int, parts[4].split(","))
            if x - a.window()[1] < 70 or x > a.window()[1] + a.window()[3] - 70:
                out[parts[1]] = (x, y, w, h)
    return out


def icon(a, label):
    hits = [f[:4] for f in a.find(label) if f[4] == "AXCheckBox"]
    if not hits:
        raise RuntimeError(f"no bar icon {label}")
    return hits[0]


def lines(a, word, depth=40):
    return [ln for ln in a.tree(depth).splitlines() if word in ln]


def held_drag(a, label, to, steps=30):
    """A user's drag of a bar icon: small first moves over the icon (IconBar starts a drag only on a pointermove
    over the button past MOVE px), then on to `to`. Returns (hang during, hang after drop) as text or None."""
    x, y, w, h = icon(a, label)
    cx, cy = x + w // 2, y + h // 2
    a.down(cx, cy)
    for i in range(1, 6):
        a.dragto(cx, cy + i * 2)
    for i in range(1, steps + 1):
        a.dragto(cx + (to[0] - cx) * i / steps, cy + 10 + (to[1] - cy - 10) * i / steps)
        time.sleep(0.02)
    during = after = None
    try:
        a.ping()
    except harness.Hang as e:
        during = str(e)
    a.up(*to)
    for _ in range(5):
        try:
            a.ping()
        except harness.Hang as e:
            after = str(e)
            break
        time.sleep(1)
    return during, after


def s01(a):
    a.press("Board")
    a.capture("01-board-done")
    return {"done_card_lines": [ln.split("|", 1)[1].strip() for ln in lines(a, "worker-done")]}


def s02(a):
    a.press("Layout")
    wx, wy, ww, wh = a.window()[1:]
    moves = [("Files", (wx + 33, wy + 400)), ("Search", (wx + ww - 265, wy + 470)), ("Board", (wx + 33, wy + 300)),
             ("Artifacts", (wx + 33, wy + 420)), ("Diff", (wx + 33, wy + 250)), ("Files", (wx + 600, wy + 400))]
    steps = []
    for label, to in moves:
        t0 = time.monotonic()
        during, after = held_drag(a, label, to)
        steps.append({"icon": label, "to": to, "hang_during": during, "hang_after": after, "secs": round(time.monotonic() - t0, 1)})
        if during or after:
            break
    a.capture("02-after-rearrange")
    a.press("Done")
    # Outside edit mode a bar icon dragged onto the session view peeks a split (PEEKSPLIT).
    during, after = held_drag(a, "Artifacts", (wx + 600, wy + 300))
    steps.append({"icon": "Artifacts (not editing)", "hang_during": during, "hang_after": after})
    a.capture("02-after-peek-drag")
    return {"drags": steps}


def s03(a):
    a.press("Layout")
    x, y, w, h = icon(a, "Files")
    cx, cy = x + w // 2, y + h // 2
    a.down(cx, cy)
    for i in range(1, 6):
        a.dragto(cx, cy + i * 2)
    for i in range(1, 25):
        a.dragto(cx, cy + 10 + i * 12)
    a.capture("03-mid-drag-left")
    wx, wy, ww, wh = a.window()[1:]
    for i in range(1, 25):
        a.dragto(cx + (wx + ww - 265 - cx) * i / 24, cy + 300)
    a.capture("03-mid-drag-right")
    a.key(53)  # Esc cancels the drag
    a.up(wx + ww - 265, cy + 300)
    a.press("Cancel")
    return {"window": [ww, wh]}


def s04(a):
    a.capture("04-bars")
    f = bar_frames(a)
    return {"icon_frames": f, "widths": sorted({v[2] for v in f.values()}), "heights": sorted({v[3] for v in f.values()})}


def s05(a):
    a.press("Settings")
    a.press("Theme")
    a.press("One theme")
    shots = []
    found = {}
    for card in ("Catppuccin Mocha", "Nunchiro Dark"):
        found[card] = [ln.split("|", 1)[1].strip() for ln in lines(a, card)][:4]
        hit = a.find(card)
        if hit:
            x, y, w, h, _ = hit[0]
            a.click(x + w // 2, y + h // 3)  # the card itself (its preview half)
            shots.append(str(a.capture(f"05-theme-{card.lower().replace(' ', '-')}").name))
    a.press("Board")
    a.capture("05-theme-board")
    return {"captured": shots, "card_lines": found}


def s06(a):
    a.press("+ Project")
    time.sleep(1.5)
    a.capture("06-add-project-click")
    dialogs = [ln for ln in a.tree(4).splitlines() if "AXSheet" in ln or "AXDialog" in ln or "Open" in ln]
    folder_button = bool(a.find("Use an existing folder…"))
    if folder_button:
        a.press("Use an existing folder…")
        time.sleep(1.5)
        a.capture("06-choose-folder-click")
        dialogs += [ln for ln in a.tree(4).splitlines() if "AXSheet" in ln or "AXDialog" in ln]
    return {"native_panel_lines": dialogs, "choose_folder_button": folder_button}


def s07(a):
    a.press("Settings")
    a.press("Keys")
    a.capture("07-keys-page")
    rows = [ln for ln in lines(a, "AXButton") if "| Edit" in ln]
    wy, wh = a.window()[2], a.window()[4]
    shown = [ln for ln in rows if wy < int(ln.rsplit("|", 1)[1].split(",")[1]) < wy + wh]
    a.press("Show the keys you can press next")
    hint_rows = len([ln for ln in lines(a, "AXStaticText") if ln.count("|") == 4])
    a.key(53)
    return {"edit_buttons_in_ax": len(rows), "edit_buttons_on_screen": len(shown), "key_hints_overlay_texts": hint_rows}


def s08(a):
    a.press("Show the keys you can press next")
    a.capture("08-key-hints")
    a.key(53)
    a.press("Settings")
    a.press("Hints")
    a.capture("08-hints-page")
    return {}


def s09(a):
    a.press("Settings")
    a.press("Accounts")
    a.capture("09-accounts")
    a.press("+ Add account")
    a.type("work")
    a.press("Add and log in", settle=3)
    a.press("Settings")
    a.press("Accounts")
    a.capture("09-account-added")
    steps = []
    for word in ("Remove Claude account work", "Log out", "Log out and remove", "Remove", "Remove anyway", "Continue", "Move to trash"):
        if a.find(word):
            a.press(word, settle=4)
            steps.append(word)
            a.capture(f"09-after-{len(steps)}-{word.split()[0].lower().strip('…')}")
            steps.append([ln.split("|", 1)[1].strip()[:120] for ln in lines(a, "AXButton") if "emove" in ln or "og out" in ln or "ancel" in ln][:6])
    a.press("Settings")
    a.press("Accounts")
    a.capture("09-final")
    return {"pressed": steps, "work_lines": [ln.split("|", 1)[1].strip() for ln in lines(a, "work")][:10],
            "error_lines": [ln.split("|", 1)[1].strip() for ln in lines(a, "AXStaticText") if "rror" in ln or "fail" in ln or "in use" in ln][:10]}


def s10(a):
    tree = a.tree(40)
    hits = [ln for ln in tree.splitlines() if "rowser" in ln]
    a.press("Open command palette")
    a.type("browser")
    time.sleep(0.8)
    a.capture("10-palette-browser")
    a.key(53)
    return {"browser_controls_in_window": hits}


def s11(a):
    a.capture("11-bars-placement")
    f = bar_frames(a)
    wx, wy, ww, wh = a.window()[1:]
    rel = {k: ("left" if v[0] - wx < 70 else "right", round((v[1] - wy) / wh, 2)) for k, v in f.items() if k in ("Settings", "Layout")}
    return {"placement": rel}


def s12(a):
    a.press("Layout")
    a.capture("12-widget-library")
    agents = [ln.split("|", 1)[1].strip() for ln in lines(a, "Agents")][:6]
    a.press("Cancel")
    return {"agents_lines": agents, "agents_on_a_bar": bool([f for f in a.find("Agents") if f[4] == "AXCheckBox"])}


def s13(a):
    a.press("worker-live")
    time.sleep(0.8)
    a.capture("13-session-tree-open")
    a.press("Open command palette")
    a.type("split")
    time.sleep(0.8)
    a.capture("13-palette-split")
    palette = [ln.split("|", 1)[1].strip()[:100] for ln in lines(a, "plit")][:8]
    a.key(36)  # Enter runs the first match
    time.sleep(1.5)
    a.capture("13-cmd-d-split")
    chooser = [ln.split("|", 1)[1].strip()[:100] for ln in lines(a, "AXButton") if any(w in ln for w in ("Agent", "Terminal", "Widget", "Chooser"))][:8]
    a.key(53)
    return {"palette": palette, "after_split_buttons": chooser}


def s14(a):
    a.press("Board")
    a.capture("14-board")
    a.press("Settings")
    a.press("Sessions and startup")
    a.capture("14-settings-sessions")
    return {}


def s15(a):
    a.press("Settings")
    for page in ("Accounts", "Agents", "Libraries"):
        a.press(page)
        a.capture(f"15-{page.lower()}")
    return {}


def s16(a):
    """Finding 16 (coordinator, ticket 171 comment): with agents running, the approved bar / head counts."""
    time.sleep(2)
    a.capture("16-agents-running")
    snap = json.loads(a.cli("snapshot", "--json"))
    att = {s.get("label"): {k: s["attention"][k] for k in ("working", "waiting")} for s in snap.get("sessions", [])}
    rows = {lab: [ln.split("|", 1)[1].strip() for ln in lines(a, lab)][:3] for lab in att}
    tree_icon = [ln.split("|", 1)[1].strip() for ln in lines(a, "AXCheckBox", 8) if "Tree" in ln]
    return {"attention": att, "tree_rows": rows, "tree_icon": tree_icon}


def s17(a):
    """Finding 17 (the owner): a session showing its terminal view still shows the composer."""
    composer = lambda: [ln.split("|", 1)[1].strip()[:80] for ln in lines(a, "AXTextArea")]  # noqa: E731
    click_tab(a, "agent-working")
    a.press("Open terminal", settle=1.5)
    a.capture("17-claude-terminal-view")
    claude = composer()
    click_tab(a, "worker-live")
    a.capture("17-shell-terminal-view")
    return {"composer_in_claude_terminal_view": claude, "composer_in_shell_view": composer()}


def click_tab(a, label):
    """The session tab whose AX text names `label` (tabs carry it in their description, not a title)."""
    tab = [ln for ln in lines(a, label, 12) if "Close tab" in ln][0]
    x, y, w, h = map(int, tab.rsplit("|", 1)[1].split(","))
    a.click(x + w // 2, y + h // 2, settle=1.2)


def both_fixture(a):
    fixture(a)
    a.cli("session", "start", "--kind", "claude", "--project", a.project, "--label", "agent-working", "--", "--stub-mode", "working")
    time.sleep(2)


def agents_fixture(a):
    """Two stub Claude sessions (stub-claude.py on PATH): one working, one waiting on a permission ask."""
    proj = a.tmp / "demo-project"
    proj.mkdir()
    subprocess.run(["git", "init", "-q", str(proj)], check=True)
    for mode in ("working", "waiting"):
        a.cli("session", "start", "--kind", "claude", "--project", proj, "--label", f"agent-{mode}", "--", "--stub-mode", mode)
    time.sleep(3)




def settings_page(a, page, name):
    a.press("Settings")
    a.press(page)
    shot = a.capture(name)
    return shot, [ln.split("|", 1)[1].strip()[:200] for ln in lines(a, "AXStaticText") if (f := ln.rsplit("|", 1)[1]).count(",") == 3
                  and int(f.split(",")[0]) > a.window()[1] + 280][:40]


def words(texts):
    return sum(len(t.replace("|", " ").split()) for t in texts)


def s18(a):
    _, t = settings_page(a, "Browser access", "18-browser-access")
    return {"texts": t, "words": words(t)}


def s19(a):
    _, acc = settings_page(a, "Accounts", "19-accounts")
    _, use = settings_page(a, "Usage", "19-usage")
    return {"accounts_words": words(acc), "usage_texts": use[:12]}


def s20(a):
    a.press("Settings")
    a.press("Accounts")
    a.press("+ Add account")
    a.type("work")
    a.press("Add and log in", settle=2.5)
    a.capture("20-add-account-terminal-login")
    return {"tabs_after_add": [ln.split("|", 1)[1].strip()[:80] for ln in lines(a, "Close tab")][:6]}


def s21(a):
    _, t = settings_page(a, "Sessions and startup", "21-sessions-startup")
    return {"words": words(t), "texts": t[:20]}


def s22(a):
    a.press("Settings")
    a.press("Appearance")
    a.capture("22-appearance-language")
    radios = [ln.split("|", 1)[1].strip()[:40] for ln in lines(a, "AXRadioButton")][:16]
    return {"radios": radios}


def s23(a):
    """Finding 23: no drag-to-resize panes. Drag the sidebar's right edge and the side pane's left edge 120 px."""
    out = {}
    side = [f for f in a.find("Left sidebar") if f[4] == "AXGroup"]
    x, y, w, h = side[0][:4]
    a.capture("23-before")
    a.down(x + w - 1, y + h // 2)
    for i in range(1, 25):
        a.dragto(x + w - 1 + i * 5, y + h // 2)
    a.up(x + w + 119, y + h // 2)
    time.sleep(0.6)
    after = [f for f in a.find("Left sidebar") if f[4] == "AXGroup"][0]
    out["sidebar_width"] = [w, after[2]]
    a.capture("23-after-sidebar-drag")
    splitters = [ln.split("|", 1)[1].strip()[:80] for ln in lines(a, "AXSplitter")]
    out["splitters"] = splitters
    return out


def s24(a):
    """Finding 24: rail icon glyph boxes and centre offsets, measured on the capture (1 px = 1 pt here)."""
    shot = a.capture("24-rails")
    wx, wy = a.window()[1:3]
    bars = {}
    for name in ("Left bar", "Right bar"):
        g = [ln for ln in lines(a, name, 8) if "AXGroup" in ln]
        bars[name] = tuple(map(int, g[0].rsplit("|", 1)[1].split(","))) if g else None
    rows = []
    for line in lines(a, "AXCheckBox", 8):
        parts = [p.strip() for p in line.split("|")]
        if parts[4].count(",") != 3:
            continue
        x, y, w, h = map(int, parts[4].split(","))
        side = "Left bar" if x < wx + 70 else "Right bar" if bars["Right bar"] and x >= bars["Right bar"][0] else None
        if not side:
            continue
        bx, by, bw, bh = bars[side]
        # glyph: the top 24 px of the button (the label sits under it)
        g = harness.ax("bbox", shot, x - wx + 2, y - wy + 2, w - 4, 24).split()
        glyph = list(map(int, g)) if g[0] != "none" else None
        rows.append({"icon": parts[1], "side": side, "button": [x - wx, y - wy, w, h], "bar": [bx - wx, bw],
                     "button_centre_off": round(x + w / 2 - (bx + bw / 2), 1),
                     "glyph": glyph, "glyph_centre_off": round(glyph[0] + glyph[2] / 2 - (bx - wx + bw / 2), 1) if glyph else None})
    return {"icons": rows}


def s25(a):
    a.capture("25-bars-always-shown")
    hide = [ln.split("|", 1)[1].strip()[:80] for ln in lines(a, "uto-hide")] + [ln.split("|", 1)[1].strip()[:80] for ln in lines(a, "Hide bars")]
    a.press("Settings")
    a.press("Layout")
    a.capture("25-settings-layout")
    return {"auto_hide_controls": hide}


def write_stubs():
    stubs = Path(harness.BUILD / "stub-bin")
    stubs.mkdir(parents=True, exist_ok=True)
    (stubs / "codex").write_text(STUB)
    (stubs / "claude").write_text((HERE / "stub-claude.py").read_text())
    for name in ("claude", "codex"):
        (stubs / name).chmod(0o755)
    return stubs


def both_fixture_waiting(a):
    """Conformance fixture: the shell sessions plus one working and one waiting stub agent."""
    both_fixture(a)
    a.cli("session", "start", "--kind", "claude", "--project", a.project, "--label", "agent-waiting", "--", "--stub-mode", "waiting")
    time.sleep(2)


SCENARIOS = {f"{i:02d}": globals()[f"s{i:02d}"] for i in range(1, 26)}
FIXTURE = {"16": agents_fixture, "17": both_fixture}


def main():
    pick = sys.argv[1:] or list(SCENARIOS)
    SHOTS.mkdir(parents=True, exist_ok=True)
    path = OUT / "results.json"
    results = json.loads(path.read_text()) if path.is_file() else {}
    stubs = write_stubs()
    env = {"PATH": f"{stubs}:{os.environ.get('PATH', '/usr/bin:/bin')}"}
    failed = 0
    for key in pick:
        t0 = time.monotonic()
        try:
            with harness.App(shots=SHOTS, before=FIXTURE.get(key, fixture), env=env) as a:
                obs = SCENARIOS[key](a)
            results[key] = {"ok": True, **obs}
        except harness.Hang as e:
            results[key] = {"ok": False, "hang": str(e)}
            failed += 1
        except Exception as e:  # noqa: BLE001  one scenario's failure is recorded, the rest still run
            results[key] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
            failed += 1
        results[key]["secs"] = round(time.monotonic() - t0, 1)
        print(key, json.dumps(results[key])[:300], flush=True)
        path.write_text(json.dumps(results, indent=1, sort_keys=True) + "\n")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
