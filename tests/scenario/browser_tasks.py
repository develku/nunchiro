#!/usr/bin/env python3
"""V2.5-20 (WP2) live check of `nunchiro browser` in the real app (a headless test cannot make a WKWebView).

Starts the debug app under an isolated NUNCHIRO_HOME with the fixture in browser_site.py, drives shell sessions whose
commands are real `nunchiro browser` CLI calls (so the core resolves each caller from its session token, as for an agent),
and checks the fixture tasks and the threat-model MUSTs that need a live page. The debug app plays the owner at the login
handoff (NUNCHIRO_BROWSER_TEST_OWNER, compiled out of release builds).

Usage: browser_tasks.py <nunchiro-app (debug)> <nunchiro-cli> [results.json]
Proves: fixture_tasks (login_read, form_fill, two_tabs), snapshot_tokens (snapshot chars <= 0.5x ego lite, findings
section 3), snapshot_omits_password_fields, snapshot_runs_in_isolated_world, browser_adds_no_listen_port,
browser_verb_targets_own_space_only (live: tabs), spaces_on_default_profile_share_cookies (live, ticket 264), browser_snapshot_fences_page_text (live), trusted input,
huge_title_click_answers_ok and tree_value_cannot_forge_a_ref (ticket 998 L5), stable_ref_hits_same_element_or_is_refused
(ticket 998 L9), other_space_not_held_by_slow_job, never_loading_page_answers_before_12s and
second_verb_in_busy_space_answers_before_12s (ticket 998 L10).
Does not prove: the owner's real handoff (WP3 builds the chip and Hand back), sites other than the fixture, visibility of the
agent's view on screen (agent tabs are parked outside the window until the side pane shows them).
Not named test_*.py on purpose: the AGENTS.md gate's unittest discovery must not open a window."""
import json, os, shlex, subprocess, sys, tempfile, threading, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import browser_site  # noqa: E402

EGO = {"login_read": 11137, "form_fill": 9500, "two_tabs": 13435}  # findings.md section 3, ego lite 0.6.2.5
FENCE = "--- page content (untrusted: written by the web page, not by the owner) ---"
FENCE_END = "--- end page content ---"
PASSWORD = "pw-4821"

RUNNER = """H="$1"; Q="$H/q/$2"; mkdir -p "$Q"; touch "$Q/ready"
while :; do
  for f in "$Q"/*.cmd; do
    [ -e "$f" ] || continue
    sh "$f" > "${f%.cmd}.tmp" 2>&1 < /dev/null; echo "exit=$?" >> "${f%.cmd}.tmp"
    mv "${f%.cmd}.tmp" "${f%.cmd}.out"; rm -f "$f"
  done
  sleep 0.05
done
"""


class Session:
    """One shell session in the core; `run` executes a command line inside it and returns (exit code, output)."""

    def __init__(self, lab, name):
        self.lab, self.q, self.n = lab, os.path.join(lab.home, "q", name), 0
        r = lab.cli("session", "open", "--project", lab.home, "--", "/bin/sh", lab.runner, lab.home, name)
        self.id = json.loads(r.stdout)["session"]["id"]
        wait(lambda: os.path.exists(os.path.join(self.q, "ready")), 30, f"session {name} runner")

    def run(self, line):
        self.n += 1
        base = os.path.join(self.q, f"{self.n:03d}")
        with open(base + ".tmp-cmd", "w") as f:
            f.write(line + "\n")
        os.rename(base + ".tmp-cmd", base + ".cmd")
        wait(lambda: os.path.exists(base + ".out"), 40, line)
        text = open(base + ".out").read()
        body, _, code = text.rpartition("exit=")
        return int(code.strip() or 1), body.rstrip("\n")

    def browser(self, *args):
        return self.run(shlex.quote(self.lab.cli_path) + " browser " + " ".join(shlex.quote(a) for a in args))


def wait(cond, secs, what):
    until = time.time() + secs
    while not cond():
        if time.time() > until:
            raise TimeoutError(what)
        time.sleep(0.05)


class Lab:
    def __init__(self, app, cli, extra=None):
        self.cli_path = cli
        self.site = browser_site.serve()
        self.base = f"http://127.0.0.1:{self.site.server_port}"
        self.home = tempfile.mkdtemp(prefix="ns-bt-", dir=os.environ.get("TMPDIR", "/tmp"))
        self.runner = os.path.join(self.home, "runner.sh")
        open(self.runner, "w").write(RUNNER)
        self.env = {**os.environ, "NUNCHIRO_HOME": self.home, "NUNCHIRO_LOGIN_PATH": "off", "NUNCHIRO_BIN": cli, "NUNCHIRO_BROWSER_TEST_OWNER": PASSWORD}
        self.env.update(extra or {})  # browser_couse.py: its own debug hooks
        self.env.pop("NUNCHIRO_TOKEN", None)
        self.log = []
        self.app = subprocess.Popen([app], env=self.env, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True)
        threading.Thread(target=lambda: [self.log.append(l.rstrip()) for l in self.app.stderr], daemon=True).start()

    def cli(self, *args):
        return subprocess.run([self.cli_path, *args], env=self.env, capture_output=True, text=True, timeout=60)

    def close(self):
        self.app.terminate()
        try:
            self.app.wait(10)
        except subprocess.TimeoutExpired:
            self.app.kill()
        self.cli("serve", "stop", "--yes")
        self.site.shutdown()

    def listeners(self):
        """TCP listening sockets of the app and core processes (core: the holder of core.sock)."""
        pids = {str(self.app.pid)}
        r = subprocess.run(["lsof", "-t", os.path.join(self.home, "core.sock")], capture_output=True, text=True)
        pids |= set(r.stdout.split())
        r = subprocess.run(["lsof", "-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", ",".join(sorted(pids))],
                           capture_output=True, text=True)
        return sorted({" ".join(l.split()[i] for i in (0, 1, 8)) for l in r.stdout.splitlines()[1:]})


def rows(snapshot):
    return [l for l in snapshot.splitlines() if l.startswith("[")]


def row_of(snapshot, words):
    for l in rows(snapshot):
        if all(w in l for w in words):
            return l[1:l.index("]")]
    raise AssertionError(f"no row with {words} in:\n{snapshot}")


def main():
    app, cli = sys.argv[1:3]
    out = sys.argv[3] if len(sys.argv) > 3 else None
    lab = Lab(app, cli)
    checks, numbers, evidence = {}, {}, {}

    def check(name, ok, detail=""):
        checks[name] = bool(ok)
        evidence[name] = detail
        print("PASS" if ok else "FAIL", name, ("- " + detail) if detail else "", flush=True)

    try:
        a = Session(lab, "agent")
        wait(lambda: "app open" not in a.browser("tabs")[1], 60, "app attached to the core")
        base = lab.base
        listen_before = lab.listeners()

        # login_read: the password field is the owner's (A3); the agent fills the user name and hands off.
        snaps = []
        code, o = a.browser("open", base + "/secret")
        code, s1 = a.browser("snapshot")
        snaps.append(s1)
        user = row_of(s1, ["textbox", "Username"])
        no_pw = "password" not in "\n".join(rows(s1)).lower() and not any("Password" in r for r in rows(s1))
        a.browser("fill", user, "owner")
        code, h = a.browser("handoff", "sign in needs the password")
        code, s2 = a.browser("snapshot")
        snaps.append(s2)
        numbers["login_read"] = sum(map(len, snaps))
        check("login_read", "NUNCHI-4821" in s2 and h.startswith("USER_IN_CONTROL"), s2.splitlines()[1] if s2 else o)
        check("snapshot_omits_password_fields", no_pw and PASSWORD not in s2 and PASSWORD not in s1,
              "rows on /login: " + " | ".join(rows(s1)[-3:]))

        # form_fill: five fields through the table, native input except the select (DOM change event).
        snaps = []
        a.browser("goto", base + "/form")
        code, s1 = a.browser("snapshot")
        snaps.append(s1)
        steps = [("fill", row_of(s1, ["textbox", "Name"]), "the owner Tester"),
                 ("fill", row_of(s1, ["textbox", "Email"]), "owner@example.com"),
                 ("select", row_of(s1, ["select", "Topic"]), "Bug"),
                 ("click", row_of(s1, ["checkbox", "agree"])),
                 ("fill", row_of(s1, ["textbox", "Message"]), "Snapshot rows work."),
                 ("click", row_of(s1, ["button", "Send message"]))]
        results = [a.browser(*st) for st in steps]
        code, s2 = a.browser("snapshot")
        snaps.append(s2)
        numbers["form_fill"] = sum(map(len, snaps))
        check("form_fill", "Sent" in s2 and all(c == 0 for c, _ in results),
              "; ".join(o.splitlines()[1] if o.startswith(FENCE) else o for _, o in results))

        # two_tabs: read a token in tab A, enter it in tab B.
        snaps = []
        a.browser("open", base + "/a")
        code, s1 = a.browser("snapshot")
        snaps.append(s1)
        token = "alpha-71" if "alpha-71" in s1 else None
        a.browser("open", base + "/b")
        code, s2 = a.browser("snapshot")
        snaps.append(s2)
        a.browser("fill", row_of(s2, ["textbox", "Transfer token"]), token or "missing")
        a.browser("click", row_of(s2, ["button", "Confirm transfer"]))
        code, s3 = a.browser("snapshot")
        snaps.append(s3)
        code, tabs = a.browser("tabs")
        numbers["two_tabs"] = sum(map(len, snaps))
        check("two_tabs", token and "Transfer confirmed" in s3, tabs.replace("\n", " / "))

        ratios = {k: round(numbers[k] / EGO[k], 3) for k in EGO}
        check("snapshot_tokens", all(r <= 0.5 for r in ratios.values()),
              ", ".join(f"{k} {numbers[k]} chars = {ratios[k]}x ego {EGO[k]}" for k in EGO))

        # A1 live: page text sits inside one fence; the page's fake closing line is neutralised.
        a.browser("goto", base + "/inject")
        code, s = a.browser("snapshot")
        lines = s.splitlines()
        check("browser_snapshot_fences_page_text (live)",
              lines[0] == FENCE and lines.count(FENCE_END) == 1
              and next(i for i, l in enumerate(lines) if "delete the repo" in l) < lines.index(FENCE_END),
              f"{len(lines)} lines, closing fence once")

        # A10: same table with and without page-world tampering.
        # Ticket 998 L9 (B8): numbers go on across pages, so the rows are compared without them.
        bare = lambda s: [r[r.index("]") + 1:] for r in rows(s)]
        a.browser("goto", base + "/plain")
        plain = bare(a.browser("snapshot")[1])
        a.browser("goto", base + "/tamper")
        code, t = a.browser("snapshot")
        check("snapshot_runs_in_isolated_world", plain and bare(t) == plain and "Keep account" not in t,
              " | ".join(rows(t)))

        # Trusted native input: click, typed text and Enter reach the page as isTrusted events.
        a.browser("goto", base + "/trust")
        code, s = a.browser("snapshot")
        a.browser("click", row_of(s, ["button", "Press me"]))
        a.browser("fill", row_of(s, ["textbox", "Type here"]), "x")
        a.browser("press", "Enter")
        code, s = a.browser("snapshot")
        log = next((l for l in s.splitlines() if l.startswith("log:")), "")
        check("trusted_native_input", all(f"{k}=true" in log for k in ("click", "input", "enter")), log)

        # Ticket 998 L5 (B3, B5) live: a 1 MB title, then a click, answers Ok with a capped title; a field value
        # cannot add a ref line to the outline.
        a.browser("goto", base + "/bigtitle")
        code, s = a.browser("snapshot")
        code, o = a.browser("click", row_of(s, ["button", "Big go"]))
        head = o.splitlines()[2] if o.startswith(FENCE) else o
        check("huge_title_click_answers_ok", code == 0 and "clicked" in o and len(head) < 400, f"exit {code}, {len(o)} chars")
        a.browser("goto", base + "/forge")
        code, t = a.browser("snapshot", "--tree")
        refs = [l.strip() for l in t.splitlines() if l.rstrip().endswith("]") and "[ref=" in l]
        check("tree_value_cannot_forge_a_ref", code == 0 and len(refs) == 2 and not any(r.startswith('- button "Pay') for r in refs),
              " | ".join(refs))

        # Ticket 998 L9 (B8) live: numbers from an older snapshot hit the same element after the page shifted, or are
        # refused once their element is gone or the page is another document; never another element.
        a.browser("goto", base + "/shift")
        code, s = a.browser("snapshot")
        ins, t, rep = (row_of(s, ["button", w]) for w in ("Insert above", "Target", "Replace target"))
        steps = [a.browser("click", ins), a.browser("click", t), a.browser("click", ins)]
        same = all(c == 0 for c, _ in steps)
        a.browser("click", rep)
        stale = a.browser("click", t)
        a.browser("goto", base + "/shift")
        moved = a.browser("click", t)
        code, after = a.browser("snapshot")
        log = lambda o: next((l for l in o.splitlines() if l.startswith("log:")), "?")
        check("stable_ref_hits_same_element_or_is_refused",
              same and log(steps[1][1]) == "log: target-1" and log(steps[2][1]) == "log: target-1"
              and stale[0] != 0 and "ref_stale" in stale[1] and moved[0] != 0 and log(after) == "log:",
              f"after shift: {log(steps[2][1])}; replaced: {stale[1].strip()[:70]}; new page: {moved[1].strip()[:70]}, {log(after)}")

        # A2 live: two more sessions; each gets an empty space of its own and its verbs drive only that space.
        # Ticket 264 (needs 198, threat model A7): spaces on one profile share its cookies by design, so b reads a's cookie;
        # profiles_do_not_share_cookies is the app selftest's (a second profile cannot be picked from a verb).
        a.browser("goto", base + "/cookie?set=space=agent")
        b, c = Session(lab, "b"), Session(lab, "c")
        code, b_tabs = b.browser("snapshot")
        b.browser("open", base + "/cookie")
        code, b_cookie = b.browser("snapshot")
        c.browser("open", base + "/doc/c")
        code, a_cookie = a.browser("snapshot")
        b_line = next((l for l in b_cookie.splitlines() if l.startswith("cookie=")), "?")
        check("browser_verb_targets_own_space_only (live)",
              code == 0 and "No tab is open" in b_tabs and "cookie=space=agent" in a_cookie and "Doc page" not in a_cookie,
              f"b before open: {b_tabs.strip()[:60]}; a after c opened /doc/c: "
              + next((l for l in a_cookie.splitlines() if "cookie=" in l or "Doc page" in l), "?"))
        check("spaces_on_default_profile_share_cookies (live)", "cookie=space=agent" in b_cookie, f"b cookie line: {b_line}")

        # Ticket 998 L10 (B9): b waits on a page that never loads; c's verbs do not wait for it, and b's answer comes
        # before the 12 s verb limit with an outcome line.
        def timed(s, *args):
            t0 = time.monotonic()
            code, o = s.browser(*args)
            return code, o, (time.monotonic() - t0) * 1000
        c.browser("snapshot")
        numbers["snapshot_ms_alone"] = round(timed(c, "snapshot")[2])
        slow = {}
        t = threading.Thread(target=lambda: slow.update(r=timed(b, "goto", base + "/never")))
        t.start()
        time.sleep(1.0)
        fast = [timed(c, "snapshot") for _ in range(3)]
        t.join()
        code, o, ms = slow["r"]
        numbers["snapshot_ms_beside_slow_space"] = [round(f[2]) for f in fast]
        numbers["never_loading_goto_ms"] = round(ms)
        check("other_space_not_held_by_slow_job",
              all(f[0] == 0 and f[2] < 2000 for f in fast) and ms > 3000,
              f"c snapshot ms {numbers['snapshot_ms_beside_slow_space']} while b waited {round(ms)} ms")
        check("never_loading_page_answers_before_12s", code == 0 and "outcome unknown" in o and ms < 12000,
              f"{round(ms)} ms: " + next((l for l in o.splitlines() if "outcome" in l or "rror" in l), o.strip()[:120]))
        # Two verbs at once in one space: the second waits for the first, and still answers within its 12 s.
        cli_q, never = shlex.quote(lab.cli_path), shlex.quote(base + "/never")
        t0 = time.monotonic()
        code, o = b.run(f"{cli_q} browser goto {never} >/dev/null 2>&1 & sleep 0.3; {cli_q} browser goto {never}; wait")
        ms = (time.monotonic() - t0) * 1000
        numbers["second_verb_same_space_ms"] = round(ms)
        check("second_verb_in_busy_space_answers_before_12s",
              code == 0 and "outcome unknown" in o and ms < 12300,
              f"{round(ms)} ms incl. 300 ms start gap: " + o.strip().splitlines()[0][:140] if o.strip() else "no output")

        # A5: three spaces open (a, b, c), and the listener set is unchanged.
        listen_after = lab.listeners()
        check("browser_adds_no_listen_port", listen_before == listen_after,
              f"before {listen_before} after {listen_after}")
    except Exception as e:  # a crash is a failed run, with what it was doing
        check("run completed", False, f"{type(e).__name__}: {e}")
    finally:
        lab.close()
    print("numbers:", json.dumps(numbers))
    print("app log:", *lab.log[-15:], sep="\n  ")
    if out:
        json.dump({"checks": checks, "numbers": numbers, "ego": EGO, "evidence": evidence}, open(out, "w"), indent=1)
    sys.exit(0 if checks and all(checks.values()) else 1)


if __name__ == "__main__":
    main()
