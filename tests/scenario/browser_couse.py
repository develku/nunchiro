#!/usr/bin/env python3
"""V2.5-21 (WP3) live check of co-use: the owner and the agent on one browser, in the real app.

Reuses browser_tasks.py's lab (isolated NUNCHIRO_HOME, fixture site, shell sessions calling the real `nunchiro browser`).
The owner's hands are the debug app's test hook (NUNCHIRO_BROWSER_TEST_HUMAN, compiled out of release builds): it posts mouse
and key events through the app's event queue, the path a person's input takes, and presses Hand back through the same
function as the side pane's button.

Usage: browser_couse.py <nunchiro-app (debug)> <nunchiro-cli> [results.json]
Proves: agent_page_keeps_its_size (ticket 997 L6), agent_input_does_not_flip_control, agent cursor shown, no_double_input (the owner typing in Nunchiro's own UI while
the agent types in the page; the owner typing in the page while the agent tries to), human_input_pauses_agent,
queued_actions_dropped_on_takeover, hand_back_resumes, handoff pauses until Hand back.
Does not prove: a physical keyboard and mouse (events are posted by the app itself, after the window becomes key), the
side pane's chip (web/tests/browser-couse.spec.ts), sites other than the fixture.
Not named test_*.py: the gate's unittest discovery must not open a window."""
import json, os, shlex, socket, sys, threading, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from browser_tasks import Lab, Session, row_of, wait  # noqa: E402

REFUSED = "USER_IN_CONTROL"


class Hands:
    """Owner, through the debug app's hook: one command file in, one answer file out."""

    def __init__(self, lab, space):
        self.dir, self.space, self.n = os.path.join(lab.home, "human"), space, 0
        wait(lambda: os.path.isdir(self.dir), 30, "test hook started")

    def __call__(self, op, rest=""):
        self.n += 1
        base = os.path.join(self.dir, f"{self.n:04d}")
        with open(base + ".new", "w") as f:
            f.write(f"{op} {self.space} {rest}".rstrip())
        os.rename(base + ".new", base + ".cmd")
        wait(lambda: os.path.exists(base + ".out"), 15, f"hook {op}")
        out = json.load(open(base + ".out"))
        if "error" in out:
            raise AssertionError(f"hook {op}: {out['error']}")
        return out


def main():
    app, cli = sys.argv[1:3]
    out = sys.argv[3] if len(sys.argv) > 3 else None
    lab = Lab(app, cli, {"NUNCHIRO_BROWSER_TEST_HUMAN": "1", "NUNCHIRO_BROWSER_TEST_OWNER": ""})
    checks, evidence = {}, {}

    def check(name, ok, detail=""):
        checks[name] = bool(ok)
        evidence[name] = detail
        print("PASS" if ok else "FAIL", name, ("- " + detail) if detail else "", flush=True)

    try:
        a = Session(lab, "agent")
        wait(lambda: "app open" not in a.browser("tabs")[1], 60, "app attached to the core")
        owner = Hands(lab, a.id)
        a.browser("open", lab.base + "/form")
        # Ticket 997 L6 (A1, A4): the agent's page keeps its 1280x800 layout in a narrow widget and after the widget closes.
        owner("place", "420 600")
        narrow = owner("viewport")
        owner("hide")
        closed = owner("viewport")
        check("agent_page_keeps_its_size",
              all((v["w"], v["h"], v["vis"]) == (1280, 800, "visible") for v in (narrow, closed)),
              f"narrow widget {narrow}, closed {closed}")
        owner("place")  # the side pane shows the agent's tab on screen
        time.sleep(0.5)
        code, s = a.browser("snapshot")
        name, email, msg = (row_of(s, ["textbox", w]) for w in ("Name", "Email", "Message"))
        agree = row_of(s, ["checkbox", "agree"])

        # A11: the agent's own clicks, typing and keys never flip control; its pointer shows where it clicked.
        results = [a.browser("fill", name, "agent-1"), a.browser("click", agree), a.browser("press", "Tab")]
        state, cursor = owner("state"), owner("cursor")
        check("agent_input_does_not_flip_control",
              all(c == 0 for c, _ in results) and state["user"] is False,
              f"exits {[c for c, _ in results]}, state {state}")
        check("agent_cursor_shown", cursor["cursor"] is not None, f"cursor at {cursor['cursor']}")

        # no_double_input, case 1: the owner types in Nunchiro's own UI while the agent types in the page, at the same time.
        owner("ui")
        typed = "".join(f"k{i}" for i in range(12))
        agent_text = "the agent writes this whole sentence in one go " * 3
        fills = []
        t = threading.Thread(target=lambda: fills.extend(a.browser("fill", msg, agent_text) for _ in range(4)))
        t.start()
        for i in range(0, len(typed), 2):
            owner("keys", typed[i:i + 2])
            time.sleep(0.15)
        t.join()
        time.sleep(0.5)
        ui, page_msg = owner("ui-value"), owner("value", "textarea[name=msg]")
        check("no_double_input (the owner in Nunchiro's UI)",
              ui["value"] == typed and page_msg["value"] == agent_text and all(c == 0 for c, _ in fills)
              and owner("state")["user"] is False,
              f"ui {ui['value']!r} (want {typed!r}), page msg {len(page_msg['value'])} chars "
              f"(want {len(agent_text)}), fills {[c for c, _ in fills]}")

        # no_double_input, case 2 + human_input_pauses_agent: the owner clicks into Email and types while the agent keeps
        # trying to fill Name. The owner's keys all land in Email; Name holds only agent text; the agent is refused.
        tries = []

        def agent_loop():
            for i in range(6):
                tries.append(a.browser("fill", name, f"agent-{i + 2}"))

        t = threading.Thread(target=agent_loop)
        t.start()
        time.sleep(0.3)
        owner("click", "input[name=email]")
        human = "owner@example.org"
        for i in range(0, len(human), 3):
            owner("keys", human[i:i + 3])
            time.sleep(0.1)
        t.join()
        time.sleep(0.3)
        got_email, got_name = owner("value", "input[name=email]")["value"], owner("value", "input[name=name]")["value"]
        refused = [o for c, o in tries if c != 0]
        code, after = a.browser("snapshot")
        gcode, gout = a.browser("goto", lab.base + "/a")
        stayed = owner("value", "input[name=email]")["value"] == human  # still the owner's page, not navigated away
        check("no_double_input (the owner in the page)",
              got_email == human and got_name.startswith("agent-") and got_name[6:].isdigit(),
              f"email {got_email!r}, name {got_name!r}")
        check("human_input_pauses_agent (threat model A11 user_input_pauses_agent)",
              owner("state")["user"] is True and refused and all(REFUSED in o and "Hand back" in o for o in refused)
              and code != 0 and REFUSED in after and gcode != 0 and REFUSED in gout and stayed,
              f"{len(refused)}/{len(tries)} fills refused; goto refused and page kept: {stayed}; "
              f"snapshot: {after.strip()[:90]}")

        # queued_actions_dropped_on_takeover: four verbs sent together while the owner has control never run, not even later.
        q = " & ".join(f"{shlex.quote(lab.cli_path)} browser fill {name} queued-{i} > q{i}.out 2>&1"
                       for i in range(4))
        a.run(f"cd {shlex.quote(lab.home)} && {q} & wait; cat {lab.home}/q?.out")
        owner("hand-back")
        time.sleep(1.0)
        later = owner("value", "input[name=name]")["value"]
        outs = [open(os.path.join(lab.home, f"q{i}.out")).read() for i in range(4)]
        check("queued_actions_dropped_on_takeover",
              all(REFUSED in o for o in outs) and later == got_name,
              f"name after hand back {later!r}; replies {[o.strip()[:40] for o in outs]}")

        # hand_back_resumes: the agent's next verb runs and sees the owner's page state.
        code, s = a.browser("snapshot")
        code2, o2 = a.browser("fill", name, "agent-after")
        check("hand_back_resumes",
              code == 0 and human in s and code2 == 0 and owner("value", "input[name=name]")["value"] == "agent-after",
              next((l.strip() for l in s.splitlines() if human in l), f"email not in snapshot: {s[:300]!r}"))

        # Key-down path: the owner clicks into Email, hands back (his focus stays in the page), then typing alone takes it.
        owner("click", "input[name=email]")
        owner("hand-back")
        assert owner("state")["user"] is False
        owner("keys", "!")
        st = owner("state")
        em = owner("value", "input[name=email]")["value"] if owner("url")["url"].endswith("/form") else None
        check("key_down_takes_control", st["user"] is True and em is not None and em.replace("!", "", 1) == human,
              f"state {st}, email {em!r} (the key lands at the owner's caret)")
        owner("hand-back")

        # Review MUST: a verb the agent sent before the owner's Hand back is dropped even when the app reaches it afterwards.
        # A slow job of the agent's own space (a page that never answers: the navigation cap, about 8 s) holds the space's
        # worker, so the agent's fill waits in the app while the owner takes over and hands back. Ticket 998 L10 gave each
        # space its own worker, so the slow job must be in this space (another session's no longer holds it).
        hang = socket.socket()
        hang.bind(("127.0.0.1", 0))
        hang.listen(4)
        slow = f"{shlex.quote(lab.cli_path)} browser goto http://127.0.0.1:{hang.getsockname()[1]}/"
        busy = threading.Thread(target=lambda: a.run(f"{slow} > {shlex.quote(lab.home)}/busy.out 2>&1 & echo started"))
        busy.start()
        time.sleep(1.0)
        late = []
        t = threading.Thread(target=lambda: late.append(a.browser("fill", name, "stale-fill")))
        t.start()
        time.sleep(0.5)
        try:
            owner("click", "textarea[name=msg]")
        except AssertionError as e:
            raise AssertionError(f"{e} at {owner('url')}")
        owner("hand-back")
        t.join()
        busy.join()
        hang.close()
        code, o = late[0]
        kept = owner("value", "input[name=name]")["value"]
        check("job_sent_before_hand_back_is_dropped",
              code != 0 and REFUSED in o and kept == "agent-after", f"reply {o.strip()[:60]!r}; name {kept!r}")

        # The agent asks for the owner (handoff): paused with the reason until Hand back.
        code, h = a.browser("handoff", "solve the captcha")
        st = owner("state")
        code2, o2 = a.browser("tabs")
        owner("hand-back")
        code3, _ = a.browser("tabs")
        check("handoff_pauses_until_hand_back",
              h.startswith(REFUSED) and st["user"] and st["reason"] == "solve the captcha" and code2 != 0
              and REFUSED in o2 and code3 == 0,
              f"state {st}; tabs while paused: {o2.strip()[:60]}")
    except Exception as e:  # a crash is a failed run, with what it was doing
        check("run completed", False, f"{type(e).__name__}: {e}")
    finally:
        lab.close()
    print("app log:", *lab.log[-15:], sep="\n  ")
    if out:
        json.dump({"checks": checks, "evidence": evidence}, open(out, "w"), indent=1)
    sys.exit(0 if checks and all(checks.values()) else 1)


if __name__ == "__main__":
    main()
