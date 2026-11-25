// Ticket 1123 (first use; owner-approved mockup docs/design/first-use-1123, 2026-11-25): Quick setup's folder and first
// prompt (T1), and the one-field MCP add with its restart line (T10). English only until the release language pass.
declare module '../index' {
  interface AreaKeys {
    'firstUse.quick.body': true;
    'firstUse.folder': true;
    'firstUse.lastUsed': true;
    'firstUse.choose': true;
    'firstUse.prompt': true;
    'firstUse.promptHint': true;
    'firstUse.start': true;
    'firstUse.addOnly': true;
    'firstUse.mcp.paste': true;
    'firstUse.mcp.name': true;
    'firstUse.mcp.hint': true;
    'firstUse.mcp.added': true;
    'firstUse.mcp.restart': true;
    'firstUse.mcp.keeps': true;
    'firstUse.mcp.new': true;
    'firstUse.mcp.agentLine': true;
    'firstUse.mcp.remote': true;
    'firstUse.mcp.envDropped': true;
    'firstUse.mcp.working': true;
    'firstUse.ago.now': true;
    'firstUse.ago.m.one': true;
    'firstUse.ago.m.other': true;
    'firstUse.ago.h.one': true;
    'firstUse.ago.h.other': true;
    'firstUse.ago.d.one': true;
    'firstUse.ago.d.other': true;
    'firstUse.rowPlus': true;
    'firstUse.cmd.worktreeAgent': true;
    'firstUse.why.noRepo': true;
  }
}

export const en = {
  'firstUse.quick.body': 'Pick a folder and tell {name} what to do. The recommended settings below apply when you start.',
  'firstUse.folder': 'Folder',
  'firstUse.lastUsed': 'last used with {agent}, {when}',
  'firstUse.choose': 'Choose folder…',
  'firstUse.prompt': 'First prompt',
  'firstUse.promptHint': 'What should {name} do?',
  'firstUse.start': 'Start {name}',
  'firstUse.addOnly': 'Add a project without starting',
  'firstUse.mcp.paste': 'Paste a command',
  'firstUse.mcp.name': 'Name',
  'firstUse.mcp.hint': 'Taken from the command; Enter adds. A pasted "claude mcp add NAME -- …" line works too.',
  'firstUse.mcp.added': 'Added {name}. Sessions started from now on get it.',
  'firstUse.mcp.restart': 'Restart {name} with it',
  'firstUse.mcp.keeps': 'Keeps the conversation',
  'firstUse.mcp.new': 'New session',
  'firstUse.mcp.agentLine': 'This line runs claude or codex itself. Paste a "claude mcp add NAME -- COMMAND" line or the server\'s own command.',
  'firstUse.mcp.remote': 'Only local servers that run a command can be added here; this line adds a remote (http or sse) server.',
  'firstUse.mcp.envDropped': 'Not added: the values of {names}. Servers added here get no environment values.',
  'firstUse.mcp.working': '{name} is busy (working or waiting for you). Restart once it is idle.',
  'firstUse.ago.now': 'just now',
  'firstUse.ago.m.one': '1 minute ago',
  'firstUse.ago.m.other': '{n} minutes ago',
  'firstUse.ago.h.one': '1 hour ago',
  'firstUse.ago.h.other': '{n} hours ago',
  'firstUse.ago.d.one': '1 day ago',
  'firstUse.ago.d.other': '{n} days ago',
  // Ticket 1130 (B-L1): the project row's "+" (C1) and the one-chord worktree agent (C2).
  'firstUse.rowPlus': 'New {agent} session in {name}',
  'firstUse.cmd.worktreeAgent': 'New agent in a new worktree',
  'firstUse.why.noRepo': 'No worktree here: this folder is not a Git repository, or it is on another machine',
};
