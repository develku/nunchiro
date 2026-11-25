# Scorecard rubric (ticket 1098)

Every part of the scorecard is scored 0 to 100 by one of three methods. The method and the checks are fixed, so a later
run (after each phase) is comparable. A new check is added only when a real gap is found, never to raise a score;
a change to this file is named in the next scorecard's notes.

- number: measured by `scripts/measure/scorecard.py run` on an isolated RC; the anchors below turn a figure into points.
- peer: the fixed tasks in [tasks.md](tasks.md) or the capability rows named below, against the peer apps; 100 = the
  best app.
- rubric: five checks of 20 points each, applied to origin/main with file:line evidence. pass = 20, partial = 10,
  fail = 0. A check without evidence is fail.

## Number anchors (score = linear between the 0 point and the 100 point, clamped to 0..100)

| Figure | 100 at | 0 at | Why these anchors |
|---|---|---|---|
| Window launch, warm, to the first drawn snapshot (s) | 0.5 | 3.0 | macOS guidance: an app is usable within about 1 s; 3 s feels broken |
| Window launch, cold (s) | 1.0 | 5.0 | the first launch may load WebKit and the core |
| Core start to the first answer (s) | 0.1 | 2.0 | the CLI starts a core on demand; a person waits for it |
| Send to agent: CLI call to the bytes in the agent's terminal, median (ms) | 50 | 1000 | 1 s is the limit for "immediate" (Nielsen) |
| Idle CPU, core + window (%) | 0.2 | 5.0 | an idle app must not drain the battery |
| Memory, core + window + WebKit, idle (MiB) | 150 | 1100 | 1,091 MB is Orca's measured RSS (ADR 0001); 150 MiB is a light native app |
| Memory added per session, 20 shell sessions (MiB) | 1 | 20 | |
| Growth of sessions.json per session (KiB) | 1 | 50 | |
| Snapshot reply per session (KiB) | 2 | 50 | the window takes the whole snapshot on every connect |
| Install on a fresh folder: copy, signature check, start, drawn (success of 5) | 5 of 5 | 0 of 5 | |
| Owner installs that landed, last 20 green mainwatch runs (%) | 100 | 0 | read only from the mainwatch log |
| Gate green rate on main, last 30 mainwatch runs (%) | 100 | 70 | |
| Gate duration, median of the last 30 runs (min) | 5 | 30 | |
| Locale key coverage, 7 other languages (%) | 100 | 80 | |
| Cold debug build of the Rust workspace, fresh target (min) | 3 | 20 | `scorecard.py dev` |
| Warm rebuild after a one-file change in the core crate (s) | 15 | 180 | the edit-build loop a lane repeats |
| Web build (s) | 15 | 120 | |
| The gate's Rust test stage, scripts/cargo-test-gate.sh (min) | 3 | 20 | |
| Largest source file, not tests or catalogues (lines) | 2000 | 15000 | sessions.rs is about 14k |
| Source files over 2,000 lines | 0 | 20 | |
| Files that two or more open lanes change today | 0 | 10 | open lane = a local branch with a commit today that origin/main lacks |
| Change failure rate: landings that broke main / tested main tips (%) | 5 | 30 | DORA: elite 0-5 %, low performers above 30 % |
| Time to restore: minutes main stayed red, median over red episodes | 60 | 1440 | DORA: elite under 1 hour, low over a day |

A part measured by numbers is the mean of its figures' points.

## Parts and methods

| ID | Part | Method | Inputs |
|---|---|---|---|
| p01 | Integrations | peer | capability rows G2, G3, G6, X1, X8, B1, B2, M1, M2 of docs/peers/inventory-1115.md and task T10 |
| p02 | Release readiness | rubric | RR1-RR5 |
| p03 | Cost and token efficiency | rubric | CT1-CT5 |
| p04 | Usability | peer | tasks T1-T12, mean |
| p05 | Update and install reliability | number | install of 5, owner installs landed |
| p06 | Agent compatibility | peer + check | capability rows A1-A5, C4, S3, S4, S5; VC1 (rows and VC1 are 10 equal items) |
| p07 | License and trademark | rubric | LI1-LI5 |
| p08 | Stability | number + rubric | launches drawn of all launches, sessions alive after the run, gate green rate; ST1-ST2 |
| p09 | Task handoff quality | rubric | TH1-TH5 |
| p10 | Accessibility | rubric | AC1-AC5 |
| p11 | Feature cohesion | peer | tasks T6, T7, T8, T12 (each crosses two features), mean |
| p12 | Test reliability | number + rubric | gate green rate, gate duration; TR1-TR3 |
| p13 | First use | peer | tasks T1, T2, T10, mean |
| p14 | Optimization and resources | number | idle CPU, idle memory, memory per session, sessions.json and snapshot growth |
| p15 | Speed | number | warm and cold launch, core start, send to agent |
| p16 | Bot and team operation | rubric | BT1-BT5 |
| p17 | Docs accuracy | rubric | DA1-DA5 |
| p18 | Internationalization (8 languages) | number + rubric | locale key coverage; IN1-IN2 |
| p19 | Data safety and recovery | rubric | DS1-DS5 |
| p20 | Observability and diagnostics | rubric | OB1-OB5 |
| p21 | Code quality | rubric | CQ1-CQ5 |
| p22 | Extensibility | rubric | EX1-EX5 |
| p23 | Design | rubric | DE1-DE5 (consistency checks, not taste; see the limit on the page) |
| p24 | Interface (CLI, API, MCP) | peer | interface rows I1-I5 below, against Orca, T3 Code, herdr, Claude Code, Codex |
| p25 | Security and privacy | rubric | SE1-SE5 |
| p26 | Maintainability for agent development | number + rubric | cold and warm build, web build, Rust test stage, gate median, largest file, files over 2,000 lines, files shared by open lanes; MD1-MD5 (agent development) |
| p27 | Deploy stability | number + rubric | change failure rate, time to restore (mainwatch and landloop logs, read only); DP1-DP3 |
| p28 | Product direction and differentiation (judgment) | rubric | PD1-PD5; a judgment part: the checks read docs and tickets, nothing is measured |
| p29 | Dependencies and supply chain | rubric | SC1-SC5 (scorecard.py ops) |
| p30 | Development speed | rubric | DV1-DV9: the DORA four keys, the flow split, cost, owner touches, rework, seat use (scripts/measure-dev-speed.py, read only) |
| p31 | Skills and agent guidance quality | rubric | SK1-SK5: the skills Nunchiro ships and the guidance agents get |
| p32 | Unattended operation | rubric | UO1-UO5: how far an agent team runs without the person |

A part with "number + rubric" is the mean of its number points and its rubric points, weighted by their count (each
figure and each check is one item).

Peer capability rows: yes = 1, partial = 0.5, no = 0; part score = 100 x Nunchiro's sum / the best app's sum.

### Interface rows (p24)

- I1 A CLI starts an agent session in a folder.
- I2 A CLI sends a prompt and reads the agent's output or state.
- I3 A CLI or API waits for a state (done, needs input) without polling by hand.
- I4 A local API (socket or HTTP) other programs can call, documented.
- I5 An MCP server or tool surface that the agents themselves use to control the app.

## Rubric checks

### p02 Release readiness
- RR1 A signed and notarized build is produced by a script in the repo.
- RR2 The public export is scanned for personal data and secrets before it leaves (script and its use).
- RR3 A user gets updates without a manual reinstall (an update path that a test covers).
- RR4 A user-facing install and first-run guide exists and matches the app.
- RR5 Open release blockers: 0 = pass, 1-3 = partial, more = fail (docs/goal.md, ROADMAP.md).

### p03 Cost and token efficiency
- CT1 The app shows usage and plan limits per account.
- CT2 The model and effort are chosen per task or seat, so cheap work runs on a cheap model.
- CT3 What Nunchiro adds to each agent's context (plugin, skills, hooks text) is small: under 4 KB pass, under 12 KB
  partial (measured size, file list as evidence).
- CT4 An idle agent session costs no tokens (no timed prompt or poll sends model turns by default).
- CT5 Context is reused instead of re-sent: a handoff or fresh conversation passes a short summary, not the whole log.

### p07 License and trademark
- LI1 A LICENSE file and the same license named in every package manifest.
- LI2 Third-party notices are generated from the lock files and checked by a script.
- LI3 Code taken from other projects is listed in a reuse ledger that a script checks.
- LI4 Dependency licenses are checked against an allow list (deny copyleft where not allowed).
- LI5 The name "Nunchiro" has a recorded trademark search or decision.

### p08 Stability (rubric part)
- ST1 A core swap keeps running sessions (test).
- ST2 A crash while drawing shows a way back, not a white window (test).

### p09 Task handoff quality
- TH1 A brief template carries the owner's words, the acceptance and the stop rules.
- TH2 A report template starts with STATUS and lists what was not checked.
- TH3 An agent can ask its lead and wait for the answer (CLI with a timeout).
- TH4 Lessons from a task are kept (task learn or a recorded lesson file).
- TH5 Landed lanes reverted on main: 5 % or less of the green runs in the mainwatch log = pass, 10 % or less = partial.

### p10 Accessibility
- AC1 Every main screen works with the keyboard only (a spec walks it).
- AC2 Every control has an accessible name (a scan spec).
- AC3 Text contrast meets WCAG AA in dark and light (a scan with 0 failures).
- AC4 Motion follows "reduce motion" (prefers-reduced-motion in the styles).
- AC5 The real app answers Accessibility actions on its controls (AX press used by scripts/app-click).

### p12 Test reliability (rubric part)
- TR1 Quarantined or skipped tests: 5 or fewer = pass, 20 or fewer = partial.
- TR2 The last full nightly web run had 0 failed and 0 flaky.
- TR3 Fixes are proven red first: 8 or more of the last 10 closed tickets name a test that was red before.

### p16 Bot and team operation
- BT1 Standing agent seats (a lead and its workers) with a room to talk.
- BT2 The board shows each seat's state truthfully (fresh, working, needs you, done).
- BT3 A lead seat is replaced on a budget without losing its work.
- BT4 Scheduled work runs without the owner (schedules).
- BT5 A stuck seat gets a fresh conversation with the same role (task T12).

### p17 Docs accuracy
- DA1 The CLI reference is checked against the CLI by a script.
- DA2 The README quick start works as written (commands exist).
- DA3 GLOSSARY terms are the words the UI shows (sample of 10).
- DA4 Area records' decisions match the code (sample of 5).
- DA5 Closed tickets name tests that exist (sample of 10).

### p18 Internationalization (rubric part)
- IN1 A native read of every language was done and its fixes landed.
- IN2 A spec fails when a key is missing in any language.

### p19 Data safety and recovery
- DS1 State files are written atomically (temp file and rename).
- DS2 An update keeps a backup of the previous app and rolls back on failure.
- DS3 Sessions survive an app crash or a core swap (test).
- DS4 A broken state file does not lose the other data (test).
- DS5 A person can take their data out (export) and bring past conversations in (import).

### p20 Observability and diagnostics
- OB1 The core writes a log file with a size limit.
- OB2 A diagnostics or status command shows what runs and its health.
- OB3 A panic or crash leaves a report on disk.
- OB4 User-facing errors say what happened and what to do.
- OB5 Timings are recorded by scripts (startup, latency, paint) and kept.

### p21 Code quality
- CQ1 The gate runs clippy with -D warnings and the web typecheck.
- CQ2 Source files over 2,000 lines (not tests, not generated): 3 or fewer = pass, 10 or fewer = partial.
- CQ3 unwrap()/expect( in non-test Rust code per 1,000 lines: under 2 = pass, under 5 = partial.
- CQ4 `any` in non-test TypeScript (": any", "as any"): under 20 = pass, under 100 = partial.
- CQ5 A gate check guards duplicate or dead code (duplicate surfaces, dead clicks) with a baseline that may only fall.

### p22 Extensibility
- EX1 Skills can be seen, made and switched from the app and the CLI.
- EX2 Hooks can be seen and edited.
- EX3 MCP servers can be added per project or globally.
- EX4 Widgets or artifacts can be added without changing the app.
- EX5 Other agents plug in through a standard (ACP).

### p23 Design
- DE1 Colours, sizes and radii come from tokens (the raw-literal ratchet at its floor).
- DE2 Every page was looked at in dark and light with shots kept.
- DE3 One input style and one head per settings page (specs).
- DE4 Every empty list carries the action that fills it (spec).
- DE5 The main screens follow owner-approved mockups committed to docs/design.

### p26 Maintainability for agent development (added 2026-11-24 by the owner; re-aimed at agent development 2026-11-25)
How easily an AI coding agent (a Builder seat in its own worktree, inside a Nunchiro session) changes Nunchiro
correctly. MD1-MD5 replaced MX1-MX5 on 2026-11-25; the number figures stay.
- MD1 An agent can run the checks it needs inside a Nunchiro session. pass: every gate stage passes when run from a
  session; partial: the tests that fail there are named and AGENTS.md or the test runner says how to run them; fail:
  they fail with no instruction where the agent reads.
- MD2 A fresh worktree reaches its first green targeted test quickly. pass: one setup command, no copy of the checkout,
  no env rule beyond the script, and under 5 min measured; partial: at most 3 steps and no copy, or under 15 min; fail:
  otherwise or a copy is needed.
- MD3 The instruction surface (AGENTS.md, CLAUDE.md, the brief template) is short, current and not contradictory. pass:
  under 40 lines and every line matches the current way of working; partial: short, with stale lines; fail: long, or two
  rules contradict.
- MD4 Module boundaries and ownership let parallel lanes rarely collide. pass: candidate conflicts under 5 % of lane
  tries and no file changed by two open lanes; partial: conflicts under 15 %; fail: more. Merges of main into lane
  branches and edits outside a lane's Own list are shown beside it.
- MD5 Main is rarely red or flaky for an agent to step around. pass: main red under 2 % of the time and under 10 % of
  gate results red or contaminated; partial: main red under 10 % and under 30 % of gate results; fail: more.

### p27 Deploy stability (added 2026-11-24 by the owner)
- DP1 Every new main tip is tested automatically after it lands.
- DP2 A landing that turns main red is reverted without a person: pass when every culprit's revert landed, partial when some did.
- DP3 A red build never reaches the owner's app (an install only follows a green run of the same commit).

### p28 Product direction and differentiation (added 2026-11-24 by the owner; judgment)
- PD1 The target user is written in one place, with who it is not for.
- PD2 What differs from each peer (Orca, T3 Code, herdr, Claude Desktop) is written.
- PD3 The difference shows in measured results, not only in plans.
- PD4 The roadmap gives the next work in order and is current.
- PD5 Owner decisions are recorded where the builders read them.

### p29 Dependencies and supply chain (added 2026-11-24 by the owner)
- SC1 Lockfiles are committed and the builds use them (--locked, --frozen-lockfile).
- SC2 Known vulnerabilities are audited by a script or the gate (cargo audit or deny, pnpm audit).
- SC3 Outdated dependencies are tracked (cargo outdated, pnpm outdated, Dependabot or Renovate).
- SC4 An SBOM in a standard format (CycloneDX or SPDX) is made for a release.
- SC5 Two clean clones of main build the same binary (scripts/update-clone.sh, cargo --release --locked --offline).

### p30 Development speed (added 2026-11-25 by the owner, ticket 1127)
Measured by `python3 -B scripts/measure-dev-speed.py [--days 7]` over the last 7 days: git merges on origin/main (the
ground truth), the bin/land events, the mainwatch log and the task ledger, all read only; it writes
docs/measure/devspeed-<date>.json. The bands are the DORA ones (State of DevOps reports: elite, high, medium, low).
pass = 100 points (20 of the part), partial = 50 (10), fail = 0. The IDs are DV, because DS1-DS5 belong to p19.
- DV1 Deployment frequency (DORA elite: on demand, several a day). pass: a lane lands on main on at least 5 of the 7
  days and the owner's app installs a green main on at least 5 of the days the mainwatch log covers; partial: at least
  one landing and one owner install in the 7 days (high: daily to weekly); fail: less.
- DV2 Lead time for changes, the first lane commit to its merge on main (elite: under a day). pass: median under 24 h
  and p90 under 7 days; partial: median under 7 days (high); fail: 7 days or more, or not measured. Task created to
  the merge is shown beside it.
- DV3 Change failure rate: landed lanes later reverted (a fable-revert-<lane> merge) or named culprit by mainwatch,
  over lanes landed (elite to medium: 0-15 %). pass: 15 % or less; partial: 30 % or less; fail: more, or not measured.
  Gate rejects (eject and kick) and review rounds are shown, not scored: a rejected lane never reached main.
- DV4 Time to restore main: red to green in the mainwatch log, median (elite: under 1 h). pass: under 60 min; partial:
  under 24 h (high); fail: 24 h or more, or not measured.
- DV5 The flow split is measured and its waits are short: build, review, review to enqueue, gate queue, gate run.
  pass: review and gate times are known for at least 80 % of landed lanes, the gate queue median is under 60 min and
  the review rounds median is 1 or less; partial: known for some lanes and the gate queue median is under 4 h; fail:
  otherwise.
- DV6 Cost per landed lane: tokens and list-price dollars of every session that worked in the lane's worktree (Builder,
  Reviewers, rework), from the agents' own transcripts priced with the core's table (usage.rs PRICES). pass: known for
  at least 80 % of landed lanes and the median under 20 USD (a first budget; the owner may change it); partial: known
  for some lanes, median under 60 USD; fail: otherwise or not measured.
- DV7 Owner touches per lane and owner wait: questions, cards and answers the owner had to give (accept conditions
  that need the owner, merge-yes waits, asks to the person, permission waits) and the time lanes waited on them. pass:
  measured over the whole window, median at most 1 touch per lane and no wait over 1 h; partial: measured in part,
  median at most 1; fail: median over 3 or not measured.
- DV8 First-pass and rework rate (DORA 2024 rework rate). pass: at least 80 % of reviewed lanes pass their first review
  and rework (gate-rejected lanes landed later, second landings of a branch, reverts) is at most 10 % of landings;
  partial: first pass at least 50 % and rework at most 30 %; fail: otherwise.
- DV9 Seat use: share of live seat time working versus waiting, blocked or stalled (the core's attention states and
  stall nudges). pass: working at least 70 % and stalled minutes under 5 % of seat time; partial: working at least
  40 %; fail: otherwise or not measured.

### p06 Agent compatibility, version check (added 2026-11-25 by the owner)
- VC1 A new Claude Code or Codex version is checked for delivery (a typed message lands, Enter submits, the composer and
  turn end are read) before seats use it. pass: a check runs on each new version and blocks or warns before a seat
  uses it; partial: the version is detected and only some readers are checked; fail: nothing is checked.

### p31 Skills and agent guidance quality (added 2026-11-25 by the owner)
The skills Nunchiro ships (plugin/skills: nunchiro, orchestration, artifacts) and the guidance agents get (the seat
prompt, briefs, AGENTS.md).
- SK1 Accuracy: every command and flag a skill names exists (docs/cli.md headings, crates/nunchiro). pass: none missing;
  partial: 1-2 missing; fail: more.
- SK2 Trigger accuracy: each description says when to load the skill and when not, and a trigger test (prompts that
  should and should not load it) passes. pass: both; partial: descriptions only; fail: neither.
- SK3 Task success with the skill alone: an agent with only the skill completes its standard tasks (start a worker,
  prompt, wait, read; publish an artifact). pass: a recorded trial passes; partial: a trial passes in part; fail: no
  trial.
- SK4 Token weight: each SKILL.md under 3,000 tokens and each description under 80 words. pass: all; partial: one over;
  fail: more.
- SK5 Prompt audit: a dated audit of the skills, the seat prompt, the brief template and AGENTS.md has no open stale or
  contradictory line. pass: audit within 14 days, no open finding; partial: findings ticketed; fail: no audit or open
  findings.

### p32 Unattended operation (added 2026-11-25 by the owner)
How far a user's agent team runs without the person stepping in.
- UO1 Stalled and finished seats move on alone: nudges, Reviewer starts, review changes forwarded, the lead woken.
  pass: in place and seen working; partial: in place, not seen; fail: none.
- UO2 Typed messages reach the agent: no dropped Enter, no stuck composer. pass: none on a measured day; partial: a few
  that the core resends itself; fail: the person had to step in.
- UO3 Permission waits do not stop a team: no wait over 10 min on a measured day. pass: measured over a day; partial:
  a shorter sample; fail: a longer wait.
- UO4 A restart (update, serve restart, app relaunch) keeps the seats, their turns and their task links. pass: no seat
  lost on the last restart; partial: seats come back but need a person; fail: seats lost.
- UO5 The team lands work while the person is away: lanes land between 00:00 and 07:00 on most nights. pass: at
  least 5 of 7 nights; partial: some; fail: none.

### p25 Security and privacy
- SE1 The core socket needs a token and its files are private to the user (0600 or 0700).
- SE2 Agent sessions run in a sandbox profile by default.
- SE3 Outward actions (send mail, publish) need an explicit approval.
- SE4 No secret or personal path is in the repo (scan in the gate or before publish).
- SE5 Dependencies are audited for known vulnerabilities by a script or the gate.
