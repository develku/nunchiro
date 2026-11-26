# Scorecard rubric v2 (ticket 1171)

Approved by the owner on 2026-11-26 after the audit of ticket 1170 (official mean 82.2, fair reading about 69). v1 is
kept as [rubric-v1.md](rubric-v1.md). v2 only tightens; the one place where an anchor is easier in a narrow range
(idle CPU under 0.43 %) is named with the other changes. Every change and its reason is in "What changed from v1" at
the end, and in the notes of parts.json, which the page prints.

Every part is scored 0 to 100. The method and the checks are fixed between runs. A new check is added only when a real
gap is found, never to raise a score; a change to this file is named in the next scorecard's notes.

## Rules for every part

1. **Not measured is 0.** A figure, a cell or a check that was not measured in this run, the way this file names,
   scores 0. It is never skipped and never carried over from an earlier run. The page counts these.
2. **An easier condition is not the figure.** A figure read under an easier condition than its anchor names (shell
   sessions where the anchor says real agent sessions, an empty home where it says restored sessions) is shown as a
   floor and scores 0.
3. **A test counts only when it ran green in this run.** A check that rests on a test or spec (RR3, ST1, ST2, AC1,
   AC2, AC3, DS3, DS4, DE3, DE4, IN2) keeps its verdict only when parts.json names the test
   commands under the check's `tests` and `scorecard.py tests` ran each of them green, with at least one test run, at
   the commit that was measured. "A test file exists" is fail.
4. **Every anchor names its source**: a peer measurement, a file and line, or a public page. An anchor with no peer
   figure says "own bar" and gives the reason. Nothing is a guess.
5. **Only tighten.** An anchor moves toward the best peer or stays; it is never moved to raise a score.

## Methods

- number: measured by `scripts/measure/scorecard.py run` on an isolated RC; the anchors turn a figure into points
  (linear between the 0 point and the 100 point, clamped). A part is the mean of its figures' points.
- field: a figure of the owner's own running app over 7 days, or read on it (`scorecard.py weigh`). Scored by anchors
  like a number.
- trial: a fixed set of real agent sessions or tasks run by the owner (it needs the owner's sign-ins and tokens).
  Scored by anchors like a number.
- peer tasks: the fixed tasks in [tasks.md](tasks.md), driven and timed in the running apps; 100 = the best app.
- peer rows: capability rows against the best peer, with breadth counts (see "Capability rows").
- rubric: five checks of 20 points each, applied to origin/main with file:line evidence. pass = 20, partial = 10,
  fail = 0. A check without evidence is fail.

A part with numbers and checks is the mean over its items (each figure and each check is one item).

## Peer measurements behind the anchors

Measured on this Mac (Mac16,10, 16 GiB, macOS 27.2.1) on 2026-11-26 with `scripts/measure/peers.py`, read only, on
the owner's own profile, nothing clicked. Raw: evidence/peers-2026-11-26-orca.json and -t3code.json.

| App | First launch to a window | Later launches, median (range) | Idle memory (footprint) | Idle CPU | State |
|---|---|---|---|---|---|
| Orca 1.4.256 | 1.71 s | 1.05 s (1.03-1.07) | 521 MiB (RSS 1,107 MiB), 13 processes | 1.75 % | its daemon (not in the sum, up 6 d 23 h) held 4 terminals, one a Claude session, while the app was closed and through this run's launches |
| T3 Code 0.1.6 | 3.50 s | 1.39 s (1.37-1.46) | 620 MiB (RSS 958 MiB), 7 processes | 0.75 % | no session started |
| herdr 0.9.5 | 0.28 s (273-278 ms) | | 22 MiB; 155-165 MiB with one Ghostty window | 0.33 % at 5 sessions | docs/research/perf/baseline-2026-10-31.md:74-76, docs/v1/figures.md:424-425 (not re-measured) |

Limits of these figures: "to a window" is the first on-screen window, earlier than Nunchiro's "first snapshot
drawn", so the peers' launch figures are floors. "First launch" is the first launch of the run (the app was not running), not a launch after a
reboot. Orca and T3 Code ran no agent session of ours, so their memory and CPU are floors too. Both are signed and
notarized Developer ID builds with an updater feed (`spctl -a -vv`: accepted, Notarized Developer ID;
Contents/Resources/app-update.yml). Orca's 1,091 MB in ADR 0001 was RSS; its footprint, the figure we use for
ourselves, is 521 MiB.

## Number anchors

| Figure | 100 at | 0 at | Source of the anchors | Measured by |
|---|---|---|---|---|
| Restored launch: the window's second launch on a home with 20 sessions and a 5,000-event conversation, to the first drawn snapshot (s) | 0.3 | 1.5 | 100: herdr 0.28 s (baseline-2026-10-31.md:74; an empty start, so this is stricter than the peer's own condition). 0: just past the slowest peer, T3 Code 1.39 s; Orca 1.05 s (peers.py 11-26) | run |
| Window launch, cold, fresh install (s) | 1.0 | 3.5 | 100: v1 (macOS guidance, usable in about 1 s). 0: T3 Code's first launch 3.50 s; Orca 1.71 s (peers.py 11-26). v1 was 5.0 | run |
| Core start to the first answer (s) | 0.1 | 2.0 | v1, unchanged; no peer has a like figure (herdr's 0.28 s is its whole start) | run |
| Terminal key to paint, p95, 3 busy sessions, WebKit (ms) | 16 | 50 | 100: one 60 Hz frame, our own target (baseline-2026-10-31.md:11; we measured 33-35 ms, :72); herdr's key to echo p95 is 6.19 ms (docs/v1/figures.md:441). 0: the paint bar of scripts/measure/measurelib.py:401 (p95 < 50 ms) | owner-run: `paint.sh --only echo --engines webkit --repeats 5 --no-record`, then the manual file |
| Idle CPU, core + window + WebKit + holders, 5 real agent sessions waiting, window open (%) | 0.3 | 3.0 | 100: herdr 0.33 % at 5 sessions (baseline-2026-10-31.md:75). 0: the audit's 3 %; on it T3 Code (0.75 %) scores 83 and Orca (1.75 %) 46 (peers.py 11-26). v1 was 0.2..5.0 with no session | owner-run: `scorecard.py weigh` |
| Idle memory, the same processes and state (MiB) | 150 | 600 | 100: herdr with one Ghostty window 155-165 MiB (docs/v1/figures.md:424-425). 0: between Orca 521 MiB and T3 Code 620 MiB idle with no session of ours (peers.py 11-26). v1's 0 point was 1,100 | owner-run: `scorecard.py weigh` |
| Memory added per session, 20 shell sessions, holders counted (MiB) | 1 | 20 | 100: herdr adds 0.9 MiB per session ((31.1 - 24.5) / 7, docs/v1/figures.md:424-425). 0: v1. New: each session's `nunchiro hold` process is counted (v1 read -0.83 MiB) | run |
| Growth of sessions.json per session (KiB) | 1 | 50 | v1, unchanged | run |
| Snapshot reply per session (KiB) | 2 | 50 | v1, unchanged | run |
| Seats lost per restart, 7 days (field) | 0 | 1 | 100: a peer loses none: Orca's daemon kept its 4 sessions while the app was closed and through four launches and quits of the app (peers.py 11-26). 0: one seat per restart, the UO4 fail line | owner-run: `scorecard.py record` (the core's record in `serve status --json`) |
| Missed prompts per 1,000 delivered, 7 days (field) | 0 | 5 | 100: cmux never types into the terminal, so it has no dropped Enter (cmux docs/agent-messages.md:3). 0: own bar: at a few hundred prompts a day, 5 per 1,000 is a miss the person must fix every day, the UO2 fail line | owner-run: `scorecard.py record` (the core's record in `serve status --json`). Prompts are queued sends with their Enter (`agent prompt`, other senders' lines, queued composer sends): only those can be missed where the core can see it. The window's direct composer writes have no queue row and are in neither count |
| Memory-pressure kills on this Mac while Nunchiro runs seats, 7 days (field) | 0 | 3 | 100: none; the Mac must stay responsive with seats running. 0: own bar: one kill every other day; a single low-memory kill froze the owner's 16 GB Mac on 2026-11-25 with five seats. Counted from the JetsamEvent reports in /Library/Logs/DiagnosticReports whose time falls while the core held at least one seat | owner-run, not yet scripted |
| Clean hours of a 24 h soak with 20 real sessions | 24 | 0 | own bar from scripts/measure/measurelib.py:397-409 (0 crashes, 0 stuck terminals, footprint at the end at most 1.25 x minute 2), run for 24 h instead of 10 min | owner-run, see p08 |
| Install on a fresh folder (success of 5) | 5 of 5 | 0 of 5 | v1, unchanged | run |
| Owner installs that landed, last 20 green main CI runs (%) | 100 | 0 | v1, unchanged | run |
| Gate green rate on main, last 30 main CI runs (%) | 100 | 70 | v1, unchanged | run |
| Gate duration, median of the last 30 runs (min) | 5 | 30 | v1, unchanged | run |
| Locale key coverage, 7 other languages (%) | 100 | 80 | v1, unchanged | run |
| Cold debug build, warm rebuild, web build, Rust test stage, largest file, files over 2,000 lines, files shared by open lanes | | | v1, unchanged (3..20 min, 15..180 s, 15..120 s, 3..20 min, 2,000..15,000, 0..20, 0..10) | dev |
| Change failure rate (%), time to restore (min) | 5, 60 | 30, 1440 | v1, unchanged (DORA) | ops |
| Open a 5,000-event conversation: select it to its newest message painted (ms) | 100 | 1000 | Nielsen's limits: 0.1 s feels instant, 1 s keeps the flow (nngroup.com/articles/response-times-3-important-limits). Peer practice: T3 Code bounds a cold open to 75 rows and about 1 MiB (t3code docs/internals/performance-regressions.md:15) | not yet: the page reports this paint (`nunchiro:chat-drawn <session>` mark) and `measurelib.chat_open` reads it, but no runner draws frames: a gate window is hidden (no animation frames), and Playwright gets no window token from a release core |
| 8 terminals streaming 20 MiB each: worst frame, WebKit (ms) | 200 | 2000 | 100: the stall bar of measurelib.py:397 (a stall a user sees). 0: the 2 s after which the same scripts call a key missed (measurelib.py:405). We read 1,453-1,843 ms on 10-25 (docs/v1/figures.md `stream-8-webkit`) | owner-run: `paint.sh --only stream --sizes 8 --engines webkit --no-record` |
| Memory after 24 h over memory at minute 2, 5 real sessions (ratio) | 1.0 | 1.5 | own bar from the soak bar 1.25 (measurelib.py:400), which is 50 points here | owner-run with the 24 h soak |
| Prompt delivery: `agent prompt` to the text submitted in a real agent's screen, median (ms) | 1000 | 10000 | Nielsen: 1 s keeps the flow, 10 s loses attention. Our path waits by design (crates/nunchiro-core/src/sessions/deliver.rs: the settle before Enter); cmux delivers through hooks with no wait for a screen | not yet |
| Delivery trial: prompts not submitted per 1,000 sent (500 sends) | 0 | 5 | as "missed prompts" above | owner-run trial, see p34 |
| Shown state matches the true state, 100 readings (%) | 100 | 90 | own bar: with six seats on the board, 90 % is one wrong seat in most looks; no peer publishes a figure | owner-run trial |
| Requests that became a card within 5 s, 50 requests (%) | 100 | 95 | own bar: docs/product.md "nothing missed" | owner-run trial |
| Start dialogs that became a card within 5 s, 10 dialogs (%) | 100 | 95 | the bar of the requests above, so one start dialog of the 10 without its card scores 0 | owner-run trial |
| Minutes per day a session waited with no card, 7 days (min) | 0 | 12 | the delivery figure's rule (0 at 5 missed in 1,000) applied to time: 0.5 % of a working day of the trial's 5 sessions (5 x 8 h = 2,400 session minutes) is 12 min. No peer publishes a figure | owner-run, 7 days (`scorecard.py waits`) |
| Outward actions that left without an approval, 20 tries on a fake mail server | 0 | 1 | docs/product.md "nothing sent outward without the owner": one is a fail | owner-run trial |
| Bot task set: runs that pass their acceptance without owner input (%) | 100 | 0 | the percent itself; the same set run in Orca and T3 Code is shown beside it when run | owner-run trial, see p35 |
| Owner touches per task in that set, median | 0 | 3 | the bands of DV7 below (pass at most 1, fail over 3) | owner-run trial |
| First-pass review rate of real lanes, 7 days (%) | 100 | 50 | the bands of DV8 below (partial from 50 %); DORA 2024 rework rate | scripts/measure-dev-speed.py |

"Measured by": run, dev, ops = `scorecard.py run|dev|ops`. "owner-run" and "not yet" figures enter through
docs/measure/manual-<date>.json: `{"date": "2026-11-27", "figures": {"<name>": {"value": 31.5, "evidence": "how and
where it was measured, with the raw file"}}}`. An entry without evidence, or a file older than 7 days before the run,
is ignored. The figure names are the keys of ANCHORS in scripts/measure/scorecard.py.

## Parts and methods

| ID | Part | Method | Inputs | Today |
|---|---|---|---|---|
| p01 | Integrations (coding tools) | peer rows | rows G2, G3, G6, X1, X8, B1, B2, M1, M2, T10; count: issue and task sources with a page | script and reading |
| p02 | Release readiness | rubric | RR1-RR5 | reading; RR3 needs its test green |
| p03 | Cost and token efficiency | rubric | CT1-CT5 | reading |
| p04 | Usability | peer tasks | T1-T12, driven and timed | owner-run, not yet |
| p05 | Update and install reliability | number | install of 5, owner installs landed | script |
| p06 | Agent compatibility | peer rows | rows A1-A5, C4, S3, S4, S5, VC1; count: agent kinds with a real turn | reading; the count is owner-run |
| p07 | License and trademark | rubric | LI1-LI5 | reading |
| p08 | Stability | field + trial + number + rubric | seats lost per restart, missed prompts per 1,000, 24 h soak, gate green rate; ST1-ST2 | gate: script; ST: tests; the rest owner-run or not yet |
| p09 | Task handoff quality | rubric | TH1-TH5 | reading |
| p10 | Accessibility | rubric | AC1-AC5 | reading; AC1-AC3 need their specs green |
| p11 | Feature cohesion | peer tasks | T6, T7, T8, T12, driven and timed | owner-run, not yet |
| p12 | Test reliability | number + rubric | gate green rate, gate duration; TR1-TR3 | script and reading |
| p13 | First use | peer tasks | T1 from the download page, T2, T10, driven and timed | owner-run, not yet |
| p14 | Optimization and resources | field + number + rubric | idle CPU and memory at 5 real agent sessions with holders; memory per session, sessions.json and snapshot growth; memory-pressure kills, 7 days; ML1 | growth: script; idle: owner-run (`weigh`); kills: owner-run, not yet scripted; ML1: rubric |
| p15 | Speed | number | restored launch, cold launch, core start, terminal key to paint | script; key to paint owner-run |
| p16 | Bot and team operation | peer rows | rows BT1-BT7 | reading; BT2 needs a look at the running app |
| p17 | Docs accuracy | rubric | DA1-DA5 | reading |
| p18 | Internationalization (8 languages) | number + rubric | locale key coverage; IN1-IN2 | script; IN2 needs its spec green |
| p19 | Data safety and recovery | rubric | DS1-DS5 | reading; DS3, DS4 need their tests green |
| p20 | Observability and diagnostics | rubric | OB1-OB5 | reading |
| p21 | Code quality | rubric | CQ1-CQ5 | reading |
| p22 | Extensibility | peer rows | rows EX1-EX5; count: kinds of extension a user can add | reading |
| p23 | Design | rubric | DE1-DE5 | reading; DE3, DE4 need their specs green |
| p24 | Interface (CLI, API, MCP) | peer rows | I1-I5 against Orca, T3 Code, herdr, Claude Code, Codex (v1, unchanged) | reading |
| p25 | Security and privacy | rubric | SE1-SE5 | reading |
| p26 | Maintainability for agent development | number + rubric | build and test times, file sizes, lane overlap; MD1-MD5 | script and reading |
| p27 | Deploy stability | number + rubric | change failure rate, time to restore; DP1-DP3 | script and reading |
| p28 | Product direction and differentiation (judgment) | rubric | PD1-PD5 | reading |
| p29 | Dependencies and supply chain | rubric | SC1-SC5 | script and reading |
| p30 | Development speed | rubric | DV1-DV9 | script |
| p31 | Skills and agent guidance quality | rubric | SK1-SK5 | reading |
| p32 | Unattended operation | rubric | UO1-UO5 | reading |
| p33 | Real-use speed and weight (new) | number + trial | open a 5,000-event conversation, 8 terminals streaming, memory growth over 24 h, prompt delivery | owner-run (2), not yet (2) |
| p34 | Multi-agent accuracy (new) | trial | delivery, shown state, cards, outward gate, start dialogs, waits with no card | owner-run, not yet |
| p35 | Bot quality (new) | trial + field | task set success, owner touches, first-pass review rate | first-pass: script; task set owner-run, not yet |
| p36 | Extensibility for others (new) | peer rows | rows XO1-XO5 | reading |
| p37 | Reach (new) | rubric | RE1-RE5, each done in the run | reading and doing |

"Today" says how an item can be measured now: script = a command of this repo; reading = a judge reads origin/main;
owner-run = a documented step that needs the owner's app, sign-ins or tokens; not yet = no way exists yet. An item
that is owner-run or not yet scores 0 until it is measured (rule 1).

## Peer tasks (p04, p11, p13)

The tasks, the path rule and the score are in [tasks.md](tasks.md). In short: every cell is one task driven in the
running app, the same way in every app, on the default GUI path a new user finds; the steps and the seconds are
recorded; three drives, the median. The task score is the lower of the step score and the time score. T1 starts at
the app's public download page. A Nunchiro cell not driven in this run scores 0. A task counts only when at least two
peers were driven on it.

## Capability rows (p01, p06, p16, p22, p36)

- A row is yes (1), partial (0.5) or no (0) for Nunchiro and for each peer. depth = 100 x Nunchiro's sum / the best
  peer's sum.
- The rows are what any peer has, not the rows where Nunchiro has something. A row is added when a peer has a thing
  the rows do not show, with the peer's file and line.
- Yes means the app itself does it. A button that sends a fixed prompt to the agent is partial. A capability proven
  only against a fake (an ACP agent that never ran a real turn) is partial.
- A peer cell is "no" only with a record of the search. A peer cell nobody searched counts yes. A Nunchiro cell
  nobody checked counts no.
- A breadth count is a number of things (agent kinds, services, kinds of extension): 100 x log2(1 + ours) /
  log2(1 + the best peer's). Ours counts only what was proven in this run. A part with counts is the mean of depth
  and breadth.

Why a log scale and not a plain ratio: Orca lists 45 agent ids and Nunchiro runs 2. A plain ratio says Nunchiro has
4 % of Orca's agent support, as if the 45th command-line agent mattered as much as Claude Code. Each further agent or
service serves fewer people, so the count is scored on a log scale (2 of 45 = 29, 8 of 45 = 57, 20 of 45 = 80). The
audit proposed "breadth against the best peer" without a formula; this is the fair version of it, and the plain
ratio is shown beside it on the page.

The best peer for a count is the best of the same-kind apps of tasks.md (Orca, T3 Code, herdr), the apps the other
rows use. Other apps have more (emdash has 13 issue-tracker integrations, packages/plugins/src/integrations/impl/)
and are named as notes, not as the anchor.

### p01 Integrations (coding tools)

Rows (docs/peers/inventory-1115.md): G2 push and create a PR, G3 PR status and CI checks, G6 AI commit message and
PR text, X1 start work from an issue list, X8 pull requests page, B1 in-app browser pane, B2 the agent drives the
browser, M1 work on a remote machine over SSH, M2 use from a phone or another device, T10 add an MCP server or skill
in the app. Count: issue and task sources with a page in the app (best: Orca 4, GitHub, GitLab, Jira and Linear,
src/renderer/src/components/task-page/).
Assistant-type integrations (mail, calendar, chat apps) are not counted for any app.

### p06 Agent compatibility

Rows: A1 Claude Code, A2 Codex, A3 other agents (ACP and named CLIs), A4 several agents at once listed by state, A5 an
agent delegates to child agents, C4 agent binary path, args and env, S3 model per session, S4 reasoning effort, S5
plan mode, VC1 (below). Count: agent kinds that completed a real turn in this run (best: Orca 45 launch ids,
src/shared/agent-launch/catalog/tui-agent.ts:2-46; T3 Code adds any agent of the ACP registry,
docs/user/providers-acp.md:1-6). Ours: Claude and Codex count when `sh scripts/scenario/v1b-full.sh` passed its chat
rows in this run; an ACP agent counts only with a real agent turn on record (a prompt sent, an answer read, the turn
end seen), never with tests/fixtures/acp/fake_agent.py. The peer's count is its catalogue, which we cannot run in
full; that favours the peer and is the strict direction.

- VC1 A new Claude Code or Codex version is checked for delivery (a typed message lands, Enter submits, the composer
  and turn end are read) before seats use it. yes: a check runs on each new version and blocks or warns before a seat
  uses it; partial: the version is detected and only some readers are checked; no: nothing is checked.

### p16 Bot and team operation

- BT1 Standing agent seats (a lead and its workers) with a room to talk.
- BT2 The board shows each seat's state truthfully (fresh, working, needs you, done). yes needs a look at the running
  app in this run; code and specs alone are partial.
- BT3 A lead seat is replaced on a budget without losing its work.
- BT4 Scheduled work runs without the owner (schedules).
- BT5 A stuck seat gets a fresh conversation with the same role (task T12).
- BT6 A task graph: tasks with dependencies and gates that the team works through (Orca skill-guides/orchestration.md:6,162).
- BT7 A bot acts on its own when a watched pull request changes: checks fail, a review arrives (T3 Code
  apps/server/src/orchestration-v2/PullRequestWatchReactor.ts).

Whether the team does the work right is p35.

### p22 Extensibility

- EX1 Skills can be seen, made and switched from the app and the CLI.
- EX2 Hooks can be seen and edited.
- EX3 MCP servers can be added per project or globally.
- EX4 Widgets or artifacts can be added without changing the app.
- EX5 Other agents plug in through a standard (ACP). yes needs a real ACP agent turn in this run.

Count: kinds of extension a user can add without changing the app (best: Orca 18: the 16 plugin shapes of
skill-guides/orca-plugin-authoring.md:32-47, plus skills and MCP servers). Ours: one per row above that is not "no".
What a third-party developer gets is p36, so it is not counted twice here.

### p36 Extensibility for others (new)

What someone who is not us can build on the app.

- XO1 A documented plugin API: third-party code adds a panel, a command or a setting, or changes or refuses an action
  (Orca skill-guides/orca-plugin-authoring.md:32-47).
- XO2 A scaffold and types for plugin authors: one command makes a plugin that builds (Orca `ORCA plugin create` and
  `ORCA plugin types`, the same guide :20-22; bb packages/plugin-sdk).
- XO3 A catalogue lists extensions and installs one from inside the app.
- XO4 A trigger others can call: a webhook or an event from GitHub, Slack or Linear starts agent work (Orca
  src/main/automations/; T3 Code orchestration-v2/PullRequestWatchReactor.ts).
- XO5 The local API is published as a schema or a typed client (herdr docs/next/api/herdr-api.schema.json).

A yes for Nunchiro needs a working example made in this run (a sample plugin loaded, a trigger fired at an isolated
core).

## New parts

### p33 Real-use speed and weight (new)

The four figures of the table above. The launch with a full tree is in p15 and the idle weight in p14; this part is
what the app costs while it is used: a long conversation, many terminals streaming, a day of running, a prompt on its
way to a real agent.

### p34 Multi-agent accuracy (new)

One trial, run by the owner: a core on its own NUNCHIRO_HOME with 5 real agent sessions (3 Claude, 2 Codex, the
cheapest models) on the owner's sign-ins, inside the config guard that scripts/scenario/v1b-full.sh uses. One of the
5 (one Claude) runs on a second Mac through `nunchiro --machine <alias>`; its figures are reported on their own and are
in the totals, and a run without the second Mac is not counted:

1. Delivery: 500 prompts sent with `nunchiro agent prompt` (100 per session, a one-line "reply ok" task), 250 of
   them while the session's composer holds half-typed text. Not submitted within 30 s without a person = missed.
2. Shown state: at 100 random moments one seat's shown state (working, needs you, done, idle) is read from
   `nunchiro agent list` and compared with what the agent's own screen shows at that moment.
3. Cards: 50 requests are raised (25 permission requests, 25 questions); each must be a card within 5 s.
4. Outward gate: 20 outward actions are tried through a fake mail MCP server (never a real account); each must wait
   for the approval card.
5. Startup waits: 10 start dialogs are raised, 5 folder trust and 5 sign-in missing, each on a new session that is
   never answered and then closed; each must become an owner card within 5 s of showing on the agent's screen. A run
   with another mix is not counted. An update prompt is raised in the script's self-test only: no real seat can show
   one, because Nunchiro keeps Codex's update screen off and refuses an argument that turns it on
   (crates/nunchiro-core/src/sessions/spawn.rs:217), and Claude Code shows no update dialog at start.

Beside the trial, a field figure (owner-run, 7 days): the minutes per day a session waited with no card, read from the
owner's own app every 30 s (each agent session's screen shows a dialog or a start question while the core holds no
card for it), with `scorecard.py waits`.

### p35 Bot quality (new)

1. Task set (trial, owner-run): ten fixed tasks, three runs each, given to a lead seat with two workers (tasks 1-7)
   or to the Assistant (tasks 8-10). A run passes when the acceptance holds and the owner gave no input after the
   first message. The set, kept the same between runs:
   1. Fix a failing unit test in a small fixture repository (the test suite is green).
   2. Add a CLI flag with its test and its help line (the new test is green, the help shows the flag).
   3. Rename a function across five files (the build is green, the old name is gone).
   4. Split one task between two workers in two worktrees and merge both (both changes are on the branch, tests green).
   5. Review a diff that hides one planted bug (the review names the bug's line).
   6. Recover from a worker that stops answering (the task still ends; a fresh conversation was started).
   7. Open a pull request with a summary of the change (the PR exists on a local bare remote, the summary names the files).
   8. Sort ten fixture mails into three labels (at least nine of ten right).
   9. Draft a reply to a fixture mail and stop at the approval card (a draft exists, nothing was sent).
   10. Find a free hour in a fixture calendar and propose it (the hour is free in the fixture).
   The fixtures (repository, mails, calendar) do not exist yet; making them is the first step of the first run.
2. Owner touches per task in that set, median.
3. First-pass review rate of the real lanes of the last 7 days (`scripts/measure-dev-speed.py`, rework.first_pass_pct,
   from the verdicts in the private review record).

### p37 Reach (new)

Each check is done in this run, not read from a script.

- RE1 A signed build can be downloaded from a public page (the file was downloaded in this run; its URL is the evidence).
- RE2 macOS opens the downloaded build without a warning: `spctl -a -vv` says accepted, Notarized Developer ID, as it
  does for Orca and T3 Code (measured 11-26).
- RE3 The installed app updates itself from one release to the next without a reinstall (done once in this run; the
  peers ship an updater feed, Contents/Resources/app-update.yml).
- RE4 A public docs site covers install, first run and each of the twelve peer tasks (URL and the page of each task).
- RE5 A public release in the last 30 days with user-facing notes.

Not scored, by the owner's direction in docs/product.md ("who it is not for"): Windows and Linux builds, cloud
sandboxes. A phone client is row M2 of p01.

## Owner-run steps

| Step | Command or method | Feeds |
|---|---|---|
| Tests of this run | `python3 -B scripts/measure/scorecard.py tests --target <cargo target>` (writes tests-<date>.json) | rule 3 |
| Idle weight with real agents | with at least 5 Claude or Codex sessions waiting at their prompts and the window open: `python3 -B scripts/measure/scorecard.py weigh` (read only; writes the manual file) | idle_mib_5, idle_cpu_pct_5 |
| Terminal paint and streaming | `sh scripts/measure/build.sh`, then the two `paint.sh` commands of the anchor table; copy p95_ms and the worst frame into the manual file | term_paint_p95_ms, stream8_worst_frame_ms |
| Real agent turns | `sh scripts/scenario/v1b-full.sh` (Claude and Codex rows), one real ACP agent turn by hand | the count of p06, EX5, A3 |
| Peer tasks | drive T1-T12 in Nunchiro (an isolated RC), Orca and T3 Code the same way (by hand with a recording, or computer use for all; the owner answers its access dialog); record steps, seconds and the date in tasks.json | p04, p11, p13 |
| Seats lost per restart | over 7 days, for each restart of the owner's app (update, serve restart, relaunch): seats held before minus seats back after, from `nunchiro agent list` before and after; the mean | seats_lost_per_restart |
| 24 h soak | 20 real agent sessions on a core with its own NUNCHIRO_HOME for 24 h with a heartbeat prompt every 10 min; clean hours until the first crash, stuck terminal or lost session; footprint at the end over minute 2 | soak_clean_hours, mem_growth_24h_ratio |
| Accuracy trial | p34 above: `python3 -B scripts/measure/scorecard.py accuracy --machine <alias> --remote-project <dir on the second Mac>` (raw records in accuracy-<date>.json; the figures go into the manual file only when the run is counted; `--self-test` checks the script on a fixture agent and is never counted) | the five p34 trial figures |
| Waits with no card | p34 above: `python3 -B scripts/measure/scorecard.py waits` on the owner's Mac for 7 days (read only; samples in waits-<date>.jsonl; `--report <file>` gives the figure of a stopped run) | waited_no_card_min_per_day |
| Bot task set | p35 above | bot_task_success_pct, bot_owner_touches |
| Reach | p37 above | RE1-RE5 |

Not yet measurable, with what is missing: opening a 5,000-event conversation (the paint mark and its reader exist; no release-core runner draws frames, see p33's row); prompt delivery time to a real agent (no script).

## Rubric checks

Unchanged from v1 unless marked. Under rule 3 these checks count only when their tests ran green in this run: RR3,
ST1, ST2, AC1, AC2, AC3, DS3, DS4, DE3, DE4, IN2. The checks of p06, p16 and p22 are rows now (see "Capability rows").

### p14 Optimization and resources (rubric row)

- ML1 Under memory pressure the app protects the Mac before it starts another seat. pass: it reads the system's memory pressure, warns, and holds a new seat until the owner overrides or pressure falls; partial: it warns only; fail: nothing. The evidence is a test that fakes the pressure reading and shows the hold.

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

### p08 Stability (rubric part; the tests must run green in this run)
- ST1 A core swap keeps running sessions (test).
- ST2 A crash while drawing shows a way back, not a white window (test).

### p09 Task handoff quality
- TH1 A brief template carries the owner's words, the acceptance and the stop rules.
- TH2 A report template starts with STATUS and lists what was not checked.
- TH3 An agent can ask its lead and wait for the answer (CLI with a timeout).
- TH4 Lessons from a task are kept (task learn or a recorded lesson file).
- TH5 Landed lanes reverted on main: 5 % or less of the green runs in the main CI log = pass, 10 % or less = partial.

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
Measured by `python3 -B scripts/measure-dev-speed.py [--days 7]` over the last 7 days: the pull requests merged into
main (the ground truth) with their auto-merge times, the GitHub Actions runs on pull requests (every attempt), the main
CI log and a private review record (verdicts, review starts and owner asks, one line per fact, outside git), all
read only; it writes
docs/measure/devspeed-<date>.json. The bands are the DORA ones (State of DevOps reports: elite, high, medium, low).
pass = 100 points (20 of the part), partial = 50 (10), fail = 0. The IDs are DV, because DS1-DS5 belong to p19.
- DV1 Deployment frequency (DORA elite: on demand, several a day). pass: a lane lands on main on at least 5 of the 7
  days and the owner's app installs a green main on at least 5 of the days the main CI log covers; partial: at least
  one landing and one owner install in the 7 days (high: daily to weekly); fail: less.
- DV2 Lead time for changes, the first lane commit to its merge on main (elite: under a day). pass: median under 24 h
  and p90 under 7 days; partial: median under 7 days (high); fail: 7 days or more, or not measured. Task created to
  the merge is shown beside it.
- DV3 Change failure rate: landed lanes later reverted (a revert lane or pull request) or named culprit in the main CI log,
  over lanes landed (elite to medium: 0-15 %). pass: 15 % or less; partial: 30 % or less; fail: more, or not measured.
  Gate rejects (a CI run on a pull request that went red after its auto-merge was turned on) and review rounds are
  shown, not scored: a rejected lane never reached main.
- DV4 Time to restore main: red to green in the main CI log, median (elite: under 1 h). pass: under 60 min; partial:
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
  that need the owner, merge-yes waits, asks to the person, permission waits; read from the review record's asks and
  the core journal's permission waits) and the time lanes waited on them. pass:
  measured over the whole window, median at most 1 touch per lane and no wait over 1 h; partial: measured in part,
  median at most 1; fail: median over 3 or not measured.
- DV8 First-pass and rework rate (DORA 2024 rework rate). pass: at least 80 % of reviewed lanes pass their first review
  and rework (gate-rejected lanes landed later, second landings of a branch, reverts) is at most 10 % of landings;
  partial: first pass at least 50 % and rework at most 30 %; fail: otherwise.
- DV9 Seat use: share of live seat time working versus waiting, blocked or stalled (the core's attention states and
  stall nudges). pass: working at least 70 % and stalled minutes under 5 % of seat time; partial: working at least
  40 %; fail: otherwise or not measured.

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

## What changed from v1, and why

1. Rules 1 to 3 (not measured is 0, an easier condition is a floor, a test counts only when green in this run).
   Reason: v1 passed checks on "a test exists" and "a script exists", and measured an empty app.
2. Peer tasks (p04, p11, p13): driven and timed in the running apps, one path rule, the lower of the step score and
   the time score, T1 from the download page. Reason: v1 counted steps from code, Nunchiro on its best path and the
   peers on their default path; one more step per task moved Usability from 86 to 53.
3. Speed (p15): the warm launch is measured on a home with 20 sessions and a 5,000-event conversation, 100 at 0.3 s
   and 0 at 1.5 s (v1: 0.5 and 3.0 on an empty home); the cold launch's 0 point moves from 5.0 to 3.5 s; terminal key
   to paint p95 replaces "send to agent", which every local socket passed. "Send to agent" is still measured and shown.
4. Optimization (p14): idle memory and CPU are read with 5 real agent sessions and holders, 150..600 MiB and
   0.3..3 % (v1: 150..1100 MiB and 0.2..5 % with no session). One anchor is easier in a narrow range: the 100 point
   of idle CPU is 0.3 % (the approved figure, herdr's measured 0.33 % with 5 sessions) where v1 had 0.2 %, so a
   reading under 0.43 % earns up to 2 points more than in v1; above 0.43 % it earns fewer, and the reading is now
   taken with 5 real sessions. We measure 2.5 to 4 %.
5. Capability parts (p01, p06, p16, p22): rows are what any peer has, a prompt button is partial, an unsearched peer
   cell counts yes, and breadth counts are scored on a log scale. Bot and team and Extensibility move from five
   existence checks to rows against the peers.
6. Stability (p08): field figures and a 24 h soak replace "launches drawn" and "idle shells alive" (both 100 for any
   app). The gate green rate stays, so a low item was not dropped.
7. New parts p33 to p37 (the audit's five blind spots). They count in the mean from the first v2 run.
8. Multi-agent accuracy (p34) runs 1 of its 5 real sessions (one Claude) on a second Mac through
   `nunchiro --machine <alias>` (owner decision, stricter). Reason: the path to another Mac (SSH, the remote core's
   cards and states) is part of running many agents, and a trial on one Mac never touches it; a run without the
   second Mac is not counted, and the second Mac's figures are shown beside the totals.
9. Multi-agent accuracy (p34) adds a fifth trial step, start dialogs that must become a card within 5 s (100 to 95 %,
   the bar of the other cards), and a 7-day field figure, minutes per day a session waited with no card (0 to 12 min)
   (owner decision, stricter). Reason: a session stuck at a start question with no card is the "missed" that
   docs/product.md rules out, and the four steps start every session past its start questions. The 12 min 0-point is
   the delivery figure's 5 in 1,000 applied to a working day of 5 sessions; it rests on 8 hours a day.
10. Multi-agent accuracy (p34) step 5 raises 5 folder-trust and 5 sign-in dialogs on a counted run, and the update
    prompt only in the self-test (owner decision). Reason: no real seat can show an update prompt (Nunchiro keeps
    Codex's update screen off), and a faked one would measure the fixture, not the product. It is the same 10 dialogs
    with the same 5 s bar, so it is not looser; the anchors are unchanged.

Where v2 differs from the audit's proposal, and why:

- Breadth on a log scale, not a plain ratio (see "Capability rows"): fair to an app that supports the two agents
  most people use.
- The best peer for a count is one of the same-kind apps the card already compares (Orca, T3 Code, herdr), not the
  largest figure found by grep in any repository (emdash 13 trackers, 37 agents): those apps are not on the card.
- A third-party plugin SDK and a catalogue are scored once, in p36, not also as rows of p22.
- First use with no download: T1 follows whatever the public page tells a new user (today the README's build
  steps), timed like any other path, instead of a fixed 0. It will score near 0 on time, but it is measured.
- "Crashes in 7 days" is not a figure: no crash report of Nunchiro, Orca or T3 Code is on this Mac, every app would
  score 100, and a window crash leaves no report (OB3). That is the kind of anchor the audit asked to remove.
- "Take the best of the three peers as 100" for launch: kept as the approved 0.3 s (herdr), although herdr's figure
  is an empty start and ours is a restored one. Stricter than the peer's own condition; kept because it was approved.
- Reach leaves out Windows, Linux and cloud sandboxes: docs/product.md says who the app is not for.

- Source names (2026-11-26, the PR flow): the gate and deploy figures read the main CI log
  (scripts/measure/ci-log.py: GitHub Actions runs on every main tip and the recorded owner installs) where they read
  the local main watcher's log; landings are merged pull requests. No anchor, window or method changed. Gate rejects,
  review rounds, first pass and rework need the local gate's events, which the PR flow does not have: they read "not
  measured" for days after 2026-11-26 (rework read 0 rejects before; now it is null, never better).
- Source names (2026-11-27, PR-flow data): p30 reads pull requests and the Actions runs on them instead of the local
  gate's events and "Merge lane" merges. A gate reject is a pull request with a red CI attempt that started at or after
  its first auto-merge enable (reds before it are the builder's own checks, shown apart; a conflict set-aside has no
  GitHub event and is not counted). The enqueue is the last auto-merge enable before the merge, no longer the opening
  (the opening put the review wait into the gate queue); without an enable the queue is not known. A pull request
  titled `Revert "<title>"` reverts the one with that title. No anchor, band or window changed; where the runs cannot
  be read, rejects and rework read null.
  Review rounds, first pass, the build and review times and owner touches read a private review record (one JSON line
  per verdict, review start, ask or answer, written when it happens; GitHub cannot hold them: an author cannot review
  their own pull request, and pull-request text is public). Rounds are the distinct commits given a verdict; Codex
  looks are shown, not rounds. First pass now means the first verdict is an accept (before: one round, which counted a
  rejected-then-fixed single round as a pass; stricter). Lanes that started before the record's first live line have
  no owner figures (unknown, not 0), so DV7 reads "measured in part" until the record is older than the window. The
  task ledger is no longer read: it never saw the pull-request lanes.
- Owner decision 2026-11-26 (stricter): p14 adds memory-pressure kills over 7 days and row ML1. The Mac staying responsive is the owner's second priority, and the idle figures alone scored a frozen Mac the same as a calm one.

Not changed in v2 (the audit's lower-priority list, outside the approval of 2026-11-26): the weight of the default
permission in Security, the time-to-restore anchor, three runs per skill trial, and the samples the judge picks in
Docs accuracy.
