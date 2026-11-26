# Brief: <lane> (level: <solo|team|strict>)
## Goal
<one or two sentences: the outcome, as the user would check it>
## Own
<the only files this lane creates or edits, one per line; then "Shared (append-only):" and the files it may only append to>
## Project rules
<the gate command and any rules from the project's AGENTS.md / CLAUDE.md that apply here>
## Acceptance
<the checks you run before reporting, each a command or a named test>
## Threats (strict level only)
<3 to 5 ways this change could be abused or break safety, each with the test that checks it>
## Pair (only when this lane shares an interface with another)
<the other seat's name, and the one thing the two of you agree on directly with `nunchiro agent ask --to <seat>`; who owns the interface>
## Checkpoints
<which of the guide's checkpoints (plan, blocked, round done) this worker sends to its lead, or "none">
## Stop and report
Stop with `STATUS: blocked` when you need a file outside Own, when a check fails for a reason outside this lane, or when
a choice belongs to the user. Do not edit shared status files. Otherwise commit your work on this branch. Either way write
`REPORT.md` in the worktree root from the report template (`nunchiro skill get orchestration --file report-template.md`),
and end your turn.
