# Prompt audit 2026-11-25 (scorecard p31 SK5, p26 MD3)

Ticket 1130, lane C1. Next audit due by 2026-12-09 (SK5 counts an audit for 14 days).

Read in full: AGENTS.md, CLAUDE.md (one line, `@AGENTS.md`), plugin/skills/nunchiro/SKILL.md,
plugin/skills/orchestration/SKILL.md, plugin/skills/artifacts/SKILL.md, crates/nunchiro/guides/orchestration/
(guide.md, brief-template.md, report-template.md, review.md, levels.md), and the seat prompt head that `task staff`
writes (crates/nunchiro-core/src/sessions.rs, "You sit on a task as").
Machine check: `scripts/check-guidance.sh` (commands and flags against docs/cli.md; paths in AGENTS.md and the two
templates), now run by `scripts/check-cli-docs.sh` in the gate.

## Findings

| # | File | Finding | Kind | State |
|---|---|---|---|---|
| 1 | AGENTS.md | "Start several tickets" row routed to the retired build-loop skill and `.agents/build-loop.toml` | stale | closed: routes to nunchiro:orchestration |
| 2 | AGENTS.md | "Close what landed" row named the build-loop record phase | stale | closed: implement only |
| 3 | AGENTS.md | "What is next" row named a `Next:` line and Notes that docs/goal.md does not have | stale | closed: Goal, Judge, Next |
| 4 | AGENTS.md | the user Flow contract path written as a repo path (`setup-me-flow-skills/...`) that does not exist in the repo | stale | closed: named as a file of the kitFlow plugin |
| 5 | AGENTS.md | No line says how to run the Rust tests (MD1, MD3) | missing | closed: "Rust tests: `scripts/cargo-test-gate.sh`" (lane C9 switches it to scripts/test.sh) |
| 6 | guide.md | "there is no herdr import": names a peer app and a feature that does not exist; no agent can act on it | stale | closed: removed |
| 7 | guide.md | "Nunchiro sets no worker or depth limits" contradicted "Seats at once" (`task cap`) in step 6 | contradictory | closed: the limit is named and scoped to core-started Reviewers |
| 8 | docs/goal.md (named by AGENTS.md) | Says it is the goal "build-loop runs under" and that a KF goal outranks it; holds the 11-18 goal, not the 11-25 one | stale | closed: the lead approved the edit (message m2063); it now holds the 11-25 goal, the scorecard judge and the current Next |

Open findings: 0.

## Kept on purpose

- AGENTS.md "Hand off a Lead" row keeps `.scratch/build-loop/handoff.md`: the product reads that path
  (crates/nunchiro-core/src/team.rs, HANDOVER and TAKEOVER, ticket 1096). Moving it is a code change (cleanup ledger:
  "move to Nunchiro place"), not part of this lane.
- The nunchiro skill description has no "not for" clause. That is SK2 (lane C2, item 1.1), not a stale line.

## Not checked

- Seat prompts other than the `task staff` head (lead prompt, Home prompt): not read.
- Skill text was checked for commands, flags and stale routes, not for whether each described behavior matches the
  code.
