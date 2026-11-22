# Recorded result fixtures

Claude: `204c9f69-9f78-4fc1-a59e-1351a1fb1e67.jsonl`, Write result line 1667, Bash result line 1896. Captured from the local Claude CLI transcript. Write IDs, file path and report content are redacted; `structuredPatch: []` and all result fields retain their recorded shape. Bash output is copied verbatim, without a completion wrapper. Tests supply a direct recognized runner invocation to isolate this result shape; the recorded command used cd, redirection and tail.

Codex: `rollout-2026-10-21T00-09-30-01a159a5-5434-70f0-a5bf-01ba8c9f2b33.jsonl`, response line 187. The recorded exec_command reads test logs and exits 0; its output includes `2 passed`. Both response records are copied unchanged. This is deliberately a negative fixture: completion of a log read is not completion of tests. The completion header is real Codex output, not a wrapper fabricated for Claude.

The current core adapter projects function_call_output but drops exec_command_end. Coordinator round 5 authorizes this lane to remain web-only and document a core follow-up. No event-end exit_code is invented or added to the web protocol. Existing focused boundary cases separately vary exit/error/pending evidence.
