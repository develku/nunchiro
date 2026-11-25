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

## How a cell is measured (this round)

- Steps from docs/code: every click, key chord or typed string the user makes, counted from the app's source (Orca, T3
  Code, herdr, Nunchiro) or public docs (Claude Desktop, ChatGPT, Claude Code, Codex). The closed apps (Claude Desktop,
  ChatGPT) are scored from their public docs only.
- "no" when the app cannot do the task; "partial" when it does part of it (the note says which part).
- Timed: Nunchiro only, from the measure scripts on the isolated RC (launch and restart). No GUI drive of any app this
  round: the measuring seat is Code Mode (no computer use) and its process has no Accessibility grant, so
  scripts/app-click was not run (lead, m1192).
- Shots: Nunchiro from the gate-run page picture of the isolated RC (`<NUNCHIRO_HOME>/gate-shot.png`, no grant needed);
  peers from the 2026-11-02 timed run (peer-compare-1102), named with their date and app version.

## Score

For each task: 100 x (fewest steps of any app that does it) / (this app's steps). "partial" counts half of that; "no"
counts 0. An app's task score is the mean over the 12 tasks.
