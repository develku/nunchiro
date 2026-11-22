# Synthetic sub-agent transcripts (needs 169)

Schema-built, not recordings: the layout was checked on this Mac on 2026-11-01 (Claude Code 2.1.312 writes
`<session-id>/subagents/agent-<agentId>.jsonl` beside `agent-<agentId>.meta.json` with `toolUseId`; Codex writes each child its
own rollout whose `session_meta.payload.source.subagent.thread_spawn` names the parent thread and `agent_path`). Ids are fake;
the expected texts are literal in `tests/subagents.rs`.

- `claude-child.jsonl`, `claude-child.meta.json`: a sidechain (`isSidechain: true`) with its prompt, a tool call and result, and its final answer.
- `codex-parent.jsonl`: a `spawn_agent` call `c1` with an encrypted `message` and its output `{"task_name":"/root/spec"}`.
- `codex-child.jsonl`: the child's rollout; it begins with a replay of the parent's history (`fork_turns: all`).
