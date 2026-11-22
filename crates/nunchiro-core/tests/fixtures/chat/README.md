# Synthetic chat transcripts

These are schema-built fixtures, not recordings of a user's sessions. No source was copied
from `~/.claude/projects` or `~/.codex/sessions`. Expected event lists are literal worked
examples, authored independently of the projection implementation.

- `claude-2.1.310`: Claude Code 2.1.310; content and structured-patch shapes follow
  claude-code-viewer `conversation-schema` at `9367cf006be9965c954e6cd36526f2195dce67ea`
  (MIT; notice in `src/chat/mod.rs`). Includes a Task's final tool result and suppressed
  sidechain internals. Sidechains with an explicit parent tool id have a separate unit check.
- `codex-0.161.0`: `codex-cli 0.161.0`; response-item messages, local image, reasoning,
  calls, outputs, apply_patch, sub-agent tool rows, completed/interrupted turn boundaries.
- `codex-0.161.0-command-execution`: the `item_completed` / `CommandExecution` shape this Codex writes for a finished
  command, trimmed and renamed from a local 0.161.0 rollout (field names only, no content copied). Its `item.id` equals
  the `function_call` `call_id` for `exec_command` (243 of 243 local pairs); code-mode `exec` calls carry `exec-<uuid>`
  ids with no call id, so they show nothing. Replay, pair, lone, failed and unmatched cases; run through `Tracker`.
- `codex-0.161.0-exec-end`: the `exec_command_end` shape (field names from the codex protocol as seen in the cmux and
  vibe-kanban reference clones; no local 0.161.0 rollout holds one). Missing, string and unmatched exit codes show nothing.

Both include unknown records with hidden payloads. Malformed and partial JSONL, read-only
input, resumed conversations, large history, and the empty tested-version list are separate
public-boundary tests. These fixtures verify projection for the represented shapes; they do
not establish fidelity for all agent transcript variants or perform image rendering QA.
