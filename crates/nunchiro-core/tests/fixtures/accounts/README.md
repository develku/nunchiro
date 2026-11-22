V2-2a signed-in probe outputs, recorded 2026-10-27 on the Mac mini (email and org id replaced by placeholders).

| File | Command | Version | Exit |
|---|---|---|---|
| claude-2.1.311-signed-out.stdout | `env -i PATH=… CLAUDE_CONFIG_DIR=<empty folder> claude auth status --json` | Claude Code 2.1.311 | 1 |
| claude-2.1.311-signed-in.stdout | `env -i PATH=… HOME=$HOME claude auth status --json` (the user's own config) | Claude Code 2.1.311 | 0 |
| codex-0.161.0-signed-out.stderr | `env -i PATH=… CODEX_HOME=<empty folder> codex login status` (stdout empty) | codex-cli 0.161.0 | 1 |
| codex-0.161.0-signed-in.stderr | `env -i PATH=… HOME=$HOME codex login status` (stdout empty) | codex-cli 0.161.0 | 0 |

Ticket 178 finding 20 browser sign-in fakes (no real agent, no real login; `tests/account_signin.rs`,
`web/tests/accounts-signin.spec.ts`):

| File | Stands in for | Shape |
|---|---|---|
| signin-fake-claude.sh | `claude auth login --claudeai`, `claude auth status --json` | calls `$BROWSER` with a local sign-in link (Orca `claude-sign-in-browser.ts`), reads one code on stdin, accepts only the code whose SHA-256 it holds; `$NUNCHIRO_HOME/mode` picks exit3, nolink, badlink, filelink, hang, signed-hang, signed-slow (status answers after 4 s), unknown-hang, child-exit |
| signin-fake-codex.sh | `codex login`, `codex login status` | prints Orca's marker and an auth.openai.com link split across two writes, then waits for `$NUNCHIRO_HOME/codex-callback` |
