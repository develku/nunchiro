# p35 bot task set: the runner's steps

The ten tasks of [rubric.md](rubric.md) "p35 Bot quality", three runs each, 30 runs in all. The fixtures are fake data
under `scripts/measure/fixtures/p35` (a small `calc` repository, ten mails, a calendar); `scripts/measure/bottasks.py`
makes a fresh copy per run and checks each task's acceptance.

## Before the first run

- Use an isolated RC: its own `HOME` and `NUNCHIRO_HOME`, never the owner's app or home.
- No mail or calendar account or connector is signed in on that RC. The mail tasks work on files only. On an Outbox
  card, press Discard, never Send.
- `python3` and `git` on the PATH.

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
  Stop the worker right after it; the check reads the time `before.json` was saved, so do not copy or edit the file.
- Stop that worker: `nunchiro agent get <worker id> --json` gives its `pid`; check with `ps -o command= -p <pid>` that
  it is the worker's agent, then `kill -STOP <pid>`. This is the test, not an owner touch. Never stop any other process.
- When the task has ended: `nunchiro events --history 2 > events.ndjson` (the core's journal of every session start
  and state; it still holds a worker the lead closed, which `agent list` may not), then `kill -CONT <pid>`, and
  check with `--stalled <worker id> --agents-before before.json --events events.ndjson`.

Task 9: when the approval card for the reply shows in the window, add `--card-shown` to the check, then press Discard.

## What each check reads

| Task | Passes when |
|---|---|
| 1 | the suite is green with all 9 fixture tests, and no test file was changed |
| 2 | the suite is green with at least one new test that names precision; `--help` shows `--precision`; `--precision 2` prints 10 / 3 as 3.33 |
| 3 | the suite is green; `parse_number` is in no file; `calc/numbers.py` defines `to_number` and the other four files use it |
| 4 | on `main` (the branch, not the working copy): the suite is green with at least 2 new tests, `mul 4 3` prints 12, `median 3 1 2` prints 2 and `median 1 2 3 4` prints 2.5 |
| 5 | `REVIEW.md` at the repository root names line 15 of the patched `calc/stats.py` (`stats.py:15` or "line 15") and at most 3 lines in all (`stats.py:N`, "line N", lists, and every line of a range such as "lines 1-40") |
| 6 | the suite is green with a new test and `pow 2 10` prints 1024; the stalled worker is in `before.json`, and the journal shows a session of this run's repository that `before.json` does not hold, started after `before.json` was saved, that went to work (a shell or a seat nobody prompted does not count) |
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

## Changes

- Task 6 reads the core's event journal, where it read `agent list` saved at the end. Reason: the acceptance is that
  a fresh conversation was started, and a list taken at the end cannot show a fresh worker the lead closed in between
  (a closed row can leave the list), so a run that met the acceptance failed. Not easier: the fresh session must be
  of this run's repository, start after the stall and go to work, none of which the list asked; a shell, a seat
  nobody prompted and a worker from before the stall do not count. A task 6 run checked the old way is checked again
  with `--events`.
