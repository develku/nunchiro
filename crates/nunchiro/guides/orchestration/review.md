# Review prompt

Start a fresh session (not the worker, not yourself) and send it this, filled in:

> Review the diff of branch `<lane-branch>` against `<base>` in `<worktree>` (`git diff <base>...HEAD`). The brief is
> `<worktree>/BRIEF.md`. Check that the change meets every Acceptance item, stays inside Own, and keeps the project's
> rules (`AGENTS.md`, `CLAUDE.md`). Read the code around the diff, not only the diff. Run the brief's checks yourself.
> Report each finding as MUST (blocks the merge: wrong behavior, a failing or missing acceptance check, a file outside
> Own, a security hole), SHOULD, or NIT, with file and line. Do not edit files. End with `VERDICT: pass` or
> `VERDICT: fix`, and record it for the files as they are now: `nunchiro task pass "<one line>"` or
> `nunchiro task changes "<what must change>"`.

At level `strict`, also start a security reviewer with the brief's Threats section:

> Review the same diff for security only. For each threat in the brief, say whether the change defends it and which test
> proves that; then look for any other path where untrusted input, credentials, permissions or files outside the
> project are reached. Report MUST / SHOULD / NIT and end with `VERDICT: pass` or `VERDICT: fix`.

Send MUST findings back to the worker as a fix round (next ROUND number), then review again with a fresh session.
