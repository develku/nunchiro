# Glossary

- **Decision queue** (결정 대기): items waiting on the user: agent permission requests and questions, cards in a column
  marked "needs decision", and items sent by integrations. Shown as decision rows on the session rows in the tree with
  the peek, and answered there or in the Decision widget (needs 95, 107; replaces the reserved rows and the strip above
  the composer of needs 26, 36, 39).
- **Bypass permissions** (full access): a session that no permission prompt stops: Claude's `bypass permissions` mode
  and Codex's `full-access`. One English label for both agents (chip, row mark, Settings), not "YOLO mode" (look v9 B N-S3-1).
- **Board**: the widget of task and session cards, stored in `board.toml`. Its default view is the watch view: columns
  derived from state (Needs you, Working, Next, Done), agents place Next cards, a card click opens its detail in place
  (needs 208); columns a user defines (default To do, Working, Needs decision, Review, Done; needs 154, replacing needs 43's
  four) belong to a user's own widget on the same card API.
  The code still ships the four until the needs 154 build lands (`crates/nunchiro-core/src/board/mod.rs:54`).
- **Task card** (needs 154): a board card that stands for one piece of work rather than one session; worker and
  reviewer sessions attach under it, each with a role chip and an assignee chip, and it carries `ref` (ticket path or
  URL) and `group`. A session attached to no task card keeps its automatic session card. Mockup approved (needs 155),
  not built.
- **Group** (board lane, swimlane; needs 154): the free-text `group` field of a card; the board draws one swimlane per
  group with a progress bar, falling back to the project. Nunchiro gives it no meaning (a coordinator may write
  milestone ids there); the lane key is switchable in the widget settings. Not a project tree group, and not a worker lane
  (one agent's worktree session in a coordinated run).
- **Receipt** (proof; needs 154): the sha, command and result a coordinator gives to move a card into a column with
  `proof = true` (Done by default); without one the card stops in Review. Moves by the user need none. Shown under the
  card's PR line.
- **Waits on** (needs 154): a display-only chip naming the card this card waits on; a cycle is refused, no order is
  enforced.
- **Stale badge** (needs 154, 155): the user-facing badge (yellow, dashed outline, clock) on a card whose session has
  been idle for 10 minutes; the time is configurable.
- **Turn-end nudge** (agent nudge, needs 154): a context line Nunchiro gives an agent at the end of each turn in which
  its card did not move; never typed keys. Configurable.
- **Coordinator** (board sense, needs 154): the session that started child sessions in a project; it becomes that
  project's coordinator automatically and may write every card there through `nunchiro board` (Done needs a Receipt),
  while other sessions move only their own card and the user can undo any change.
- **Saved widget view** (needs 154): what one placed board widget keeps of its own (visible card fields, filters, lane
  key), so the board can sit in any zone and look different in each; the board's data stays in `board.toml`.
- **Card source**: anything that feeds cards to the board: automatic session cards, manual
  cards, or an integration.
- **Integration source**: a named file or approved command that feeds board cards through the
  Integration contract. One kind of Card source; automatic session and manual cards are not
  Integration sources.
- **Board decision** (보드 결정): a Decision queue item raised by a manual or Integration source card in a
  needs-decision column, or an Integration source card with `needs_decision`; not a session item. Its identity is
  `manual:<id>` or `integration:<source>:<id>` plus the card's `updated_at`; answering marks it resolved in
  Nunchiro only (never written back), and a later `updated_at` raises it again (V1B-18).
- **Approval subject**: a widget or Integration source command whose manifest and command files
  are approved together by content hash, identified by Subject kind plus name.
- **Subject kind**: the approval namespace, `widget` or `source`. The latter identifies an Integration
  source command. Same-named subjects of different kinds have separate approvals. This differs
  from the manifest kind, which identifies the subject's content or execution form.
  `setup` (ticket 259) is a worktree setup script read from the repo (`orca.yaml` `scripts.setup`), approved per project
  by the content hash of its text; the owner's own typed scripts need no approval.
- **Integration contract**: a file or command that emits card JSON; the only way external
  tools (a personal roadmap, a local dashboard, later GitHub/Linear) reach the board.
- **Session**: one agent conversation, bound to a project folder or a worktree.
- **Start commit** (시작 커밋): the HEAD the core recorded when a session started, in its folder or worktree; Diff compares the folder against it (v1b spec B3).
- **Subscription path**: the user's own installed `claude` or `codex`, interactive, in a PTY; the
  chat view comes from its transcript and hooks.
- **ACP path**: agents driven over the Agent Client Protocol (API-key Claude, Gemini, others; Codex runs on the subscription path).
- **Transcript adapter**: the replaceable parser that turns an agent's session files (Claude, Codex) into chat events; one per agent.
- **Agent CLI**: the `nunchiro` command that agents inside Nunchiro sessions use to start, message,
  read and wait on other sessions (plus worktrees, widgets, browser and layout; board cards once ticket 183 lands); every send is logged and shown on the target session.
- **Nunchiro skill**: the shipped instructions that teach an agent the agent CLI.
- **Skills & hooks** (스킬·훅; agent extension in code and older records): a skill or hook that Nunchiro adds to one Nunchiro session at launch (skills by `--plugin-dir`, Claude hooks in the per-session `--settings` file, Codex by `-c` overrides); default (shipped) or custom (from Nunchiro's own folder), toggled per item on Settings > Skills & hooks (needs 65; ticket 391 renamed the page from Agent extensions). Never written into `~/.claude` or `~/.codex`; the user's own skills and hooks there are not agent extensions (needs 65, ticket V1B-39).
- **Artifact**: HTML, SVG, Markdown or image output from an agent (not the Claude.ai feature of the same name; a claude.ai artifact link an agent prints shows as a Claude link card, never loaded inside Nunchiro), a file it wrote or a `nunchiro-artifact` block, shown inside the conversation: HTML and SVG in a sandboxed frame, Markdown and images as one-line cards opened in Preview (v1b spec B2, ticket 06).
- **Chat event**: one rendered unit of the chat view (user message, assistant text, tool row, diff card, image, artifact card), projected by the core from an agent's transcript (v1b spec).
- **Slot** (icon bar slot, ICONBAR A, needs 116): one icon-size place in an icon bar (ten a side, `web/src/layout/bars.ts:10`); an icon sits in any slot, empty slots stay empty, an occupied slot swaps on a drop, slots a short window cuts off go behind a ⋯ button.
- **Icon bar** (아이콘 바): the left or right strip of slots holding widget icons in the window shell; each icon is one widget, and a click opens it in that side's sidebar (needs 100, LAYOUT D5b). The tree is required on one of them.
- **Sidebar**: the panel beside an icon bar that shows the one open widget of that side; clicking its open icon again collapses it. Not a zone, and not stored in `layout.toml`.
- **Widget library** (위젯 보관함): the edit-mode panel listing every built-in and user widget with where it is now; drag a card onto a bar or into a zone (needs 100).
- **Arrangement**: the icon bars' membership and order, the open widget per side, presets and the title-bar mode, kept as window settings; the zones stay in `layout.toml`.
- **Preset**: a named arrangement (main zones plus bars); Default, Review and Focus are built in, "Save as…" adds more (needs 100).
- **Title bar mode**: Always shown, Auto-hide (revealed at the window's top edge) or Hidden; the command palette keeps "Edit layout" and "Show title bar" in every mode.
- **Script widget**: a user widget that runs a user-approved command in the widget sandbox and shows its text or JSON output (needs 38, v1b spec).
- **Web widget**: a user widget made of HTML shown in the artifact sandbox, talking to Nunchiro only through the widget bridge (needs 38, v1b spec).

- **Built-in theme**: a theme that ships with the app: Nunchiro Light, Nunchiro Dark, Catppuccin Latte and Catppuccin
  Mocha (the last two from one fixed iTerm2-Color-Schemes version); can be hidden, not removed (needs 55, 70).
- **Imported theme**: a theme the owner added in the app, by paste, file, or applying an online theme in the gallery;
  it keeps its colours, an optional source and its licence; it can be removed. A dropped built-in still in use
  becomes one on upgrade (needs 55, 70, V1A-47, V1A-62).
- **Browse themes online**: the theme gallery's online part (Settings > Appearance, which took in the Theme page): iTerm2-Color-Schemes themes of that same upstream version,
  shown with installed themes in one grid; the index loads when the gallery opens and theme files only for cards
  on screen; off with the "Browse themes online" setting (needs 55, 70, V1A-47, V1A-62; ADR 0001 records the
  request).
- **Theme slot**: the light or dark theme used when following the system appearance; "Use for light" / "Use for
  dark" on a gallery card sets it; defaults Nunchiro Light and Nunchiro Dark (needs 55, 70).
- **Set aside** (state file): a `sessions.json` or `queue.json` of another `version` (a newer core's), kept beside
  itself as `<name>.v<N>.<unix-time>.aside` (0600), never loaded, deleted or overwritten; the core starts empty and,
  while a sessions one is kept, sweeps no saved scrollback or exports (V1B-40). Unlike the hook journal's
  **quarantine** (`hook-journal-quarantine/`, rejected hook events of any kind, capped and pruned oldest first), a
  set-aside file is whole state and is never pruned.

- **Group** (project tree; 프로젝트 그룹, called project group in older records; menus say New group, Move to group): a user-made, named, folding row in the project tree that holds projects; one group
  per project, ungrouped projects sit at the top with no header, never a layout, mode or switcher; stored in the
  core-owned `tree.toml` per machine (needs 81, spec V2-9, ticket V2-9a).
- **Space**: retired. Needs 22 proposed it and needs 81 replaced it with the project tree **Group**; do not use the word for
  anything in the tree.

- **Holder** (홀더): the per-session `nunchiro hold` process (same binary) that owns one agent PTY, its child process group
  and the scrollback ring, and survives a core exit, crash or update; it serves one core at a time over an owner-only
  socket, and its identity is a leader whose parent runs this executable (needs 32, 76, spec V2-1). Not: the core, or
  the agent itself.
- **Live record**: what a live session keeps in `sessions.json` (store version 2) beside its row: the session token's
  SHA-256 and the holder's record (socket path, protocol version, pid and start time); never sent to a window. A
  reattaching core re-proves it against the running holder before it sends a byte, and a v1 file has none (spec V2-1,
  V2-1a). Not: the session row, or the chat transcript.
- **UI language** (화면 언어): the language of the app's own window text, chosen in Settings > General > Language (`web/src/features/builtin.ts:30`; System by default, which follows macOS including its per-app language; needs 93, V2-14). Not: the language agents answer in, or terminal content; neither is translated.
- **Side pane** (옆 패널, AGENTVIEW, needs 108, 110): the resizable pane next to the chat with tabs for the session's PTY, extra shells, the v3 browser and previews; starts closed, remembered open per session.
- **Temporary split** (임시 분할, TERMW + PEEKSPLIT, needs 112): a widget or session dragged into the centre and shown as a split pane; per session, it stays until the user closes it (needs 114) and is not written into the Layout (배치) preset.
- **Persistent split** (고정 분할, PEEKSPLIT amend, needs 114): a split pinned with 📌, kept in the Layout (배치) preset for all sessions.
- **Decision widget** (Decisions, 결정 위젯, DECISIONW, needs 107): the widget in the Widget library that lists pending decisions and holds the risky allow; place it anywhere, off by default in the chat area. The tree's decision rows and peek stay the primary place.
- **Tokens** (`tokens.css`, STYLE, needs 102): the shared semantic colour roles (page, panel, text, muted, line, hover, focus ring, status hues) every screen reads; user themes map onto them.
- **Limit mark** (ticket 31, needs 66): the "limit · resets <time>" badge on an account's cell, set when a session of that account shows its usage limit on screen. Display only, memory-only (lost on core restart); text a session merely prints can set it for its own account.
- **Codex reset** (리셋권, reset ticket, needs 225): a ticket on a Codex account that refills its usage windows at once when used; read and used only through the user's own `codex` (Settings > Accounts & Usage, off by default). **Allow ahead** (미리 허용): the agent policy that uses one for an agent without asking when the owner's conditions hold.
- **Kind key** (needs 118): a user-assignable key pressed after the hint key that narrows hints to one kind of target: p projects, s sessions, t tabs, l left icon-bar icons, r right icon-bar icons, w panes and splits, f files and paths, u URLs (plus o other, h hashes). A kind key is never also an alphabet key.
- **Hint alphabet** (needs 118): the user's string of keys (WezTerm `quick_select_alphabet` style, order = priority, stored as physical codes) that hint labels are made from, shortest labels first; kind keys are removed from it automatically.
- **Claude link card** (needs 117, ticket 73): the one-line chat card for an exact `https://claude.ai/artifact/<id>` or `/code/artifact/<uuid>` link an agent printed; "Open in browser" uses the user's browser, the page is never loaded inside Nunchiro. Not a local Artifact.
- **Settle** (치우기, needs 131): put a session out of the way without deleting it; it leaves the inbox view of the tree and stays undoable. Not Close (needs 120), which ends the session. Dropped with needs 131 (owner 2026-10-30); kept so old records read.
- **Snooze** (잠시 숨김, needs 131): hide a session from the tree until a chosen time, then it comes back on its own. Not Settle, which has no return time. Dropped with needs 131 (owner 2026-10-30).
- **Steer** (끼어들기, needs 134): send text into a session that is already working so it takes effect now, instead of waiting for the next step. Ctrl+Enter steers; Enter queues.
- **Background send** (백그라운드 전송, needs 133): Cmd+Enter sends the composer's text to a session and moves on without opening or waiting on it.
- **Takeover** (이어받기, needs 13): the user's own click or typing in a tab the agent drives; the agent pauses and shows it until the user hands the tab back.
- **Dev web-load** (needs 151, ticket 172): a debug-only mode in which the app window loads the web UI from a checkout
  folder or a loopback dev server named by `NUNCHIRO_WEB` instead of its embedded copy; Develop > Reload UI shows a web
  build without an app rebuild (`app/src-tauri/src/dev_load.rs`). Release builds refuse the variable.
- **Phone and web access** (ticket 1049): the Settings page (id `browser`) that lets a paired phone or another browser reach this Mac (on/off, port, addresses, paired devices). Not the In-app browser; the old name "Browser access" stays a search word.
