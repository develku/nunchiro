# Core session interface (V1A-02)

The foreground `nunchiro serve` process owns PTYs. All other commands are short-lived clients;
closing a socket does not close a session. A CLI command automatically starts the core if absent.
`nunchiro serve stop` stops owned agents/helpers and the core. Shell sessions become exited;
agent sessions with known conversation IDs become resumable. Explicit session close stays closed.
Resume replaces the previous row for that conversation/project and retains its agent ID across Stop.
Close/Stop removes session hook files. Test fixtures remove their own homes and worktrees.

Tests: `cargo test -p nunchiro-core` starts `target/debug/nunchiro` but does not build it; run `cargo build -p nunchiro` first (a missing binary fails with that message, `tests/fixtures/cli.rs`).

Default data folder: `~/.nunchiro`; override with an absolute `NUNCHIRO_HOME`. The data folder is
0700; `core.sock`, `core.token`, session hook settings and atomic metadata files are 0600. A lifetime
`flock` prevents competing cores and protects stale socket recovery. Each start rotates the owner
token. No credential handling, TCP listener or HTTP server exists in this ticket.

Logs (V2-13a) live in `logs/` in the data folder (0700): `core.log` (everything the core writes to stderr),
`panic.log` (each panic's message and location) and `sessions/<id>.log` (deleted when the session closes or its row
is replaced). Files are 0600 and rotate at 10 MB, keeping 5 (`core.log`, `core.log.1`..`.4`). Every line is redacted
before it is written: live session, core and window tokens become `[redacted:session|core|window]`, `Authorization`
values and `Bearer` words `[redacted:authorization|bearer]`, values of secret-named keys (`*token`, `*api_key`,
`*password`, `*secret`, `*credentials`, `Cookie`; JSON, `k=v` and header forms) `[redacted:secret]`, and provider key
shapes (`sk-ant-`, `sk-`, `ghp_`/`gho_`, `github_pat_`, `xox?-`, `AKIA`/`ASIA`, `eyJ…` JWTs; colour escapes count as
separators) their kind. A line over 16 KiB is cut at a space. Rotation opens the next file before renaming any, so a
failure (no file descriptors, no space) keeps every older file; lines the full file cannot take are dropped, said once
on the core's original stderr, and counted in the file (`[logs: N lines dropped: …]`) when it takes lines again.
Output the core does not control is to be quoted only through `logs::excerpt` (redacted, one line, at most 2 KiB).
`sessions/<id>.log` has no production caller yet, and `logs::excerpt` only the CLI's startup-failure message: V2-1a's
holder and ACP are their first real users. A failed rename in the rotation chain stops rotation until the core
restarts, so the moved files are never shifted twice.
While a CLI starts the core it reads the core's stderr, so a core that cannot open `logs/` says why
(`core startup failed: data folder must not be a symlink`); it closes that pipe once the core answers. Nothing
leaves the machine. A pre-v2 `core.log` in the data folder is left in place and no longer written.

`settings.json` in that folder accepts:

```json
{"disable_hook_injection": false, "worktrees_dir": "/absolute/optional/worktree/root"}
```

`worktrees_dir` (Settings › Git & Worktrees) may also be relative to the project: inside it or one level up beside it
(`../.worktrees`); any other relative path is refused. Unset, it is `~/nunchiro/worktrees` (in the user's home, never inside the data folder; made on first use). Set a folder
to use another disk. Each worktree record keeps the root it was made under; a record made before ticket 1083 lies
under `../.worktrees` (beside the repository) or, older, `<data folder>/worktrees`, and keeps working.

Injection defaults on. Claude receives a session-specific settings file with the hook events
listed in `sessions.rs`. Codex receives invocation-only hook overrides and
`default_mode_request_user_input` only when Nunchiro can prove they are the sole hook source.
The required `--dangerously-bypass-hook-trust` trusts every enabled hook for that invocation.
Detection therefore fails closed: any `hooks.json` or `plugins` entry in `$CODEX_HOME` (default
`$HOME/.codex`), or within project/worktree/ancestor `.codex` folders, disables both injection and
the bypass. So does any `config.toml` there except a regular file of at most 1 MiB that holds only
keys Codex writes itself (ticket 690): `projects.<dir>.trust_level`, `[tui]` and `[notice]` with only
their Codex 0.161 keys, `model`
and `model_reasoning_effort`, and the keys a person's own file usually holds, none of which can hold a
hook in Codex 0.161 (ticket 760): `mcp_servers`, `model_provider`, `model_providers`, `approval_policy`,
`sandbox_mode` and `sandbox_workspace_write` (`codex_written_config` in `sessions.rs`). Unreadable entries,
symlinks, malformed files and every other key, a later Codex's new ones too, count as potential
hook/plugin sources. Unknown home locations
and extra Codex launch arguments also disable injection because they can select other sources.
Existing user configuration remains read-only. Without injection, waiting detection falls back
to transcript and screen (ticket 01); any native trust dialog goes to the user, and the core
never answers it. Explicit injection off also removes these hook/feature overrides.
Codex always uses `--no-daemon`, so its process tree is owned
by this core. Installed agent executables and the user's existing config/plugins remain in use.
The core removes the launching session's variables from every agent, shell and login it starts: a fixed list
(`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_PID`, `AI_AGENT`, `TRACEPARENT`, the
`CODEX_THREAD_ID`, `CODEX_SESSION_ID` and `CODEX_SANDBOX*` markers and so on, `PARENT_SESSION_ENV` in `sessions.rs`) and
every `CLAUDE_CODE_MESSAGING_*` name, so a child neither acts as the outer conversation nor holds its messaging token.
User config and credentials stay: `CLAUDE_CONFIG_DIR` and `CODEX_HOME` remain intact (an account session replaces them),
as do `PATH`, locale, `CLAUDE_CODE_SKIP_PROMPT_HISTORY`, `OTEL_*` and any key the user exported.
`NUNCHIRO_HOME`, `NUNCHIRO_SESSION` and `NUNCHIRO_TOKEN` are replaced with this core/session's values.
Version probes and Git worktree creation run outside the registry lock, with 3 s and 10 s limits.
Full shutdown drains any in-flight preparation/rollback before the core exits. Child status failures
mark only that session `failed`; Close/Stop still work. PTY cleanup uses its own process group,
including when process inspection fails or the leader has exited. Exit observation uses
`waitid(WNOWAIT)`; the group is killed before reaping its leader. Close/Stop/Drop never
signal that group again once the leader has been reaped. Launch probes use the same ordering.

Claude gets a generated `--session-id`, or the explicitly requested `--resume` ID. Codex identity
comes from SessionStart or read-only inspection of rollout files opened by its own process tree
(macOS `ps`/`lsof`). Discovery requires exactly one CLI rollout with matching cwd and a valid ID;
it never guesses the latest global transcript. The fallback is fixture-tested; real Codex fallback
compatibility has not been verified on this host because live quota had no headroom.

## Transport and extension points

Public serde types live in `api.rs`. One newline-delimited `Envelope {token, request}` per connection
returns one `Response` (`{"Ok": <Reply>}` or `{"Err": "message"}`). Incoming frames are capped at
512 KiB. `server::call(home, request)` serves owner clients; `server::serve(home)` owns the core.
Session-scoped tokens are injected via `NUNCHIRO_TOKEN`; at this stage they authorize only their
own metadata hooks. Agent CLI grants are a later ticket. Tokens are never in snapshot metadata.

`Read {id, after}` uses absolute byte offsets. Reply `Output` contains raw bytes as a JSON numeric
array, start/end offsets and a truncation flag. Repeated reads with no new output return empty
bytes at the same offset; an offset ahead of output is an error. Each retained PTY has a strict
1 MiB byte ring; at most 32 PTYs (including exited replay) are retained until explicitly closed.
Terminal protocol CPR/DA replies come from the host, including while detached. CPR uses the fixed
initial origin; a future screen emulator can provide tracked cursor state. A terminal client must
avoid sending a second automatic reply to the same host-answered query.

`SendText` writes exact UTF-8 bytes without submission or bracketed-paste wrapping. Use explicit
`SendKeys ["enter"]` to submit. Input is capped at 64 KiB and backpressure is bounded to 100 ms;
a failure reports partial delivery and never queues a hidden retry. Keys are validated as a whole
before any bytes are written. Resize validates 1–500 columns and 1–300 rows.

The hook stub at `crates/nunchiro/src/hook.rs` forwards metadata and prints no permission decision.
`waiting`, `queue` and `http` are public empty modules reserved for tickets 03/07. Those tickets can
add serde-compatible commands/fields and their handling without replacing existing types. They
will supply waiting state, grants, hook answers and HTTP/WebSocket behavior; none is claimed here.

Metadata is versioned JSON in `sessions.json`, written through an owner-only temporary file,
fsync and atomic rename. Startup refuses malformed shape/types, duplicate IDs and invalid state/ID
relationships without rewriting the file. Restart never treats a persisted PID as live authority.
Since V2-1a the file is version 2: a `live` map keeps, per running session, the SHA-256 of its token (saved before
the agent launches, dropped when the session closes) and its holder (socket, protocol, pid and start time). A version 1
file reads with no `live` records and is copied once to `sessions.json.v1` first (`queue.json.v1` likewise). A `live`
record without its session row is a launch that never finished: dropped when it names no holder, refused when it does.
Each session's PTY is owned by its holder process (`nunchiro hold`, `src/holder/`); in this version a holder ends,
stopping its agent, when its core's connection closes. The core's link to its holder is one end of a socket pair
the holder inherits, never a connect by path; the path socket (`holders/<short id>.sock`, 0600 in a 0700 folder)
only answers other peers.

**Going back to an older core.** An older binary reads version 2 `sessions.json` and `queue.json` as another
version: it sets them aside (`<name>.v2.<time>.aside`) and starts empty, so the sessions it offers are gone. To go
back by hand: stop the core, then copy `sessions.json.v1` and `queue.json.v1` over `sessions.json` and
`queue.json`. The `.v1` copies hold the state from the first time a version 2 core opened this folder, not later
changes.

**Holder peer check limits.** A holder has no registry. It refuses a peer inside a session (a process-table session
leader whose parent runs the holder's own executable) and, since V2-1b r3, any peer that descends from a process of this
user whose first argument is `hold`, whatever install it runs from. Another user's ancestor (root's `login` above a
terminal, `sshd-session [priv]` over ssh) is walked through: its parent and uid come from the short process info,
which macOS gives for any process, and its arguments are never read, since a holder runs as this user. An ancestor of
this user whose arguments cannot be read refuses the peer. Still admitted, the accepted V1A-18 limit: a process that left its session's
tree (fork and `setsid` while its parent exits, `launchctl`, `osascript`, ssh), and a child that outlives its session's
leader. While a holder has no core, such a process can attach as its core and gets WRITE to that session. The core's
own check (registry leaders with their holder pids) is unchanged.

**Other versions (V1B-40).** A `sessions.json` or `queue.json` that is a well-formed JSON object with an integer
`version` this core does not read (V2-1a: it reads 1 and 2; a newer core's file) is set aside, never deleted or overwritten: the regular file is kept
beside itself as `<name>.v<N>.<unix-time>.aside` (`.<k>` added before `.aside` when the name is taken), mode 0600, the
folder is fsynced, the core starts with empty state for that file and logs one line naming the kept file. A
`queue.json` over the 8 MiB cap is parsed streamed and only its `version` is kept (it must still be
one object), and another version is set aside (an over-cap version 1 is still refused). Nothing in a set-aside queue is loaded, so none of its
items is answerable. While any `sessions.json.v*.aside` is kept, startup sweeps no saved scrollback or exports: their
sessions are only in the kept file. A malformed file (bad JSON, not an object, missing or non-integer `version`) or a
symlink is still refused with its bytes kept. Hook journal events are not covered: each already moves to
`hook-journal-quarantine/` on any validation failure, including another version. After a `sessions.json` is set
aside, version-1 journal events of its sessions (now unregistered) are quarantined too and the quarantine cap may
prune them; this is fail-safe (an event never reaches an approval, so no answer is lost or replayed).

Scrollback is bounded in memory; a stopped PTY's last 1 MiB is saved for the next core while `keep_history` is on (see
Lifetime and resume).

## Waiting and decision queue (V1A-03)

The core polls current terminal cells every 50 ms; a separate worker discovers and reads
transcripts outside the session registry mutex,
plus session hooks. Each snapshot session adds `pending`, `completion_seq` and `attention`
(`working`, `waiting`, `stale`, `failed`, last activity, background count, observer error,
`skipped_transcript_lines`).
Existing version-1 session metadata loads with defaults. Complete malformed transcript lines
are skipped and counted durably with the cursor; oversized lines are discarded across bounded
1 MiB reads, including restart. Other transcript I/O failures appear in `observer_error`.
Nonregular/symlink inputs are refused without blocking. Read results are applied only if session
identity, path and cursor still match; closed sessions and shutdown discard late results.
Screen observation and lifecycle commands remain available even during slow transcript I/O.
Queue persistence errors are logged without preventing explicit Close/Stop; an invalid
store still blocks the next start until repaired. Transcript
paths come from session hooks or the exact conversation ID, never the newest global transcript.
The VT reader handles split UTF-8/control sequences, cursor movement, erasure and scrolling;
only current cells supply decisions, not historical scrollback. Detection patterns target the
versions documented in the PTY-path report; unknown layouts require adapter updates.

Internal `queue.json` version 1 stores a session-ID map: agent kind, attention, pending items,
last hook time, active background IDs, active/completed turn identities and transcript
file identity/byte cursor. Each item has a generated ID, session/scope, kind, text, numbered
choices with keys and settings-change flags, evidence sources, observation time, reconciliation
and actionable flags, and an optional hook event ID. A separate `seen` map deduplicates journal
event IDs. Store size is capped at 8 MiB, 4096 sessions, 64 items per session and 32768 seen events;
question text is bounded at 64 KiB. Limit violations are reported, never silently evicted.
Writes reuse the fsync/atomic-rename helper (0600 files, 0700 data directory). Malformed shape,
field types, duplicate item identities and foreign session relations fail without overwriting the
store (another version is set aside, see Other versions above). Transcript events, skipped-line count and cursor/discard state
commit together. Identical states do not rewrite the file. Activity timestamps checkpoint at
most once per second; the live stale clock and snapshots retain exact activity between writes.

`hook-journal/<unique-id>.json` version 1 contains `event_id`, `session_id`, event name, payload
and epoch-ms creation time. No authentication token or saved answer is written. Credential-named
payload fields are removed recursively; hook tool arguments remain user data. Admission is
serialized by an owner-only lock; maximum 1024 files, 128 KiB per event, 24-hour age. Expired
valid events are removed. Admission ignores malformed/newer entries it did not write (they still count toward the cap) and
never alters them.
On startup, malformed/newer, unknown-session and unreplayable/over-limit events are moved
byte-for-byte to `hook-journal-quarantine/` (0700 directory, 0600 regular files), outside replay.
The directory is capped at 64 files and 8 MiB; the oldest (by change time) are pruned first, the
file just quarantined is exempt, and pruning errors are logged without blocking replay. Each move
and prune is logged; snapshot sessions report recovery warnings through `observer_error`.
Valid events replay idempotently and acknowledged files are removed. A recovery/quarantine
filesystem failure is logged and flagged rather than keeping the core down; no rejected event
is approved or replayed. Queue-store corruption still fails closed as described above.
Pending evidence survives restart, marked reconciled and non-actionable until seen by a live
session again. Explicit resume copies prior pending evidence and the completion counter to
new decision/session identities; old choices, screen bindings and hook-response authority are
cleared. The old mapping remains durable if the session metadata commit fails and counts
against store limits until coordinated retention is available. Replaying never writes PTY
bytes or replays an approval. Core death loses the PTY owner; surviving process continuity
is not claimed, and sessions require explicit resume.

`QueueConnect` is an owner-client heartbeat with a 3-second lease. A permission hook waits at
most 1.4 seconds only while a client has a current lease; otherwise it returns no decision
immediately. The hook subprocess has a 1.8-second overall bound, journals before delivery and
prints nothing on connection failure, timeout or no decision. `Answer {item, answer, confirmed}`
accepts `allow_once`, `deny` or `choose {index}`. Only an explicit answer can return a hook allow.
Questions use numbered choices read from the current screen. A numbered choice prompt that matches
no known kind is a dialog (deny/Esc only) when exactly one choice line carries a cursor glyph and
the screen shows "enter to confirm", "enter to select" or "esc to cancel"; "esc to interrupt"
and quoted `>` lists never qualify. Every dialog choice is terminal-only,
regardless of label or confirmation; only explicit deny/Esc may answer a dialog. Late permission
answers use verified screen choices when the hook has already returned, and only on a screen that
shows that hook's own request: for Claude, below the last full-width rule, the Edit, Write (create, or
an overwrite whose diff shows the whole new file) or Bash prompt with exactly the request's body, the
diff gutter read as one column; for Codex, the command approval prompt with exactly the one-line
command. Anything else refuses the late answer. It is refused outright (the item stays pending with its
text and the refusal says to answer in the terminal; its hook still answers while it waits) when a matched
line of the request (Edit old/new text, Write content, the command) ends in whitespace, when the command
spans lines (LF or CRLF), and while more than one hook permission is pending for the session. Beside such a
held item, another prompt the screen provably shows (its question names none of the held requests) appears as its
own card, view-only: nothing can be sent from it and it says to answer in the terminal; a dialog card there answers
only with Esc (V1B-32). The held request's own prompt adds no card. A view-only card is never continued:
when the hold ends it goes, and the next frame or hook gets a fresh card. Durable removal precedes
input delivery so crashes can lose a send but cannot repeat it; failed sends have no hidden retry.
Settings-changing choices return `confirmation_required` first; persistent trust/config choices
remain terminal-only even after confirmation, per the R3 coordinator ruling. No automatic trust.
A valid hook reply is still printed if journal acknowledgement cleanup fails; the cleanup
error is logged and event replay remains idempotent.

`stale_after_ms` in Nunchiro's `settings.json` overrides the default 1,200,000 ms threshold.
Activity resets the clock; waiting sessions are excluded. A main Stop with active background
work does not finish the turn. Transcript background starts and hook task/agent completion
preserve that rule across source order; duplicate finish signals do not increment twice.
Use `cargo build --workspace`, then `scripts/scenario/matrix.sh --core`: default five live runs
per row, `RUNS=30` expands only rows whose first five passed. Receipts include config attribution
guards; these runs use real installed agents and no permanent-trust answers. The `--core`
mode requires installed tmux (calibrated with 3.7c) as its independent current-screen VT
reference, using a separate owner-only socket and `/dev/null` configuration per attempt.
Codex runs require quota or a positive existing credit balance (authorized by the host model
roster); exhausted quota without credits or unreadable usage produces `not run`.

K/XK follow needs 32 and amended spec Acceptance 1 (owner ruling `ad14883`): agents end with
the core. On restart, pending items must be reconciled and not answerable, the session must
be offered for explicit resume, and saved input or approval must never replay. The matrix
checks the restored state, resume identity, refusal of an answer and absence of execution.
Synthetic regressions separately prove timeout/disconnect fallback with the PTY owner alive
and explicit-resume recovery without replayed approval or input.

The waiting observer feeds the screen at most 64 KiB per session per pass (V1A-19), so a
flooding session never holds the registry lock for long. While a pass leaves output unfed, the
screen is not current and every action decided from it fails closed: answers, agent keys, sends
(owner interrupts excepted) and model switches return `screen not current, try again`, queued
sends and a model switch's next key wait, and a pending Enter waits up to 10 s, then fails its
row. A session that never stops producing output therefore cannot be answered through
screen-only decisions; hook-sourced permission answers still work. This is intended.

## Chat events

The public chat schema is version **1**. `chat::project(agent, record)` projects one JSONL
record to data objects; persisted and transmitted events wrap them as
`{schema_version:1,cursor:<u64>,data:<object>}`. Cursors are stable, increasing ordinals
within one generation of an adapter/conversation's persisted projection, not tool ids or transcript line numbers.
Tool rows remain ungrouped; link a result to its call using `tool_id`.

Data variants:

| `kind` | Fields |
|---|---|
| `message` | `role` (`user`/`assistant`), `text` |
| `image` | `role`, `source`: Claude `{type:"base64",media_type,data}`, Codex `{type:"url",url}` or `{type:"path",path}`; no file is opened or saved by projection |
| `thinking` | `text`; Codex encrypted reasoning is omitted |
| `tool_use` | `tool_id`, `name`, `input` (JSON object or an unparsed string) |
| `tool_result` | `tool_id`, `output` (string or content-block array), `is_error` |
| `edit` | `tool_id`, `path`, `added`, `removed`, `hunks`: Claude structuredPatch objects (`oldStart`, `oldLines`, `newStart`, `newLines`, `lines`), or Codex apply_patch lines (`@@`, context, `+`/`-` lines). Deletion adds `operation:"delete"`, `removed:null` (no preimage); rename adds `operation:"move"`, `destination` |
| `task_result` | `tool_id`, `text`; only a sidechain final with an explicit parent tool id; otherwise sidechain records are suppressed and the parent's Task tool result supplies the final text |
| `turn` | `turn_id` (nullable), `state` (`started`/`completed`/`interrupted`) |
| `skipped` | `count`; malformed JSONL and unknown top-level, response-item or content-block records, never raw JSON |
| `version_banner` | `agent`, `version` (`unknown` when absent) |
| `final_text` | `turn_id`, `text` from a main-agent Stop hook |
| `artifact` | `tool_id` (null for a block), `source` (`written`/`edited`/`block`), `type` (`html`/`svg`/`markdown`/`image`), `root` (the Nunchiro session id, or `data` for a block), `path` (relative to that root), `title` |

`artifact` (ticket v1b-06, additive; schema stays version 1): emitted right after the successful `tool_result` of a
Claude `Write`/`Edit`/`MultiEdit` or a Codex `apply_patch` (exit code 0 or `Success` output) that touched a `.html`,
`.htm`, `.md`, `.svg`, `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp` file (a move counts at its destination, a deletion
never), and after an assistant message for each `nunchiro-artifact` fenced block (info string optionally followed by
`html`, `svg` or `md`; default `html`). A failed call (`is_error`, a non-zero exit) yields none. `path` is made
relative to the session folder when the agent wrote an absolute path inside it; anything else (outside, `..`) is
kept as written, and the file API refuses it, as it refuses a symlink out, so such a card cannot open. A block is
saved before its event as `NUNCHIRO_HOME/artifacts/<session-id>/<sha256>.<ext>` (0600 in 0700 folders, atomic,
written once per content); over 2 MB or an unknown type is neither saved nor emitted. Saved blocks are not pruned.
`title` is the HTML/SVG `<title>`, else the first Markdown heading (tags stripped), else the file name; an edit
without the file's content uses the file name. Projection stays pure: detection runs over projected events in the
store's indexing loop, which alone saves blocks. A cache indexed before this kind (no `artifacts` key in its
metadata) starts a new generation once so its history backfills. Known limits: `root` is the session id at
indexing time (the window uses its own session for non-`data` roots, so a resumed session still opens them); a
Codex patch applied through a shell command is not detected. A transcript line over 1 MiB (the indexer's batch limit) is
skipped as unreadable, so a Claude `Write` whose record carries more than about 1 MB of content gets no card: the
skipped line exposes no path or size to show a "too large" card from; the window shows the skipped count instead.

A page is `{schema_version:1,generation:<u64>,events:[...],before:<exclusive cursor or null>,end:<latest cursor>,
banner:<version event or null>,skipped:<cumulative count>}`. `banner` pins the untested-version
warning even when history exceeds one page; deduplicate it against its ordinary history cursor.
An untested adapter exposes the banner and Stop texts, suppressing parsed conversation content.
The parser still counts unreadable records. `TESTED_VERSIONS` is shared by launch and chat;
passing `[]` to the store's page/since methods exercises the untested-version fallback.

Window WebSocket frames (same `/ws` token and Origin gates as terminal output):

- Newest page and subscribe: `{"id":1,"chat":"<session>"}`. Reply:
  `{"id":1,"response":{"Ok":{"type":"chat_page","session":"<session>","page":<page>}}}`.
  It returns up to the newest 200 events and starts live updates at `page.end`.
- Older page: `{"id":2,"chat":"<session>","before":<page.before>}`. Same reply shape;
  it does not change the live cursor. Null `before` means newest, not an older-page request.
- Live push: `{"event":"chat","session":"<session>","page":<page>}`. Up to 200 events
  per push; cursors advance only through delivered events, catching up without gaps.
  A skipped-count update may have no events. On read failure the subscription is removed and
  `{"event":"chat_error","session":"<session>","error":"..."}` is sent.
- Owner API equivalent: `{"op":"chat_page","id":"<session>","before":null,"after":null}`;
  `after` requests up to 200 live events strictly after that cursor. `before` and `after` are
  exclusive. A nonexistent session or invalid cursor returns `Err`. Closing the socket drops
  subscriptions; at most 64 chat sessions per socket, independently of terminal watches.

Persistence: `NUNCHIRO_HOME/chat/<agent>-<conversation-id>.json` (fallback identity: Nunchiro
session id before discovery). Formats are described below. Parent folder 0700, files 0600;
metadata uses atomic fsync/rename via the existing store helper. Invalid/newer files are refused
and left untouched. Explicit resume keeps the conversation key. Stop payload `turn_id`/`prompt_id`
wins, followed by a journal event id, then queue completion sequence for direct nonjournal hooks.
A journal id remains stable when recovery replays an already durable queue effect. The transcript
is never written, moved or truncated.

Chat uses `waiting::transcript::read_batch` with an independent persisted cursor: waiting can
already have consumed historical records before a window subscribes. This replaces the brief's
advisory shared-cursor design; it preserves waiting/queue behavior and permits history backfill.
Reads use the same 1 MiB batch/partial-line handling and validated agent path. The cache retains
history on disk, with append-only length-prefixed event records (`<uuid>.events`) and fixed-width
8-byte offsets (`<uuid>.index`). Small version-2 `<conversation>.json` metadata commits source
identity, byte cursor, generation and log positions atomically; uncommitted log tails are trimmed
on the next append. Version-1 caches upgrade by streaming events and Stop texts. Invalid/newer
metadata remains untouched. Stop text has its own version-1 `<conversation>.stops.json`, event log
and `.stops.lock`; a successful hook acknowledgment follows fsync and atomic metadata commit.
The Stop queue/waiting effects retain their existing order under the registry lock; only the
chat append runs afterward, with a 750 ms wait. A timeout is an error, leaving the hook journal
available for retry/recovery. At most one append per conversation can be pending.

The in-memory cache holds at most 64 conversation slots. Each projection or Stop log retains
at most 200 recent events and 256 KiB of recent JSON. Pages contain at most 200 events and 2 MiB (an individual
record is capped at 2 MiB). Older pages seek through the disk index. Both transports capture a
plan under the registry mutex and perform all chat source/cache I/O after releasing it. Disk
history grows linearly with retained events; it is not automatically pruned. A replaced inode,
shrink, or changed sampled prefix/boundary starts a new generation and clears projected history
while retaining Stop texts. `page.generation` is additive; live watchers receive `chat_reset`
with a newest page when it changes. Consumers discard their old generation on that event.
The fingerprint samples the first and last 4096 consumed bytes; edits strictly between these
samples require source rotation to be detected. Release probe:
`cargo test --release -p nunchiro-core --features measure --test chat_performance -- --nocapture`. No new dependency, rendering or image saving is included.
## Approvals

One mechanism approves anything Nunchiro runs on the user's behalf (script widgets, web widgets, board
integration commands). `approval::check` is the only way to learn a subject is approved and returns a
`Proof`; nothing in the module spawns a process. The runner (tickets 17, 19) must hold a `Proof` and call
`check` again right before it spawns, because files can change after a check returns.

**Approval subject.** Subject kind `widget` names `NUNCHIRO_HOME/widgets/<name>/`; subject kind
`source` names an Integration source command at `NUNCHIRO_HOME/sources/<name>/`. Both contain
`widget.toml`. The trusted NUNCHIRO_HOME is resolved once before opening the subject namespace;
symlinked homes are supported, while links at or beneath `widgets/` or `sources/` are refused.
Names are `[a-z0-9_-]`, at most 64,
not starting with `-` or `_`.

**`widget.toml` (version 1).** Exactly these fields; an unknown field, a missing or other `version`, or a bad
value refuses the manifest:

| field | type | rule |
| --- | --- | --- |
| `version` | integer | must be `1` |
| `kind` | string | `script`, `web` or `integration` (a board command approved on the same sheet) |
| `author` | string, optional | shown as "made by"; `unknown` when absent |
| `command` | array of strings | script and integration only; non-empty argv, no empty word |
| `entry` | string | web only; relative path inside the folder, no `..` |
| `interval` | integer, optional | seconds, 1 to 86400, commands only |
| `permissions` | array, optional | `read`, `act`; default `["read"]`; must include `read` |
| `network` | array, optional | exact lowercase hostnames; no wildcard, port or scheme |

**Text rules.** `command` words, `entry`, `author` and the `[act]` `session` label hold only characters the shared `delivery::shown` allowlist draws: General Category L, M, N, P, S or Zs, minus Default_Ignorable and the blanks U+2800, U+16FE4 and U+1D159. So no control (tab, ESC, DEL), bidi, tag, zero-width, variation-selector or line-separator character reaches the sheet, and the sheet and the CLI show text as it runs, in that order. The manifest is parsed from the exact `widget.toml` bytes that went into the hash, and files are opened without following symlinks.

**Command rules (V1B-21, V1B-31).** The hash covers only the folder, so `command` may name nothing outside it:
- argv[0] is a relative file in the folder, a bare PATH name, or a binary directly in `/usr/bin`, `/bin`,
  `/usr/sbin`, `/sbin`, `/opt/homebrew/bin` or `/usr/local/bin`. Its name must be ASCII after case folding.
- No word holds a `..` component or a path outside the folder. A path is found at the word start, after a
  separator (`=@:,;'"()[]{}<>|&` `` ` `` `$`, whitespace) or after short option letters (`-o/x`). It may be
  absolute, `~`/`~user`, `$NAME/`, `${NAME}/` or a `file:` URL. Other `scheme://` URLs pass.
- A listed interpreter never takes inline code: sh, bash, zsh, dash, ksh, csh and tcsh `-c`; fish `-c`/`-C`/
  `--command`/`--init-command`; node `-e`/`-p`/`--eval`/`--print` and any `data:` option; osascript `-e`; env
  `-S`/`--split-string`.
  - python*, perl and ruby take only the option words in `ALLOWED_INTERPRETER_FLAGS` (manifest.rs); any other
    option word, a cluster such as `-lw` included, is refused as inline script. Value flags take a glued plain
    value: perl `-Ilib`, `-MName::Space` (no import list); ruby `-Ilib`, `-rname`.
  - Every word is checked, so a wrapper (`nice`, `timeout`, `nohup`, `xargs`, `env`, any other) cannot hide one.
  - A name matches after full case folding, as APFS compares names (`/bin/ſh` is sh), plus a trailing version
    (`perl5.34`, `bash5`).
  - Options end at `--` or at the first word that neither is an option nor directly follows one. This refuses
    too much (`python3 -u run.py -c x`) rather than too little.

This is a denylist and stays incomplete. These stock or common programs still run inline code and are shown verbatim but not parsed:
- `expect -c`, `tclsh` (and `tclsh8.5`) reading code, `sqlite3 db '.shell cmd'`
- `ssh -o ProxyCommand=...`, `git -c alias.x='!cmd'` or `core.pager`, `vim -c '!cmd'`
- awk, sed and `find -exec`
- `deno eval`, `php -r`, `lua -e`, `pwsh -c`, `su -c`

A path glued after more than one option letter (`tar -xf/path`) is not found, and a later argv word whose name
does not fold to ASCII is not checked as an interpreter.

`env NAME=VALUE` assignments are not refused, so variables that make an interpreter run code (PERL5OPT,
NODE_OPTIONS, RUBYOPT, BASH_ENV, PYTHONSTARTUP, DYLD_*) pass. The boundary that limits what any run can read is
the sandbox read scope, not these checks. V1B-33 (planned) sets that scope to the project, the cache and a tool list
by default, with declared read paths approved per widget.

**Content hash.** `sha256("nunchiro-approval-v1\0" ++ entries)`, where entries are every regular file in the
folder (nested ones too) except the top-level `cache/` folder, sorted by relative path bytes, each as
`u64be len(path) ++ path ++ exec byte (1 if any x bit is set) ++ u64be len(content) ++ content`. A rename,
add, delete, content edit or exec-bit change gives a new hash. A symlink or special file refuses the folder;
at most 2000 files and 32 MiB.

**Store.** `NUNCHIRO_HOME/approvals.json`, version 1, written atomically with mode 0600:
`{"version":1,"approvals":[{"kind"?:"widget"|"source","name","level":"read"|"act","hash","granted_at_ms"}]}`.
One entry per `(kind, name)`; omitted `kind` means `widget`. A same-named Integration source and
widget never share an approval.
A file that is invalid or newer is an error and is never rewritten; unknown top-level fields are kept.
States: no entry is `unapproved`; an entry whose hash matches the folder now is `approved`; any other is
`changed` (asked again). `act` implies `read` and can be granted only if the manifest declares it. Never
(answer decisions, change settings, touch agent config) has no API and no level.

**Requests** (socket and window API):

- `{"op":"approval_status","name":"open-prs"}` replies
  `{"type":"approval_status","view":{name,state,level,hash,manifest{kind,author,command,entry,interval_secs,permissions,network},manifest_text,cli}}`.
- `{"op":"approval_grant","name":"open-prs","level":"read","hash":"<hash from the view>"}` replies the same
  shape after storing. It is refused if the folder's hash is no longer the one the user was shown.

**CLI.** `nunchiro widget allow` grants without showing the folder content it hashed; it prints the command and hosts afterwards. Review the folder (or use the sheet) first.

**Trust.** Only the user's authority grants: the window (its own token) and a CLI or socket caller outside every
session. V1A-23: a session caller (a session token, or the owner token from inside a session, see [Owner peer
check](#owner-peer-check-v1a-13)) asking `approval_grant` or `board_source_grant` approves nothing: the core raises one
owner item (subject kind, name, level and the hash at that moment; one per subject, a new hash replaces it) and replies
`{"type":"waiting","item":"<id>"}`; `nunchiro widget allow` prints `waiting for the owner in the Nunchiro window`. The
owner answers in the window: a widget or source item opens this sheet (for a source it reads `board_source_status` and
grants with `board_source_grant`; the approval clears the item; a stale hash refuses), `allow_once` on an approval
item is refused, and `deny` dismisses. Session callers cannot answer owner
items. Owner items persist in `queue.json` (`owner`, omitted when empty) across core restarts and show in the
snapshot's `owner_decisions`.

## Agent CLI and grants (V1A-04)

`NUNCHIRO_TOKEN` is the session token, replacing the owner token inside each PTY;
`NUNCHIRO_SESSION` identifies that PTY. V1A-23 (needs 47, OWNERC = D'): the token names the caller (send logs,
"sent by") but no longer limits reach. A **session caller** (a session token, or the owner token from a peer inside
a session, see [Owner peer check](#owner-peer-check-v1a-13)) runs the owner commands: list/snapshot show every
session (board decisions and owner items stay the owner's); read, send, keys, lifecycle and close reach any session;
start and resume work in any project; `stop` (`serve stop`, `serve restart`) and `layout`; worktrees open and remove
whatever their creator (the record's `creator` is display only); `approval_status`. What stays the user's:

- the two human actions: `approval_grant` and `board_source_grant` (widget or integration source) and turning
  `permission_answers` on become one owner item each (`ask_owner`, `Reply::Waiting`) instead of acting;
- dialog and permission answers, below (a remote caller's yes also needs the flag its machine delegated); the Claude submit slash check and composer tracking (a session caller's
  submit is a token submit, never the token-less owner submission that resets tracking);
- `window_auth`, `--machine` transport requests and hook intake for another session are refused;
- the window's own features stay the owner's and the window's, as before: files, diff, chat pages, image uploads,
  widget list/run/act/page, the board (including source status and move), quit settings, `queue_connect` and model
  switches (`operation not granted`).

Tokens expire with the core/session. Remote callers (`--machine`, V1A-06) keep the V1A-04 rule: their own project
and the workers they started (`Grants`, in memory; a core restart ends them, needs 32).
Hook tokens still submit events only for their own session.

The owner alone turns on this optional `settings.json` field (default empty/off), with
`nunchiro permission-answers on|off [--project <dir>]` (request `permission_answers`):

```json
{"permission_answers": {"/absolute/canonical/project": true}}
```

The map is per project. A session caller's `on` raises an owner item (the owner's `answer` with `allow_once` on it
writes the field); its `off` applies. Allow-once permission answers by a session caller require the setting for the
target session's project; deny/Esc remains available with it off. Answers allow only
`allow_once` or `deny`. Numbered
keys are accepted only when they exactly match a verified current choice; persistent
options are refused. Dialogs accept only explicit Esc/deny. Questions use their current
numbered choices. For token callers to Claude, every Enter/submit checks the composed
input from tracked text and the current readable composer, including split sends and
embedded newlines. Unicode format/zero-width characters are removed for this check;
after trimming/lowercasing, slash command words must be exactly `/clear` or `/compact`.
Raw owner `send_text`/`send_keys` writes make Claude composer tracking uncertain until a successful write ends in Enter (`\r`); an owner submission then resets tracking for later token prompts. Failed/partial writes remain uncertain.
Interrupting nonempty tracked input or making unverifiable edits keeps the guard uncertain until a token-less owner submits a replacement. An old empty prompt on screen cannot establish that Esc/Ctrl+C cleared the composer. Token-less owner
submissions keep user authority. Esc and Ctrl+C reach working agents immediately.

This is same-user authority, not an OS sandbox. Stripping the token or reading the owner token inside a session
gives nothing more than the session token ([Owner peer check](#owner-peer-check-v1a-13)); SSH, direct
filesystem access, editing the settings file or the approval store (a `serve restart` from a session now loads an
edited `settings.json` at once) and the residual escapes listed there can still bypass it.
A token-less CLI caller outside every session retains user authority. The CLI/skill documentation must
carry these limits too.

New socket requests: `agent_prompt`, `agent_send`, `agent_keys`, `agent_get`,
`agent_read`, `cancel_send`, and `worktree`. These are internal transport variants;
the CLI surface is defined in `docs/v1/spec.md`. `agent get` adds `status` and the
`agent_session` alias to session JSON. Read defaults to the current screen; transcript
source returns recent JSONL records from the verified conversation (at most 1 MiB).
Transcript I/O runs outside the Sessions mutex, then rechecks the caller and session
identity before returning. A missing/vanished transcript returns `transcript source
unavailable` explicitly rather than substituting screen data.
`agent cancel <session> <send-id>` cancels an undelivered send.

`Session.send_log` is an additive, default-empty field in the existing version-1
`sessions.json`. Each row records id, sender, time, content or keys, submit flag,
completion/activity counters and status: queued, attempting, delivered, canceled or
failed. It is visible in snapshot and agent get, bounded to 256 rows per session;
the oldest finished row is dropped when a new finished row is recorded.
Active sends are stored separately in the default-empty `Session.send_queue`; a full history never rejects a send or an interrupt. Snapshots also project the newest 256 active/history records into `send_log` for existing readers; all active ids remain in `send_queue`.
Text is bounded to 64 KiB and keys to
100 per send. The owner-only atomic session store persists the log before PTY input.
An interrupted/queued send is canceled on restart, never retried. A queued prompt
waits for an idle turn with no open decision; the initial turn requires a visible
Claude `❯` or Codex `›` composer; after a submission, another
queued send requires a later completion. Closed targets/revoked senders cancel their
queued input. Only open dialogs, questions and permission prompts refuse a prompt with
`agent_blocked`; stale/background attention does not. A non-waiting queued prompt returns
its queued status and cancelable send id immediately. `--wait` waits for delivery and
the requested state; a timeout while still queued returns that queued record. Only after
delivery and five seconds without activity does the CLI return `agent_prompt_stalled`.
Prompt `--wait` compares the submitted turn's counters, not an earlier busy turn's completion.
Each delivery tick attempts at most one send per ready session, across all sessions.

The gap rule: nothing is typed into a Claude or Codex input box that shows text the core did not put there (not
the agent's faint suggestion or placeholder): every queued submit waits, the owner's own too, and the snapshot names
the reason (`send_waits`: `terminal_text`). A message from another sender (a lead, another agent, a schedule, the
core) also waits while the owner types for that session: `typing` (the window sends `typing` from its composer, at
most every 2 s, and any key the terminal sends counts) holds such rows for 5 s after the last one. The owner's own
prompts never wait for his typing; answers into a running turn, deny notes and widget acts do not either. On another
sender's queued row the owner may `send_now` (no typing wait), `send_later` (it waits until a turn ends after his
next submit), `send_attach` (it goes with his next prompt, under his words, as `[Message from <name>, attached by
the owner]`, in one paste; a prompt starting with `/ ! # &` takes none) or `send_detach` (back to later). These five
requests are the owner's and the window's only. Type in terminal (`direct`, owner and window only) holds such messages too
(`direct`) while the owner types in the agent's own box; it ends 60 s after his last key there or the window's last
renewal. The snapshot's `at_box` says the agent's input box is on a current screen and nothing asks.
Text the owner left in an agent's box comes home (sessions/home.rs): when a queued row waits only for that text and the
session would take it now, or Type in terminal just went off, and the box holds one row of his words (no collapsed
`[Pasted`/`[Image` label), on a current and still screen, with no key for 5 s, the core writes `{words, at}` to
`<home>/aside/<id>.json` (0600, atomic), then three Ctrl+U. Once a later pass reads the box empty the snapshot's
`draft_home` hands the words to the window's composer, which answers `draft_taken` (the file goes); with no window it
waits for the next one, also over a restart. A box not empty 1.5 s after the clear gets nothing more (the row keeps
waiting as `terminal_text`, and the file goes while the box still shows the words). `draft_put_back` pastes words back
into an empty box with no Enter. `take_back` (owner and window only) is ⌘Z on another sender's message in the box waiting for its Enter
(pasted, or left after a dropped Enter): no Enter goes, the box is cleared (two Ctrl+U per row and one more) and the
row waits as Later; the snapshot's `take_back` says one is there. A message the agent already took is not undone. Spaces at the very end of the line are not kept (the screen does not hold them). The marks live in memory: queued rows never outlive a core. Other
`send_waits` reasons: `turn`, `dialog`, `later`, `attached`.

Text, settle, Enter (V1A-15): a submit send (`agent prompt`, the window's composer) to a Claude or Codex agent that
has bracketed paste on (its last `ESC[?2004h`/`ESC[?2004l` switch, tracked from PTY output) writes the text wrapped
in `ESC[200~ … ESC[201~` and leaves the send `attempting`. A later delivery tick writes Enter as its own write once
the agent's echo shows its composer holding text, or at the 3-second settle deadline when nothing was drawn since the
paste; a deadline Enter marks the row `settle: "settle_timeout"`. Right before the Enter the tick rechecks the
session: an open dialog, permission or question, a model switch, Claude's model picker on screen, a working agent,
or (at the deadline) an echo without the composer holding text drops the Enter for good; the row ends `failed` with
`settle: "enter_dropped_<blocked|switch|picker|working|composer>"`, the text stays in the composer, and nothing is
pressed on the dialog. Only then is the send `delivered`, the submitted turn's counters taken and the
in-flight completion set. Real Claude Code takes a long `text\r` in one read as a paste and never submits it.
While the Enter is pending the session takes no other queued send; `esc`/`ctrl+c` cancels it (`canceled`), a close
or agent exit cancels it, a failed Enter write fails it. Text cannot end the paste early: send text refuses ESC and
C1 controls. Without bracketed paste (and for shells) the text and Enter stay one write. Text plus markers must fit
the 64 KiB PTY write. `NUNCHIRO_SETTLE_MS` on the core overrides the deadline for tests, never below 250 ms.
Raw `session send-text`/`send-keys` (owner path) are not queued behind a pending Enter: text typed that way in the
meantime is submitted by that Enter, by design.

Worktrees created through the CLI have version-1 metadata in `worktrees.json`,
with canonical project, managed path, branch, label and, for a token caller's create,
`creator` (its session id; absent on owner-created and older records). `worktrees.lock` serializes
operations; metadata and lock are 0600, managed parent directories 0700. Invalid,
newer, wrongly typed or relationally invalid metadata is refused without overwriting
it. Git operations run outside the session registry lock, with a ten-second bound.
Configured roots are canonicalized before deriving records. A removal reserves its
path until Git returns; all start/open paths reject that reservation.
Create pins the requested base to a commit and never writes trust. Open starts a
shell session in a managed worktree; list returns managed records; remove refuses
live sessions and uses Git's non-force removal, preserving dirty worktrees and branches.
A managed record whose path has disappeared is listed with `missing: true`, without
blocking other worktrees. Open refuses that missing record; remove drops just that
record only. Git metadata, including unrelated stale registrations, is kept; the CLI
tells the caller to run `git worktree prune` themselves if needed only for a path observed missing before removal. Existing worktrees
and branches are kept. Missing paths must still have normalized, non-aliased ancestors under the managed root.

`serve restart` waits up to five seconds for both socket removal and release of the
old core lifetime lock before starting the replacement; socket removal alone is not
a completed shutdown.

An unresponsive core that does not answer Stop returns `core did not answer stop`
after the socket read deadline; the CLI does not start a replacement on that error.

## Owner peer check (V1A-13)

The owner token (`core.token`) is owner authority only when the socket peer passes `peer.rs`: the same uid
(`getpeereid`) and not inside a live session of this core. V1A-23: inside one, the core does not refuse; it treats the
request as that session's caller (its token), with exactly a session token's reach (see
[Agent CLI and grants](#agent-cli-and-grants-v1a-04)). Another uid, or a failed check, is refused. The peer is identified by the socket's audit token
(`LOCAL_PEERTOKEN`: pid and pid version), so a pid reused after the peer exits fails the check instead of
passing it. Inside means the peer's session id is a session child's pid (each PTY child calls `setsid`), or an
ancestor is a session child of this core or has such a session id; a process that calls `setsid` inside a
session, or whose parent exited, is still inside. Plain shell sessions are included: such a shell cannot be told
apart from an agent's. (SHELL=A, which refused owner commands in every session with a hint line, was replaced by
OWNERC = D', needs 47.) Hooks keep their own-session limit. Only this core's sessions count: a core started inside another core's session serves its
own clients normally. A failed check (unsupported call, a process tree that changed mid-read) refuses owner
authority with one log line.

The window token is no longer in `window.json` (which keeps `port` only, 0600, replaced at each start). The
owner-only request `{"op":"window_auth"}` replies `{"type":"window_auth","port":<u16>,"token":"<hex>"}` to a peer
that passes the same check; the app asks for it at each page load. A session caller gets `operation not granted`.

The window's WebSocket accepts at most 16 sockets in handshake. A new socket at the cap evicts the oldest pending
socket that has nothing waiting to be read (idle, trickling or closed) instead of being dropped; a socket whose
request is in but not yet read is never evicted, and if all 16 are like that the newcomer is dropped. Each eviction
pauses the accept loop 1 ms, and a socket leaves the list once its request is read. A socket must send its first bytes
within 500 ms and finish within 3 s.

Known limit (residual escapes): one fork is enough to leave: a child that calls `setsid` while its parent exits
(reparented to launchd, with a new session id) is outside; so is anything started through another service: `ssh localhost`,
`launchctl`, `osascript` (Terminal or another app), a login item. A child left running after its session leader
exited counts as inside only while that session is live in the core. The core's own children that are not
sessions (git, ssh, widget runs) are outside. The check binds a same-user process inside a session that does not
take these steps; it is not an OS sandbox. No keychain storage: an agent can run the same CLI binary, so a keychain
ACL adds no boundary against it. V1A-18 measured the candidate boundaries (owner boundary
spike, an internal note); its candidate C was dropped by OWNERC = D' (needs 47). When D' was decided the
escape mattered only for the two human actions (approve a widget, turn verified yes on). Since then more is the
owner's alone, and an escaped process gets all of it (ticket 1023): outside tokens (`token create`), worktree setup
approvals, and a shell with the owner's full environment, the secrets ticket 1008 keeps from agents included.

## Lifetime and resume

<!-- v1a-09 -->
`settings.json` gains two keys beside `disable_hook_injection`, both optional: `session_lifetime`
(`"keep_running"`, the default, or `"end_with_app"`) and `start_at_login` (default `false`). The window edits
all three through `{"op":"quit_settings","patch":{"lifetime":…,"start_at_login":…,"disable_hook_injection":…}}`;
an empty or absent patch only reads. The file is re-read for each write, so edits made since the core started
are kept, as are keys this build does not know; an unreadable file is refused and left as it is. The reply is `{"type":"quit_settings","settings":{…}}`. The file is
written atomically before the running core changes, a failed write changes nothing, and every other key is
kept. `disable_hook_injection` affects sessions started after the change only.

<!-- v1a-74 (needs 79) -->
Two more keys go through the same request: `keep_history` (default `true`; an absent key keeps history) and
`mask_history` (default `false`), patched as `"keep_history":…` and `"mask_history":…` and returned in the reply. The
window shows them under Lifetime as "Keep terminal history for restarts" and, only while it is on, "Mask known secret
shapes when saving". The export a closed shell offers (Save to file) is never masked: the owner asked for that text.

`nunchiro serve stop` is the full quit: it ends every process the core started (by PID, never by name) and then
the core. From a terminal it first lists the running agents and the pending queue items and asks once; a script
(no tty) or `--yes` skips the question. The window app has no part in deciding it: it leaves when the core has
been gone for three seconds, so no menu bar icon outlives the core.

After the core starts again, each session that was running is `resumable` with its `agent_session_id`. It runs
only when a client sends `start` with `resume` set to that id (`claude --resume <id>`, `codex resume <id>`);
restored queue items are not answerable and no saved answer is replayed. The window's resume offer is that
request. A session that ran in a worktree resumes in that worktree (the folder `claude --resume` looks in);
if the folder is gone it resumes from the project folder.

<!-- v1a-40 -->
When a PTY stops (core stop) or its process exits, its last 1 MiB of output is written to
`$NUNCHIRO_HOME/scrollback/<session id>` (0700 folder, 0600 file; a symlinked folder is refused). By default the file
is raw terminal output, unredacted: everything the session printed, including a secret a Shell session showed (a
`cat .env`) or an agent echoed. With `mask_history` on, the file holds the session-log redaction of that output
(registered session tokens, values after secret key names, `Bearer` words and known provider key shapes become
`[redacted:<kind>]`), applied before the 1 MiB cut; a full 1 MiB replay also drops its first line (up to a newline or
carriage return), which may start mid-secret. Escape sequences and control bytes inside a masked value are kept after its marker, so colours, cursor
moves and OSC terminators reach the restored terminal unchanged. Masking is best effort: an unknown format, a secret
split by cursor movement, or one printed before the option was turned on (until the next save) stays as it was. The
live screen, the in-memory replay and a resume seeded in the same core keep the real text; a session restored after a
restart shows the masked text. With `keep_history` off nothing is written (exit, core stop, Close), every file under
`scrollback/` is deleted once the setting is stored and again when a core starts (a set-aside `sessions.json`'s
included; a symlinked folder is refused and a symlink inside is removed, never followed), and a session restored
after a restart has no saved output. It is kept until the session is closed, or until a resume of that conversation
copies it into the new session's replay above a dim `— resumed; earlier output above —` line. A starting core
deletes files whose id has no open session. After a restart, `read` and the window's watch of a stopped session
return it from cursor 0 (`truncated` when older output was dropped). The resume seed is display only: nothing is
written to the agent, and prompt detection starts after it. Not covered: output since the last stop or exit when
the core is killed, and `--machine` sessions.

## Board

The core serves one board across all projects. Board state is separate from `Session`, the legacy
`Snapshot` reply and `queue.json`. The window polls `board_snapshot`; no board event is added. The GUI writer
(`board_columns_put`, v1b-16) is described at the end of this section. Automatic cards use the existing queue's attention projection and 20-minute stale
flag, without another detector or clock. No integration source or card decision-queue item is
implemented in this module (tickets 17 and 18).

`$NUNCHIRO_HOME/board.toml` (default `~/.nunchiro/board.toml`) is user-edited. Proposed version-1 schema:

```toml
version = 1

[[columns]]
id = "working"
title = "Working"
states = ["working"]

[[columns]]
id = "needs-decision"
title = "Needs decision"
states = ["needs_decision"]
needs_decision = true

[[columns]]
id = "review"
title = "Review"
states = ["review"]

[[columns]]
id = "done"
title = "Done"
states = ["done"]
```

Those are also the zero-config defaults; the core creates or writes `board.toml` only for `board_columns_put`. `states`
defaults to `[]` and `needs_decision` to `false`. Columns are ordered, have unique IDs (ASCII letters,
digits or `-`, 1–80 bytes), nonblank titles of at most 256 bytes, and may claim any of the four
states. An unclaimed state uses the first column. Duplicate state claims, unknown fields/states,
unsupported versions and zero or more than 64 columns are errors. The UTF-8 file must be regular,
not a symlink, and at most 1 MiB.

Reload checks mtime, inode, size and ctime on board requests. A changed valid file replaces the
columns; invalid input keeps the last good columns and returns `error` naming `board.toml line N`
(one-based; I/O errors name line 1). The cached board survives core restart. Removing the file
retains the last good columns, or the defaults if no valid file has existed. A removed column
releases holds in that column; manual cards whose stored column disappeared display in the first
column while retaining their stored placement. Last-good retention also applies across a core
restart after deleting `board.toml`.

Session states, in precedence order:

- Exited, closed or resumable sessions are `done`.
- Failed sessions, failed attention or waiting attention are `needs_decision`.
- Working attention, background work or no completed turn is `working`.
- An unseen completed turn is `review`; a seen completed turn is `done`.

One automatic card per session uses its label verbatim. A session drag holds its column across
activity and label changes until its derived state, lifecycle state or completion sequence changes.
Core observation at lifecycle/attention mutation boundaries releases holds even between board
reads. Observation does nothing when `board.json` is absent; each distinct consecutive error is
logged once, followed by one recovery line when observation succeeds again. These errors never
fail legacy commands. `board_seen` records the completion sequence actually opened by the window; an
older observation cannot hide a newer turn, and a sequence ahead of the session is refused.
Stored seen or held sequences ahead of a known session are stale: an ahead-of-session seen marker
is cleared to unread, and either kind of stale stamp releases the held card. A successful atomic
repair logs once and preserves manual
cards, configuration and unrelated fields. This recovery runs on board requests and background
observation; the refusal of a new future `board_seen` request still applies.

Owner requests use the existing unix socket or authenticated window WebSocket envelope:

```json
{"op":"board_snapshot"}
{"op":"board_seen","id":"session-id","completion_seq":1}
{"op":"board_put","id":null,"title":"Read review","note":"Check evidence","session_id":"session-id","column":"review"}
{"op":"board_put","id":"manual-id","title":"Review read","note":"Done","session_id":null,"column":"done"}
{"op":"board_move","source":"session","id":"session-id","column":"review"}
{"op":"board_move","source":"manual","id":"manual-id","column":"done"}
{"op":"board_delete","id":"manual-id"}
```

`board_put` creates with `id: null`/omitted, or fully replaces an existing manual card's editable
fields with a non-null ID. `note` defaults to `""`; optional `session_id` and `column` default to null.
Null column selects the first column. Titles must be nonblank and at most 256 bytes; notes at most
65536 bytes. Linked sessions and explicit columns must exist. Moves validate the source and target;
manual IDs and session IDs are separate namespaces (`source` + `id` is the card identity). Unknown
manual IDs, missing linked sessions, invalid columns and capacity violations return `Err` without
committing changes. Deletion can remove the last manual card. No input is sent to a PTY.

Every successful board request returns the full current board (including mutations):

```json
{"Ok":{"type":"board_snapshot","board":{"columns":[{"id":"working","title":"Working","states":["working"],"needs_decision":false}],"cards":[{"id":"session-id","source":"session","title":"Label","note":"","session_id":"session-id","project":"/project","column":"working","state":"working","stale":false,"updated_at":1000}],"error":null}}}
```

This is a shape example; the default reply has four columns. Cards have `source` (`session` or
`manual`), `id`, `title`, `note`, nullable `session_id`/`project`, `column`, nullable `state`, `stale`
and epoch-ms `updated_at`. Manual cards have null state and false stale; their project comes from
the linked session when available. Manual edits/moves advance `updated_at` even within the same
millisecond; identical manual replacements and snapshots do not rewrite the store. Session stamps
come from queue activity and a held move, without rewriting the queue.

Internal `$NUNCHIRO_HOME/board.json` version 1 stores `columns` (last good configuration),
`config_stamp` (mtime seconds/nanos, inode, size, ctime seconds/nanos), `config_error`, `manual`
(array of ID/title/note/session link/column/update time), `seen` (session ID to completion sequence),
and `held` (session ID to column/derived state/lifecycle/completion sequence/update time). Missing
manual/seen/held fields load as empty for additive v1 evolution. Unknown top-level and manual/held
record fields survive writes. The store is limited to 8 MiB and 4096 manual cards, seen markers and
held drags each. Shape/types, duplicate manual identities, invalid identifiers and duplicate
column/state relationships are validated. Invalid/newer stores and nonregular/symlink stores are
refused without modification; only board requests fail. The core's registry lock serializes
requests and observation. Writes reuse the existing fsync + atomic-rename helper (0600 file in a
0700 data directory); writes occur only when board data changes. No saved card or seen marker
contains execution authority.

### GUI writer (v1b-16)

Column edits from the window replace `board.toml`'s columns:

```json
{"op":"board_columns_put","revision":"<revision from the last board_snapshot>","columns":[{"id":"working","title":"In progress","states":["working"],"needs_decision":false}]}
```

Every board reply carries `revision`: an opaque string made from the `board.toml` stamp (mtime,
inode, size, ctime), empty when there is no file. Compare it only for equality; its format may change.
The write is refused with `board.toml changed, reloaded` when `revision` differs from the file as the
core reads it now (a hand edit, or another window's write, since that snapshot) or when the file
changes between that check and the read; the reply's refusal never touches the file, and the next
snapshot shows the current file. A current file that is invalid (any `board.toml line N` error,
including a symlink, more than 1 MiB or `version = 2`) refuses the write with that error, untouched.

`columns` is the complete new list, in order. Through `toml_edit`, existing `[[columns]]` tables are
matched by `id` and edited in place: only a changed `title`, `states` or `needs_decision` value is
rewritten (keeping that value's surrounding spaces and comment); a new id gets a new table placed right
after the column table that precedes it in `columns` (the GUI adds at the end, so after the last column
table, before any later table such as `[sources]`); missing ids are removed with their table; reordered
tables keep their own bytes. `states` is written only when the key was already present or the column
takes a state, and `needs_decision = false` only when the key was already present, so a hand-written
column without those keys keeps its bytes. An inline `columns = [...]` array is rewritten as
`[[columns]]` tables (values kept, spacing normalised). Everything else, comments,
spacing, key order, `version` and `[sources]` included, keeps its bytes. The result must pass the same
parser as a hand edit (1 to 64 columns, ids, 256-byte titles, one claim per state) before it is
written; deleting the last column is refused. The write is atomic and keeps the existing file mode;
with no file, the core creates one (0600) from `version = 1` and the given columns. The reply is the
board after the write. Owner-only: agent tokens get `operation not granted`.

## Integration sources

`board.toml` version 1 accepts this optional strict section, alongside its existing columns:

```toml
[sources]
version = 1
[[sources.entries]]
name = "roadmap"
kind = "file"
path = "/absolute/path/cards.json"
[[sources.entries]]
name = "builds"
kind = "command"
subject = "builds"
```

Names are unique board IDs (1–80 ASCII letters, digits or hyphens); at most 64 Integration sources. File paths
are absolute and opened read-only, without following a final symlink or blocking on special files.
Integration source command subjects follow the approval name rule (1–64 lowercase letters, digits, hyphens or
underscores, beginning with a letter or digit) and live at `$NUNCHIRO_HOME/sources/<subject>/`.
Their `widget.toml` uses the unchanged version-1 manifest with `kind = "integration"`, `command`
(argv), optional `interval` (seconds), `permissions` and exact lowercase `network` hosts.
The Integration source folder is hashed in full except its top-level `cache/`; any other change needs approval.
Widget and Integration source grants share one approvals store but are keyed by Subject kind plus name.
Legacy grants with no `kind` remain widgets; a source grant never authorizes a widget.

A board read registers its home with a core-lifetime worker polling metadata every 250 ms. File
reloads use mtime/ctime/inode/length; commands subsequently run without further board reads.
Foreground board snapshots stat command-folder metadata and reuse the last checked proof hash;
changed size/time/inode/path/mode or approval-store metadata invalidates it and queues a background
check. Foreground snapshots never read command file bytes. Full hashing plus an immutable snapshot
still occurs in a worker before every run; metadata alone never authorizes execution.
The effective command interval is `max(manifest interval or 30, 30)` seconds; runs never overlap
for a subject. A deleted board.toml removes sources; malformed/newer/unknown config retains the
last accepted declarations and columns with a board error. Replacing a declaration resets its
cached input. Last-good integration cards and local drag positions are retained in memory for
the core lifetime; restart reads the current input again. Source inputs are never rewritten.

Card input is UTF-8 JSON `{"cards":[{"id":"a","title":"Title","updated_at":1}]}`. Optional fields:
`column`, `url`, `project`, `note`, `needs_decision: {"question":"..."}`. Unknown card fields are
ignored; required fields/types, unique nonempty IDs, nonempty titles/questions and HTTP(S) URLs
with a host are checked. Limits: 1 MiB input/output, 4096 cards, 256-byte ID/title/column,
64 KiB note/question, 4096-byte project, 8192-byte URL. A failed read, invalid JSON or failed command
keeps the previous cards and reports a per-source error with a line/reason for card parse errors.
Command approval failures report `needs approval`; sandbox startup failures report their reason.

The existing board snapshot adds `sources: [{name,error,running}]` only when declarations exist;
no-source wire output remains unchanged. Integration cards add `source: "integration"` and
`source_name` to their validated fields, with unknown/missing columns falling back to the first
column. `id` is scoped by `source_name`. All new requests are owner-only (V1A-23: a session caller's
`board_source_grant` raises an owner item instead of granting):

- `board_source_status {name}`: `name` is the approval subject, returns the existing
  `approval_status {view}` reply. That view's command is an executable owner-socket `printf | nc`
  grant for the displayed source/hash; the widget CLI keeps its original meaning.
- `board_source_grant {name,level,hash}`: grants only the displayed source content, returns the same
  approval view. A stale hash refuses without a grant.
- `board_source_move {name,id,column}`: `name` is the declaration name; changes only the in-memory
  drag position after checking the card and column, returns `ack`.

Wire request discriminator: `op`. The board UI and its use of the existing permission-sheet fields
are ticket 16's handoff, not part of this core lane. No integration queue items or write-back here.
An agent directly editing board.toml still runs with the user's shell rights; this is a known
same-user limit, not an authorization boundary.

## Sandbox

Shared interface for ticket 19:

```rust
sandbox::run(profile: &sandbox::Profile, proof: &approval::Proof) -> Result<Vec<u8>, String>
sandbox::Profile::new(home: PathBuf, cache: PathBuf, user_home: PathBuf) -> Profile
```

The profile's paths are trusted core inputs. Production callers pass the actual core home,
subject cache and user home; tests use stand-ins. Defaults: `/usr/bin/sandbox-exec`, 5-second timeout,
1 MiB stdout/stderr caps, 64 MiB `cache_limit`. The runner requires an unforgeable approval proof, materializes only its
immutable hashed files in `cache/.runs/<id>/work`, a fresh 0700 directory beside the run's own empty 0700 HOME
`cache/.runs/<id>/home` (V1B-21; ruling 01:39 named a separate temp dir), then runs the approved argv there. Both are
deleted after the run; a `.runs` entry a killed core left is swept before the subject's next run. Use relative paths for bundled command files. It never reopens command inputs after
checking approval. The approval walk opens every path component fd-relative with `O_NOFOLLOW`;
intermediate subject-directory symlinks are refused. The trusted home prefix may contain symlinks;
only the widgets/sources namespace and its descendants are traversed with no-follow. Existing hash encoding and file/byte limits remain unchanged.

The profile denies writes outside the subject cache (a symlink planted in the cache does not lead out), except the
spike's null/dtracehelper devices; denies reads of `.claude`, `.codex`, `.ssh`, `.nunchiro`, the credential stores
`.aws`, `.gnupg`, `.config/gh`, `.docker`, `.kube`, `.netrc`, `.git-credentials`, `Library/Keychains` and configured
NUNCHIRO_HOME, except the subject's own cache; every other path stays readable. Network goes only to its private
loopback CONNECT proxy. The environment is cleared, then only PATH/HOME/TMPDIR/LANG/LC_ALL, `NUNCHIRO_CACHE` and HTTP(S)
proxy variables are supplied: HOME and TMPDIR are the run's fresh empty directory, `NUNCHIRO_CACHE` the persistent
cache, so a `.zshenv`, `.gitconfig` or Python user site a run leaves in the cache is never read as startup config by
the next (V1B-21). No session or owner token reaches the command.

Limits (V1B-21): before a run the cache is measured as du counts it (symlinks not followed); over `cache_limit` the
run is refused with "cache over N MiB" and the cache is kept. Each run gets `RLIMIT_FSIZE` = `cache_limit` per file and
`RLIMIT_NPROC` = the user's current process count + 64. macOS counts processes per user, so that limit stops only the
run's own forks; every other process of the user keeps its own limit. Memory has no limit (`RLIMIT_AS` is not
enforced on macOS) beyond the timeout and the process cap (ruling 09:48 Q3; the permission sheet says so).

The proxy accepts only CONNECT to approved exact hosts on port 443; it checks every resolved address,
rejecting private, loopback, link-local, metadata and reserved ranges including IPv6/mapped forms,
then dials a checked IP directly. No second DNS lookup or redirect is followed. Headers, connection
counts, resolver concurrency/wait time and dialing are bounded. A DNS call already inside libc may
finish after its bounded waiter exits (at most 16 such jobs); it cannot dial on its own.

A startup self-check runs once per sandbox executable for denied writes, denied direct network and
process-group escape prevention. A missing executable, unsupported policy or failed check disables
commands, with no unconfined fallback. `setsid`, `setpgid` and `posix_spawn` syscalls are denied so
children cannot leave the owned process group; fork/exec remain available. Programs requiring
posix_spawn fail closed, including commands whose runtime uses it to spawn children. Approval does
not bypass that restriction; use a runtime that supports fork/exec. The runner kills the entire owned group
before reaping its leader, including on normal exit, timeout and output cap, then kills it again until it is empty:
one group SIGKILL misses a child whose fork is in flight (V1B-21; a probe left survivors in 8 of 30 kills).
A core that stops kills every run group it started (`sandbox::stop_all` from `Sessions::stop`), and closes its home:
a run whose spawn comes later (its self-check finished outside the lock) is refused ("core is stopping; nothing ran"),
because runs spawn and register under the same lock. The next open (`sweep`) reopens the home. Each run also leaves a
record `$NUNCHIRO_HOME/.sandbox-runs/<pgid>` holding its leader's start time, outside the writable cache. When the
core opens after a crash, `sandbox::sweep` kills a recorded group only if its leader still has that start time. It
then removes the `.runs` entries in widget and source caches without following symlinks. A group whose leader had
already exited when the core died is not found. A short-lived output
burst over the cap is an error, never silently truncated successful JSON. Reviewed in V1B-21 (ticket 21 comments);
this is not protection against arbitrary unconfined processes of the same user.

## Second-machine store (V1A-06)

`settings.json` additionally accepts `machines.<ssh-alias>.projects`, a map from canonical
absolute local project paths to absolute remote project paths. See [remote operation](../../docs/remote.md)
for the CLI, explicit install and local session authority rules. The quit-settings writer retains
this mapping. Changes to mappings take effect at core restart.

`NUNCHIRO_HOME/machines.json` is an internal, versioned remembered-alias store:

```json
{"version":1,"machines":["macbook"]}
```

The module atomically writes it through the existing private-store helper (0600 files in the
0700 data directory). Missing means no remembered aliases. Invalid JSON, wrong shapes/types,
unknown fields, unsupported versions, duplicate aliases and invalid aliases are refused and
left untouched. Aliases contain ASCII letters, digits, dots, underscores and hyphens, at most
128 bytes; they cannot begin with a hyphen. Configured settings aliases also feed snapshots.
Project mappings do not live in this store. Remote child records, delegated callers and snapshot
caches are memory-only and drop on core restart; remote processes continue. Already authorized
visible sends may finish remotely after a local restart; new calls cannot reclaim old grants.
No approval answer is persisted or replayed by this module.

## File access

Requests for the window (spec B3): reads, plus one write, `file_write` (ticket 820; nothing here creates or deletes a file). Each names a
`root` and a path relative to it: `root` is a session id (that session's folder or worktree) or `data`
(Nunchiro's data folder). Replies come back as `{"id":n,"response":{"Ok":...}}`.

| Request | Reply `Ok` |
| --- | --- |
| `{"op":"files_list","root","path":""}` | `{"type":"files","entries":[{name,kind:"dir"\|"file"\|"symlink",size,ignored,git}]}` |
| `{"op":"file_read","root","path"}` | `{"type":"file",kind,size,too_large,mtime_ms,text,hash,data}` |
| `{"op":"file_write","root","path","text","hash"}` | the file as read again, `{"type":"file",...}` |
| `{"op":"files_search","root","query","path":"","names":false}` | `{"type":"matches","matches":[{path,line,text}],"truncated"}`; with `"names":true` it matches the relative path in any case (ticket 821) and returns `line` 0 and empty `text` |

- `git` is one status letter (`M`, `A`, `D`, `R`, `?`), null when clean or outside a git repository; a
  folder shows `?` if untracked and `M` if something beneath it changed. `ignored` follows `.gitignore`.
  Status comes from `git status --porcelain=v1 -z` without refreshing the index.
- `kind` is decided by content (image magic, NUL bytes, UTF-8) with the extension choosing among text
  kinds: `text`, `markdown`, `image`, `svg`, `html`, `binary`. Over 2 MB, `too_large` is true and neither
  `text` nor `data` is sent. Text kinds fill `text`; an image fills `data` (raw bytes, as in `Output`).
  `mtime_ms` is the file's modification time when it was read (ms since the Unix epoch, every kind
  including `too_large`), so a same-size edit of a large file is still seen. `hash` is the SHA-256 (hex) of the
  bytes read, sent with `text`.
- `file_write` (ticket 820) replaces a text file with `text` when its bytes still hash to `hash`; otherwise `the file
  changed on disk since it was opened; nothing was saved`. It takes a session root only (never `data`), the same
  confinement as `file_read` (no `..`, absolute path, `.git` or link out), an existing regular file that is UTF-8 text
  (`not a text file; it is not edited here`) up to 512 KiB, and a text up to 512 KiB. The write goes through the
  checked folder's descriptor: a temp file in the same folder with the file's permissions, synced, renamed over it; a
  link inside the root is written at its target. Owner window and owner socket only: a session token, the browser role
  and a remote machine are refused.
- Search is a literal, case-sensitive substring over files up to 2 MB, honouring the `.gitignore` files
  inside the folder (not a parent repo's or the global one), skipping binaries and links. Hidden files are
  searched; `.git` never is. At most 200 matches or 2 s, then `truncated` is true. The query is 1 to
  256 bytes. Lines are cut to 300 characters; `line` counts from 1; `path` is relative to the root.
  A `.gitignore` over 64 KB is not applied and is named in `skipped_ignore_files`. At most 3 searches run
  at once across all windows; another gets the error `search busy: try again in a moment`.
- File, `git` and search work runs outside the session registry lock, so a slow search never delays the
  terminal, hooks or snapshots.
- Root rule: a path with `..`, an absolute path or a NUL is refused. The path is canonicalised, the opened
  file's real path is checked again after opening, and anything outside the root (a symlink out
  included) is refused. The `data` root reaches only `artifacts/` and `images/`: `window.json`,
  `sessions.json`, the queue, journals, approvals and tokens are never served, and the same rule applies
  to links inside those folders.
- `.git/` is refused (read, list, search) at any depth and in any letter case: remotes can carry tokens.
- Known limit: a hard link inside the root to a file outside it reads like any file (only symlinks are
  detected; tools such as pnpm hard-link inside projects, so `nlink > 1` is not refused).
- Requests are window or CLI requests (core token). A session token is not accepted for them.

## Diff

A session folder's changes against the commit that was HEAD when the session started, plus untracked
files (spec B3 Diff). Read only: nothing here stages, commits, stashes, reverts or writes the index.

| Request | Reply `Ok` |
| --- | --- |
| `{"op":"diff_list","session"}` | `{"type":"diff","base":{"kind":"commit","sha"}\|{"kind":"no_commits"}\|{"kind":"not_git"}\|null,"base_missing","files":[{path,status,old_path,additions,deletions,binary,stamp}],"truncated"}` |
| `{"op":"diff_file","session","path"}` | `{"type":"diff_file",path,status,old_path,binary,too_large,patch}` |

- Start-commit rule: when a session starts (its project folder or its worktree), the core records
  `start_commit` in the session record: `commit` with HEAD's sha, `no_commits` for a repository without a
  commit yet (compared with the empty tree), or `not_git` (no repository, or a folder its enclosing
  repository ignores, or a git check that failed, such as a timeout; each request checks a `not_git` start
  again and compares with HEAD at that time). A resumed conversation keeps the start of the session it continues. A record
  written before v1b-11 has none: `base` is null ("start commit unknown") and `files` is empty; Diff never
  falls back to today's HEAD. A stored sha must be 40 or 64 lowercase hex digits, or `sessions.json` is
  refused as `invalid metadata relationship`. A recorded commit that no longer exists (history rewritten,
  garbage-collected) gives `base_missing: true` with empty `files`, and `diff_file` fails with
  `start commit no longer exists`.
- `files` is the working tree (staged and unstaged) against the start commit, renames detected (`R` with
  `old_path`), plus untracked files (`?`, `git ls-files --others --exclude-standard`), sorted by path,
  relative to the session folder (a session in a subfolder sees only that subfolder). `status` is one
  letter (`M`, `A`, `D`, `R`, `C`, `T`, `U`, `?`). Counts are null for a binary file and for untracked
  files beyond an 8 MB reading budget. At most 2000 files, then `truncated` is true. `stamp` is a number
  from the working file's stat (null for a deleted file): it changes with each write, so Diff re-reads a
  patch whose status and counts stayed the same.
- `diff_file` serves only a path that is a tracked change or an untracked file, looked up for that one
  path (it also serves a path beyond the 2000-file list cap). A list cut by git's 64 KB output cap keeps
  only whole entries and reports `truncated`. `patch` is git's unified patch for that file (file
  headers, then `@@` hunks; `\ No newline at end of file` and CR bytes kept), or a new-file patch for an
  untracked file. A binary file has `binary` true and no patch; a patch or untracked file over 64 KB has
  `too_large` true and no patch.
- No git write: `git` runs with `GIT_OPTIONAL_LOCKS=0`, `core.fsmonitor=false`, no external diff or
  textconv, `--end-of-options` before the reference, and only plumbing for the working tree (`diff-index`; porcelain `git diff` rewrites the index
  after stat-only changes even with optional locks off). Untracked content is read through the File
  access root rule above, never by git, so a link out of the folder is not followed. Each `git` call has
  a 10 s timeout.
- Diff work runs outside the session registry lock. Requests need the core token; a session token is
  refused.

## Nunchiro plugin (skill) on disk

- `$NUNCHIRO_HOME/plugin/` is the Claude plugin directory passed to every Claude session as `--plugin-dir`. It holds
  `.claude-plugin/plugin.json` and `skills/nunchiro/SKILL.md`, embedded in the core from the repo's `plugin/` folder.
- Internal format, version 1: `plugin.json` has a string `version` that parses as an integer ("1"). Every directory under
  `plugin/` is 0700, files are 0600, writes are atomic (temp file then rename).
- On each Claude start the core rewrites a file only when its content differs. A `plugin.json` that is invalid, lacks an
  integer `version`, or has a newer `version` than the build leaves the whole directory untouched. Older versions are
  overwritten (additive: new files may appear, none are removed).
- Nothing is written under `~/.claude`; Codex sessions get no `--plugin-dir`.
- v1b-07: the plugin also ships the artifact-authoring skill, `skills/artifacts/SKILL.md` (published in the repo as
  `plugin/skills/artifacts/SKILL.md`), under the same rules; version 1 already adds missing files, so no bump.
- v1b-07: every Claude and Codex session gets an artifact folder, `$NUNCHIRO_HOME/artifacts/<id>/` (0700, created before
  spawn, canonical path), as `NUNCHIRO_ARTIFACTS` and `--add-dir <folder>` (Claude: before `--plugin-dir`, since its
  `--add-dir` takes several values; Codex: a writable root, after `resume <id>`). `<id>` is the session id; a resumed
  conversation keeps the folder of the run it continues (session record `artifacts`, only when it differs from the
  id). Shell sessions get neither.
- v1b-35: a Codex session whose launch args make its sandbox read-only (`-s`/`--sandbox read-only`, the value next,
  after `=` or attached; or `-c sandbox_mode=read-only` with no `-s`; the last of each wins, `-s` over `-c`) gets no
  `--add-dir`: codex-cli 0.161.0 exits 1 at start on that pair. It still gets the folder and `NUNCHIRO_ARTIFACTS`, but
  it cannot write artifacts, so its chat shows no artifact card. A read-only sandbox set only in `config.toml` or a
  profile is not detected.
- v1b-07: Claude's per-session settings file (`hooks-<id>.json`, passed with `--settings`) carries
  `permissions.allow` = `Edit(//<folder>/**)` for exactly that folder, with or without hook injection; `--add-dir`
  alone still asks in the default permission mode (Claude 2.1.310). Only `Edit(path)` rules govern writes, the Write
  tool's too; no `Write(path)` twin is written (Claude Code 2.1.318 warns "not matched by file permission checks" for
  one at start, ticket 287; the `deny_rules_enforced_by_current_claude` test runs the installed `claude` against the rules). `permissions.deny` (checked first) covers
  every file Claude Code loads configuration from inside an `--add-dir` folder: `**/.claude/**`, `**/CLAUDE.md`,
  `**/CLAUDE.local.md`, each also in any letter case (`[cC]...` classes; macOS folders are case-insensitive), so an agent
  cannot write itself a skill, command, subagent or plugin setting. A folder that already holds `.claude`, `CLAUDE.md` or
  `CLAUDE.local.md` (any case) gets the deny rules but no allow rule. A folder path with a rule-syntax character
  (`*?[]{}()\!` or a control character) gets no rules, so a rule can never widen; writes there then ask. The project and
  other sessions' folders keep asking.
- v1b-07: chat detection reads a file written under the artifact folder as `root:"data"`,
  `path:"artifacts/<id>/<file>"` (plain components only; `..` or another session's folder stays a session-root
  path the file API refuses). `nunchiro-artifact` blocks are saved in the same folder.
- v1b-07: Codex has no `--plugin-dir` and ruling 17:36 forbids writing `~/.codex`. `-c developer_instructions=...` is
  session-only but replaces the user's own `developer_instructions`, so it is not used; Codex receives the skill by
  prompt (the published file's path) until a coordinator ruling.

## Board decisions

(V1B-18.) A card raises a **board decision** when it is a manual or integration card in a column with
`needs_decision = true`, or an integration card with `needs_decision: {question}`. Session cards never raise one:
a waiting session is already a session queue item, and a held drag of a session card into that column changes
nothing. Board decisions are not session items: they never touch `queue.json`, a PTY or an integration (writing
answers back is v2).

- **Identity**: `manual:<id>` or `integration:<source_name>:<id>` (the same `id` in two sources is two items),
  plus the card's `updated_at`. The question is `needs_decision.question`, else the card title. `project` is an
  integration card's own field, or a manual card's linked session's project; `null` shows in the strip only.
- **Snapshot**: `nunchiro snapshot --json` and the window's `snapshot` event carry one top-level
  `board_decisions` array, omitted when empty (the pre-board snapshot bytes are unchanged). Each item is
  `{identity, source, source_name?, id, title, question, project, url, column, updated_at}`. Session-token
  snapshots never carry it.
- **Freshness**: the core keeps the list in memory and refreshes it on every board request (manual edits, moves,
  board reads) and from the 50 ms tick at most every 100 ms (board.json, board.toml columns and Integration source
  cards). The first tick registers the Integration source worker, so items appear after a restart before any
  board read. A snapshot reads the list under the registry lock without file or source I/O. A source read error
  keeps its last good cards and their items; a broken board.json keeps the last good list.
- **Answer**: `{"op":"board_resolve","identity":"…","updated_at":N}` (owner only: unix socket owner token or the
  window WebSocket; a session token gets `operation not granted`, and it is never forwarded to a remote machine)
  replies `{"type":"board_decisions","board_decisions":[…]}`. It is refused with `card changed` when `N` is not the
  card's current `updated_at`, and `board decision not found` when the card no longer raises one. It records
  `resolved: {identity: updated_at}` in board.json, nothing else.
- **Re-raise**: a resolved identity stays resolved for the same or an older `updated_at` and raises again for a
  later one. A card that leaves the column, is deleted or loses its source drops its item without being resolved.
- **Bound**: at most 4096 resolutions; the next one evicts the lowest `updated_at` among the others (ties by
  identity; the one just made always stays) and logs `board: 4096 resolutions kept; forgot the oldest, <identity>`.
- **Removed sources**: when board.toml changes, the resolutions of a source no longer declared, or declared for
  another input under the same name, are dropped (logged), so a reused name never inherits an answer. An invalid
  board.toml drops nothing. A removal made while the core is stopped is seen only as "not declared" at the next
  start (a name re-declared before then for another input keeps its resolutions). A `resolved` field with the wrong shape, a
  non-integer value, an empty or over-1024-byte key, or more than 4096 entries makes board.json invalid (board
  requests fail; nothing is rewritten).

The window shows each item as kind `board` in its project's tree slots (expanded projects) and the answer strip,
with the answers Resolved (key R) and, when the card has a `url`, Open (the user's browser). A long question
ellipsises; Full text opens it in the top layer. OS notifications name the kind, source and project only, and
follow the board decisions' own notification level (all, waiting only or muted; the strip header shows it while
board items exist; a board decision counts as waiting).

## Script widgets

Ticket v1b-19. A script widget is a folder `$NUNCHIRO_HOME/widgets/<name>/` whose `widget.toml` (`kind = "script"`)
names an argv; `nunchiro widget new <name>` writes a starter (`widget.toml`, `widget.sh`, unapproved). Off by default:
`settings.json` `"script_widgets": true` turns runs on, written by the owner's `quit_settings` patch from the switch in
Settings › Layout › Script widgets (ticket 872); while off the window lists widgets marked off with a button to that
switch, and `widget_run` is refused.

Owner-only requests (window and token-less CLI; a session token gets `operation not granted` from the agent
allow-list, and `Remote` refuses to forward them):

```
{"op":"widget_list"}                       -> {"type":"widgets","list":{"enabled":bool,"unavailable":str|null,
                                               "widgets":[{"name","state":"unapproved|approved|changed"|null,
                                               "kind","author","interval_secs","error"}]}}
{"op":"widget_run","name":N,"session":ID?} -> {"type":"widget_run","run":{"name","project":str|null,"ran_at_ms",
                                               "interval_secs","running":bool,"output":{"format":"text|json","text"}|null,
                                               "error":str|null}}
```

`widget_run` answers within 250 ms (a window serves its frames one at a time); a longer run finishes in the background,
the reply says `running` and keeps the last cached result until the next call. Per (widget, project) the core runs at
most every `max(interval or 60, 10)` seconds, never runs one widget twice at once, and answers early calls from the cache.
Refusals are errors: setting off, "script widgets unavailable: <reason>" (sandbox missing, or its self-check failed;
remembered per executable, never an unconfined fallback), "needs approval: ..." (unapproved or changed), not a script.
Run failures are cached results with `error`: "timed out after 5 s", "output over 1 MiB", "cache over 64 MiB" (`Config.cache_limit`;
nothing runs and the cache is kept), "sandbox command failed: <stderr>"
(including runtimes that need `posix_spawn`).

V1B-21 round 2 (ruling 09:48 Q2): `command` may name nothing outside the widget folder. No word has a `..` component,
and no word is an absolute path, except argv[0] directly inside `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`,
`/opt/homebrew/bin` or `/usr/local/bin`. Otherwise the manifest is refused when it loads ("command path ... is outside
the widget folder"); integration commands follow the same rule. Round 3: a path is also found inside a word, after
`=`, `@`, `:`, quotes, spaces and similar separators (`--file=/x`, `@/x`, `". /x"`); a `//` right after `:` is a URL.
An interpreter outside the folder (a system binary or a PATH name) never takes inline code: shells `-c`, `env -S` /
`--split-string`, python `-c`, perl and ruby `-e`, node `-e`/`--eval`/`-p`/`--print`, osascript `-e` ("inline script
(...) for ... is refused"). The words of other program languages (awk, sed, `find -exec`) and `file://` URLs are
shown on the sheet as written and are not parsed.

A run goes through `sandbox::run_env` (the V1B-17 runner, unchanged otherwise): cwd is the runner's snapshot of the
approved bytes under the widget cache, not the project (a manifest word such as `sh widget.sh` must resolve to a hashed
file); writes only to `widgets/<name>/cache` (`$NUNCHIRO_CACHE`, skipped by the folder hash; `$HOME` is empty and new each run); network only through the proxy to the
manifest's hosts. Extra environment is exactly `NUNCHIRO_CONTEXT` (path of `cache/context.json`, written 0600 by
temp-file-and-rename before each run) and `NUNCHIRO_PROJECT_DIR` (the project of the session the placement is pinned to,
else the focused session; absent without one). `context.json` is
`{"projects":[{"name"}],"sessions":[{"label","project","state"}]}` with project display names (folder basenames): no
paths, ids, transcripts or tokens. Output is `json` when the whole stdout parses as JSON (sent as printed, so the
window keeps key order), else `text`; the window strips escapes and renders text nodes only.

Reads (ticket v1b-33, needs 45): a script widget reads only its project folder (`NUNCHIRO_PROJECT_DIR`), its cache,
the system and Homebrew folders (`/usr`, `/bin`, `/sbin`, `/System/Library`, the cryptexes, `/Library`,
`/private/etc`, `/private/var/db`, `/private/var/select`, `/dev`, `/opt/homebrew`, `/usr/local`; not their `var`,
which holds service data) and `~/.cargo/bin`, `~/.local/bin`; any path outside the blocked list may be stat()ed
(existence, size, times), never read or listed. The sandbox matches paths, so a hard link in the project to a blocked
or undeclared file is readable; a widget cannot make one (it writes only its cache), another writer can. `read = ["~/notes",
"/opt/data"]` in `widget.toml` adds folders: each entry is `~`, `~/<path>` or absolute, without `.` or `..` parts,
hidden characters, `"` or `\`, at most 32 (`~user` and `$HOME` are refused); only script widgets may declare it. The
sheet lists them, and an entry covering the whole home (`~`, the home or a folder holding it, after links resolve) shows
a red warning. `.claude`, `.codex`, `.ssh`, `.nunchiro`, the V1B-21 credential stores and the core home stay denied
even when declared or reached through a link. Integration sources keep the V1B-21 read rule (everything but that list).

### Script widget act

Ticket v1b-20. Act is off until the user grants it per widget. A script widget declares it in `widget.toml` (inside the
hashed folder, so an edit asks again), allowed only when `permissions` includes `act`:

```toml
[act]
template = "review {title} (#{number})"   # {field} placeholders: a-z, A-Z, 0-9, _ and -; { } have no other use
session = "reviewer"                      # the running session with this label in the placement's project
# or: start = "claude" | "codex"          # starts one session there with the text as its first prompt
```

Exactly one of `session` or `start`; unknown keys, other `{`/`}`, control characters other than newline and tab, bidi
controls and invisible zero-width characters refuse the manifest. The permission sheet shows the template and the target verbatim. `widget_list` adds
`"act":{"template","session","start"}` per widget only while it is approved at the act level (else `null`); the window
makes table rows clickable only then.

```
{"op":"widget_act","name":N,"session":ID,"row":I,"ran_at_ms":T}
                                           -> {"type":"widget_act","session":TARGET_ID,"send":{send row}}
```

Owner only, like `widget_run` (session tokens get `operation not granted`, `Remote` refuses to forward it). The window
sends the row index of the run it showed; the core renders the text from its own cached run of the same approved content
and never takes text from the window. Checks, in order: setting on; approved (not `changed`) with an `[act]`; level
`act`; the placement's session gives the project; the cached run for that project has `ran_at_ms` and the row (else
"output changed; click the row again"); JSON array output with object rows; each placeholder is a string, number or
boolean without a newline; no line of the text starts (after spaces and invisible format characters) with `/`, `!` or
`#`, for every agent kind; the target resolves to exactly one running session with that label in the project ("no
session named <label>", "<n> sessions named <label>") and it is a Claude or Codex session (a shell would run `$(...)` or
`;` from a value: "session <label> is a shell; act sends only to Claude or Codex sessions"); `delivery::check_text`
(64 KiB, controls); every character of the rendered text is on an allowlist (V1B-21 round 3, `delivery::shown`,
Unicode 16 tables from regex-syntax). It is a letter, mark, number, punctuation, symbol or space separator that is not
Default_Ignorable and not U+2800, or it is newline or tab. Everything else is refused (Cc, Cf, Co, unassigned, line and
paragraph separators, tag characters, variation selectors other than U+FE0E/FE0F, Hangul fillers...): "act text
contains an invisible, bidi or control character (U+XXXX); nothing sent". The one other allowance is ZWNJ, ZWJ,
U+FE0E and U+FE0F (Hangul and emoji sequences need them). Each run of these must come directly after a visible
character and be at most one variation selector then one ZWJ/ZWNJ (a run such as `Deploy now` + nine U+FE0F is
refused). Subdivision flags are refused. The same allowlist finds a session token's slash command behind any hidden
character (`delivery::Input::submit`). V1B-21: the act
sends only what the table shows: it is refused from a table with more than 64 columns or from a row past 500 (the
window's caps, pinned by a test), and a number field only when the table prints it the same (safe integers, decimals
without an exponent; else "print it as a string"). A `start` act is refused once the widget has 3 running sessions in
the project. A second click on the same
row of the same run within 1 s returns the first send. Right before the send, under the registry lock that writes, the
act grant is checked again ("act grant changed before the send; nothing sent"; a `start` act's launch preparation can
take seconds), and it must be the approval whose content hash rendered the text: a re-approval with another template in
between refuses it ("output changed; click the row again"). A queued act keeps that hash in memory and is canceled at
delivery on a mismatch. Then the V1A-04 delivery path sends it as `widget:<name>`:
logged before PTY input, queued until the target is ready (a `session` act types the text without Enter; a `start` act's
first prompt is submitted), and a queued act is canceled when the target closes, the setting turns off or the act grant
stops being current. A widget never reaches `answer`: a target with an open decision refuses the act (`agent_blocked`).

The send log accepts `sender = "widget:<name>"` (widget name syntax). An older core refuses a `sessions.json` that holds
such a row (fail closed; the file's bytes are kept). The session header shows the newest send not typed by the user as one
line ("sent by widget <name> · <time>"; agent CLI sends show the sender's label).

## Web widgets

Ticket v1b-22. A web widget is a widget folder whose `widget.toml` has `kind = "web"` and `entry = "<file>"` (one
self-contained HTML file inside the folder; other files are hashed but never served). Off by default: `settings.json`
`"web_widgets": true` turns them on (no UI toggle until ticket 23); while off the window lists them marked "off until
security review (settings.json `web_widgets`)", frames nothing, and `widget_page` and the web act are refused with that
text. `script_widgets` does not turn web widgets on, and the script sandbox (`unavailable`) does not apply to them.

Owner-only requests (window and token-less CLI; a session token gets `operation not granted`, `Remote` refuses to
forward them):

```
{"op":"widget_page","name":N}  -> {"type":"widget_page","page":{"name","hash","network":[host],"act":bool,
                                   "entry":str,"context":{"projects":[{"name"}],"sessions":[{"label","project","state"}]}}}
{"op":"widget_act","name":N,"session":ID,"text":T,"target":{"session":LABEL}|{"start":"claude"|"codex"},"hash":H,"frame":F}
                               -> {"type":"widget_act","session":ID,"send":{...}}   (as the row form)
{"op":"widget_list"}           -> as above, plus "web_enabled":bool
```

`widget_page` answers only for a web widget approved as it is now: `entry` is the entry file's bytes from the very
snapshot the approval hash was computed over (never a second read), at most 2 MiB and UTF-8; `hash` is that approval
hash; `network` is the manifest's hosts minus IP literals, single labels and local suffixes (`localhost`, `local`,
`lan`, `internal`, `localdomain`, `arpa`); `act` says whether the grant is `act`; `context` is exactly a script widget's
`context.json`. Unapproved, changed, not a web widget, a missing, oversized or non-UTF-8 entry: an error, no bytes.

The app serves the page on the artifact scheme as `w-<name>-<first 16 hex of the hash>`: each request asks
`widget_page` again and serves only while the hash still has that prefix, so a newer hash is never served before the
user grants it again. The policy is the artifact default (`csp-default.txt`) with `connect-src` and `img-src` widened to
`https://<host>` for each `network` host (none: the default exactly). A page whose `act` is true (v1b-34 r2) runs only
approved code: `script-src` is the `'sha256-…'` of the app's bridge key and bootstrap and of each inline `<script>` in
the approved entry bytes (computed at serve time; no host, `'unsafe-inline'`, `'unsafe-eval'`, `blob:` or `data:`), and
`worker-src 'none'`; `connect-src` still reaches the `network` hosts, for data only. No `http:`, `ws:`, `wss:` or loopback; same
`sandbox allow-scripts` and frame flags as artifacts; no artifact grant, network chip or per-project allow applies.
Known limit (as 04's grant): DNS may resolve an approved public name to loopback, which then gets a TLS socket only.

The window's bridge: the frame posts `{nunchiro:1, id, method, params}` and gets `{nunchiro:1, id, ok}` or
`{nunchiro:1, id, error}`. Methods are exactly `context` (the page's `context`) and `act` (`{text, session:"<label>"}`
or `{text, start:"claude"|"codex"}`); messages from any other window than the widget's own frame are ignored, and
replies carry no token or path. An `act` is refused in the window without the `act` grant (nothing confirmed or sent),
while another act of that widget is pending ("busy"), within 1 s of the last one, or for text the core's rules below
refuse (the same rules, `delivery::shown` included, mirrored in `bridge.ts`); otherwise the widget header shows a
confirm line naming the target with the character and wrapped-line count, and the whole text opens in a wrapped box
with a visible scrollbar over the top of the frame and capped by the frame's area (it never leaves the widget; nothing
moves). Send stays disabled until the box has shown its end (it fits, or was scrolled to the bottom) while the box
was whole on screen and uncovered (a point inside each corner hits the box), checked again at the click, and only a click on it (pointerdown on Send at least 500 ms after the
line rendered, or a key press after that) sends the web form of `widget_act` with the hash of the page the confirm
was drawn for. A frame that loads a second time (it navigated or reloaded) or announces a second bridge key loses the
bridge: no replies, no confirm, an open confirm is dropped. The core then checks it on its own: `kind = "web"`, the `act` grant, the setting, the
request's `hash` equal to the current approval hash ("widget changed since the confirm"), at most one web act per
widget per second, and the text rules of the row form plus one line: no control character (newline and tab
included), no invisible or bidi character, no line-leading `/`, `!` or `#`, not blank, at most 1000 characters
(`web::MAX_CHARS`, what a person reads in the box), no space character other than U+0020, never more than 2
spaces in a row (padding cannot push text out of sight), and at most 4 combining marks per base (the shared
`act::MAX_MARKS`, a joiner starting no new base). The target is a
running Claude or Codex session with that label in the placement's project (none or several refused) or a `start` of
one there (3 running at most, labelled as the widget). The send goes through the same V1A-04 path as `widget:<name>`,
checked again under the lock that writes (`widget_act_current`: the web branch needs `web_widgets` and the act grant
for the hash that was checked). A request mixing the row and web forms is refused.

Act loads no outside script (v1b-34, needs 52). The default's script CDN hosts (`web::SCRIPT_HOSTS`: cdnjs.cloudflare.com,
cdn.jsdelivr.net, unpkg.com, cdn.tailwindcss.com, code.jquery.com) serve files outside the approval hash. A web
widget whose `network` names one cannot get act: `approval_status` carries the reason as `act_refused` (the sheet shows
it and disables the act switch), `approval_grant` at act answers with it, and an act grant stored earlier for such
content is no proof (`widget_page` and the web act answer `needs approval: <reason>`) and its status reads `changed`,
so the sheet asks for a review. A read grant is unchanged. To act, put the library inside the entry file (other files
are never served); editing it asks for approval again. The frame id of a page framed with act ends in `-act`
(`w-<name>-<prefix>-act`), and the app serves an id only while that matches the grant: a page framed under the read
policy (with the CDN hosts) never acts after act is granted; the window frames the page again under the act policy
and answers that act call with `act was just allowed; the widget reloads under its act policy`.
The core checks the frame too (defense in depth, not proof): the web form of `widget_act` carries `frame`, the id of
the page that asked as the window framed it, and is refused (`the page was framed without act; nothing sent`) unless
it is `web::frame_id(name, hash, true)` for the confirmed hash. Event handler attributes (`onclick="…"`) and
`javascript:` URLs do not run on an act page, and a blocked script is reported only to the frame's console; set
handlers from a script. Known limits: approved code can still put text it fetched from a `network` host into an act,
so what reaches an agent is guarded by the full-text confirm, not by the policy; an act page keeps the default's
Google Fonts style and font hosts (no script).

Reviewed in ticket v1b-23 (security and intent roles; report in its Comments). What changed and what it rests on:

- Bridge key. The app puts `bridge-key.js` before anything else in a widget page (right after a leading doctype;
  never in an artifact). It makes a random key, posts `{type:"nunchiro:bridge", key}` once, and replaces `parent`
  with an object whose `postMessage` stamps the key on every message (`MessageEvent.source` reads the same object, so
  `e.source === parent` still holds). Page code never sees the key. The window takes the first announced key, answers
  only calls carrying it, and closes the bridge for good on a second announcement or a second load. A page the frame
  navigates to, before or after the first load, has no key: another widget's page announces its own (closed), an
  artifact's page or one that never runs its scripts posts without it (ignored). Calls through `top` are not stamped
  and get no answer; the documented way is `parent.postMessage`.
- A confirm never opens after the bridge closed; replies stop once it closed.
- `context` at most once per second per placement (each call re-hashes the folder in the core): `one context per
  second`.
- The confirm keeps the session and page hash it was raised for; following another session meanwhile does not move
  the send.
- An act target label must draw as itself (no control, bidi or invisible character, at most 256 bytes).

Residual limits (for owner, not fixed here): the native navigation policy (`main.rs` `on_navigation`) still lets a widget
frame navigate to any artifact-scheme page, so a widget that colludes with an artifact holding a network grant can
carry its `context` data out in the URL (follow-up: refuse subframe navigations away from a `w-` page natively).
Scripts from the five default CDN hosts are outside the approval hash. A same-user process holding the owner token can
call `widget_act` without the confirm (ADR 0001 grant threat model). Checked in Chromium only, not WKWebView. A frame
that reloads itself in a loop makes one core `widget_page` call per load.

## Model and effort

<!-- v1a-10 -->
`Session` gains optional `model` and `effort` (absent = the agent's default; stores without them load). They
are set from `start` (`--model`/`--effort` for Claude, `-m`/`-c model_reasoning_effort=` for Codex) and after
a successful switch.

`{"op":"switch_model","id":…,"model":…|null,"effort":…|null}` changes a running session for that session
only. It is owner-only: a session token gets `operation not granted`. The model and effort must be in the
catalog (`CLAUDE_MODELS`, `CLAUDE_EFFORTS` in `sessions.rs`, equal to the window's
`web/src/picker/catalog.ts`; for Codex, Codex's own listed models from `$CODEX_HOME/models_cache.json`, else the
fixed list in `agent_models.rs`, which `{"op":"agent_models"}` serves to the window as `{codex: [{value, label,
efforts}]}`); anything else is refused before a byte reaches the PTY. It is refused while
the agent is working or a decision waits, while text is in the agent's own input box (Claude `❯ …`,
Codex `› …`; their empty-box placeholders count as empty), for a shell, and while another switch of that
session runs. `start` refuses a `model` or `effort` that is empty, over 100 bytes, starts with `-` or holds
whitespace (it could read as a flag), and a session token's `start` takes only catalog values.

- Claude: refused unless Claude is at its prompt. The core opens Claude's own picker with `meta+p` (`chat:modelPicker` in 2.1.310; never `/model`
  or `/effort`, which save defaults to `~/.claude/settings.json`), then reads the screen at each step: Down
  to leave search mode, Up/Down to the model row, Left/Right to the effort line, and `s` (2.1.310 shows "s to use this
  session only" under the list and a footer that names other keys without it fails the switch; 2.1.318 shows no hint,
  and only the confirmation proves the key; without the footer, a screen counts as the picker only with one 2.1.318 picker
  line ("Switch between Claude models" or "← → to adjust") and no input box below "Select model", so a block left in view
  gets no key; Enter would set the default and is never sent). An alias names its family:
  the first row whose label starts with it (2.1.318 lists "Sonnet 5.5" before the older "Sonnet 5"). It is done when the picker
  is gone and "for this session only" shows. A screen that does not match, or no redraw that matches within 4 s of a key (10 s after
  `s`), sends Esc and fails. Each step reads only a screen that changed since the last key and then stayed
  quiet for 100 ms. Success needs a "for this session only" line naming the chosen model. The reply is
  `delivery`: one send row that ends `delivered` or `failed`. While it runs, queued sends wait, raw
  `send_text`/`send_keys` are refused (`model switch in progress`) except a bare Esc, and the picker is not
  queued as a decision. A `null` effort leaves Claude's effort as it is when the model does not change.
- Codex: the session restarts into the same conversation (`codex resume <id> -m … -c
  model_reasoning_effort=…`) under the resume replacement rule: a new Nunchiro id replaces the old session,
  in the folder it ran in (its worktree stays its own: ownership follows `cwd`), with the original extra
  launch args when every one is on an allowlist of Codex 0.161.0 `resume` options: `-s`/`--sandbox` and
  `-a`/`--ask-for-approval` with their listed values, `-c`/`--config` with a key not starting with `model` or `profile` (quotes stripped),
  `--add-dir`, `--enable`, `--disable`, and the flags `--search`, `--no-alt-screen`, `--approve-for-me`,
  `--dangerously-bypass-approvals-and-sandbox`, `--no-daemon`. Anything else (`--`, a prompt, `-m`,
  `--model`, a model key in `-c`, an unknown option) refuses the switch before Codex is stopped, since the
  restart would resend or contradict it. So does a session whose launch args are not known (restored from
  disk, or started as a resume). The reply is `started` with the
  new session. It needs the conversation id Codex reported. A stop error counts only while the agent still
  lives (Darwin's `killpg` can report EPERM after the agent was killed and reaped); then nothing changes. If
  the restart cannot spawn, the old agent has already stopped and the error says so.

Each click writes one core log line: `switch session=… agent=… model=… effort=… result=…`.

## Images

Ticket v1b-05: images the user pastes or drops in the window composer are saved by the core so the agent can
read them by path (ADR Amendments, images). The system clipboard is never read beyond the paste or drop event's
own data and never written.

- Store: `$NUNCHIRO_HOME/images/<session-id>/<sha256>.<ext>`; folders 0700 (created on first use), files 0600.
  The name is the address: no index file, the same image saves once and names the same path. `ext` is
  `png`, `jpg`, `gif` or `webp`, decided by magic bytes; anything else (SVG, HTML, text) is refused.
- Upload (owner only; window WebSocket or the owner token on the unix socket; refused when forwarded to a
  remote machine and never granted to session tokens):
  `{"op":"image_put","session","upload","offset","chunk_b64","last","sha256"}`. `chunk_b64` is at most
  256 KiB of standard base64 (fits the 1 MiB WebSocket and 512 KiB unix-socket frame caps); `upload` is a
  client id of 8-80 `[A-Za-z0-9-]`; `sha256` is the whole image's lowercase hex. Pieces are appended to
  `images/<session>/.part-<upload>` in strict offset order; the last piece is checked (sha256, magic) and
  renamed atomically after fsync. Reply `{"type":"image","received":<bytes>,"path":null|"<absolute path>"}`.
  The session must exist. Any refusal (offset gap, over 20 MiB, wrong magic on the first piece, hash mismatch,
  bad base64) deletes the part. The write runs after the registry lock is released.
- Parts of uploads that never finished (window closed, ✕ during upload, core killed) are deleted at the next
  core start (`images::clean`).
- Window: the composer accepts PNG, JPEG, GIF and WebP whose bytes match their type, up to 20 MiB each and
  10 per message. On the user's Enter each is uploaded, then the prompt is one write: the composer text,
  then each absolute path on its own line in chip order, then the usual Enter. Claude Code 2.1.310 turns those
  path lines into `[Image #n]` attachments (a base64 `image` block in the transcript). Codex 0.161 keeps the path
  as text and reads it with its `view_image` tool (an `input_image` in that tool's output). Chat thumbnails come from
  transcript `image` events and from user-message lines that are exactly a saved path; paths are read through
  `file_read` (`data` root for saved images, the session's folder for agent-local paths), never directly.

Limits: no pruning of `images/` in v1b; thumbnails of saved images over 2 MB come from the composer's own
chip in the window that sent them, and are a named placeholder after a reload (`file_read` serves images up to
2 MB).
