#!/usr/bin/env python3
"""V2.5-22 (WP4) live check of the element picker in the real app (a headless test cannot make a WKWebView).

Starts the debug app under an isolated NUNCHIRO_HOME (NUNCHIRO_ANNOTATE_TEST=1: a file switches a space's picker on and
every `browser-picked` event is echoed to stderr as the main window gets it), drives one shell session whose commands are
real `nunchiro browser` calls (a native, trusted click), and checks the payload.

Usage: browser_annotate.py <nunchiro-app (debug)> <nunchiro-cli>
Proves: picker_agent_click_does_not_take_control, picker_owner_click_picks_and_takes_control (and Hand back resumes the
agent), picker_strips_secret_descendants (a card holding hidden CSRF, password and file inputs yields no input and no
value), annotate_off_when_view_gone (Forget, then a reopened view has the picker off), picker_isolated_world (a page that overrides DOM methods and getters yields the same payload as a plain page),
annotate_end_to_end (picker on, a trusted click on a fixture element, the event arrives with the element's selector and
text), picker_trusted_clicks_only (a script click makes no pick), picker_swallows_page_clicks, picked_event_page_cannot_listen (the page's listen on
`browser-picked` is refused).
Does not prove: the web half (web/tests/browser-annotate.spec.ts feeds the same payload shape to the composer), the main
window's own listener under a real click on the Annotate button, picks on sites other than the fixture.
Not named test_*.py on purpose: the AGENTS.md gate's unittest discovery must not open a window."""
import json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import browser_site  # noqa: E402
from browser_couse import Hands  # noqa: E402
from browser_tasks import Lab, Session, wait, row_of  # noqa: E402

BODY = """<main><h1>Shop</h1><p>Cart is empty.</p><button id="buy" class="cta big">Buy now</button>
<input type="password" id="pw" value="hunter2"><p id="ipc">ipc: waiting</p>
<button id="fake">Script click</button>
<div id="card" role="button" tabindex="0" aria-label="Pay card" style="padding:20px">Pay by card
<input type="hidden" name="csrf" value="csrf-77a"><input type="password" style="display:none" value="pw-secret"><input type="file" style="display:none" value="C:/fake/file-secret"></div>
<script>
setInterval(() => document.getElementById('fake').click(), 300);
document.getElementById('buy').addEventListener('click', () => document.getElementById('ipc').textContent += ' buy-clicked');
document.getElementById('fake').addEventListener('click', () => document.getElementById('ipc').textContent += ' fake-clicked');
(async () => { let r = 'none'; try { await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {event: 'browser-picked', target: {kind: 'Any'}, handler: 0}); r = 'allowed'; } catch (e) { r = 'refused'; }
  document.getElementById('ipc').textContent = 'ipc: listen=' + r; })();
</script></main>"""
# A10: the page world rewrites what a page-world picker would read.
TAMPER = """<script>
Element.prototype.getBoundingClientRect = () => ({x: 0, y: 0, width: 0, height: 0});
Element.prototype.getAttribute = () => 'TAMPERED';
Object.defineProperty(HTMLElement.prototype, 'innerText', {get() { return 'TAMPERED'; }});
Object.defineProperty(Node.prototype, 'textContent', {get() { return 'TAMPERED'; }});
Object.defineProperty(Element.prototype, 'outerHTML', {get() { return 'TAMPERED'; }});
Object.defineProperty(Element.prototype, 'tagName', {get() { return 'TAMPERED'; }});
CSS.escape = () => 'TAMPERED';
</script>"""
browser_site.PROBES["/annotate"] = f"<!doctype html><title>Shop</title>{BODY}"
browser_site.PROBES["/annotate-tamper"] = f"<!doctype html><title>Shop</title>{TAMPER}{BODY}"


def main():
    app, cli = sys.argv[1:3]
    os.environ["NUNCHIRO_BROWSER_TEST_HUMAN"] = "1"  # WP3's hook plays the owner's hands
    os.environ["NUNCHIRO_ANNOTATE_TEST"] = "1"  # Lab copies the environment when it starts the app
    lab = Lab(app, cli)
    checks = {}

    def check(name, ok, detail=""):
        checks[name] = bool(ok)
        print("PASS" if ok else "FAIL", name, ("- " + detail) if detail else "", flush=True)

    def picks():
        return [json.loads(l.split(" ", 1)[1]) for l in lab.log if l.startswith("annotate-picked ")]

    def pick_on(a, path, words=("button", "Buy now")):
        """Opens the page, switches the picker on for the session's space, clicks the buy button natively; returns the pick."""
        a.browser("goto", lab.base + path)
        code, s = a.browser("snapshot")
        row = row_of(s, list(words))
        n = len(picks())
        open(os.path.join(lab.home, "annotate-on"), "w").write(a.id)
        wait(lambda: not os.path.exists(os.path.join(lab.home, "annotate-on")), 10, "picker switched on")
        time.sleep(0.6)  # the poller's first tick re-arms the picker in the loaded document
        a.browser("click", row)
        wait(lambda: len(picks()) > n, 10, "browser-picked event")
        return picks()[-1]

    try:
        a = Session(lab, "agent")
        wait(lambda: "app open" not in a.browser("tabs")[1], 60, "app attached to the core")
        plain = pick_on(a, "/annotate")
        el = plain["element"]
        check("annotate_end_to_end", plain["space"] == a.id and el["target"]["selector"].endswith("#buy")
              and el["target"]["textSnippet"] == "Buy now" and el["target"]["tagName"] == "button"
              and el["page"]["sanitizedUrl"].endswith("/annotate"), json.dumps(el)[:200])
        owner = Hands(lab, a.id)
        check("picker_agent_click_does_not_take_control", owner("state")["user"] is False, "agent's native click with the picker on")
        # The owner's own click in picker mode: a real mouse-down on the view is the owner's hands (WP3, A11), so it picks AND hands him
        # the browser, exactly like any click of his; the page is untouched (the picker swallows the click).
        owner("place")
        time.sleep(1)
        n = len(picks())
        owner("click", "#buy")
        wait(lambda: len(picks()) > n, 10, "the owner's pick")
        check("picker_owner_click_picks_and_takes_control", picks()[-1]["element"]["target"]["selector"].endswith("#buy")
              and owner("state")["user"] is True and "USER_IN_CONTROL" in a.browser("snapshot")[1], json.dumps(owner("state")))
        owner("hand-back")
        check("picker_hand_back_resumes_agent", owner("state")["user"] is False and "USER_IN_CONTROL" not in a.browser("snapshot")[1])
        el = pick_on(a, "/annotate")["element"]  # the plain page again, in the view's current placement
        a.browser("goto", lab.base + "/annotate-tamper")
        tampered = pick_on(a, "/annotate-tamper")["element"]
        norm = lambda e: {**e, "page": {**e["page"], "sanitizedUrl": e["page"]["sanitizedUrl"].replace("-tamper", "")}}
        check("picker_isolated_world", norm(tampered) == el, json.dumps(tampered)[:200])
        code, s = a.browser("snapshot")
        check("picked_event_page_cannot_listen", "listen=refused" in s, next((l for l in s.splitlines() if l.startswith("ipc:")), "?"))
        time.sleep(1.2)  # the page has been clicking #fake from a script every 300 ms
        check("picker_trusted_clicks_only", not [p for p in picks() if p["element"]["target"]["selector"].endswith("#fake")])
        check("picker_swallows_page_clicks", "fake-clicked" not in a.browser("snapshot")[1])
        card = pick_on(a, "/annotate", ("button", "Pay card"))["element"]["target"]
        blob = json.dumps(card)
        check("picker_strips_secret_descendants", card["tagName"] == "div" and "Pay by card" in card["textSnippet"]
              and "<input" not in card["htmlSnippet"] and not any(v in blob for v in ("csrf-77a", "pw-secret", "file-secret")), blob[:200])
        # annotate_off_when_view_gone: Forget closes the view; the view opened afterwards has the picker off.
        n = len(picks())
        open(os.path.join(lab.home, "annotate-forget"), "w").write(a.id)
        wait(lambda: any(l == "annotate-forgotten" for l in lab.log), 30, "forget")
        time.sleep(1)
        # The side pane's way back in: the space's first view (the agent's tab list still names it).
        open(os.path.join(lab.home, "annotate-show"), "w").write(f"{a.id} {lab.base}/annotate")
        wait(lambda: not os.path.exists(os.path.join(lab.home, "annotate-show")), 10, "view reopened")
        time.sleep(1.5)
        row = row_of(a.browser("snapshot")[1], ["button", "Buy now"])
        a.browser("click", row)
        time.sleep(1.5)
        check("annotate_off_when_view_gone (live)", len(picks()) == n and "buy-clicked" in a.browser("snapshot")[1],
              f"picks {n} -> {len(picks())}")
    finally:
        lab.close()
    print("log:", *lab.log[-6:], sep="\n  ")
    sys.exit(0 if checks and all(checks.values()) else 1)


main()
