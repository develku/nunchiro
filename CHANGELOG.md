# Changelog

What changed for people who use Nunchiro. Newest first. Nunchiro is in development; expect breaking changes.

## 2026-11-26

- Codex sessions and ACP agents now ask before an outward action too, as Claude sessions do: publishing a package,
  creating a release, making a repository public, or sending mail or posts through an MCP tool. In Codex the action
  waits for a card in Nunchiro, also in full access, and runs only when you allow it. For ACP agents this covers
  commands the agent asks Nunchiro to run; a tool an agent runs inside itself is outside Nunchiro's reach.
- A Codex start whose extra arguments set hooks is refused; keep your own hooks in Codex's config file.

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
