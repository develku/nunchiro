# Synthetic artifact transcripts (ticket v1b-06)

Schema-built, not recordings. `claude.jsonl` follows the Claude Code 2.1.310 shapes of `../chat/claude-2.1.310`
(`Write`/`Edit` calls, `toolUseResult`); `codex.jsonl` follows codex-cli 0.161.0 `apply_patch` as a custom tool and
as a function call with a JSON exit-code envelope. `/project` stands for the session folder; tests substitute it.
Covered: each artifact type, an `.rs` file, a failed write, a deletion, a move, paths outside the folder, and
`nunchiro-artifact` fenced blocks (repeated, unknown type). They do not establish fidelity for every agent variant.
