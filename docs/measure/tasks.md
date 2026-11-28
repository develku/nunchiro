# Peer task list (ticket 1098, part 2)

Fixed list: the same tasks on every app, so a later run compares like with like. Approved by the lead on 2026-11-24
(message m1192), with T11 and T12 added from the owner's reports of that day.

## Tasks

| ID | Task | Done when |
|---|---|---|
| T1 | First launch to the first agent prompt sent (first use) | the agent has the first prompt, starting from a fresh install with an agent CLI already signed in |
| T2 | Start a new agent session in a chosen project folder | an agent runs in that folder |
| T3 | Answer one permission request from the agent | the agent continues after "allow once" |
| T4 | Switch the model of a running session | the next turn uses the new model |
| T5 | Find a past conversation by a word in it | that conversation is open |
| T6 | Run two agent tasks at once, each in its own worktree | two agents run, each in a new worktree |
| T7 | See the diff of what the agent changed | the changed lines are on screen |
| T8 | Open a shell beside the agent session | a shell prompt in the same folder is on screen next to the agent |
| T9 | Quit and reopen the app: the session is back and continues | the old session takes a new prompt |
| T10 | Add an integration (an MCP server or a skill) | the agent can use it in its next session |
| T11 | Answer an agent's multiple-choice question with the keyboard only | the agent has the chosen answer, no mouse used |
| T12 | Start a fresh conversation for the same standing agent while the old one is stuck | the new conversation answers; the role, folder and settings are the same |

## Apps

- Same kind: Nunchiro, Orca, T3 Code, herdr (Herdr.app and the herdr TUI).
- Chat polish and first use: Claude Desktop, ChatGPT desktop.
- Agent baseline: Claude Code CLI, Codex CLI.

## How a cell is measured (rubric v2, ticket 1171)

A cell is one task driven in the running app on this Mac. A cell counted from docs or code is not a measurement.

- One path rule for every app: the default GUI path a new user finds. Only controls that are on screen at that moment
  count: buttons, menus, fields, and a key the screen itself shows at that point. No CLI, no pasted command, no
  shortcut the screen does not show, no setting changed beforehand. For the CLIs (Claude Code, Codex) and the herdr
  TUI the default path is what their first screen and its on-screen hints offer.
- Seconds are compared between apps, so every app of a run is driven the same way: by the owner's hand with a screen
  recording, or by computer use for all of them. The typed text is the same in every app. The apps are driven in one
  session and take turns task by task, so they share the Mac's load and the agent service's speed of that hour; a
  drive does not start while the 1-minute load is 15 or more (the start bar of scripts/measure/measurelib.py).
- Recorded per drive: steps (every click, key chord or typed field) and seconds from the first input to the "done
  when" state on screen, read from the recording. Three drives, the median of each.
- Seconds of a computer-use drive. A driver's own pace is not the app's: the same four steps took 7 s from one
  driver and 27 s from another. So the user's part of every step is a fixed time and only the app's part is measured:
  seconds = over the steps, the step's user time plus the app's wait after it.
  - User time, from the Keystroke-Level Model (Card, Moran and Newell 1980: M 1.35 s to prepare, P 1.1 s to point,
    K 0.28 s per key or button press): a click M + P + K = 2.73 s; a key or chord M + K per key; a typed field M + K
    per character.
  - The wait, from a recording of the app's window that has the time in each picture's name
    (`python3 -B scripts/measure/drive.py record`): from the time stamped right before the step's input to the first
    picture that shows the screen ready for the next step, or the task's "done when" state after the last step. It
    counts in full and is never negative. It holds the tool's own time to deliver the input, the same for every app.
  - `drive.py seconds` adds a drive up. What the driver does between two steps (looking, thinking) is in no figure.
  A hand drive keeps the seconds of its recording; a run never mixes the two.
- T1 starts at the place the app's public page sends a new user: its download button, or the README's build steps
  when there is no download. It runs on a macOS user account that never ran the app, with an agent CLI already
  signed in. Download, unpacking, the Gatekeeper dialog and onboarding all count.
- "no" when the app cannot do the task on that path; "partial" when it does part of it (the note says which part).
- In tasks.json a driven cell carries `driven` (the date), `steps`, `seconds`, `path` and its shots or recording.
  `run` at the top of the file is the date of the run whose Nunchiro cells count.
- Nunchiro runs as an isolated RC. scripts/app-click is for rehearsing its path, not for the timed drive (it is not
  how the peers are driven). Computer use needs the owner to answer its access dialog, so the drives are an owner-run
  step. Never sign in to a peer for a drive and never press anything in it that sends data outward.

## Score

For each task: the lower of 100 x (fewest steps of any driven app) / (this app's steps) and 100 x (fastest seconds
of any driven app) / (this app's seconds). "partial" counts half of that; "no" counts 0. A short path with long
waits does not win.

- A Nunchiro cell that was not driven in this run scores 0 (not measured).
- A peer cell's steps stay valid while that peer's version is the one recorded; its seconds count only beside
  Nunchiro seconds of the same session (a wait depends on the load and on the agent's answer time of that hour), so
  the peers are driven again in every run. A peer cell that was never driven is left out of that peer's mean and
  cannot be the best.
- A task counts only when at least two peers were driven on it; otherwise Nunchiro's score for it is 0.

An app's part score is the mean over the part's tasks.

## v1 (kept for history)

Until 2026-11-26 the cells were steps counted from source and docs, Nunchiro on its best path. The step counts still
in tasks.json are those readings; they are notes for the first drive, not scores.
