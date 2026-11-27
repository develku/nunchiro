# Nunchiro CLI reference

`nunchiro` talks to the local Nunchiro core over a unix socket in `NUNCHIRO_HOME` (default `~/.nunchiro`; a debug build: `nunchiro-home` beside its binary;
must be absolute). The first command starts the core if it is not running. Replies are one line of JSON unless noted;
errors go to stderr with exit code 1.

Inside a Nunchiro session the environment carries `NUNCHIRO_HOME`, `NUNCHIRO_SESSION` and `NUNCHIRO_TOKEN`, which
names the calling session (send logs show it as the sender). As in tmux and herdr, every command works from inside a
session too, agent or plain shell: sessions in any project (`session close` only on itself and the sessions it started), `serve stop`, `serve restart`, `layout`, worktrees. Exactly
two actions stay the owner's: approving a widget or integration source (`widget allow`) and turning on the verified-yes
option (`permission-answers on`). From inside a session these do nothing but put one waiting item in the Nunchiro
window for the owner's click, and print `waiting for the owner in the Nunchiro window` (exit 0). Removing
`NUNCHIRO_TOKEN` changes nothing: the core checks the calling process, not the environment. Answering dialogs and
permission prompts also stays the user's (see `agent send-keys`). Outside every session the commands act as the owner.

`scripts/check-cli-docs.sh` fails when a command in `nunchiro --help` has no `###` entry here, or an entry has no
command. An entry marked a pending marker documents a command that `--help` does not list yet.

## Sessions

### `nunchiro serve [stop [--yes]]`
Runs the core in the foreground (`serve`), or stops it (`serve stop`, the full quit). Stopping ends every agent and every
session holder in this data folder, found by socket scan, not only those the core knows.
From a terminal, `serve stop` asks once and lists what it ends; scripts (no tty) and `--yes` skip the question.
The `exit` request (the core leaves its agents running, as `serve restart` does) is the owner's only: a session's is
refused with `operation not granted` (V2-1b): the `exit` request is refused to sessions. A core started inside a
Nunchiro session (a holder's descendant, e.g. by a CLI call there when no core runs) cannot reattach holders until that
CLI has exited; the next reattach retry then attaches them.
Ticket 575: at start, once it holds the core lock and before any other work, the core runs the user's `$SHELL` once as a
login interactive shell (`-ilc`, no controlling terminal, 3 s limit) and reads its `PATH`. The core keeps its own `PATH` first, in its order, and appends the login entries it lacks (so a terminal or test start keeps its own tool priority, and a Finder start still gains the user's folders). Relative login entries (`.`, `bin`, empty) are dropped: they would resolve in a project folder. First-run
detection, Settings > Accounts, version probes and every agent the core starts then use it. An app opened from Finder
gets only `/usr/bin:/bin:/usr/sbin:/sbin`, so without this step `claude` and `codex` in `~/.local/bin` or
`/opt/homebrew/bin` showed as "Not installed" until `nunchiro serve restart` ran from a shell. When the shell fails, prints
no `PATH` or takes over 3 s (the shell and its children are then killed), the core keeps its own `PATH` and adds `~/.local/bin`, `/opt/homebrew/bin`,
`/opt/homebrew/sbin` and `/usr/local/bin`. `core.log` gets one `login PATH (...)` line with the result (the `PATH` only).
`NUNCHIRO_LOGIN_PATH=off` in the core's environment skips the step. A shell rc file can test `NUNCHIRO_LOGIN_PATH_PROBE`
to take a fast path. Agents already running keep the `PATH` they started with.
Agents survive a core that exits any other way (a crash, `kill`, `serve restart`): each runs in its own holder process
(`nunchiro hold`), and the next core reattaches it with its scrollback, label, grants and session token.

### `nunchiro serve update`
Run by the app at each page load (F24). Prints `current`, `replaced` (a core older than this RC-stamped binary was
swapped through the `exit` path) or `kept` (the old core stays because the swap would lose work). A binary replaces
only an earlier build of itself: the core's recorded executable must be this same file, so an RC CLI run by hand never
touches the owner's core. An earlier build has a lower build stamp, or (ticket 1082) another git commit than this
binary (`core.start.json` `commit`); two stamps that make this binary the lower one are a downgrade and replace nothing. An RC-stamped binary also
refuses `serve update` and `serve restart` when its home is the owner's `.nunchiro`. Run them from a Nunchiro terminal,
where a session gets the core's own home.

A swap is blocked by a running ACP chat, a non-empty send queue, a holder below this binary's protocol floor, a running
account sign-in or a sandbox run. The core decides that under its registry lock (`exit_if_idle`, owner only). A core
from before that request is judged from what it left on disk (`sessions.json`, `.signin-logins`, `.sandbox-runs`), with
a moment between the read and the exit.

What a swap leaves running: every terminal and agent in a holder, its scrollback and its pending decisions. `serve
restart` and the plain `exit` request have no blockers: they end ACP chats, sign-ins and sandbox runs, and cancel queued
sends. Both wait up to 40 s for the old core to wind down (a blocked hook or a worktree removal can hold it that long).

### `nunchiro serve status [--json]`
Prints `{"core": <bool>, "holders": [{"socket", "session", "orphaned"}], "record": {"days", "restarts"},
"low_memory_kills_7d": <n>}`: whether a core runs, and every live session holder in this data folder with the session
that records it. A holder is `orphaned` when no core runs or no session record names it (an unknown holder, which a core
never adopts). `low_memory_kills_7d` counts the low-memory kills macOS reported in the last 7 days (its JetsamEvent
reports; `null` when they cannot be listed). Never starts a core.

`record` is the delivery record of the last 30 days (`record.json` in the data folder, counts only, never message
text): `days` maps each local date to `delivered` (queued prompts that reached the agent with their Enter: `agent prompt`,
other senders' lines, and composer sends the core queued; keys, text without Enter, card answers and model switches are
no prompt, and the window's own composer writes that go straight to the terminal have no queue row and are not
counted), `resent` (of those, prompts the core sent again by itself after a dropped Enter) and `person` (prompts that
needed a person, once each: his own Enter in the terminal sent one, he canceled one after a dropped Enter, or the core
gave one up); `restarts` lists each core start that found agents the last core ran, with `at_ms`, `before` (those
agents) and `after` (those that came back), and `lost` names the agents a restart counted lost (by process id and start
time) so a later start does not count them again. A missing record reads as empty; an unreadable one is moved to
`record.broken-<time>.json` (at most 5 kept) and a new one starts; the record never stops a delivery or a start.

On a terminal, without `--json`, the same is printed as text: a line per day and a line per restart. Piped, it prints
the JSON as before.

### `nunchiro serve restart`
Asks the core to exit without ending any agent, waits for its lock, starts a new one, which reattaches every live
session (the same agent pids and session ids; the agents' `nunchiro` calls keep working). From inside a session it
prints `restarting the core; agents keep running` and a helper that has left the session (a session of its own) finishes
the restart as the owner (with `core.token`). That
new core starts from the old core's own executable and the environment it was started with (recorded at each core
start in `$NUNCHIRO_HOME/core.start.json`, owner-only), not from the asking session's environment, so a variable set in
that shell (a venv, a proxy, `CLAUDE_CONFIG_DIR`) does not reach the new core or later sessions. If the recorded
executable is gone (an upgrade moved or rebuilt it), the asking binary is used with the recorded environment. If the
record itself is missing or unreadable, the asking binary and environment are used. If core.start.json is gone and an
agent on an account restarts the core, 'Your own' sessions start without the owner's API keys (`ANTHROPIC_API_KEY` etc.)
until the core is started again from a terminal or the window. `DYLD_*` variables never reach a core.

### `nunchiro update status`
Ticket 1082: the installed `Nunchiro.app` updates itself from an update folder, keeping every session. The owner sets the
folder in Settings > About; the app writes it to `$NUNCHIRO_HOME/update-source` (one line; no file or an empty one is off).
The folder holds a built `Nunchiro.app` and `nunchiro-build.json` beside it:
`{"commit": "<git sha>", "built": "<RFC 3339 time>", "sha256": {"nunchiro": "<hex>", "nunchiro-app": "<hex>"}}`, where
`sha256` names every file in `Nunchiro.app/Contents/MacOS`. Prints
`{"state": "off" | "none" | "ready" | "refused", "source", "commit", "built", "reason"}`: `ready` is a stamp of another
commit than this build whose hashes match the bundle. Refused, with the reason: a folder or bundle that is a symlink, not
owned by you, or writable by group or others; a bundle id other than `dev.nunchiro.app`; a hash that does not match; a
build that is not an installed `Nunchiro.app` (the isolated test build keeps its own home and never updates). Changes
nothing. Like `update install`, it refuses to run with a session token (`NUNCHIRO_TOKEN`): it is for the owner.

### `nunchiro update install [--archive <file>]`
Copies the ready bundle beside the installed one (`.nunchiro-update/new`), checks the copy again (hashes, bundle id,
`codesign -v`), moves the installed bundle to `.nunchiro-update/backup` and the copy into its place, then runs the new
bundle's `serve update`: the core is replaced and every session stays in its holder. It then checks that the running core
is the new commit and that every session that ran before still runs. When any step fails, the backup goes back, the
previous build's core takes over again, and the reason is printed. A core kept because the swap would lose work (see
`serve update`) is such a failure. Prints `replaced` or `current`. The app's Install and restart is this command, then a
relaunch; run by hand, the window keeps the old app until it is reopened. Ticket 1107: `--archive <file>` (an absolute
path) takes the build from the official release's signed feed instead of the folder: the app has verified the archive's
signature and version and passes it here. It must hold only `Nunchiro.app` and `nunchiro-build.json`; it is unpacked
into `.nunchiro-update/feed` (removed afterwards) and then checked and installed exactly as a folder build.

### `nunchiro session start --kind claude|codex|shell --project <dir> [--worktree] [--label <text>] [--model <m>] [--effort <level>] [--resume <id>] [--account <label>] [--env <KEY=VALUE>]... [-- <args>...]`
### `nunchiro session start --agent acp:<name> --project <dir> [--worktree] [--label <text>] [--resume <id>]`
Starts a session in `<dir>` (default: the current directory) and prints it. `--worktree` runs it in a new git worktree.
`--account` runs a Claude or Codex session on the account with that name (see `account list`; default: the account
checked in the status bar, else "Your own"; `--account ""` names "Your own"),
fixed for the session's life; an unknown name is refused with `unknown account "<label>" for <agent>; see nunchiro
account list` and no session starts. A resumed conversation keeps the account it ran on. Run from inside a session, the new session takes its place's account, else your default account (the status bar's pick, ticket 1126), else the caller's; `--account` may name the caller's own, the place's or your default (a team lead any registered account when `account leads-any` is on); the owner picks any.
Everything after `--` goes to the agent unchanged. For `shell`, the first word after `--` is the program.
`--env KEY=VALUE` (repeatable, split at the first `=`) sets a variable in the new agent's environment for this start
only; a restart or switch does not carry it, and it is never stored. The CLI refuses a name given twice. The core
refuses the whole start when a name is not letters, digits and `_` (not starting with a digit), is not on the allow
list, or would carry a secret (ticket 595; any case):
- allowed: names starting with `TASK_` or `LANE_` (task context a lead hands a worker) or `CLAUDE_CODE_EXPERIMENTAL_`
  (Claude Code's feature flags), and `RUST_LOG`,
  `RUST_BACKTRACE`, `NO_COLOR`, `FORCE_COLOR`, `CI`, `TZ`, `LANG`, `LC_ALL`;
- refused as a secret, even with an allowed prefix: any name containing `TOKEN`, `SECRET`, `KEY`, `PASSWORD`,
  `CREDENTIAL` or `AUTH`, plus the start-secret names such as `PGPASSWORD` and `DATABASE_URL`.

Any other name is refused with `--env <name>: not on the allow list (...); pass task context as a TASK_ name, or ask
the owner to add the name (docs/cli.md)`. So the agents' own variables, loaders, proxies, `PATH`, `HOME` and
`NUNCHIRO_*` cannot be set this way. To add a name, the owner files a ticket; the list is `check_start_env` in
`crates/nunchiro-core/src/sessions.rs`.

At most 64 values, each at most 4096 bytes. Pass secrets through the agent's own login instead. An ACP agent
(`--agent acp:<name>`) does not take `--env` yet: the start is refused; its environment is the `env` list in
`agents.toml`.
Claude sessions also get the Nunchiro skill through `--plugin-dir` (see "Skill" below).
`--agent acp:<name>` starts the ACP agent `<name>` of `$NUNCHIRO_HOME/agents.toml` (`[[agent]]` tables of `name`,
`command` (an absolute path), `args` and `env`, the names of the variables it may see; never values). It starts only
once a person approved that entry as it is now (any edit asks again; a session or the agent CLI cannot approve), sees
only the env names listed, and runs with no PTY as a child of the core: it ends with the core and comes back stopped,
resumable with `--resume <id>` only when the agent declared `loadSession`. Its requests to you (permissions,
elicitations) wait in the queue as allow once or reject once; Esc (`send-keys esc`) cancels its turn. Its file
requests stay in the project and never reach `~/.claude`, `~/.codex` or `$NUNCHIRO_HOME`; your home folder itself cannot be
its project. A Claude ACP entry
is refused unless its env names include `ANTHROPIC_API_KEY` or a cloud credential set; no `--model`, `--effort`,
`--account` or `-- <args>`.

### `nunchiro session open --project <dir> -- <command>`
Starts a `shell` session running `<command>`. Same reply as `session start`.

### `nunchiro session list`
All sessions with `id`, `kind`, `label`, `state`, `completion_seq`, `pending` items and the send log, plus `parent` for a
session another session started.

### `nunchiro session read <id> [--after <cursor>]`
Terminal output as a JSON byte replay from `<cursor>` (default 0). Use `agent read` for text.
After a core restart a stopped session returns the output saved when it stopped (at most 1 MiB, `truncated` when older
output was dropped); a session closed or never stopped cleanly has none. That saved file
(`$NUNCHIRO_HOME/scrollback/<id>`, owner-only 0600) is raw terminal output, unredacted, including anything a Shell
session printed (a `cat .env`); it is kept until the session is closed.

### `nunchiro session send-text <id> <text>`
Writes `<text>` to the session's terminal exactly as given. No Enter is added. Slash commands follow the rule under
`agent prompt`. While a new agent session is still starting (its input box not drawn yet, when Claude drops typed
keys) the command waits until it is ready, as the window's composer holds a first message (ticket 1025). A start
question on its screen (folder trust, imports) is answered with `send-keys`, not with text: `send-text` holds the text
until the question is answered and the input box is ready, then sends it. If the question is still up after 150 s, it
fails with "not sent: ... start question", and types nothing. A question after the session is ready (a permission
prompt) takes the text at once.

### `nunchiro session send-keys <id> <key>...`
Sends keys such as `enter`, `esc`, `down`, `up`, or a choice's number `0` to `9` (`send-keys <id> 1 enter`).
The owner CLI sends no `seen` ids (`session send-keys` has no `--seen`), so it cannot use the Esc gate to dismiss a dialog; the owner answers the dialog by hand (ticket 123, Owner CLI behaviour).

### `nunchiro session close <id>`
Ends the session. Takes the session id (agent commands also accept a label). From inside a session it closes only
that session and the sessions it started; any other session is refused with `a session closes only itself and the
sessions it started` and stays open (ticket 286 r6). Outside every session it closes any session.

### `nunchiro session label <id> <label>`
Renames the session. Labels show in the session list and the queue; agent commands accept a label wherever an id is expected.

### `nunchiro session resize <id> <cols> <rows>`
Resizes the terminal.

### `nunchiro snapshot --json`
Every session with its state, `completion_seq` and pending items.

### `nunchiro diagnose`
Writes a local bundle to `$NUNCHIRO_HOME/diagnose/<UTC timestamp>/` (folder 0700, files 0600) and prints its path.
Nothing is uploaded; it reads files only and works with the core stopped. The bundle holds `versions.json` (Nunchiro,
Claude, Codex, OS), `settings.json` (known keys only; unknown keys and token-like values are dropped, named in
`dropped`), `core.log.tail` (the last 200 lines or 64 KiB of `logs/core.log`, redacted again), `snapshot.json`
(id, kind, state, project, cwd, label and pending count per session; no transcript, scrollback or tokens) and
`status.json` (state files, including a set-aside one, and whether each holder process is alive). Redaction matches
known secret shapes and registered tokens, so read the bundle before sharing it.

## Accounts

### `nunchiro account list [--json]`
Each agent's accounts (V2-2a), "Your own" first: agent, id, label, config folder and signed-in state (`yes`, `no` or
`unknown`), tab-separated under a header line, or `{"accounts":[...]}` with `--json` (each row also carries `default`,
true for "Your own"). "Your own" is the agent's own config (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` of the core, else
`~/.claude` / `~/.codex`) with id `own`; an added account's folder is `$NUNCHIRO_HOME/accounts/<agent>/<id>/` (0700).
The signed-in state comes from the agent's own status command (`claude auth status --json`, `codex login status`) run
with only PATH and that folder (5 s; a run that timed out, did not start or ended on a signal before printing anything is
run once more, then `unknown`; at most 8 at once in the core); Nunchiro never opens the agent's credential files or the Keychain. "Your own" is never probed by a
list, because the status command writes into the owner's live config: the window checks it when Settings > Providers or
Onboarding opens, unless it was checked in the last minute, and when the owner presses Check (the `account_check`
request, with PATH, HOME and the core's own variable: at most one probe a minute per agent, except the owner's Check,
`force`; a check that arrives while one runs gets that one's answer). Until its first check it shows `unknown`.
The registry is `$NUNCHIRO_HOME/accounts.toml` (0600, `version = 1`); a file of another version is kept aside as
`accounts.toml.v<N>.<time>.aside`, a malformed one or a symlink is refused and left as it is. Accounts are added in the
window (Settings > Accounts), which opens a visible terminal tab running the agent's own login with the account's
folder; the list and add requests are the owner's and the window's only (a session's are refused with
`operation not granted`).

### `nunchiro account codex-reset [--reason TEXT] [--account ID] [--yes]`
Codex reset tickets (needs 225), only while Settings > Accounts > "Show Codex resets" is on (off by default).
Run inside a session (with its `NUNCHIRO_TOKEN`), it is the agent's ask to use one ticket of its own session's Codex
account ("Your own" for a non-Codex session; `--account` is refused), and the owner's "When an agent wants to use a
Codex reset" setting decides: Off refuses it, Ask every time (the default) files a card in the Decisions widget and
prints `waiting for the owner in the Nunchiro window`, Allow ahead uses one at once when its conditions hold (only when
the weekly limit is used up, at most N a week, keep the last one; a ticket expiring within 3 days without asking) and
otherwise asks as Ask every time does. `--reason` is shown on the card and in the log (control characters dropped, 200
characters). Run outside a session it is the owner's own use of `--account` (an id from `account list`, default `own`)
and needs `--yes`. A use starts the user's own `codex -c approval_policy=never -c features.plugins=false -s read-only
-a never app-server` once with that account's `CODEX_HOME`, sends one `account/rateLimitResetCredit/consume` with a
fresh idempotency key and prints `codex reset: <outcome>` (`reset`, `nothing_to_reset`, `no_credit`,
`already_redeemed`). Every ask, refusal and use is kept in `$NUNCHIRO_HOME/codex-resets.json` (0600; who, when, why,
the rule and the outcome; never a count, an expiry or anything codex printed), shown on the Usage page. Never across
`--machine`, never from a widget or a browser.

### `nunchiro account leads-any on|off`

"Leads may use any of my accounts" (owner 2026-11-25; off by default). On, a team lead's own seat may start sessions on any
registered account and continue itself on one; each such start or move writes one line to the lead's room. Workers,
reviewers, remote (`--machine`) callers and ACP sessions stay on their own account, their place's account or your
default. Run outside a session it is your own switch; run from inside a session, `on` puts a card in the Decisions
widget and waits for your yes, and `off` is refused.

## Agents

An `<agent>` is a session id or label. A label that matches two sessions is refused as ambiguous; use the id.
The status values are `working`, `idle`, `done` (a turn finished since start), `blocked` (an open dialog or question),
`failed` and `exited`. As in the tree and `session list`, an agent that failed (it ended with a why-it-ended card, such
as Claude's exit code 3) is `failed`, and one that quit is `exited`, also while the shell it left still runs. `completion_seq` increases by one per finished turn.

Exit codes (ticket 573, T3's pattern): `0` done, `1` failed (the error is on stderr), `2` the agent needs an answer: it
waits on a question, a permission prompt or a dialog. On `2` the agent's record (as `agent get` prints it) is on stdout,
with what it asks in `pending`, and stderr says `agent_blocked: ...`. Per verb:

| Verb | 0 | 1 | 2 |
|---|---|---|---|
| `start` | started (or the receipt's session) | refused or failed | never |
| `prompt`, `send` | delivered or queued (`--wait`: the state reached) | refused, stalled, timeout | the agent is blocked (`--until blocked` makes that a 0); a prompt kept behind a question in the agent's terminal |
| `wait` | a listed state reached | timeout, the agent ended, not found | the agent is blocked and `blocked` is not listed |
| `send-keys` | keys sent | refused | keys refused while a dialog is open (`agent_blocked: ...`) |
| `get`, `list`, `read`, `cancel` | read or done | not found, refused | never |

`nunchiro agent` alone, or any agent verb with `--help` among its options (before `--`), prints every agent and room
verb's usage and exits 0; it starts nothing and sends nothing.

### `nunchiro agent start <name> --kind claude|codex --project <dir> [--worktree] [--model <m>] [--effort <level>] [--env <KEY=VALUE>]... [--receipt <id>] [--anyway] [-- <args>...]`
While macOS reports memory pressure (warning or critical), a new agent session is not started and the command says so
in one sentence that names memory (one reading at the start; running sessions, resumed conversations, model switches
and sessions a core brings back are never held; a reading that fails allows the start). `--anyway` starts it all the
same; only the owner can, never a session, also with `--machine` (the other Mac reads its own pressure). The owner's
starts from the window (a new tab, Settings > Team Open, a goal, a bot hand-over, a new conversation, a handoff to
another agent, a widget action, a schedule's Run now) are held at critical pressure only. Starts nobody watches hold
from warning: a due schedule (its run reads "held", not failed, with the reason), the auto-started Reviewer (planned
again on a later pass), a lead's `team open`, and a session's start from another Mac. Each hold writes one line to the
core's log.
Starts a session labeled `<name>`; a name that starts with `-` is refused with a usage error (`agent start --help` prints the usage and starts nothing). (`--agent acp:<name>` in place of `--kind` starts an ACP agent). Same options and reply as `session start`, in any project, from inside a session
too. The reply carries a `receipt` (24 hex characters, made up when `--receipt` is not given). A receipt is 1-128
printable ASCII characters without spaces; any other value (an empty one too) is refused with `start_receipt_invalid`.
A caller that may retry should pass its own `--receipt`: a first call that times out never shows the made-up one. A start retried with
`--receipt <id>` returns the session the first start with that id made, instead of starting a second one (Orca's
pattern), also when both run at once: the second waits up to 60 s for the first. A receipt is the caller's own (the
owner's, or the starting session's); the core keeps the last 1024 in memory, so after a core restart the same receipt
starts again. When the first start failed, a retry starts again. `session start` takes `--receipt` too. Inside a session `--model` and `--effort` take only what the window offers. The new agent may show a startup dialog
(folder trust, hook review); read it with `agent read` and answer it with `agent send-keys`.

### `nunchiro agent prompt <agent> <text> [--wait] [--until done|idle|blocked]... [--timeout <ms>]`
Sends `<text>` and presses Enter. Without `--wait` it returns the delivery. With `--wait` it returns the agent's
state once any `--until` state is reached (default `done`; `idle` also matches `done`; default timeout 300000 ms).
While a dialog is open (a start question such as folder trust) the owner's prompt is kept, never typed into it: it
waits in the queue and goes in once the dialog is answered in the agent's terminal. The command ends with 2 and stderr
says which session waits at what (its choices), on which machine with `--machine`, and the `agent cancel` command
that drops the prompt; the window shows the dialog as a card on that session. From a session token the prompt is
refused with `agent_blocked`. For a Claude agent a session token may submit only `/clear` and
`/compact` as slash commands; any other text starting with `/` is refused (the user is not limited). Fails with `agent_prompt_stalled` when the agent shows no activity
within 5 seconds of delivery, and with `agent_wait_timeout` at the timeout. If the agent is busy the send waits in its
visible "send when ready" queue and is delivered once when it is ready; `agent cancel` removes it.

### `nunchiro agent send <agent> <text> [--wait] [--until ...] [--timeout <ms>]`
Like `prompt` but returns after delivery (or queueing) with the agent's state, without waiting for the turn to finish.

### `nunchiro agent wait <agent> --until working|done|idle|blocked|failed|exited [--timeout <ms>]`
Blocks until the agent reaches any listed state; prints the agent as `agent get` does. `agent_wait_timeout` on timeout.
When the agent is blocked (a question, permission prompt or dialog) and `blocked` is not listed, it ends at once with
exit 2 and the agent's record.
Fails at once with `agent_ended: <id> is <State>, not running` when the agent no longer runs (it ended, or a next core
found it Resumable) and no listed state matches. An agent that failed or quit and left its shell running ends a wait
the same way (`agent_ended: <id> is failed, not running`, or `is exited`, exit 1), so `--until done` or `--until idle`
never reads it as finished; list `failed` or `exited` to get its record with exit 0. `prompt --wait` ends the same way.

A session that started an agent (`agent start` from inside a session) needs no wait loop: when that worker reaches
done, blocked (a question or a permission prompt), failed or exited, the core sends its parent one line through the
same "send when ready" queue, `worker <label> <state>; report says: "<STATUS line>"` (the session id when the label is
empty), where the STATUS part is the first line of
`REPORT.md` in the worker's folder when it starts with `STATUS:` (one line, control bytes removed, at most 200
characters; a symlinked REPORT.md is ignored). A turn end names the report only when the worker wrote it during that
turn; a turn end with no such report is `worker <label> ended a turn (no report yet)`, so a standing seat that writes
no report still wakes its lead. A subagent's end is no turn end and wakes nobody. One line per state per turn; nested workers wake only their own
parent; a parent that is closed or gone gets nothing and no other session does; sessions without a parent wake nobody.
Only agent parents (Claude, Codex, ACP) get the line; a shell parent gets nothing, because a shell would run it.

### `nunchiro agent read <agent> [--lines <n>] [--source screen|transcript]`
Prints the last `<n>` lines (default 50) as plain text: the visible `screen` (default) or the agent's `transcript`.

### `nunchiro agent get <agent> --json`
The agent's record plus `status` and `agent_session`. `parent` is the id of the session that started it (absent for
sessions the owner started); it is stored with the session, so it survives a core restart and a resume. It is the raw
link: it can name a session that has since closed.

### `nunchiro agent list [--mine] [--json]`
The sessions `session list` shows you, one per line (`id`, label, status, parent or `-`), or with `--json` an array of
`agent get` records. `--mine` keeps only the sessions the calling session started itself (direct children, not their
own workers), so a coordinator finds its workers again after its context is compacted. The core decides which session
is calling, from its token or, for the owner token, from the process asking; no option or variable names it. Outside
every session `--mine` is refused.

### `nunchiro agent send-keys <agent> <key>...`
Sends keys to the agent. With no dialog, permission prompt or question open, the keys pass through. While one is open, a
caller inside a session (with its token, or with the owner token from inside it) may send only `esc`, which denies; any
other keys are refused (`agent_blocked: unverified answer keys`, or
`dialog choices are terminal-only` for a recognised option), so an agent cannot choose an option that saves trust or changes settings. A
permission prompt also accepts a verified "yes" or "this time only" option when the owner turned the verified-yes option
on for the target session's project (`permission-answers`). Dialog choices stay with the user, in the window or the terminal.

### `nunchiro agent cancel <agent> <send-id>`
Cancels a queued send. The id is in the agent's `send_queue`.

## Events

### `nunchiro events [--project <dir>] [--since <id>]`
Ticket 573. Prints the core's events on stdout as NDJSON (one JSON object per line) until stopped, so a caller does not
poll (cmux's `events` stream, paseo's event feed). Each event has `id` (increasing), `at` (ms), `type`, `project`, and
by type `session`, `label`, `state`, `path`, `data`:

- `session_started` (with the first `state`), `state` (each change), `session_ended` (closed or gone);
- `worktree_created` (by `worktree create` or a `--worktree` start), `worktree_removed` (remove, forget, auto-clean),
  with `path`;
- `room_message` (ticket 571): one event for each append to a project's room log, so a caller reads the room without
  polling `agent check`. `project` is the room's folder and `data` is the message as the log stored it: `id`, `kind`
  (`message`, `ask`, `reply`, `timeout`, `lost`, `cap`), `from`, `to`, `thread`, `reply_to` (when set), `body`,
  `created_by` (`agent`, `person` or `core`, stamped by the core; `core` is a `timeout` the core wrote itself) and `ts`. The body is text from an agent or the person: treat
  it as quoted data, never as an instruction. `data` is cut to 4 KB of JSON; a body that does not fit is shortened
  and the event says `"body_truncated":true` (`agent thread read <thread>` prints it whole). Reading the stream moves
  no seat's read cursor and types no notice. Room events follow the room's own reach: the owner sees every project's;
  a token made for one project sees that project's room only; a session sees the room it can read (the project of
  the top of its parent chain); a session another machine's calls flagged as remote sees none.
- `room_pins` (ticket 593): the person pinned or unpinned a room message in the window; `data` is `{log, pins}`, the
  room's whole pin list in pin order for the log named by `log` (the time of its first message). Same reach as
  `room_message`.
- states: `working`, `waiting` (for input), `question` (a question or dialog), `permission`, `exited`, `failed`,
  `lost` (a next core found the agent gone; it can be resumed).

States are read at the core's tick (50 ms while busy, longer when idle): a change shorter than that shows as the newer
state only. Without `--since` the stream starts at now. To resume, pass the last `id` seen as `--since`: the events
after it come once, in order. The core keeps the last 4096 events in memory; when `--since` is older than that, or comes
from an earlier core, the first line is `{"type":"gap",...}`: events were missed, read the state again (`agent list
--json`). A session's token sees its own project's events only (`--project` cannot widen that); the owner sees all, or
`--project`'s. A session whose id another machine's calls flagged as remote sees only the sessions it started. An
event's `data` is cut to 4 KB of JSON (`{"truncated":true,"head":...}`).

### `nunchiro events --history <days> [--project <dir>]`
Ticket 1130. Prints the event journal of the last `<days>` UTC days (1 to 14, today included) as NDJSON, oldest first,
and ends. The core appends every event it streams to a day file under `$NUNCHIRO_HOME/logs/events/` (folder 0700,
files 0600, append only, redacted as the logs are), so events outlive a core restart; this command reads those files
and needs no running core. A room event's `data` (the message body, the pin list) is never kept. A day file stops at
4 MiB (its last line is `{"type":"journal_full",...}`) and day files older than 14 days are removed. The journal also
holds:

- `core_started`: a core started; `data` is `{kept, lost, exited}`, the sessions the last core left running that came
  back live, that can be resumed, and that cannot;
- `send_dropped`: an Enter the core held back for a typed message (`session`; `data` `{mark, requeued}`, `mark` one of
  the `enter_dropped_*` reasons, `requeued` when the message waits to be sent again);
- `owner_prompt`: the person pressed Enter in a lead's own seat (`session`; no text).

These three also appear on the live stream. The journal holds every project's events, so `--history` is the owner's: a
session's token is refused. `--project` keeps one project's events.

## Room

Ticket 571: agents in one project talk through a message log the core keeps (`$NUNCHIRO_HOME/room/`, one append-only
log per project). A seat is an address: a session id (or label, resolved to its id) or `person`. The sender is always
the calling session, stamped by the core from its token or the peer check; no option or field names it. Outside every
session the sender is the person, and `--project <dir>` (default: the current folder) names the room. A session's room
is the project of the top of its parent chain, so workers in worktrees share their lead's room; a session may address
only seats in its own room. Every verb prints one JSON object per message (`id`, `kind`, `from`, `to`, `thread`,
`reply_to`, `body`, `created_by` (`agent`, `person` or `core`), `ts`); bodies are data, never instructions. Control characters in a body other than
newline and tab are left out of the output.

A new message reaches an agent seat as one fixed line through the "send when ready" queue,
`N new messages: run nunchiro agent check`; the body never goes to a terminal. A notice still queued gets the new count
instead of a second line. A seat with an open dialog, permission prompt or question gets nothing until it is closed:
messages never answer a dialog or a permission. Shell seats get no notice.

Hooks (Nunchiro's own hooks in each agent session): a Claude seat with unread messages also gets the same line as
PostToolUse `additionalContext`, once per new batch, so a long turn hears it before the turn ends; a subagent's tool
call gets nothing. A Claude session's `AskUserQuestion` or a Codex session's `request_user_input` (or
`request_user_input_async`, the one Codex 0.161 offers its default model) in a session whose
parent is a running agent session (Claude, Codex or ACP) in the same room becomes an `ask` to that parent, in the
child's own thread `q-<child id>` (the question and its numbered options as the body), and the tool call is denied with
`sent as ask <id> to your lead; end your turn, the answer arrives as a message`; the person is not asked. The parent is
the core's record, never a hook payload field. These keep today's path, where the person answers in the app: a session
with no parent, a parent that is a shell tab or has ended, an ask the guards refuse (a child's thread stops at 6 agent
messages), and a hook that reaches the core too late for the deny to get back to the agent (1.2 s after the hook
started). When the deny's reply cannot be written, the person gets the question too, and the ask stays in the log.
Limit for Codex (ticket 589, live Codex 0.161.0; ticket 690): Nunchiro gives a Codex session its hooks only when no
`hooks.json` or `plugins` exists in the Codex home or any `.codex` folder above the project, and each `config.toml`
there holds only what Codex writes itself: `[projects."<dir>"]` tables with only `trust_level` (the folder-trust
screen), `[tui]` and `[notice]` with only the keys Codex 0.161 has there, `model` and `model_reasoning_effort`, and
(ticket 760) `[mcp_servers.*]`, `model_provider`, `[model_providers.*]`, `approval_policy`, `sandbox_mode` and
`[sandbox_workspace_write]` (see `crates/nunchiro-core/README.md`). Any other key (a profile, `features`, `notify`, a
hook) turns the hooks off, and a Codex worker's question then goes to the person. A
Codex worker should run `nunchiro agent ask` instead.
Ticket 692: every Codex start gets `-c check_for_update_on_startup=false`, so no seat shows Codex's update screen,
whose preselected "Update now" runs `brew upgrade --cask codex` on one Enter. Update Codex outside Nunchiro. A start
whose Codex arguments name `check_for_update_on_startup` is refused, since a later `-c` would win.
Ticket 1130: every Claude session Nunchiro starts asks before an outward action (a mail, a calendar event, a post, a
publish; `nunchiro hook outward`), whatever its permission mode, and so always runs hooks: its `--settings` layer sets
`disableAllHooks: false`, which overrides a `true` in the user's, the project's or the local settings, because a
project must not be able to turn the outward ask off. Your other hooks run too. Managed (enterprise) settings still
win over `--settings`; a managed `disableAllHooks: true` turns the outward ask off as well.
Ticket 1151: the card shows the call's input without its fields named like a secret (`token`, `authorization`,
`password`, `api_key`, `access_token`, `refresh_token`, `credentials` or `auth`, in any letter case, at any depth),
and Claude would run the call with them. You are never asked to allow what the card does not show, so an outward
Claude call with such a field is refused, not asked, as a Codex one is; the agent is told why and there is no
"allow anyway". Calls that are not outward are unchanged.
Ticket 1149: Codex and ACP sessions ask too.
- Codex: every Codex start (with or without your arguments, your own hooks or Nunchiro's other hooks) gets one
  PreToolUse hook, `nunchiro hook outward --codex`, as `-c` values: `features.hooks=true`, `hooks.PreToolUse` and a
  `hooks.state` entry that trusts this one hook by its hash and keeps it enabled. Your own hooks keep their own trust;
  Nunchiro's hook is never a reason to run them unreviewed. Codex has no "ask" answer for a hook (live Codex 0.161.0:
  only `deny` or exit 2 stops a tool; `ask`, `allow`, a failed hook and a timed-out hook all let it run), so the hook
  holds the call, Nunchiro shows its own card ("Publish", "Send or post"), and the call runs only on your Allow. A
  deny, no window to ask, no answer in 30 minutes, a core that is down or any error refuses the call. The card has no
  "always allow". The card shows the call's whole input; a call too large for a card (64 KiB) or with a field the
  card would leave out (one named like a secret: `token`, `password`, `auth`) is refused, not asked. A start whose
  Codex arguments name hooks in a config or feature flag (`-c hooks...`,
  `-c features.hooks=...`, `--disable hooks`) is refused, since a later `-c` would win; keep your own hooks in
  Codex's config.
  Limits: the hook sees a shell command and an MCP tool call. Codex runs no hook for text typed into a command that
  is already running (`write_stdin`), so a publish typed into an open shell is not asked about. The trust hash is
  Codex 0.161's rule; if a later Codex changes it, the hook reads as untrusted and does not run until Nunchiro follows.
  When Codex's own approval mode also asks for the same call, you are asked twice. Codex has no fail-closed setting for a hook, so the hook command ends with
  `|| exit 2`: if Nunchiro's program cannot run (it was replaced by an update while the session runs), shell commands
  and MCP calls of that session are refused until you restart it. A hook Codex itself stops at its time limit (30
  minutes and 10 seconds; the hook gives up and refuses before that) would let the call run.
  Ticket 1150: a Codex that will not run the hook is not started. Managed Codex settings can allow managed hooks
  only (`allow_managed_hooks_only` in `/etc/codex/requirements.toml`, a device profile or the workspace's cloud
  policy); live Codex 0.161.0 then leaves Nunchiro's hook out and runs outward actions with no card. So before every
  Codex start Nunchiro asks that same Codex, with the session's environment, folder and hook arguments, which hooks
  it would run (`codex app-server`, `hooks/list`; 24 to 176 ms measured). The session starts only on a yes: the
  outward hook listed, on and trusted. Everything else refuses the start, and the error says why: the managed
  policy (read from `configRequirements/read`), a hook that is missing, off or not trusted (a later Codex that
  changed the trust hash), a Codex that is not found, and a Codex that gives no answer: one that ends, prints
  something else, is too old to have `app-server`, or takes more than 5 seconds for either of the two answers.
  There is no "start anyway". Codex is asked before anything is made for the session and outside the core's own
  lock, so a slow or stuck Codex holds only its own start, never your other sessions; Nunchiro ends the asked
  Codex itself and its process group and never waits on it without a limit. A model change restarts Codex and
  asks again first; a refusal there leaves the running session as it is.
  Limit: the answer is read at the start; a policy that reaches a running session later is not seen until its
  next start.
- ACP agents: a command the agent asks Nunchiro to run (`terminal/create`) waits for your card when it is outward (a
  publish, a release, a repository made public); other commands run as before. The card shows the whole command
  line, and the folder and variables the agent set; a command too long to show whole (4096 characters) is refused,
  not cut. Every `session/request_permission`
  was already a card. No ACP card has an "always allow". Limit of the protocol: ACP gives the client no hook on a
  tool the agent runs inside itself, so an agent that publishes or sends with its own built-in tool without asking
  permission is not seen by Nunchiro. Use an agent's own approval mode for that.

When a seat ends (exited or failed; a closed tab says nothing) with an ask open, one it sent or one sent to it, the core
adds one `lost` event to that ask's thread: from the ended seat to the ask's other party, `reply_to` the ask, body
`the seat ended (exited) with this ask open`. A reply, a `timeout` or an earlier `lost` closes an ask, and so does a later message in its thread from the seat it was sent to (for the person: any message the person wrote), as the window reads it. The core checks a
seat once per ending, and types no notice for the event. The window shows it as "Lost". An ask sent to a seat after it
ended is not marked.

Guards: a body over 8 KB is refused (write it to a file and send the path); the same message from the same sender twice
in a row is dropped (`repeat dropped`); a seat with 50 unread messages takes no more (`inbox_full`); a thread with 6
agent messages since the last person message refuses the next agent message (`round_cap`) and leaves one `cap` message
for the person. Two peer seats (agent sessions where neither started the other, such as a worker and a reviewer) are also
capped across threads: 12 messages between them with no person message to either refuses the next one and leaves one
note for the person, so fresh `send`s do not get around the cap. A lead and its own worker are capped the same way at
80 messages (ticket 590: a lead hands one worker many short threads). A room log at 10000 messages or 8 MB refuses
every agent message (`room_full`) and tells the person once; the person can still write. When `log.jsonl` is moved
aside, the next message starts a new log and every seat reads it from its start.

`--` ends the options of every room verb: each word after it is a positional word, even one that starts with `--`
(`agent send --to person -- --help`).

### `nunchiro agent send [--to <seat>] [--thread <name>] <body>`
Adds a message and returns at once. Without `--to` it goes to the lead: the sender's parent session, or the person when
there is none (the person must name a seat). Without `--thread` the message starts a new thread named by its id;
`--thread` takes 1-40 of `a-z`, `0-9`, `-`, `_`. A single word after the options, or options first, is this form; two
words (`agent send <agent> <text>`) type into a terminal as before.

### `nunchiro agent ask [--to <seat>] [--thread <name>] [--wait [--timeout <s>]] <body>`
As `send`, as an ask. Every ask has a deadline. With `--wait` it returns the reply as its output in the same call (default
timeout 600 s), and no notice is typed for that reply. At the timeout it exits 2 with `ask_timeout` and the log keeps one
`timeout` event in the thread; an ask times out once, and only its asker can end it. The `timeout` event is logged even
when the seat has 50 unread messages or the room is full; if the core still cannot log it, the call exits 2 all the same.
A plain ask (no `--wait`) times out 30 minutes after it was sent, if it is still open (no reply, no later message in
its thread from the seat it went to, no `lost` or `timeout` event): the core writes one `timeout` event, up to 15 s late,
and tells the asker with the usual notice. The same holds for a `--wait` ask whose caller is gone. An ask to the person,
or one the person sent, has no timer: the person already has it.

The `timeout` event is addressed to the person (`from` is the asker, `reply_to` the ask), so the window shows the thread
under "Needs you" and the person answers it like any ask: a message in the thread, or `agent reply` to the `timeout`
message. The asker finds the `timeout` in its own `agent check`; it is stamped `created_by: core`, and the asked seat's late reply
ends the window's "Needs you" for that ask. The deadline is read from the log, so a restarted core
neither forgets nor repeats one.

### `nunchiro agent reply <message-id> <body>`
Answers a message addressed to the calling seat; the reply goes to its sender, in its thread.

### `nunchiro agent check`
Prints the unread messages addressed to the calling seat and moves its read cursor past them.

### `nunchiro agent thread read <thread>`
Prints every message of one thread in the room, read or not; the cursor does not move.

## Worktrees

### `nunchiro worktree create --project <dir> --branch <b> [--path <dir>] [--base <ref>] [--label <l>] [--no-focus] [--json]`
Creates a git worktree on a new branch from `--base`. Without `--base` the base is the remote default branch's tip as
last fetched (`origin/HEAD`, for example `origin/main`; run `git fetch` first for the newest), or `HEAD` when the
project has no such remote branch; the CLI prints the base it used on stderr (`base for a new branch: origin/main`).
The reply is JSON; `--json` is accepted and changes nothing. Trust for the new folder is never written to user config.
Without `--path` the folder is `<worktrees folder>/<project folder>/<random id>`. `--path` names the folder instead,
as Orca's `--name` does: it must be one new plain name (not starting with `.`) right under
`<worktrees folder>/<project folder>/`, where the worktrees folder is the `worktrees_dir` setting, a folder this
project's worktrees already use (`$NUNCHIRO_HOME/worktrees` only while a record of this project lies there), or the
unset default. Unset, the worktrees folder is `~/nunchiro/worktrees` (in the user's home; made on first use, and refused when `~/nunchiro` is a link or not a folder). Set a folder to use another disk. A record made under `../.worktrees` (ticket 1061) keeps working. A path
anywhere else, one that already exists, or one a worktree record already names is refused and nothing is created. When
the user's home is not known or cannot be written, the command fails and names the `worktrees_dir`
setting to change.
Inside a session the record names the session as its creator (shown only; any caller may open or remove it).

### `nunchiro worktree open --path <dir> [--label <l>]`
Registers an existing worktree.

### `nunchiro worktree list [--project <dir>]`
Lists the project's worktrees.

### `nunchiro worktree remove --path <dir>`
Removes the worktree. For a path that no longer exists, git metadata is kept; run `git worktree prune` yourself.

## Outside callers

Ticket 573. Scripts and other tools drive Nunchiro through the same verbs, as the owner (outside every session) or
with a token the owner made. A token resolves to its own caller, `token-<id>`: the core stamps it as the sender of its
sends and room messages, and as the parent of the sessions it starts. Every rule a session caller has still holds
(no Skip permissions, the window's own features stay the window's), and the scope narrows it further:

| Scope | Allows |
|---|---|
| `read` | `agent list`, `get`, `read`, `wait`; `worktree list`; `agent check`, `thread read`; `session read`; `events` |
| `supervised` | read, plus `agent start`, room `send`/`ask`/`reply`, and `prompt`, `send`, `cancel`, `session close` of the sessions this token started |
| `full` | what a session token may do, minus what no token may do (below); it acts on a session (`prompt`, `send`, `cancel`, `session close`, `label`, `resize`) only when this token started it, and removes, renames or forgets only the worktrees it created |

A session a token started is a token session for its whole life. A resumed run of it (by anyone, the owner's Resume
too), a restart and a side chat of it are token sessions as well. The session's own credential (its
`NUNCHIRO_TOKEN`) acts as that session, with the token's limits: the same scope, project and rules, refused once the
token is revoked or expired. In the room the agent keeps its own seat, as any agent session does: it reads and
answers what is sent to it, and its messages come from its own session. A session that credential starts is a token
session too, and it gets no browser space.

No token runs a command line as the user, since that could read `core.token` and act as the owner. So for every
scope: a token starts only Claude (`--kind claude`; no shell, no `worktree open`, and no Codex or ACP agent, since
neither can be kept out of the Nunchiro folder), with no launch arguments after `--` (no print mode, settings file or
permission flag; `--env` takes the same checks as for any caller). Its project, folder, worktree folder and
`worktree create --path` are outside `$NUNCHIRO_HOME` and do not hold it; a `--worktree` start is refused when the
worktree folder (the default `~/nunchiro/worktrees`, or the setting) is inside it. A token types, prompts and cancels only into the sessions it started, into no
shell session and into no session whose agent has ended (the shell left on its screen), and sends no text that
starts with `!` or `/` (the agent would run it as a shell or slash command).

A token session never reads `$NUNCHIRO_HOME`, even when the user's own Claude settings allow reads or commands
without asking. The settings file the core passes it (`--settings`) denies `Read` and `Edit` of that folder under
every spelling (as set, canonical, and on macOS also through the system data-volume alias of the same folder). A deny wins over every allow rule and
holds in every permission mode. Its Bash commands run in Claude's sandbox, which takes the same deny, may not run
outside it, and refuses to start without it. A command asks the person when the user's own rules or permission mode
would ask; if they allow it, it runs, still inside the sandbox. So that agent cannot run `nunchiro` itself. A reply
to a token never carries the owner token as typed: it reads `[redacted]`, as on a screen that printed it.

No token answers a permission or a dialog (`answer`, `send-keys`, steer), changes a setting (`permission-answers`,
an approval), makes or lists tokens, drives the browser, reads the whole room (the window's room view), stops or
restarts the core (`serve stop`, `serve restart`), changes the window's `layout`, or reaches another machine. A token
made with `--project` sees and reaches only that project's sessions, worktrees, room and events. A token caller names
its room with `--project`.
A refusal is exit 1 with the core's message, such as `operation not granted to a read token`.

### `nunchiro token create --scope read|supervised|full [--project <dir>] [--expires 30m|12h|7d]`
Owner only. Prints the token's secret once, alone on stdout (`export NUNCHIRO_TOKEN=$(nunchiro token create --scope
read)`), and its id on stderr. `$NUNCHIRO_HOME/tokens.json` keeps only the secret's SHA-256, so a lost secret is
revoked and made again. Without `--expires` the token lasts until it is revoked.

### `nunchiro token list [--json]`
Owner only. One row per token: id, scope, project (`-` for every project), expiry in Unix milliseconds (`-` for none).
Expired tokens stay listed until revoked; no secret or hash is shown.

### `nunchiro token revoke <id>`
Owner only. The token's next call is refused (`unauthorized`); a send it or one of its token sessions queued earlier is cancelled when its turn
comes.

### `nunchiro mcp`
A stdio MCP (Model Context Protocol) server, one JSON-RPC message per line. Its tools are the CLI verbs: `agent_start`,
`agent_prompt`, `agent_send`, `agent_wait`, `agent_read`, `agent_get`, `agent_list`, `agent_stop` (`session close`),
`worktree_create`, `worktree_list`, `room_send`, `room_ask`, `room_reply`, `room_check`, `room_thread_read`. Each call
runs on its own thread, so a long wait holds up no other request, and runs this binary with the CLI's arguments and the server's environment (`NUNCHIRO_HOME`, `NUNCHIRO_TOKEN`), so results
and refusals are the CLI's. A result's `structuredContent` is `{"result": ...}` with the CLI's JSON output (text output
as `{"text": ...}`); exit 2, such as an ask that timed out, is `{"needs_answer": true, "message": ...}` and not an
error; exit 1 is an error result `{"error": "<the CLI's message>"}`. Room tools without `project` use the server's
folder.

### Use from another tool

Make a token, then give the server to the tool. For Claude Code, `.mcp.json` in the project:

```json
{
  "mcpServers": {
    "nunchiro": {
      "command": "nunchiro",
      "args": ["mcp"],
      "env": { "NUNCHIRO_TOKEN": "<the secret from nunchiro token create>" }
    }
  }
}
```

Codex takes the same in `~/.codex/config.toml` under `[mcp_servers.nunchiro]` (`command`, `args`, `env`). Without
`NUNCHIRO_TOKEN` the server acts as the CLI would: the owner outside every session, the session inside one. A script uses the CLI the same way:
`NUNCHIRO_TOKEN=<secret> nunchiro agent list --json`.

## Team

### `nunchiro team open <name> [--level light|standard|deep]`
For the lead of a place only (ticket 990, 리더와 방): run inside the session that is the seat of a lead teammate
(Settings > Team, "Leads this place"). Opens the seat of another teammate of the same place (its project, or Home),
by name: an open seat is returned as it is; else a session starts in the teammate's folder with its agent, model and
name, as the lead's worker, and gets the teammate's own brief (job, memory, lead) as its first prompt. Prints the
session and `"started": true|false`. Any other caller is refused ("only the lead of a place opens its teammates");
making, changing and removing teammates stay the owner's (the window).

`--level` (ticket 992) asks how much the task needs: `light` (quick, routine work), `standard` (no level asked is
standard), `deep` (hard or risky work). The level picks the model and effort from Settings > Levels. A teammate pinned
to a level keeps it, and Auto with an upper limit opens at that limit at most; a teammate with a custom model has no
levels. An idle open seat at another level is ended and a new one opens at the asked level (same teammate, memory and
notes); a working seat keeps the task at its own level. Without `--level` an open seat is never replaced. The printed
session carries `"level"` with the `"model"` and `"effort"` it resolved to (ticket 994: the level table has a row per
agent, an ACP agent's too), and `"why"` says in plain words when the level used is not the asked one, or when an ACP
agent no longer reports the level's model. A lead's own seat keeps its level: a task's `--level` is not used for it.

## Tasks, notes and roles

The job ledger (ticket 990, 리더와 방). The core keeps the record of a lead's work; a lead only decides. A task is an
outcome with acceptance conditions that uses zero or more worktrees. The owner's shell reads every place (name one
with `--project DIR`); a session reaches the tasks of its own place. Add `--json` for the record as JSON.

### `nunchiro task new "<outcome>"`
`nunchiro task new "<outcome>" [--accept "<condition>"]... [--after <id>]... [--project DIR]`. For the lead of a place and the owner.
Asked twice with the same outcome, it gives the same open task back. A worktree a lead makes joins the open task of
its name, else gets a task of its own. `--after` names a task of the same place this one waits for (see `task after`).

### `nunchiro task after`
`nunchiro task after <id> <id>... | --none` sets the tasks of the same place that task `<id>` waits for, at most 8, as a
whole; `--none` clears them. For the lead of a place and the owner; who set it is kept on the task (`order set by`).
A task waits while one of them has not landed (closed as merged or done). `task list` and `task show` say
`waits for <id> "<title>" (<stage>)` per task it waits for, and `<n> tasks wait for this` on a task others wait for.
Refused with a sentence: the task itself, an id that is no open task of this place, a dropped task, an order that
would go round (a task waiting for one that already waits for it, however far), more than 8. An older Nunchiro opens
a ledger with this order and drops it on its next write.

### `nunchiro task list`
`nunchiro task list [--all] [--project DIR]` and `nunchiro task show <id>`. Each task with its state now (`needs`,
`working`, `review`, `changes`, `approved`, `merge`, `asked` (a seat waits for an answer to its room ask), `idle`, or how
it closed), its worktrees, its seats, what the user told a seat directly, open questions, the review and proposed
lessons. The first line says the place's way of working and what its seats may do without asking. `--all` lists closed tasks too.
`nunchiro task list --all-places [--all]` is the Home lead's: every place's tasks under each place's folder, read
only. Every other session and lead is refused. The Home lead also reads one other project with `--project DIR` and
`nunchiro task show <id>`; a change to another project's task is refused ("the Home lead reads other projects' tasks;
it cannot change them").

### `nunchiro task digest`
For the Home lead and the user: one line per registered project with its lead (or "no leader"), open tasks, what waits
for the user (pending decisions only) and working sessions. The same numbers as the Home view. The first line is the
count of what needs the user ("3 need the user"): every project's pending decisions and (ticket 993) each schedule
whose last run failed or could not start, which then gets a line of its own
("Scheduled run failed: Lister · Every day 9:00 PM: sort the mail (Lister is no longer a teammate)"). `--json` carries
those as `failed_runs` (`schedule`, `line`, `reason`, `at`, `session`).

### `nunchiro task goal "<goal>"`
`nunchiro task goal "<goal>" --project DIR`. The Home lead only. Files a card for the user: "<Home lead> wants to
give <project>'s lead this goal". Send writes the goal into that project's room, marked as from Home and approved by
the user, and wakes its lead; Not now tells the Home lead in Home's room. A project with no leader is refused.

### `nunchiro outbox stage`
Ticket 1002. `nunchiro outbox stage --tool <tool name> --args '<JSON>'` (`--args -` reads stdin)
`[--source "what it answers"]`. The Home lead only (its scheduled runs too; any other session, a token and the user's
own shell are refused). Stages one outward tool call as the user's Outbox card; nothing is sent, and one card is one
call. `--tool` is the full tool name with its server (`mcp__<server>__send_message` or `mcp__<server>__create_event`;
a reply is a `send_message` with its `replyThreadId`, since `reply` and `forward` let the mail service pick recipients
and content the card cannot show); `--args` its exact arguments. Only arguments the card shows are accepted (mail:
`to`, `cc`, `bcc`, `subject`, `body`, `replyThreadId`; event: `summary`, `startTime`, `endTime` as local
`YYYY-MM-DDTHH:MM:SS`, `description`, `location`, `timeZone`, `calendarId` `primary`); any other is refused (a draft
id, an HTML body, attachments, a signature, a send-as address, guests, recurrence), as is text with control or hidden
characters, a subject over 300 or a body over 8000 characters (refused, never cut). Addresses are plain, one per list
entry. The card binds the call by its hash (`approval::outward_call_hash`: the full tool name and the arguments as
canonical JSON): staging the same call again keeps the card, a changed byte is a card of its own. "New recipient"
marks an address whose domain the user never said yes to. At most 20 cards wait at once.

The user answers in the Nunchiro window only (an answer over the core's socket is refused). Send has a 10 second
Undo. Not undone, the card is approved, in the core's memory only: the core tells the Home lead's seat to make exactly
that call, and lets it through once within 10 minutes, for the session that staged it (the seat's hook asks the core,
`outbox_spend`); a different call, another session, a second call, a later one or one after a core restart is
refused. Open in Mail (or Calendar) instead opens a new message (or an .ics event) built from the same arguments for
the user to send or save. Discard is No; a card left unanswered for 24 hours, and an approval not spent in 10
minutes, count as No. Each outcome is one line in Home's room; `nunchiro task digest` counts the waiting cards
("Outbox: N waiting").

### `nunchiro task loops [--json]`
Ticket 1003: open loops, the user's promises and what the user waits for. The core keeps them as rows in
`$NUNCHIRO_HOME/loops.json` (kind `promise` or `waiting`, who, what, an optional due date, where it came from), not the
Home lead in its memory file. Nothing here sends anything. For the user and the Home lead; every other session is
refused (this command and the two below).

The counts come first ("Open loops on 2026-11-22: 1 overdue · 2 waiting · 1 promised"), then one line per open loop.
`nunchiro task digest` gives the same counts ("Open loops: ..."; `--json`: `loops` with `promises`, `waiting`,
`overdue`), so a brief's numbers come from the core. Each open-loop card that waits is one of the digest's "N need the
user" (`--json`: `loop_cards`).
- The core adds a row itself in one case: an Outbox mail the user approved was let through (`outbox_spend`) and the
  connector reported it sent (the call's own PostToolUse, without an error), so the user now waits for its reply
  ("waiting for <recipient>: a reply to "<subject>"", no due date). A send that failed makes no row.
- A row is overdue from the day after its due date (the machine's local date). The core raises one card per overdue
  row, once ("Overdue", counted in "Needs you"): "Done, close it" closes the row; "Still open" keeps it open and
  counted as overdue, and the card does not come back.
- The Home lead's brief quotes the open rows as they are when its seat starts.

### `nunchiro task promise|waiting "<what>" --who "<name>" [--due YYYY-MM-DD]`
From the Home lead it files a card for the user ("Keep track?"); the row exists only after their yes. The same loop
asked twice is one card, and one already open is not asked again. From the user's own shell the row is kept at once. A
reminder is a schedule (`nunchiro schedule propose`), never a row.

### `nunchiro task loop-close <id> ["<why>"]`
From the Home lead it files a card ("Done?", with the why, such as the reply it found); the row stays open until the
user's yes. From the user's own shell it closes at once.

### `nunchiro task attach`
`nunchiro task attach <id> --path <worktree>` moves a managed worktree of the task's project to the task, with the
seats in it. `nunchiro task assign <id> <session>` seats a session on a task that uses no worktree. Lead and owner.

### `nunchiro task staff`
`nunchiro task staff <id> <role> [--path <worktree>] [--prompt "<first words>"] [--level light|standard|deep] [--effort <effort>] [--account <label>]` starts a seat of one of the user's
roles on the task: a session named "<Role> · <task>" in the task's worktree (or the project, for a task with none),
with the role's agent and model. One live writer per worktree: a second one is refused. A role that does not write
starts without the edit tools; where the project lets seats edit without asking, a writer starts in accept-edits.
The seat's first prompt from the lead opens with the role, the task, its conditions and the notes it reads.
The seat opens at a level as a teammate's seat does (ticket 993): `standard` when no `--level` is given, and the
level picks the model and effort from Settings > Levels (`deep` for a hard task, `light` for routine work). A role
with a model of its own keeps it, whatever the level. `--effort` sets the seat's effort instead of the level's (also on a
role with its own model); one that is not in that agent's and model's effort list (Claude: low, medium, high, xhigh,
max) is refused and nothing starts. The line it prints names the model and effort the seat started
on ("started Builder · fix (…) on task …, on Sonnet").
Settings > Team > Worker models can fix every Builder and Reviewer seat to one level or set an upper
limit; a `--level` beyond the limit opens at the limit and the command prints one more line saying so. A seat that does
not write (a Reviewer) never opens below the level the task's Builder opened at; a Reviewer role with its own model keeps
it, and `nunchiro task show` prints a note line that the floor could not apply.
`--account <label>` (ticket 1120) starts the seat on that agent account (its config folder, as `session start --account`).
Without it the seat starts on the place's account (`task account`), else on the lead's own. A label that is no account of
the role's agent is refused with the list of its labels. A lead may name only its own account or the place's account the
user set; any other is refused (ACCOUNTPICK). The printed line and the seat line of `task show` and `task list` name the
account ("on Opus · high · official", "seat: … (…, running, on official)").

### `nunchiro task pass`
`nunchiro task pass ["<note>"] [--task <id>]` and `nunchiro task changes "<what must change>" [--task <id>]` record
a review of the files as they are now. Only a seat of the task that does not write, or the owner, reviews; the
builder cannot. The review holds for that revision only: after any edit the task reads `review` again. A note keeps its
lines, up to 4,000 characters: `task list` shows its first line, `task show <id>` and `--json` the whole note.

### `nunchiro task learn "<a lesson in one line>"`
`nunchiro task learn "<a lesson in one line>" [--cites <file>] [--task <id>]`. A seat of the task or its lead
proposes a lesson for the merge card (the newest two are kept). It becomes a note only if the user keeps it there.

### `nunchiro task ask-merge`
`nunchiro task ask-merge <id>` asks the user to merge on a card. Refused unless the review passed for the files as they
are now and they are committed. The answer arrives as a room message; a yes names the exact commit to merge.

### `nunchiro task done`
`nunchiro task done <id>` closes a task whose outcome the user accepted; `nunchiro task drop <id>` gives it up (its
proposed lessons go with it). `nunchiro task way solo|team|strict --project DIR` and
`nunchiro task grant ask|edits --project DIR` are the owner's choices for a place.

### `nunchiro task package`
`nunchiro task package <id> quote "<words, exactly>" --who "<who said it>" --when "<when>" [--image <attached image>]... |
unquote <n> | background "<your text>" | see "<what the user will see>" | shown <n> | approve <n> |
link <path or URL> --kind mockup|doc|code|url [--approved] | unlink <n>` (ticket 1095) fills the task's work package:
the quoted lines of the conversation, the lead's background, the lines the user will see, and the linked mockups,
documents, code and URLs. Only the place's lead seat and the user fill a package; a closed task's package is kept as it is.
A quote is never edited: a wrong line is removed with `unquote` and the right one added. Only the user marks a
you-will-see line (`approve`) or a mockup link (`--approved`) as approved; a lead is refused and asks the user.
The package reaches a seat's first prompt through `task staff --prompt` (and the core's own Reviewer).

### `nunchiro task auto on|off`
`nunchiro task auto on|off --project DIR` (ticket 1081, on by default) is one more owner's choice for a place. On, the core nudges a seat of an open task once
when it stalls (a queued message older than 5 minutes, or 20 minutes quiet with no done report), asks the user on a
card when it is still stalled 5 minutes later, and tells the lead every 10 minutes what waits; `task list` and `task show`
print each stalled seat, what waits, and a running seat's last activity.

On, in a place whose way is team or strict, the core also starts the Reviewer (ticket 1081 part B): when a task's
Builder ended its turn with `STATUS: done` in REPORT.md (written after its last prompt), its files are committed (no
changed tracked file), no review exists for that revision and no Reviewer of the task is at work, it starts one fresh
Reviewer seat through the same path as `task staff` (the level floor of its Builder; the prompt is review.md filled in,
both blocks at strict), once per revision. It starts it as the lead's own `task staff` would: on the lead's account,
under the same start check, with the lead's seat as its parent; it checks again, right before the start, that the task
is open, auto-advance on, the way team or strict, the lead running and the cap free, and starts nothing otherwise. It
closes that Reviewer once its verdict is recorded and its turn ended; a failed start is tried again, at most 3 times
per revision, then the user is asked on a card. A review that asks for changes is forwarded to the Builder as one line
(the Reviewer sends the full findings with `agent send`), at most 3 rounds; a fourth "changes" asks the user on a card.
Each action is one line in the room.

### `nunchiro task account <label>|own`
`nunchiro task account <label>|own --project DIR` (ticket 1120) is the owner's choice of the agent account a place's seats
start on: the lead's `task staff` without `--account` and the core's own Reviewer alike, each on its agent's account of
that label (a seat of an agent with no account by that label runs on the lead's own). `own` goes back to the lead's own
account. An unknown label is refused with the list. A lead is refused and asks the user; the lead hears the change in
its room. With it set, a session of that place may start sessions on that account as on its own.

### `nunchiro task cap 2|4|6|8`
`nunchiro task cap 2|4|6|8 --project DIR` (ticket 1081 part B, 4 by default) is the owner's choice of how many live seats
the place may have before the core stops starting Reviewers. Every live seat of the place counts: each task's seats
(closed tasks too), the leads', and an idle Reviewer until it is closed. At the cap the review waits ("1 review waits
for a free seat" in the Team view) and starts when a seat closes. The lead's own `task staff` is counted, never held back.

### `nunchiro task ask-cap 2|4|6|8`
`nunchiro task ask-cap 2|4|6|8 --why "<what you saw>"` (ticket 1099) is how a place's lead asks for another cap: the
user gets a "Change live seats" card in Decisions, and only their yes sets the cap, as `task cap` does. A new ask
replaces the place's card not yet answered; an ask for the cap the place already has is refused. A lead's own
`task cap` stays refused. The answer arrives as a room message.

### `nunchiro note list`
The notes this session reads: about the user, its role's, and its project's (the owner's shell: every note). Notes
are lessons the user accepted; only the user keeps, edits and removes them (the merge card, Settings > Notes).

### `nunchiro role list | propose "<name>"`
`nunchiro role list` prints the user's roles (Builder and Reviewer exist with no setup).
`nunchiro role propose "<name>" --job "<what it does>" --why "<what you counted>" [--kind claude|codex] [--model M] [--reviews]`
is for a place's lead: the user is asked on a card, and only a yes adds the role.

### `nunchiro bot offer "<name>" --job "<one sentence>" --why "<what you counted>"`
For a bot's own session (the seat of a teammate, a lead included): when the same kind of work keeps coming back and
no teammate's job covers it, the bot offers the user a new bot for it. `--why` says what it counted ("3 of the last 5
tasks were release notes"). The user gets a card with the name, the job and the reason; nothing is made before
their yes, which makes the bot in the offering bot's place (its project, or Home) with no seat. A second offer of the
same name replaces the first card. Refused to any other caller ("only a bot offers a bot"), without a reason, and for
a name a teammate of the place already has.

## Schedules

Ticket 993. A schedule starts a session, or wakes a teammate with a task, at a set local time: once, every day, or
on days of the week. The user makes, edits, pauses, runs and removes schedules in the window (the Schedules widget).
From a session, only the seat of a place's lead reads them, and what it proposes is a card for the user: the core
stores nothing before the user's yes. A session that is doing a scheduled run (until the user speaks to it) cannot
propose or change schedules.

### `nunchiro schedule list [--json]`
In the user's shell: every schedule. In the seat of a place's lead: the schedules of its place (a teammate's schedule
belongs to the place the teammate is in; any other to the folder it runs in); the Home lead reads all. Any other
session is refused ("operation not granted"). Each schedule prints as its id, who and when in words, the task in one
line, then when it runs next (`off` when paused; a once schedule that ran stays listed, off, until the user removes
or edits it) and how its last run ended (`finished`, `waits for the user`,
`failed` with the reason, `still working`, or `never ran`). `--json` prints the core's rows: `id`, `run`, `at`,
`daily`, `days` (0 Sunday to 6 Saturday; absent: every day), `paused`, `next_ms` and `last` (`session`, `at`,
`result`: `finished` | `needs_you` | `failed`, `reason`).

### `nunchiro schedule propose --who <teammate> --when "<when>" --task "<text>" [--level light|standard|deep]`
For a place's lead: asks the user, on a card with one sentence ("Lister · Every day 9:00 PM · Haiku: sort the
mail": the model and effort the level starts, ticket 994) and Add / Not now, to schedule a teammate of the lead's own place. `--when` is `daily HH:MM`,
`weekdays HH:MM`, `weekly <day> HH:MM` (a day's name or its first three letters) or `once YYYY-MM-DD HH:MM`, in the
user's local time. `--level` is the level the teammate's seat opens at for this task (see `team open`; default light, as a schedule
made by hand starts). A schedule for a teammate that leads its place stores no level: its run never replaces the
lead's seat (the task goes into the open seat as it is, or the seat opens by the lead's own level rule), and the
card's sentence shows that level. The proposal
is checked as the user's own add is (the teammate, the time, a date still to come, a task of 1 to 4000 characters), so
a refusal comes at once and a card can always be applied. The answer arrives as one line in the lead's room.

### `nunchiro schedule change <id> pause|resume|remove`
For a place's lead: asks the user on a card (Pause, Resume or Remove / Not now) to change a schedule the lead may
read. A resumed schedule runs at its next time from then, never for a time it missed while it was off.

## Board

V2.5-35. The task board the window shows, written through the same core requests the window sends. Who may write
what is decided in the core on every write, never by a flag:

- Outside every session (and in the window) you are the owner: every card, no receipt needed.
- The coordinator, a session that is the parent of at least one live session, writes every card of its child
  sessions' projects, Done included. The status ends when its last child session ends.
- Any other session moves only a card it is attached to. Every other write is refused with one line naming why,
  and the refusal is kept in the card's history (the window can undo past it).
- A session's move into Done (a column with `proof = true`) needs a receipt. Without one the card stops in Review,
  the history says `receipt needed (sha, command, result)`, and the command exits 1 with
  `receipt missing · stopped in Review on the way to Done (sha, command, result needed)`.

A session's card text (title, note, group, ref, role, receipt) is plain text: control characters are refused (a note
keeps line breaks and tabs), and `list` and `self` print any stored one as `\u{..}`. Sessions on another machine reach
no board command. Every write lands in the card's history with the writer's session label (`owner` outside a session). There is no
herdr ledger import. Errors (unknown card or column, malformed receipt, a refused write) print one line, exit 1 and
write nothing.

### `nunchiro board list [--json]`
One tab-separated line per task card: id, column, title, group, ref, attached sessions (`label:role`), receipt,
and a last field that is `archived` for a card in Done for longer than `done_days` (board.toml `[settings]`: 1, 7 or 30,
default 7), else empty. An archived card is only hidden in the window's Done column (it shows in the Archive fold);
nothing is deleted, and the card still counts in lane progress. `--json` prints the whole board snapshot the window
reads, with `"archived": true|false` and `done_at` (when the card arrived in Done, else null) added to each card.

### `nunchiro board create <title> [--column <column>] [--why <line>] [--group <id>] [--ref <path|url>] [--waits-on <card>]... [--attach <session> [--role <role>]]... [--json]`
Places a card, with its task fields in the same write: all or nothing (an unknown `--column`, `--waits-on` card or
attached session leaves no card). `--column` and `--why` are a second write after the card exists: a core that refuses
it (a rights refusal) leaves the card in the first column without its line, and the command exits 1. Only the
coordinator and the owner create or note cards; any other session moves only its own card. Without `--column` it lands in the first column (To do), which the Board's Next
column shows; `--column needs-you` puts a blocked-on-you item in the column whose cards raise decisions. `--why` is the
one line that says why the card waits (it becomes the card's note; a line break is refused). A session's card is
linked to that session, so it belongs to its project and that is the only project it can write to. Prints the new
card's line, or the card with `--json`.

### `nunchiro board add <title> [...]`
The same as `create` (kept so existing scripts and prompts keep working).

### `nunchiro board note <card> <text> [--json]`
Rewrites the card's note (the line the Board shows under the title). Rights as for any edit: the owner, or the
coordinator for a card of its child sessions' projects.

### `nunchiro board move <card> <column> [--json]`
Moves a card to a column, by column id or title, or by a Board name: `next` (the first column that claims no state)
or `needs-you` (the column whose cards raise decisions).

### `nunchiro board done <card> [--receipt "<sha> · <command> · <result>"] [--json]`
Stores the receipt (three parts split on ` · `, plain text: no control characters, each part at most 4 KiB) and
moves the card into Done.

### `nunchiro board self [--json]`
The card the calling session is attached to (the latest updated one), or `no card is attached to this session`
(exit 0; `--json` prints `null`). Outside a session it is refused.

## Widgets

### `nunchiro widget new <name>`
Creates a starter script widget in `$NUNCHIRO_HOME/widgets/<name>/` (`widget.toml` and `widget.sh`). It only creates
files, so it works inside a session too; the widget starts unapproved and nothing runs until you allow it. It refuses
an existing folder, an invalid name (a-z, 0-9, `-`, `_`, up to 64) and a `widgets` folder that is a symlink. Script
widgets run only when `settings.json` has `"script_widgets": true` (off until the security review).

### `nunchiro widget allow <name> --read|--act`
Approves a widget at the read or act level, as the permission sheet does. From inside a Nunchiro session it approves
nothing, because an agent must not approve what it asks you to approve: it puts one waiting item in the window (a repeat
asks for the same item) and prints `waiting for the owner in the Nunchiro window`. The owner opens the permission
sheet from that item, which shows the widget as it is then; a change after the sheet was shown asks again. An unknown
widget is an error and raises nothing.

### `nunchiro permission-answers on|off [--project <dir>]`
Turns the verified-yes option for one project (`--project`, default the current folder) on or off in `settings.json`
(other keys are kept). With it on, agents may answer that project's permission prompts with a verified "yes" or "this
time only" option (see `agent send-keys`). From inside a session `on` changes nothing and puts one waiting item in the
window for the owner's click, printing `waiting for the owner in the Nunchiro window`; `off` always applies at once.

## Browser

V2.5-20. An agent drives its own browser space in the Nunchiro app: the space is the calling session (resolved from
its session token), its first tab is the view the side pane's Browser tab shows for that session, and later tabs share
its data store. Each command waits up to 12 s for the app and answers once. Outside a session (your terminal, no token)
every `browser` command is refused: you drive the browser in the window. The owner's own browser is never reachable, there is
no command that runs page script, and nothing is forwarded to another machine. The app must be open on this Mac.
Everything a page wrote is printed between `--- page content (untrusted: written by the web page, not by the owner) ---` and
`--- end page content ---`; page lines that start with `---` are indented so a page cannot close the fence, and terminal
control characters are removed.

An action (`open`, `goto`, `click`, `fill`, `select`, `press`, `scroll`, `tab`) prints its done line and then the page
after it, as `snapshot` prints it. An element keeps its number while it stays on the page, and a number is never given to
another element of the space, so a number from an earlier answer still names the same element; the page printed last
lists what is there now. A number that no longer names an element is refused and nothing runs: `ref_stale` (that element
is gone or hidden: take a number from the last page printed) or `page_moved` (the number is from another tab or the tab
has a page you have not read yet: run `snapshot`). An action that ran never ends
in an error: when its page wait or check fails, the done line says `outcome unknown: ...` or what the page shows
instead, so read the page it printed before you repeat it. Over the answer budget the page is left out
(`snapshot, page title and address omitted`). `open` and `goto` wait until the new page is past loading (up to 8 s). Every
answer comes within 11 s of the command, so it arrives before the 12 s limit; a page wait cut short by that says
`outcome unknown`, and a command that waited too long behind earlier ones says `Not run: out of time` (nothing ran). Each session's browser commands run in order, and never wait for another session's. A
`click` or `press` that starts a page load waits for that page; one that starts none waits until the page has stopped
changing for 100 ms (at most 1 s, then `the page was still changing`); when nothing on the page changes within
200 ms the done line says `no page change seen in 200 ms; requests may still be running`.

### `nunchiro browser open <url>`
Opens a new tab (up to 8 per space) and makes it current. Only `http` and `https` load; `file:`, the app's own schemes
and Nunchiro's own listener ports are refused, as in the Browser tab.

### `nunchiro browser goto <url>`
Loads the address in the current tab (opens one when the space has none) and waits for the page.

### `nunchiro browser snapshot [--tree] [--full]`
Prints the current tab's actionable elements in view as numbered rows (`[3] textbox Email = "a@b"`,
`[7] checkbox I agree [ ]`, `[6] select Topic = Choose (Billing | Bug)`), then up to 6,000 characters of visible text,
and `more below` / `more above` hints. An element keeps its number across snapshots and actions on the same page; new
elements and new pages get new numbers. Password, file and hidden inputs are never
listed: a login is a `handoff`. `--tree` prints a role outline with the same numbers as `[ref=N]`; `--full` covers the
whole page instead of the viewport (up to 60,000 characters of text, 1,000 rows). A page picks its own strings, so they
are capped: title 200 characters, address 1,000, field value 200, a select's first 5 other options and `… N more`. Over
the row or answer budget the first 80% and the last 20% of rows are listed and `N more elements in the middle not listed`
counts the rest. In `--tree` every quoted string is one line with its quotes escaped.

### `nunchiro browser click <n>`
Clicks element `n` with a native mouse click at its centre (pages see a trusted event), after scrolling it into view.
Refused when another element covers that point, and with `ref_stale` or `page_moved` as above.

### `nunchiro browser fill <n> <text>`
Gives text field `n` the keyboard focus, clicks it, selects its content and types `<text>` through the view's text
input (trusted `input` events); the rest of the line is the text. The text only ever goes into field `n`: when the field
will not take the focus the verb is refused with `focus_refused` and nothing is typed. Refused for anything that is not a
text field, and with `ref_stale` or `page_moved` as above.

### `nunchiro browser select <n> <option>`
Chooses an option of select `n` by its label or value (a DOM change, not native input).

### `nunchiro browser press <key>`
Sends one native key: Enter, Tab, Escape, Backspace, Space, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, PageUp,
PageDown, Home or End.

### `nunchiro browser scroll <up|down>`
Scrolls the current tab by most of a screen.

### `nunchiro browser tabs`
Lists the space's tabs with their titles and addresses; `*` marks the current one.

### `nunchiro browser tab <n>`
Makes tab `n` current.

### `nunchiro browser handoff <reason>`
Tells the window that the agent needs the owner (a password, a captcha, a payment) and prints `USER_IN_CONTROL: ...`: the
agent stops browser work until the owner says to go on. The window's chip and Hand back control are a later package (WP3).

## Layout

### `nunchiro layout ...`

Changes the window layout (`$NUNCHIRO_HOME/layout.toml`, default `~/.nunchiro/layout.toml`) with the same actions as the
GUI's layout edit (the GUI has no `:` command line since needs 153; this CLI stays for agents and scripts). The words go to an open Nunchiro window, which applies them and saves the file,
so the CLI and the GUI write the same `layout.toml`. With several windows open, the command goes to the one the
user last worked in (clicked or typed in), else the most recently opened. It works from inside a session too.

```
nunchiro layout split <up|down|left|right> <widget> [--pin SESSION] [--zone ZONE] [--size PX]
nunchiro layout stack <widget> [--pin SESSION] [--zone ZONE]
nunchiro layout edge <up|down|left|right> <widget> [--pin SESSION]
nunchiro layout add <widget> [--pin SESSION]
nunchiro layout move <zone> split <dir>|stack|edge <dir> [--zone ZONE] [--tab N]
nunchiro layout remove <widget> | remove --zone ZONE [--tab N]
nunchiro layout pin <session> [--zone ZONE] [--tab N]
nunchiro layout unpin [--zone ZONE] [--tab N]
nunchiro layout resize <zone> <px>
nunchiro layout reset | undo
```

- Widgets (v1a): `tree`, `waiting` (the answer strip), `terminal`, `composer`; v1b adds `diff` and `files` (the
  focused session's folder, read only). A widget may appear more
  than once; an unpinned one follows the focused session, `--pin SESSION` (an id or the session's shown name)
  keeps it on one session.
- Zones are named in the file (`id`); the default layout has `tree`, `terminal`, `waiting` and
  `composer` zones, and new zones are named after their widget (`terminal-2`). Without `--zone` a command acts on
  the first terminal zone.
- `split` halves the zone (both halves share the space) and is refused when either half would go below its
  widget's minimum size. `edge` adds a zone at a window edge (264 px wide or 160 px high). `add waiting` puts the
  answer strip back above the composer.
- `remove waiting` prints that only signals remain (tree rows, AGENTS dots, tab dots, menu bar count). No command
  may remove the last tree, AGENTS and answer strip together.
- `reset` restores the default layout. `undo` steps back the file itself, up to 3 earlier versions written by
  Nunchiro (a window or the CLI), and needs no window. A hand edit, or any change
  Nunchiro did not write, ends that history: `undo` then says there is nothing to undo instead of dropping the
  edit.
- Output is JSON like the other commands: `{"type":"text","text":"<the command it ran>"}`.
- Errors: no running core or no open window (edit `layout.toml` by hand instead; `undo` needs no window); the
  target window is in layout edit mode (press Done or Cancel there first); an unknown widget, zone or option; a
  `layout.toml` that does not parse, which is kept untouched until it is fixed or removed.

#### `layout.toml`

Written by the window, editable by hand; the window reloads it on change. A file that does not parse, or has a
newer `version`, is never overwritten: the window keeps its last good layout and names the bad line in the
status bar. Without a file the default layout applies, and nothing is written until the first change.

```toml
version = 1

[root]
id = "main"
split = "row"            # "row": side by side; "column": top to bottom

[[root.children]]
id = "left"
size = 256               # pixels along the parent split; absent: share the rest
split = "column"

[[root.children.children]]
id = "tree"
widgets = ["tree"]

[[root.children.children]]
id = "agents"
size = 190
widgets = ["agents", "terminal@v1a-03"]   # two tabs; the second is pinned to session v1a-03
active = 1                                 # the tab shown first (0-based)
```

## Window-only APIs

The window's local API has operations with no CLI command: files (list, read, search), chat history,
approvals status, the board, and the quit settings. Every request, answer and event is in the published schema
([api.md](api.md)); the window's own operations are marked `x-stability: window` there and may change.

### `nunchiro api schema`
Prints the local API as one JSON Schema (draft 2020-12), the file `docs/api/nunchiro-api.schema.json`: the envelope
a caller writes to `core.sock`, the response it reads back, and the lines of `nunchiro events`. Each request
variant carries `x-stability`: `stable` for what an outside token may call, `window` for the rest. Needs no core.
See [api.md](api.md) for the socket, the callers and an example client.

## Plugins

A plugin is one folder, `$NUNCHIRO_HOME/plugins/<id>/`, that adds panels, commands and settings; see
[plugins.md](plugins.md). It is off and not approved after it is made or copied in, and runs nothing until both
change. `new` and `check` touch only the folder, so they work inside an agent session; the others are the owner's.

### `nunchiro plugin new <id> [--with panel,command,setting,gate]`
Writes a starter plugin (all four parts by default; `gate` is a check that allows every start) that passes `plugin check`. Never replaces a file.

### `nunchiro plugin check <id>`
Checks `plugin.toml` by the core's rules, then runs each script panel, command and check once in the widget sandbox on a
sample input, before and without any approval. Prints `ok` or `failed` per part; exit 1 when any part failed.

### `nunchiro plugin list [--json]`
One row per plugin: id, on or off, and approved, not approved, changed since approval, or broken (with why); also
which setting stops it (`script_widgets` or `web_widgets`).

### `nunchiro plugin on <id>`
Turns the plugin on. Its parts still run only while its approval matches its files.

### `nunchiro plugin off <id>`
Turns the plugin off; its panels leave the Widget library and its commands stop.

### `nunchiro plugin allow <id>`
Approves the plugin's files as they are now (the same as Review in the window). From inside an agent session it
asks the owner instead: one waiting item in the window.

### `nunchiro plugin run <id> <command>`
Runs one of the plugin's commands now, with no project, and prints its output.

### `nunchiro plugin remove <id>`
Moves the folder to `$NUNCHIRO_HOME/plugins/.removed/<id>-<time>` and forgets its switch and settings; move it back
to undo.

## Other machines

Each Mac runs its own core; see [remote.md](remote.md) for install, SSH settings and project mappings.

### `nunchiro --machine <alias> <command>`
A global flag that must come first. It runs `<command>` against the core on the machine named by the SSH alias
(`~/.ssh/config`, host key already verified; Nunchiro never prompts or edits SSH). Every command in this reference
works the same way, for example `nunchiro --machine macbook agent prompt worker 'Reply with OK.' --wait --until done`.
Each request has a 6 second bound; after a timeout the remote action may still have happened, so check
`machine status` or read the worker before repeating a state-changing command. `serve` and `serve restart` with
`--machine` start or restart the remote core. Both machines must run exactly the same Nunchiro version.

From a session, `--machine` still reaches only workers that session started remotely (unchanged by the local rule
above): `session start` or
`agent start` with `--project` set to the owner-mapped remote path (an unmapped project is refused), then prompt, send,
read, wait on and close those workers. Startup dialogs stay deny/Esc-only and the slash-command rule holds on the remote core. A session never gets
a remote owner token, so other operations on the remote core (`serve`, `serve restart`, `widget allow`, other sessions)
are not available to it.

### `nunchiro machine status [<label>]`
Reports `reachable`, `unreachable` or `version_mismatch` (with an error) for the named alias, or for every configured and
remembered alias when no label is given.

### `nunchiro --version`
Prints `nunchiro <version>`.

### `nunchiro hold <session-id>`
Internal (V2-1a): one session's PTY holder. Only the core starts it, with the listening socket
`$NUNCHIRO_HOME/holders/<short id>.sock` (0600) as its stdin; run by hand it exits with "nunchiro hold is started by
the core". It owns the agent's PTY, process group and 1 MiB replay, admits only a peer outside every session, and in
this version ends (stopping its agent) when its core's connection closes.

## Extensions

Ticket 455. The Skills & hooks page of Settings from a terminal. Each command is sent to the core as the owner's, so
inside an agent session the core refuses it as it refuses the window's. A change applies to new sessions.

### `nunchiro extensions list [--json]`
One line per item: id, kind (`skill`, `hook` or `plugin`), on or off, and its one-line description; `--json` prints the
rows as JSON. The last two rows are the window's two Nunchiro switches (ticket 580): `nunchiro-hooks` (the hooks
Nunchiro adds to new sessions) and `orchestration` (the orchestration skill). A folder with only skills is a `skill`,
only hooks a `hook`, both a `plugin`.

### `nunchiro extensions show <id> [<path>]`
The item's kind, state, description, its folder (custom items: edit the files there with your own editor, or in the
window; a change applies to new sessions), skills, the commands its hooks run, and its files with their sizes. With a
path, prints that file of the item; control characters other than line ends and tabs are shown as a mark.
`show nunchiro-hooks` lists the hooks Nunchiro adds, one line per event (read only); `show orchestration` says what
the skill is. Neither has files, so a path is refused.

### `nunchiro extensions new <name> --about "<one line>" [--hook]`
Creates a custom item under `$NUNCHIRO_HOME/extensions/`: one starting skill file (`skills/<name>/SKILL.md`), or with
`--hook` one starting `hooks/hooks.json` with a command that only prints a line on the Stop event. It starts off; turn it
on with `nunchiro extensions on custom:<name>`. The message names the file to edit.

### `nunchiro extensions on <id> [--yes]`
Turns the item on. An item that can run commands (a hook item, an item with hooks, and every custom item) first
lists the commands its hooks.json runs (a custom item without one says to read its files) and asks
`Turn it on? [y/N]`; `--yes` answers yes after you have read them. A no, or no terminal to ask in, changes nothing
and exits 1. Ticket 456: the window asks the same way (Settings > Skills & hooks shows the commands and needs Turn on),
and the core refuses an `extensions.enabled` change that adds such an item unless the request names it in
`extensions_confirmed`.

For `nunchiro-hooks` and `orchestration` no question is asked: they change what Nunchiro adds to new sessions, and
the hooks only report events to Nunchiro.

### `nunchiro extensions off <id>`
Turns the item off. For `nunchiro-hooks` it is the window's "Add Nunchiro hooks to new sessions" switch.

### `nunchiro extensions mcp [add <name> [--project <dir>] -- <command> [<arg>...] | remove <name>]`
Nunchiro's own MCP servers, the "Your servers" list of Settings > Skills & hooks. Each server goes to new Claude and
Codex sessions on their launch line; the agents' own config is never written. Without a word, lists one line per
server: name, `all projects` or the project folder it is for, its command, and a mark when the entry was changed
outside Nunchiro (no session gets it until it is removed or added again).

`add` stores the command (no env: a server that needs env gets it from your shell). With `--project`, only sessions of
that project folder get the server, a worktree's sessions included; a relative folder is taken from where you run the
command. Added again under the same name for the same projects, the server is replaced. A name already added for all
projects cannot be added for one project, nor the other way round, nor for a second project: the command says so in
one line, and you remove the old one first or pick another name. `remove` takes it out of new sessions. Each change
prints the list.

The file is `$NUNCHIRO_HOME/extensions/mcp.json`; each entry carries a seal over its name, command and project, so an
entry edited by hand (its project too) is not started. An entry for all projects is written as before, so an older
Nunchiro reads and starts it; an older Nunchiro starts no one-project entry.

## Skill

`plugin/skills/nunchiro/SKILL.md` teaches an agent this CLI. The core writes the plugin into
`$NUNCHIRO_HOME/plugin/` and starts every Claude session with `--plugin-dir` pointing there; nothing is written under
`~/.claude`. For Codex, copy the file by hand into the skills folder of your own Codex setup.

## Skills

### `nunchiro skill get orchestration [--file <name>] [--full]`
Prints the orchestration guide compiled into this binary: `guide.md` by default, one file with `--file`
(`guide.md`, `brief-template.md`, `report-template.md`, `review.md`, `levels.md`; any other name is refused), or every
file with `--full`, each after a `<!-- file: <name> -->` line. A file of the same name in
`$NUNCHIRO_HOME/skills/orchestration/` (default `~/.nunchiro/skills/orchestration/`) replaces the built-in one; a link
there or a file over 256 KiB is refused, never followed or cut. Updates never write that folder. Needs no core.

While Settings > Orchestration is on (default), Claude sessions get the `orchestration` stub in the `--plugin-dir`
plugin and Codex sessions get one `-c developer_instructions=...` line pointing at this command; nothing is written
under `~/.claude` or `~/.codex`. Off: new sessions get neither. Nunchiro sets no worker or depth limits; each agent
follows its own settings. Only the owner changes this switch.
