# Measure: the Nunchiro scorecard (ticket 1098; rubric v2, ticket 1171)

The scorecard scores 37 parts of Nunchiro 0 to 100, each on its own (parts 26 to 32 added by the owner on 2026-11-24 and
11-25; part 28, product direction, is a judgment part; parts 33 to 37 added with rubric v2 on 2026-11-26). Open
[scorecard.html](scorecard.html). Until the first v2 run that page is still the v1 card of 2026-11-26.

Rubric v2 in one line: a figure that was not measured the way the rubric names scores 0, a check that rests on a test
counts only when the test ran green in the same run, and anchors come from measured peers.

## Files

- [rubric.md](rubric.md): the method of every part, the number anchors with their sources, the capability rows and the
  rubric checks. Fixed between runs. [rubric-v1.md](rubric-v1.md) is the rubric of the cards up to 2026-11-26.
- [tasks.md](tasks.md): the 12 peer tasks, the path rule and how a cell is driven and scored.
- tasks.json: the peer task table (steps, seconds, the date driven, result, evidence and shots per app).
- parts.json: the rubric version and its change notes, and per part its method, the rubric verdicts with file:line
  evidence, the capability rows and counts, and the test commands a check rests on.
- results-<date>.json: the figures of one measure run (median, range and every value).
- tests-<date>.json: which of those test commands ran green in the run (`scorecard.py tests`).
- soak-<date>.jsonl: the samples of a 24 h soak (`scripts/measure/soak.py`), one line per heartbeat round.
- manual-<date>.json: figures no script measures yet, each with how it was measured (rubric.md, "Owner-run steps").
- evidence/peers-<date>-<app>.json: launch, idle memory and idle CPU of an installed peer (`scripts/measure/peers.py`).
- shots/: Nunchiro pictures from the run, and peer pictures from the 2026-11-02 timed run.

## Old names in history records

The local gate that ran before pull requests (named build-loop, with `bin/land` and `.agents/build-loop.toml`) is retired.
Its names stay only in records of runs made while it existed: rubric-v1.md, scorecard.html and parts.json of the card at
c5cd98879, results and dev files dated up to 2026-11-26, and evidence/prompt-audit-2026-11-25.md. They are kept unchanged
because a record must show what was measured then; the next run writes new evidence from the pull-request flow. Scripts
and tests no longer read those names, and tests/scenario/test_measure_scorecard.py fails if a measure script uses them again.

## Weekly full run (TR2)

.github/workflows/full.yml runs every web spec on Chromium and WebKit and the `measure` Rust set each week. Read the newest
result with `gh run list --workflow full.yml --limit 1` and `gh run download <run id> -n full-run-result`, which gives
full-run.json: `sha` and `date` (UTC) of the tested commit, `run_id`, `clean` (true only when every field below is
clean), `jobs` (`web`, `rust_extended` and `shots` job results: success, failure or cancelled), `web.chromium`,
`web.webkit` and `web.shots` each with `passed`, `failed`, `flaky` (passed on its retry) and `skipped` test counts and
`errors` (report-level errors, such as a global teardown failing after every test passed), `web_shards` (`expected` and
`reported` reports, the shards plus the one shots report; fewer reported means a shard died and the counts are
incomplete), and `rust_extended` (each scripts/extended-tests.sh
group: `pass`, `FAIL` or `skipped(...)`; null when that job did not finish). The run's summary page shows the same table.

The same run has a `shots` job (ticket 1161): the @shots tests (theme sweep and files measure; no accounts) run with
`PW_OPT_IN=shots --project shots`, their counts are `web.shots` and `jobs.shots` in full-run.json, and the sweep's
pictures are the run's `shots` artifact (`gh run download <run id> -n shots`, kept 30 days).

## Live tests (by hand, before a release)

The three @live specs need a real Claude (and for two rows Codex) account; hosted runners never get one, so no
automatic run starts them and the scorecard counts them as skipped (TR1). Each is driven by its scenario script, which
starts its own core and agent and passes the spec its session: `web/tests/chat-live.spec.ts`
(`scripts/scenario/v1b-chat.sh`), `web/tests/thumbnails-live.spec.ts` (`scripts/scenario/v1b-images.sh`) and
`web/tests/artifacts-live.spec.ts` (`scripts/scenario/v1b-artifact-skill.sh`). They check what fake agents cannot: the
real agent's transcript (timing, image blocks, artifact events). Run them on the owner's Mac before each release with
`sh scripts/scenario/v1b-full.sh` (all real-agent rows, config guard around the run; cheapest models), or one script
alone. Never on a machine whose accounts are not the owner's own.

## Run it again (after each phase)

1. `MEASURE_TARGET=<a cargo target folder on a roomy disk> python3 -B scripts/measure/scorecard.py run` builds the
   isolated RC and measures (about 15 minutes; add `--no-build` to reuse the last build in .scratch/startup). It writes
   results-<today>.json here. Run it with the `NUNCHIRO_*` variables unset (`env -u NUNCHIRO_HOME -u NUNCHIRO_TOKEN
   -u NUNCHIRO_SESSION`): the script drops them anyway, but a session's CLI should not see them either.
2. Re-apply the rubric checks and the capability rows to origin/main (a fresh agent with rubric.md) and update
   parts.json. `python3 -B scripts/measure/scorecard.py tests --target <a cargo target folder>` runs the test commands
   the checks name and writes tests-<today>.json; a check whose tests are not green there is not counted. It needs
   `pnpm install` and a web build first (the specs, and the app crate's tests, read web/dist), and runs at the commit
   that `run` measured.
   The owner-run steps of rubric.md (peer task drives, `scorecard.py weigh`, `scorecard.py chatopen`, `scorecard.py stream8`, the paint figures, the trials) fill
   tasks.json and manual-<today>.json; what was not done scores 0.
   `python3 -B scripts/measure/peers.py "/Applications/Orca.app" --out docs/measure/evidence/peers-<today>-orca.json`
   re-measures a peer when its version changed (it refuses when the app already runs and stops only what it started).
3. `python3 -B scripts/measure/scorecard.py dev --target <a throwaway cargo target folder>` measures part 26 (cold and warm
   build, web build, the gate's Rust test stage, the largest files, files shared by today's open lanes; about 15-25
   minutes, heavy on the CPU) and writes dev-<today>.json.
4. `python3 -B scripts/measure/ci-log.py` writes the main CI log (the GitHub Actions runs on main and the owner installs
   recorded with `ci-log.py --install`; `--history <log> --history-start <date>` puts an earlier log in the same format
   first, so "the last 30 runs" can reach back before the PR flow), which `run`, `ops` and
   `scripts/measure-dev-speed.py` read. `python3 -B scripts/measure/scorecard.py ops --clones <a throwaway folder>`
   reads that log and the git log of origin/main (read only) for deploy stability and checks the supply chain: lockfiles, audit tools (nothing is fetched), an SBOM, and two
   clean clones of origin/main built and compared (about 6 minutes). Writes ops-<today>.json.
5. `python3 -B scripts/measure/scorecard.py page results-<date>.json` renders scorecard.html (with the newest dev and ops files).

The run opens the app window (an own copy under its own bundle id). Every process it starts gets a fresh HOME and
NUNCHIRO_HOME in the system temp folder (from run 4 of 2026-11-24; runs 1-3 gave the window phase's core and window the
real HOME, so they could read ~/.claude). Code that reads the passwd home instead of HOME is not redirected. The memory and CPU window is a normal launch, so it takes the front once per repeat; the launch timings run
in the gate mode, which stays behind. The run lists, with lsof, the open files of the window, its WebKit helpers, the core and everything under it,
once per launch and once per window phase, and fails if one is under ~/.nunchiro, ~/.claude or ~/.codex (runs 1-3
checked only ~/.nunchiro and only the core and window processes). lsof sees open files at that moment only. The run
also fails if the owner's core is not the same process before and after.

`dev --target` and `ops --clones` empty a folder only when they made it: a new path gets a `.scorecard-owned` marker,
and an existing folder without it is refused, as are /, a home or a folder above one, this checkout, any git checkout
and the owner's Nunchiro home. The `dev` test stage runs detached (launchd as its parent), because 29 holder tests
fail under a Nunchiro session (crates/nunchiro-core/src/peer.rs under_holder); it is bounded at one hour and cannot be
stopped from the session that started it.

A run overwrites docs/measure/shots/nunchiro-launch.jpg and nunchiro-20-sessions.jpg on its first repeat, also with
--out. An "install" is a copy of the bundle (ditto) into a fresh folder, a --version call and a first launch; it is not
the self-update path or a Finder drag.
