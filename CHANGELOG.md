# Changelog

What changed for people who use Nunchiro. Newest first. Nunchiro is in development; expect breaking changes.

## 2026-11-28

- A project lead now merges a bot's task work into its own working branch by itself once the work is reviewed and
  approved, so you no longer press a merge card for each task; you get the lead's final result as a pull request.
  It never merges into the main branch: while the project is on its default branch, the card still asks you. Settings
  > Team has "Ask me before merging task work" (off by default) to bring the card back for a project.
- Settings > Assistants has an Account connectors switch. Off, your assistant starts with no tool server at all, so
  your claude.ai connectors (mail, calendar and the rest) never reach it, and any tool from one is refused if it shows
  up anyway. It still works with files in its folders. It applies the next time the assistant's seat starts.

## 2026-11-26

- A new bot takes a name and one sentence: "New bot" in the Bots view, or "New bot…" in the command palette. Its face
  is given and a press changes it, and six starts (Lead, Reviewer, Release notes, Chief, Peer watch, Docs) fill the
  sentence. Its chat opens at once: the bot greets you with one question, does one small job and writes its own SOUL
  file, which the chat shows on a card with Read, Edit and Undo. A Lead or Chief start asks in the chat where the
  bot sits; nobody takes a seat before you say so.
- A bot can offer you a new bot when the same kind of work keeps coming back. You get a card in Decisions with the
  name, the job and what the bot counted; nothing is made before you press Create bot.
- "Hand to a bot…" in a worktree row's menu hands that worktree to a bot you pick, with a line on what to do with it.
  The bot's chat opens; with no line, the bot asks.
- Bots have their own view ("Open Bots" in the command palette, also reached from Settings). Every bot has a face
  that shows its state (resting, working, needs you), a seat (Chief for the office, Lead of one project, or none), a
  SOUL file that says who it is and that you can edit there, its schedules, and its model settings. A project lead's
  chat header shows the lead's face.
- The teammates you already have become bots as they are. Your team file is copied to a backup before the first
  change, and an older build still reads it.
- An outward action is refused, not asked, when its card could not show all of it: a command too long for the card,
  or a call that carries a field named like a secret (a token or a password). This holds for Claude, Codex and ACP
  agents. The card for an ACP agent's command also shows its folder and the variables the agent set.
- Fixed: installing an update could put the old build back with "sessions did not come back" when an agent's own
  `nunchiro` command started the background service in the middle of the install.
- Showing a chat puts the cursor in its message box, and so does coming back to the window. A button, card, menu,
  dialog or field you had focused keeps the focus.
- Fixed: the window could crash when an agent's list of subagents came back in an unexpected form.
- For contributors: every web test, the screenshot tests included, and the long Rust tests run once a week on
  hosted CI; pull requests keep running the core set.
- Codex sessions and ACP agents now ask before an outward action too, as Claude sessions do: publishing a package,
  creating a release, making a repository public, or sending mail or posts through an MCP tool. In Codex the action
  waits for a card in Nunchiro, also in full access, and runs only when you allow it. For ACP agents this covers
  commands the agent asks Nunchiro to run; a tool an agent runs inside itself is outside Nunchiro's reach.
- A Codex start whose extra arguments set hooks is refused; keep your own hooks in Codex's config file.
- Fixed: on a second Mac driven over SSH, agents said "Not logged in" (and `gh` that its token was invalid) when
  Nunchiro's background service had been started by the SSH connection. It is now started in that Mac's login
  session. When nobody is logged in there, the Machines page says that its agents may not be signed in and what to do.
- A message you send to a session that waits at a start question (such as Claude's folder trust) is no
  longer refused: it waits in that session's queue and goes in once you answer the question in its terminal. From
  the command line, `nunchiro agent prompt` now says which session waits at which question, on which Mac, and how to
  drop the message, instead of only `agent_blocked`.

## 2026-11-25

- Every standing seat (a project's Lead, an assistant, a teammate) has a "New conversation" button in its header.
  One press stops a running turn and opens a fresh conversation with the same role, folder, model, effort and mode.
  The old conversation stays in History, and Undo (10 seconds) brings it back. Agents that cannot continue an old
  conversation show the button as unavailable and say why.
- Paste a `claude mcp add NAME -- COMMAND` line into the chat box and Nunchiro offers to add that MCP server. Nothing is
  added before you click; an idle session restarts with the server, a busy one gets it at its next restart, and values
  passed with `-e` are never saved.
- On a Mac where Claude and Codex have never run, the first prompt in Quick setup starts in Assistants, with no folder
  to choose first.
- Every Claude session asks before an outward action: publishing a package, creating a release, making a repository
  public, or sending mail or posts through an MCP tool. A project's own settings cannot turn this off.
- The status bar account applies to every new session. A card shows when the checked account has used a set share of
  its week (98% by default; you can change it). Nothing switches accounts on its own.
- Installing an update waits until the running agents are idle, with a time limit, instead of replacing the core
  under them.
- `nunchiro events --history DAYS` reads a small journal of state changes that survives a restart of the background
  service.
- The background service writes far less to disk while agents work, and builds from source use less memory.
