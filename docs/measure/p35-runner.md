# p35 bot task set: the runner's steps

The ten tasks of [rubric.md](rubric.md) "p35 Bot quality", three runs each, 30 runs in all. The fixtures are fake data
under `scripts/measure/fixtures/p35` (a small `calc` repository, ten mails, a calendar); `scripts/measure/bottasks.py`
makes a fresh copy per run and checks each task's acceptance.

## Before the first run

- Use an isolated RC: its own `HOME` and `NUNCHIRO_HOME`, never the owner's app or home.
- Tasks 8-10 run with the account connectors off (below). The mail tasks work on files only. On an Outbox
  card, press Discard, never Send.
- `python3` and `git` on the PATH.

### Tasks 8-10: the Assistant sees no account connector

The RC's Claude may be signed in to an account whose claude.ai connectors (Gmail, Calendar) are real. Before the first
of tasks 8-10, cut them off for the Assistant's seat; the fixtures are files, so the seat needs no tool server at all.

1. With the RC's `NUNCHIRO_HOME` set, turn **Settings > Assistants > Connectors > Account connectors** off. Without the
   window: stop the RC's core, add `"home.connectors_off": true` under `"features"` in `$NUNCHIRO_HOME/settings.json`,
   start it again. The seat then starts with `--strict-mcp-config` and an empty `--mcp-config`, so no MCP server loads.
2. Close any Assistant seat that was open before the change (the setting applies at the next start), then open it.
3. Check before sending the task: `nunchiro agent list --json` gives the seat's id, `nunchiro agent get <id> --json`
   its `pid`, and `ps -ww -o command= -p <pid> | grep -c -- --strict-mcp-config` must print 1 (without `-ww`, macOS
   cuts the line at the terminal width). If it does not, stop: do not send the task. This shows the flag was passed; it
   is not proof that no connector loaded. The seat's lock hook also refuses every `mcp__` tool while the switch is off.
4. Keep the Assistant's mode below "Full access, shell included" for tasks 8-10: in that mode its shell runs unasked
   and could start another `claude` that loads the connectors.
5. Do not ask the seat to list or call mail or calendar tools.

## One run

1. `python3 -B scripts/measure/scorecard.py bottasks setup <task 1-10> <run 1-3>` prints the run folder, where to send,
   and the first message. Every run gets a new folder; never reuse one.
2. Tasks 1-7: in Nunchiro, open `<run folder>/repo` as a project, with its lead and two workers. Tasks 8-10: open the
   Assistant.
3. Send the printed first message unchanged, as one message. Start a stopwatch if you want times; they are not scored.
4. Watch until the lead or the Assistant says the task is done. Count every owner touch after the first message: each
   message, answer to a question, key press in a seat, or answer to a permission prompt or card is 1. A run that waits
   for the owner either gets the input (a touch) or is stopped where it is.
5. `python3 -B scripts/measure/scorecard.py bottasks check <run folder> --touches <N>` prints PASS or FAIL with the
   reasons and appends one JSON line to `docs/measure/bottasks-<date>.jsonl`. Checking a run again adds a line; the
   newest line of a task and run counts.

Task 6 (a worker stops answering) needs three more steps, with the RC's `NUNCHIRO_HOME` set:

- When the lead has handed the work to a worker and that worker is working: `nunchiro agent list --json > before.json`.
- Stop that worker: `nunchiro agent get <worker id> --json` gives its `pid`; check with `ps -o command= -p <pid>` that
  it is the worker's agent, then `kill -STOP <pid>`. This is the test, not an owner touch. Never stop any other process.
- When the task has ended: `nunchiro agent list --json > after.json`, then `kill -CONT <pid>`, and check with
  `--stalled <worker id> --agents-before before.json --agents-after after.json`.

Task 9: when the approval card for the reply shows in the window, add `--card-shown` to the check, then press Discard.

## What each check reads

| Task | Passes when |
|---|---|
| 1 | the suite is green with all 9 fixture tests, and no test file was changed |
| 2 | the suite is green with at least one new test that names precision; `--help` shows `--precision`; `--precision 2` prints 10 / 3 as 3.33 |
| 3 | the suite is green; `parse_number` is in no file; `calc/numbers.py` defines `to_number` and the other four files use it |
| 4 | on `main` (the branch, not the working copy): the suite is green with at least 2 new tests, `mul 4 3` prints 12, `median 3 1 2` prints 2 and `median 1 2 3 4` prints 2.5 |
| 5 | `REVIEW.md` at the repository root names line 15 of the patched `calc/stats.py` (`stats.py:15` or "line 15") and at most 3 lines in all (`stats.py:N`, "line N", lists, and every line of a range such as "lines 1-40") |
| 6 | the suite is green with a new test and `pow 2 10` prints 1024; the stalled worker is in `before.json`, and `after.json` holds an agent session that `before.json` does not |
| 7 | origin's `main` is unchanged; a new branch on origin has the `mod` change (suite green, `mod 7 3` prints 1) and `PULL_REQUEST.md` at its tip naming every file it changes |
| 8 | at least 9 of the 10 mails are in `labels/<right label>/` and in no other label |
| 9 | `drafts/` holds a mail to the sender with Subject "Re: <subject>" and a body; `sent/` is empty; the card was seen |
| 10 | `proposal.txt` holds exactly one `YYYY-MM-DD HH:MM`, on 2026-12-07, and the hour from it is free in the fixture |

The answer keys (labels, free hours, the planted line) stay in the fixtures folder and are not copied into a run.

## The figures

After all 30 runs: `python3 -B scripts/measure/scorecard.py bottasks report`. It writes `bot_task_success_pct` (runs
that passed with 0 touches, of 30) and `bot_owner_touches` (the median over the 30 runs) into
`docs/measure/manual-<date>.json` only when every task has its three runs on one fixture version; otherwise it says what
is missing. `scorecard.py page` then scores p35 from them.
