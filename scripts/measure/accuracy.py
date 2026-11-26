"""Part p34's trial, as docs/measure/rubric.md "p34 Multi-agent accuracy" names it: an owner-run step. A core on its own
NUNCHIRO_HOME with 5 real agent sessions on the owner's sign-ins (3 Claude on haiku, 2 Codex on the cheapest model),
one of the Claude seats on a second Mac through `nunchiro --machine <alias>`, inside the config guard of
scripts/scenario/v1b-full.sh (lib.snapshot/guard_check and the ~/.claude, ~/.codex manifest, before and after):

1. Delivery: `nunchiro agent prompt` sends `reply ok #<n>` to each seat in turn (100 per seat); every second send goes
   while the seat's box holds half-typed words (`session send-text`). Submitted = the exact text shows on the agent's
   own screen (`agent read`) above its input box; not within 30 s = missed.
2. Shown state: at 100 random moments one seat's `status` in `agent list --json` against the state its own screen
   shows (read just before and just after the list): a dialog = needs you, "esc to interrupt" = working, else idle or
   done (a screen does not tell those two apart).
3. Cards: 50 requests on the Claude seats, 25 permission requests (`mkdir trial-<n>`) and 25 questions
   (AskUserQuestion); each must be one card in the owner's snapshot within 5 s of the request showing on the agent's
   screen (from the prompt when the screen never shows it). Permissions are then answered allow or deny, questions
   with their first choice.
4. Outward gate: 20 sends through a fake mail MCP server (MAIL_SERVER below, never a real account; it appends each
   call to trial-mail.jsonl in the seat's folder), 4 per seat; a send in that log without an allow on its card counts.
   Even tries are allowed, odd ones denied.

5. Startup waits: 10 start dialogs, each on a new session that is never answered and then closed: folder trust (a
   new folder outside every trusted one, 3 here and 2 on the second Mac) and sign-in missing (5 on a second core here
   whose agents get empty config folders: CLAUDE_CONFIG_DIR, CODEX_HOME). Each must be one card within 5 s of the
   dialog showing on the agent's screen. An update prompt is in the self-test only: no real seat can show one
   (Nunchiro keeps Codex's update screen off and refuses an argument that turns it on, crates/nunchiro-core/src/
   sessions/spawn.rs:217; Claude Code shows no update dialog at start).

The figures are given for all seats, for the second Mac's seat and for this Mac's seats. A run is counted only when it
ran real agents (none is the fixture, versions recorded), the full sizes, the seat on the second Mac (the core says
the session runs on the alias) and the config guard found nothing; otherwise it says why it is not counted.
`--self-test` runs the fixture crates/nunchiro-core/tests/fixtures/trial-agent for every seat, on one Mac for both
sides (a second core on its own home behind scripts/scenario/fake-ssh), at small sizes: "self-test, not counted".
Stdlib only; `figures` and `verdict` are tested by tests/scenario/test_measure_accuracy.py.

The field figure beside the trial, "minutes per day a session waited with no card" (`waits`, 7 days on the owner's
own app, read only): every --every seconds each Claude or Codex session's own screen is read (`agent read`); a screen
showing a dialog or a start question while the core's snapshot holds no card for that session adds --every seconds.
Each sample is appended to the raw file, so `--report FILE` gives the figure of a stopped run.

Usage: scorecard.py accuracy --machine ALIAS --remote-project DIR [--project-root DIR] [--nunchiro BIN] [--out FILE]
       scorecard.py accuracy --self-test [--nunchiro BIN]
       scorecard.py waits [--days 7] [--every 30] [--nunchiro BIN] | --report FILE"""
import argparse, base64, hashlib, json, os, random, re, shutil, socket, subprocess, sys, tempfile, threading, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "scripts/scenario"))
FAKE = ROOT / "crates/nunchiro-core/tests/fixtures/trial-agent"
FAKE_MARK = b"The accuracy trial's agent"
# (label, kind, where): the rubric's 3 Claude and 2 Codex; one Claude on the second Mac.
SEATS = [("c1", "claude", "local"), ("c2", "claude", "local"), ("r1", "claude", "remote"),
         ("x1", "codex", "local"), ("x2", "codex", "local")]
FULL = dict(sends=500, readings=100, cards=50, outward=20, startup=10)
SELF_TEST = dict(sends=20, readings=20, cards=6, outward=5, startup=10)
# Step 5 (dialog, agent, where): the real run's 10 and the self-test's 10 (with the update prompt only a fixture shows).
STARTUP_PLAN = ([("trust", "claude", "local")] * 2 + [("trust", "codex", "local"), ("trust", "claude", "remote"),
                 ("trust", "claude", "remote")] + [("signin", "claude", "local")] * 3 + [("signin", "codex", "local")] * 2)
STARTUP_SELF_TEST = ([("trust", "claude", "local"), ("trust", "codex", "local"), ("trust", "claude", "remote"),
                      ("signin", "claude", "local"), ("signin", "claude", "local"), ("signin", "codex", "local")]
                     + [("update", "codex", "local")] * 4)
START_SCREEN = re.compile(r"trust this folder|one you trust|trust the contents of this directory|Select login method|"
                          r"Sign in with ChatGPT|Choose the text style|Update available|Press enter to continue", re.I)
SHOWN = {"working": "working", "blocked": "needs_you", "done": "done", "idle": "idle"}
CLAUDE_MODEL = "haiku"
DIALOG = re.compile(r"Do you want to proceed\?|Enter to select|Would you like to (run|make|allow)|Allow command\?")
PROMPT_LINE = re.compile(r"^\s*[>❯›]\s?(.*?)\s*$")
TRUST = re.compile(r"Do you trust the files|Is this a project you created or one you trust|Trust this folder\?")
MAIL_SERVER = r"""
import json, sys, time
for line in sys.stdin:
    try:
        m = json.loads(line)
    except ValueError:
        continue
    i, method, r = m.get('id'), m.get('method'), {}
    if method == 'initialize':
        r = {'protocolVersion': m.get('params', {}).get('protocolVersion', '2024-11-05'), 'capabilities': {'tools': {}},
             'serverInfo': {'name': 'fakemail', 'version': '1'}}
    elif method == 'tools/list':
        r = {'tools': [{'name': 'send_email', 'description': 'Send an email (a trial fake: nothing leaves this Mac).',
                        'inputSchema': {'type': 'object', 'required': ['to', 'subject', 'body'], 'properties': {
                            'to': {'type': 'string'}, 'subject': {'type': 'string'}, 'body': {'type': 'string'}}}}]}
    elif method == 'tools/call':
        with open(sys.argv[1], 'a') as f:
            f.write(json.dumps(dict(m['params'].get('arguments', {}), t=time.time())) + '\n')
        r = {'content': [{'type': 'text', 'text': 'sent'}]}
    if i is not None:
        print(json.dumps({'jsonrpc': '2.0', 'id': i, 'result': r}), flush=True)
"""
BOOT = "import base64;exec(base64.b64decode('%s'))" % base64.b64encode(MAIL_SERVER.encode()).decode()


def _figures(rec):
    sends, reads, cards, outs = rec["sends"], rec["readings"], rec["cards"], rec["outward"]
    starts = [r for r in rec.get("startup", []) if r["raised"]]
    missed = sum(1 for s in sends if not s["submitted"])
    return dict(missed_with_draft=sum(1 for s in sends if not s["submitted"] and s["draft"]),
        delivery_missed_per_1000=round(1000 * missed / len(sends), 1) if sends else None,
        state_match_pct=round(100 * sum(1 for r in reads if SHOWN.get(r["shown"]) in r["true"]) / len(reads), 1) if reads else None,
        cards_shown_pct=round(100 * sum(1 for c in cards if c["latency_s"] is not None and c["latency_s"] <= 5 and c["ids"] == 1)
                              / len(cards), 1) if cards else None,
        outward_unapproved=sum(1 for o in outs if o["sent"] and not o["allowed"]) if outs else None,
        startup_cards_pct=round(100 * sum(1 for c in starts if c["latency_s"] is not None and c["latency_s"] <= 5
                                          and c["ids"] == 1) / len(starts), 1) if starts else None,
        counts=dict(sends=len(sends), readings=len(reads), cards=len(cards), outward=len(outs), startup=len(starts)),
        startup_not_raised=sum(1 for r in rec.get("startup", []) if not r["raised"]),
    )


def figures(rec):
    """The four p34 figures (pure) for all seats, the second Mac's seat and this Mac's seats."""
    part = lambda where: {k: [r for r in v if r["where"] == where] for k, v in rec.items()}  # noqa: E731
    return dict(total=_figures(rec), remote=_figures(part("remote")), local=_figures(part("local")))


def verdict(res):
    """(counted, reasons not counted) of a finished run (pure)."""
    why = []
    if res["self_test"]:
        why.append("self-test on the fixture agent")
    fakes = [a for a in res["agents"] if a.get("fake")]
    if fakes:
        why.append("fixture agent ran: " + ", ".join(sorted({a["where"] + " " + a["kind"] for a in fakes})))
    if any(not a.get("version") for a in res["agents"]):
        why.append("an agent's version was not read")
    remote = [s for s in res["seats"] if s["where"] == "remote"]
    if not res.get("machine") or not remote or any(s.get("machine") != res["machine"] for s in remote):
        why.append("the second Mac was not used (no seat ran through --machine)")
    elif not res["figures"]["remote"]["counts"]["sends"]:
        why.append("no prompt reached the second Mac's seat")
    if res["figures"]["total"].get("startup_not_raised"):
        why.append(f"start dialogs not raised: {res['figures']['total']['startup_not_raised']}")
    short = [k for k, n in FULL.items() if res["figures"]["total"]["counts"][k] < n]
    if short:
        why.append("below the rubric's sizes: " + ", ".join(f"{k} {res['figures']['total']['counts'][k]} of {FULL[k]}" for k in short))
    if res.get("guard_problems"):
        why.append("config guard: " + "; ".join(res["guard_problems"])[:300])
    if res["guard_problems"] is None:
        why.append("the config guard did not run")
    return not why, why


def is_fake(path):
    try:
        with open(path, "rb") as f:
            return FAKE_MARK in f.read(4096)
    except OSError:
        return False


def screen_state(text):
    tail = "\n".join(text.splitlines()[-20:])
    if DIALOG.search(tail):
        return {"needs_you"}
    if re.search(r"esc to interrupt", tail, re.I):
        return {"working"}
    return {"idle", "done"}


def submitted(text, want):
    """(exact, glued): `want` on a line of the agent's screen other than its input box (the last prompt line), alone
    or behind other words."""
    lines = text.splitlines()
    box = max((i for i, l in enumerate(lines) if PROMPT_LINE.match(l)), default=None)
    norm = lambda l: l.strip().lstrip(">❯›• ").strip()  # noqa: E731
    above = [l for i, l in enumerate(lines) if i != box and want in l]
    return any(norm(l) == want for l in above), [l.strip() for l in above if norm(l) != want]


def box_line(text):
    """The input box's line (the last prompt line) of a screen: what a missed send left there."""
    return next((m[0].strip() for m in map(PROMPT_LINE.match, reversed(text.splitlines())) if m), None)


class Trial:
    def __init__(self, nunchiro, work, machine, remote_project, project_root, self_test):
        self.n, self.work, self.machine, self.self_test = str(Path(nunchiro).resolve()), Path(work), machine, self_test
        self.home = self.work / "h"
        self.home.mkdir(mode=0o700)
        self.project = Path(project_root or self.work) / ("acc-" + self.work.name[-6:])
        self.project.mkdir(parents=True)
        self.extra = []  # processes this trial started
        if self_test:
            bin_ = self.work / "bin"
            bin_.mkdir()
            for name in ("claude", "codex"):
                shutil.copy(FAKE, bin_ / name)
                os.chmod(bin_ / name, 0o700)
            self.rhome = self.work / "rh"
            self.rhome.mkdir(mode=0o700)
            self.remote_project = self.rhome / "proj"
            self.remote_project.mkdir()
            base = {"PATH": f"{bin_}:/usr/bin:/bin", "TERM": "xterm-256color", "NUNCHIRO_LOGIN_PATH": "off", "NUNCHIRO_KEYCHAIN": ""}
            self.renv = dict(base, HOME=str(self.rhome), NUNCHIRO_HOME=str(self.rhome), CODEX_HOME=str(self.rhome / "codex-data"),
                             CLAUDE_CONFIG_DIR=str(self.rhome / "claude-data"))
            self.env = dict(base, HOME=str(self.home), NUNCHIRO_HOME=str(self.home), CODEX_HOME=str(self.home / "codex-data"),
                            CLAUDE_CONFIG_DIR=str(self.home / "claude-data"), NUNCHIRO_SSH=str(ROOT / "scripts/scenario/fake-ssh"),
                            NUNCHIRO_FAKE_REMOTE_HOME=str(self.rhome), NUNCHIRO_BIN=self.n)
            self.extra.append((self.serve(self.renv, self.rhome), self.renv))
        else:
            import lib
            self.remote_project = Path(remote_project)
            self.env = lib.clean_env({"NUNCHIRO_HOME": str(self.home)})
            for key in ("NUNCHIRO_TOKEN", "NUNCHIRO_SESSION", "NUNCHIRO_MACHINE"):
                self.env.pop(key, None)
        (self.home / "settings.json").write_text(json.dumps(
            {"machines": {machine: {"projects": {str(self.project): str(self.remote_project)}}}}))
        self.core = self.serve(self.env, self.home)
        # Step 5's second core here: its agents get empty config folders, so they start signed out.
        self.ohome = self.work / "o"
        self.ohome.mkdir(mode=0o700)
        for d in ("claude-empty", "codex-empty"):
            (self.ohome / d).mkdir()
            if self_test:
                (self.ohome / d / "trial-signed-out").touch()
        self.oenv = dict(self.env, NUNCHIRO_HOME=str(self.ohome), CLAUDE_CONFIG_DIR=str(self.ohome / "claude-empty"),
                         CODEX_HOME=str(self.ohome / "codex-empty"))
        self.extra.append((self.serve(self.oenv, self.ohome), self.oenv))
        if self_test:  # the update screen, a fixture's only
            self.uhome = self.work / "u"
            self.uhome.mkdir(mode=0o700)
            (self.uhome / "codex-up").mkdir()
            (self.uhome / "codex-up" / "trial-update").touch()
            self.uenv = dict(self.env, NUNCHIRO_HOME=str(self.uhome), CODEX_HOME=str(self.uhome / "codex-up"))
            self.extra.append((self.serve(self.uenv, self.uhome), self.uenv))
        self.token = (self.home / "core.token").read_text().strip()
        self.seats, self.helper, self.lock = {}, None, threading.Lock()

    def serve(self, env, home):
        p = subprocess.Popen([self.n, "serve"], env=env, stdin=subprocess.DEVNULL, stdout=open(home / "serve.log", "w"),
                             stderr=subprocess.STDOUT)
        until(lambda: (home / "core.token").exists() and (home / "core.sock").exists(), 20, "core start")
        return p

    def cli(self, *args, remote=False, timeout=60, env=None):
        argv = [self.n, *(["--machine", self.machine] if remote else []), *args]
        try:
            r = subprocess.run(argv, env=env or self.env, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return -1, "", f"no answer in {timeout} s"
        return r.returncode, r.stdout, r.stderr

    def sock(self, request, remote=False, home=None):
        if remote:
            request = {"op": "remote", "machine": self.machine, "request": request}
        home = home or self.home
        token = self.token if home == self.home else (home / "core.token").read_text().strip()
        with socket.socket(socket.AF_UNIX) as s:
            s.settimeout(20)
            s.connect(str(home / "core.sock"))
            s.sendall((json.dumps({"token": token, "request": request}) + "\n").encode())
            return json.loads(s.makefile().readline())

    def screen(self, label):
        seat = self.seats[label]
        rc, out, _ = self.cli("agent", "read", seat["id"], "--lines", "60", remote=seat["where"] == "remote", timeout=20)
        return out if rc == 0 else ""

    def shown(self, label):
        seat = self.seats[label]
        rc, out, _ = self.cli("agent", "list", "--json", remote=seat["where"] == "remote", timeout=20)
        return next((s.get("status") for s in json.loads(out) if s["id"] == seat["id"]), None) if rc == 0 else None

    def pending(self, label):
        seat = self.seats[label]
        reply = self.sock({"op": "snapshot"}, remote=seat["where"] == "remote")
        sessions = reply.get("Ok", {}).get("sessions", [])
        return next((s.get("pending", []) for s in sessions if s["id"] == seat["id"]), [])

    def answer(self, label, item, answer):
        return self.sock({"op": "answer", "item": item, "answer": answer, "confirmed": True},
                         remote=self.seats[label]["where"] == "remote").get("Err")

    def mails(self, label):
        """Subjects in the fake mail server's log of seat `label`: read here, or on the second Mac through the helper."""
        seat = self.seats[label]
        if seat["where"] == "local":
            p = Path(seat["mail"])
            text = p.read_text() if p.exists() else ""
        else:
            rc, out, _ = self.cli("session", "read", self.helper, remote=True, timeout=20)
            import lib
            text = lib.visible(bytes(json.loads(out)["data"])) if rc == 0 else ""
        return re.findall(r'"subject": "(trial \d+)"', text)

    def start(self):
        rc, out, err = self.cli("machine", "status", self.machine)
        if rc or not re.search(r'"status":\s*"reachable"', out):
            raise SystemExit(f"{self.machine} is not reachable with this Nunchiro: {out.strip() or err.strip()}")
        # The helper on the second Mac: its claude's version and fixture mark, then its mail log as it grows.
        mail = self.remote_project / "trial-mail.jsonl"
        script = (f"touch '{mail}'; echo VERSION $(claude --version 2>&1 | head -1); p=$(command -v claude); "
                  f"head -c 4096 \"$p\" | grep -q \"{FAKE_MARK.decode()}\" && echo FAKE-AGENT; echo PATH-END; "
                  f"exec tail -n +1 -f '{mail}'")
        rc, out, err = self.cli("session", "start", "--kind", "shell", "--project", str(self.remote_project), "--label",
                                "trial-helper", "--", "/bin/sh", "-c", script, remote=True)
        if rc:
            raise SystemExit(f"helper shell on {self.machine}: {err or out}")
        self.helper = json.loads(out.splitlines()[-1])["session"]["id"]
        for label, kind, where in SEATS:
            project = self.remote_project if where == "remote" else self.project
            mail = project / f"trial-mail-{label}.jsonl" if where == "local" else project / "trial-mail.jsonl"
            args = ["agent", "start", f"trial-{label}", "--kind", kind, "--project", str(project)]
            if kind == "claude":
                mcp = {"mcpServers": {"fakemail": {"command": "python3", "args": ["-c", BOOT, str(mail)]}}}
                args += ["--model", CLAUDE_MODEL, "--", "--mcp-config", json.dumps(mcp), "--strict-mcp-config"]
            else:
                import lib
                args += ["--model", lib.CODEX_MODEL, "--effort", "low", "--", "-c", f'projects."{project}".trust_level="trusted"',
                         "-c", 'mcp_servers.fakemail.command="python3"',
                         "-c", "mcp_servers.fakemail.args=" + json.dumps(["-c", BOOT, str(mail)])]
            rc, out, err = self.cli(*args, remote=where == "remote", timeout=90)
            if rc:
                raise SystemExit(f"agent start {label} ({where}): {err or out}")
            s = json.loads(out.splitlines()[-1])["session"]
            self.seats[label] = dict(label=label, kind=kind, where=where, id=s["id"], machine=s.get("machine"),
                                     project=str(project), mail=str(mail))
        for label in self.seats:
            def ready():
                text = self.screen(label)
                if TRUST.search(text):
                    raise SystemExit(f"{label}: a trust dialog shows (never answered here); give a folder the agent already trusts")
                return re.search(r"for shortcuts|mode on|Ask Codex to do anything|context left|^❯ ", text, re.M | re.I)
            until(ready, 120, f"seat {label} ready")

    def remote_sh(self, script):
        """One short shell command on the second Mac (a shell session, closed after a second)."""
        rc, out, err = self.cli("session", "start", "--kind", "shell", "--project", str(self.remote_project), "--label",
                                "trial-sh", "--", "/bin/sh", "-c", script + "; exec cat", remote=True)
        if rc:
            raise SystemExit(f"shell on {self.machine}: {err or out}")
        time.sleep(1)
        self.cli("session", "close", json.loads(out.splitlines()[-1])["session"]["id"], remote=True)

    def agents(self):
        """Which agents ran, with versions: this Mac's from PATH, the second Mac's from the helper."""
        out = []
        for kind in ("claude", "codex"):
            path = shutil.which(kind, path=self.env["PATH"])
            v = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=30).stdout.strip() if path else ""
            sha = hashlib.sha256(Path(path).read_bytes()).hexdigest()[:16] if path else None
            out.append(dict(where="local", kind=kind, path=path, version=v, sha256=sha, fake=bool(path) and is_fake(path)))
        until(lambda: "PATH-END" in self.helper_text(), 30, "the helper on the second Mac")
        text = self.helper_text()
        v = next((l.split(None, 1)[1].strip() for l in map(str.strip, text.splitlines()) if l.startswith("VERSION ") and len(l.split()) > 1), "")
        out.append(dict(where="remote", kind="claude", machine=self.machine, version=v, fake="FAKE-AGENT" in text,
                        helper=text.split("PATH-END")[0][-400:]))
        return out

    def helper_text(self):
        import lib
        rc, out, _ = self.cli("session", "read", self.helper, remote=True, timeout=20)
        return lib.visible(bytes(json.loads(out)["data"])) if rc == 0 else ""

    def wait_done(self, label, timeout=120):
        seat = self.seats[label]
        self.cli("agent", "wait", seat["id"], "--until", "done", "--until", "idle", "--timeout", str(timeout * 1000),
                 remote=seat["where"] == "remote", timeout=timeout + 10)

    def clear(self, label):
        """After a miss: cancel the seat's queued sends and empty its box, so the next send starts clean."""
        seat, remote = self.seats[label], self.seats[label]["where"] == "remote"
        rc, out, _ = self.cli("agent", "get", seat["id"], "--json", remote=remote)
        for send in json.loads(out).get("send_queue", []) if rc == 0 else []:
            if send.get("status") == "queued":
                self.cli("agent", "cancel", seat["id"], send["id"], remote=remote)
        self.cli("session", "send-keys", seat["id"], *["backspace"] * 80, remote=remote)

    def stop(self):
        for sid in [s["id"] for s in self.seats.values() if s["where"] == "remote"] + [self.helper]:
            if sid and not self.self_test:
                self.cli("session", "close", sid, remote=True, timeout=30)  # the second Mac's core is not ours
        homes = [(self.core, self.env)] + self.extra
        for p, env in homes:
            try:
                subprocess.run([self.n, "serve", "stop", "--yes"], env=env, capture_output=True, timeout=30)
                p.wait(10)
            except subprocess.TimeoutExpired:
                p.kill()  # only a core this trial started


def until(check, timeout, what=None):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if check():
            return True
        time.sleep(0.1)
    if what:
        raise SystemExit(f"timed out waiting for {what}")
    return False


def delivery(t, label, ks, rec):
    seat = t.seats[label]
    remote = seat["where"] == "remote"
    for i, k in enumerate(ks):
        text, draft = f"reply ok #{k}", i % 2 == 1
        if draft:
            t.cli("session", "send-text", seat["id"], "half typed ", remote=remote)
            time.sleep(0.3)
        t0, got = time.time(), {}
        sender = threading.Thread(target=lambda: got.update(r=t.cli("agent", "prompt", seat["id"], text, remote=remote, timeout=30)))
        sender.start()  # the screen is read meanwhile: a prompt call that hangs does not stop the 30 s clock
        seen = {}
        def check():
            seen["screen"] = t.screen(label)
            seen["exact"], seen["glued"] = submitted(seen["screen"], text)
            return seen["exact"]
        ok = until(check, 30)
        sender.join()
        rc, out, err = got["r"]
        with t.lock:
            rec["sends"].append(dict(seat=label, where=seat["where"], k=k, draft=draft, submitted=ok, rc=rc,
                                     err=err.strip()[:200], seconds=round(time.time() - t0, 2), glued=seen.get("glued", [])[:1],
                                     box=None if ok else box_line(seen.get("screen", ""))))
        if ok:
            t.wait_done(label)
        else:
            t.clear(label)


def window(t, stop):
    """The window's part, as the core's own tests play it (Request::QueueConnect): a connected window keeps permission
    requests held for their cards; with none, Codex's outward hook refuses at once and Claude falls back to its own
    dialog. Both cores, every second (the core counts a window gone after 3 s)."""
    while not stop.wait(1):
        for remote, home in [(False, None), (True, None)] + [(False, h) for h in (t.ohome, getattr(t, "uhome", None)) if h]:
            try:
                t.sock({"op": "queue_connect"}, remote=remote, home=home)
            except OSError:
                pass


def readings(t, n, stop, rec):
    while len(rec["readings"]) < n and not stop.is_set():
        time.sleep(random.uniform(0.5, 4))
        label = random.choice(list(t.seats))
        before = screen_state(t.screen(label))
        shown = t.shown(label)
        after = screen_state(t.screen(label))
        with t.lock:
            rec["readings"].append(dict(seat=label, where=t.seats[label]["where"], shown=shown, true=sorted(before | after)))


CARD_PROMPT = {
    "permission": "[trial perm {k}] Run exactly this shell command with your Bash tool, nothing else: mkdir trial-{k}",
    "question": "[trial ask {k}] Use your AskUserQuestion tool to ask me one question: which colour, red or blue, should "
                "go in a comment? Then reply with the colour only.",
}


def cards(t, label, ks, rec):
    seat = t.seats[label]
    for k in ks:
        kind = "permission" if k % 2 == 0 else "question"
        t0 = time.time()
        t.cli("agent", "prompt", seat["id"], CARD_PROMPT[kind].format(k=k), remote=seat["where"] == "remote")
        raised, first, ids, seen = None, None, set(), None
        end = time.monotonic() + 60
        while time.monotonic() < end:
            text = t.screen(label)
            if raised is None and (screen_state(text) == {"needs_you"} or f"Bash(mkdir trial-{k}" in text):
                raised = time.time()
            items = [i for i in t.pending(label) if i["kind"] == kind]
            ids |= {i["id"] for i in items}
            if items and first is None:
                first, seen = time.time(), items[0]
            if first is not None and time.time() - first > 1:  # watch a second more for a second card
                break
            time.sleep(0.1)
        start = raised if raised is not None and (first is None or raised <= first) else t0 if raised is None else first
        row = dict(seat=label, where=seat["where"], k=k, kind=kind, ids=len(ids), raised_on_screen=raised is not None,
                   latency_s=round(first - start, 3) if first else None)
        if seen:  # the card live now: a doubled request's first card may be gone (counted above as ids 2)
            live = [i for i in t.pending(label) if i["kind"] == kind] or [seen]
            answer = {"type": "choose", "index": 0} if kind == "question" else {"type": "allow_once" if k % 4 == 0 else "deny"}
            row["answer_error"] = t.answer(label, live[-1]["id"], answer)
        with t.lock:
            rec["cards"].append(row)
        t.wait_done(label)


MAIL_PROMPT = ('[trial mail {k}] Send one email with the fakemail send_email tool: to trial@example.invalid, subject '
               '"trial {k}", body "hello". Do nothing else.')


def outward(t, label, ks, rec):
    seat = t.seats[label]
    for k in ks:
        allow, subject = k % 2 == 0, f"trial {k}"
        t.cli("agent", "prompt", seat["id"], MAIL_PROMPT.format(k=k), remote=seat["where"] == "remote")
        mailcard = lambda: next((i for i in t.pending(label) if i["kind"] == "permission" and re.search(  # noqa: E731
            r"fakemail|send_email", json.dumps(i))), None)
        card, end = None, time.monotonic() + 60
        while card is None and time.monotonic() < end and subject not in t.mails(label):
            card = mailcard()
            time.sleep(0.2)
        before_answer = subject in t.mails(label)
        card = (mailcard() or card) if card else None  # the card live now, as in cards()
        err = t.answer(label, card["id"], {"type": "allow_once" if allow else "deny"}) if card else None
        extra, end = 0, time.monotonic() + 60  # a retry asks again: refused, counted
        while time.monotonic() < end and screen_state(t.screen(label)) != {"idle", "done"}:
            again = mailcard()
            if again and again["id"] != (card or {}).get("id"):
                extra += 1
                t.answer(label, again["id"], {"type": "deny"})
            time.sleep(0.3)
        t.wait_done(label)
        sent = subject in t.mails(label)
        with t.lock:
            rec["outward"].append(dict(seat=label, where=seat["where"], k=k, card=bool(card), sent=sent,
                                       sent_before_answer=before_answer, extra_cards=extra, answer_error=err,
                                       allowed=bool(card) and allow and not err and not before_answer))


def startup(t, plan, rec):
    """Step 5, one dialog at a time: start a session that shows it, time its card, close it unanswered."""
    tag = t.work.name[-6:]
    for k, (dialog, kind, where) in enumerate(plan):
        remote, env, home = where == "remote", None, None
        project = t.project
        if dialog == "trust":  # a new folder no trusted folder holds
            if remote:
                project = Path(f"/tmp/acc-untrusted-{tag}-{k}")
                t.remote_sh(f"mkdir -p '{project}'")
            else:
                project = Path(tempfile.mkdtemp(prefix=f"acc-untrusted-{tag}-"))
        else:
            env, home = (t.oenv, t.ohome) if dialog == "signin" else (t.uenv, t.uhome)
        args = ["agent", "start", f"trial-start-{k}", "--kind", kind, "--project", str(project)]
        import lib
        args += ["--model", CLAUDE_MODEL] if kind == "claude" else ["--model", lib.CODEX_MODEL, "--effort", "low"]
        if kind == "codex" and dialog != "trust":
            args += ["--", "-c", f'projects."{project}".trust_level="trusted"']
        t0 = time.time()
        rc, out, err = t.cli(*args, remote=remote, env=env, timeout=90)
        row = dict(where=where, dialog=dialog, kind=kind, raised=False, latency_s=None, ids=0)
        if rc:
            row["error"] = (err or out).strip()[:300]
        else:
            sid = json.loads(out.splitlines()[-1])["session"]["id"]
            raised, first, ids, text = None, None, set(), ""
            end = time.monotonic() + 60
            while time.monotonic() < end:
                rc2, text, _ = t.cli("agent", "read", sid, "--lines", "60", remote=remote, env=env, timeout=20)
                if raised is None and START_SCREEN.search(text):
                    raised = time.time()
                snap = t.sock({"op": "snapshot"}, remote=remote, home=home).get("Ok", {}).get("sessions", [])
                items = next((x.get("pending", []) for x in snap if x["id"] == sid), [])
                ids |= {i["id"] for i in items}
                if items and first is None:
                    first = time.time()
                if raised and first and time.time() - max(raised, first) > 1:
                    break
                if raised and time.time() - raised > 10:
                    break  # no card in 10 s: a miss, no need to wait longer
                time.sleep(0.1)
            start = raised if raised is not None and (first is None or raised <= first) else t0 if raised is None else first
            row.update(raised=raised is not None or first is not None, ids=len(ids), raised_on_screen=raised is not None,
                       latency_s=round(first - start, 3) if first else None,
                       screen=next((l.strip() for l in text.splitlines() if START_SCREEN.search(l)), text.strip()[-200:]))
            t.cli("session", "close", sid, remote=remote, env=env, timeout=30)  # never answered
        if dialog == "trust":
            t.remote_sh(f"rmdir '{project}'") if remote else shutil.rmtree(project, ignore_errors=True)
        with t.lock:
            rec["startup"].append(row)


def waited(samples, every):
    """Minutes per day a session waited with no card (pure): `every` seconds for each sample of a session whose screen
    showed a dialog while it had no card, over the days the samples span (at least one sample interval)."""
    if not samples:
        return None
    span = max(samples[-1]["t"] - samples[0]["t"] + every, every) / 86400
    lone = sum(1 for s in samples for x in s["sessions"] if x["waiting"] and not x["cards"])
    return round(lone * every / 60 / span, 2)


def field(nunchiro, days, every, out):
    """The owner's own app, read only: `snapshot --json` and `agent read` of each agent session, every `every` s."""
    end = time.time() + days * 86400
    # As the owner, also from a Nunchiro terminal: a session's own token would be refused the owner's snapshot.
    env = {k: v for k, v in os.environ.items() if k not in ("NUNCHIRO_TOKEN", "NUNCHIRO_SESSION", "NUNCHIRO_MACHINE")}
    with open(out, "a") as f:
        while time.time() < end:
            t0 = time.time()
            r = subprocess.run([nunchiro, "snapshot", "--json"], capture_output=True, text=True, timeout=30, env=env)
            rows = []
            for x in json.loads(r.stdout).get("sessions", []) if r.returncode == 0 else []:
                # ponytail: this Mac's sessions only; a remote one would need `--machine` per alias
                if x.get("kind") not in ("claude", "codex") or x.get("state") != "running" or x.get("machine"):
                    continue
                text = subprocess.run([nunchiro, "agent", "read", x["id"], "--lines", "40"], capture_output=True,
                                      text=True, timeout=30, env=env).stdout
                waiting = screen_state(text) == {"needs_you"} or bool(START_SCREEN.search("\n".join(text.splitlines()[-20:])))
                rows.append(dict(id=x["id"], waiting=waiting, cards=len(x.get("pending", []))))
            f.write(json.dumps(dict(t=t0, ok=r.returncode == 0, sessions=rows, **({} if r.returncode == 0 else
                                                                                   dict(error=r.stderr.strip()[-300:])))) + "\n")
            f.flush()
            time.sleep(max(0, every - (time.time() - t0)))


def waits_main(argv=None):
    ap = argparse.ArgumentParser(prog="waits", description="p34's field figure; see docs/measure/rubric.md")
    ap.add_argument("--days", type=float, default=7)
    ap.add_argument("--every", type=int, default=30)
    ap.add_argument("--nunchiro", default="nunchiro", help="the owner's app's CLI (default: nunchiro on PATH)")
    ap.add_argument("--report", help="a raw file of an earlier run: its figure, no sampling")
    a = ap.parse_args(argv)
    raw = Path(a.report) if a.report else ROOT / "docs/measure" / f"waits-{time.strftime('%Y-%m-%d')}.jsonl"
    if not a.report:
        field(a.nunchiro, a.days, a.every, raw)
    samples = [json.loads(l) for l in raw.read_text().splitlines() if l.strip()]
    every = a.every
    days = (samples[-1]["t"] - samples[0]["t"] + every) / 86400 if samples else 0
    res = dict(waited_no_card_min_per_day=waited(samples, every), days=round(days, 2), samples=len(samples),
               every_s=every, raw=raw, enough=days >= 7)
    print(json.dumps({k: str(v) if k == "raw" else v for k, v in res.items()}, indent=1))
    return res


def parallel(jobs):
    threads = [threading.Thread(target=f, args=a) for f, a in jobs]
    for th in threads:
        th.start()
    for th in threads:
        th.join()


def spread(n, seats):
    ks = list(range(n))
    return {s: ks[i::len(seats)] for i, s in enumerate(seats)}


def run(nunchiro, size, work, machine, remote_project=None, project_root=None, self_test=False):
    rec = dict(sends=[], readings=[], cards=[], outward=[], startup=[])
    started = time.time()
    t = Trial(nunchiro, work, machine, remote_project, project_root, self_test)
    try:
        t.start()
        agents = t.agents()
        stop, shut = threading.Event(), threading.Event()
        threading.Thread(target=window, args=(t, shut), daemon=True).start()
        reader = threading.Thread(target=readings, args=(t, size["readings"], stop, rec))
        reader.start()
        parallel([(delivery, (t, s, ks, rec)) for s, ks in spread(size["sends"], list(t.seats)).items()])
        claude = [l for l, s in t.seats.items() if s["kind"] == "claude"]
        parallel([(cards, (t, s, ks, rec)) for s, ks in spread(size["cards"], claude).items()])
        if len(rec["readings"]) < size["readings"]:
            reader.join(timeout=600)
        stop.set()
        reader.join()
        parallel([(outward, (t, s, ks, rec)) for s, ks in spread(size["outward"], list(t.seats)).items()])
        startup(t, (STARTUP_SELF_TEST if self_test else STARTUP_PLAN)[:size["startup"]], rec)
    finally:
        seats = list(t.seats.values())
        if "shut" in locals():
            shut.set()
        t.stop()
    prompts = len(rec["sends"]) + len(rec["cards"]) + len(rec["outward"])  # step 5 sends no prompt
    return dict(date=time.strftime("%Y-%m-%d"), started=time.strftime("%Y-%m-%d %H:%M", time.localtime(started)),
                minutes=round((time.time() - started) / 60, 1), prompts=prompts, self_test=self_test, machine=machine,
                size=size, seats=seats, agents=agents, figures=figures(rec), records=rec)


def guarded(fn):
    """fn() inside the config guard of scripts/scenario/v1b-full.sh; (result, problems)."""
    import lib, v1b_full
    before, m_before = lib.snapshot(), v1b_full.manifest()
    try:
        res = fn()
    finally:
        after, m_after = lib.snapshot(), v1b_full.manifest()
    ours = [str(ROOT / ".scratch"), str(ROOT / "scripts")]
    problems = lib.guard_check(before, after, ours)[0] + v1b_full.manifest_diff(m_before, m_after, ours)[0]
    return res, problems


def main(argv=None):
    ap = argparse.ArgumentParser(prog="accuracy", description="p34's trial; see docs/measure/rubric.md")
    ap.add_argument("--machine", help="the SSH alias of the second Mac (its core runs this same Nunchiro version)")
    ap.add_argument("--remote-project", help="a folder on the second Mac that Claude already trusts")
    ap.add_argument("--project-root", default=str(ROOT / ".scratch"), help="a folder here that Claude already trusts")
    ap.add_argument("--nunchiro", default=str(ROOT / "target/debug/nunchiro"))
    ap.add_argument("--self-test", action="store_true", help="the fixture agent on this Mac for both sides; not counted")
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    if a.self_test:
        work = tempfile.mkdtemp(prefix="acc-", dir=os.environ.get("ACCURACY_WORK"))
        res = run(a.nunchiro, SELF_TEST, work, "trialmac", project_root=work, self_test=True)
        res["guard_problems"] = []  # throwaway HOME: the user's agent config is not reachable
        shutil.rmtree(work, ignore_errors=True)
    else:
        if not a.machine or not a.remote_project:
            raise SystemExit("p34 runs 1 of its 5 seats on a second Mac: give --machine ALIAS and --remote-project DIR")
        for kind in ("claude", "codex"):
            path = shutil.which(kind)
            if not path or is_fake(path):
                raise SystemExit(f"{kind} on PATH is {'missing' if not path else 'the fixture agent'}: p34 needs the real agents")
        Path(a.project_root).mkdir(parents=True, exist_ok=True)
        work = tempfile.mkdtemp(prefix="acc-", dir=str(ROOT / ".scratch"))
        res, problems = guarded(lambda: run(a.nunchiro, FULL, work, a.machine, a.remote_project, a.project_root))
        res["guard_problems"] = problems
        shutil.rmtree(work, ignore_errors=True)
    res["counted"], res["not_counted"] = verdict(res)
    res["mode"] = "counted" if res["counted"] else ("self-test, not counted" if a.self_test else "not counted")
    out = Path(a.out) if a.out else (ROOT / ("docs/measure" if not a.self_test else ".scratch")) / f"accuracy-{res['date']}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(res, indent=1, ensure_ascii=False) + "\n")
    print(json.dumps(dict(mode=res["mode"], not_counted=res["not_counted"], minutes=res["minutes"], prompts=res["prompts"],
                          agents=res["agents"], figures=res["figures"]), indent=1, ensure_ascii=False))
    print(f"raw records: {out}")
    return res, out


if __name__ == "__main__":
    main()
