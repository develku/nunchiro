---
name: orchestration
description: Split a task across Nunchiro worker sessions, each in its own worktree, then review and merge their work. Use when the user asks for parallel lanes, Nunchiro workers, a different agent kind, or isolated worktrees. For a quick lookup or a small edit, prefer your own built-in subagents.
---

# Nunchiro orchestration

This file is a stub. The full guide is served by the app so it always matches the version you run:

    nunchiro skill get orchestration          # guide.md
    nunchiro skill get orchestration --full   # guide plus templates

Read it before starting any worker. It resolves the user's own copy and the project's rules for you.

Rules that hold even if the guide cannot be read:
1. Every worker gets a brief with Goal, Own (the only files it edits), Acceptance (checks it runs) and Stop
   (stop and report when it needs a file outside Own).
2. After starting workers, end your turn. Nunchiro wakes you when one finishes; do not poll in a loop.
3. Workers never edit shared status files; you update them after merging.
4. Before merging, have a fresh session review the diff against the brief (unless the level is solo).
5. After a merge, close the worker and remove its worktree; never remove a worktree with unmerged work.
6. Questions from workers come to you; ask the user only what the user must decide.
