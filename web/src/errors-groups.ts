// Ticket 601 round 2: the core reasons a user can reach that share a next step, one plain line per group (`err.h.*`, 8
// languages, src/i18n/areas/errors-groups.ts). Each entry is the core's wording with `{}` for a value; `tests/core-reasons.ts`
// finds the same wording in the core source, and tests/errors-core-reasons.spec.ts fails when a reason here is gone from it.
import type { Key } from './i18n';

const esc = (s: string) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\}/g, '[\\s\\S]+?');
/** One KNOWN row for the templates: the whole message, with `{}` standing for any value. */
const row = (what: Key, templates: string[], todo?: Key): [RegExp, Key, Key?] => [new RegExp(`^(?:${templates.map((t) => TIGHT[t] ?? esc(t)).join('|')})$`), what, todo];
/** A template whose `{}` is one of a few fixed words in the core (`7` is the stand-in tests/core-reasons.ts gives a value). */
const TIGHT: Record<string, string> = {
  'too many {}': 'too many (?:pins|added projects|fold keys|7)',
  'duplicate in {}': 'duplicate in (?:pins|added projects|fold keys|7)',
};

// A template that starts with a value (`{} was not found`, `{} is not a folder`, `line {}: {}`, `over {} bytes`, ...) also catches a
// reason of that shape built at run time. These rows come last in KNOWN, so an earlier row still wins; a future core reason of such a
// shape gets its group line silently, so read the line before adding a template like that.
export const GROUPS: Record<string, string[]> = {
  'err.h.later': [
    'machine is already being forgotten', 'machine channel is still closing; retry removal', 'machine start in progress; retry removal', 'machine is being forgotten',
    'a new conversation is already being opened', // team.rs: a second New conversation (or its Undo) while the first one opens
    'a check is running', '{} is signing in', 'agent commands are busy', 'chat cache busy', 'chat append already pending', 'chat append exceeded hook wait',
    'search canceled', 'already loading that theme', 'request failed', 'could not start the request; try again', 'could not start the sign-in: {}',
    '{}; the agent still runs', '{} already running',
    'Codex did not stop ({}); nothing changed', '{} has not reported its conversation id yet',
    '{}; current line not cleared: a dialog is focused or the screen is not current', '{}; current line cleared', 'not imported',
    "fast mode is available after Claude's first reply", // sessions/claude_modes.rs (fast mode, ultracode, restart); nightly 11-21
  ],
  'err.g.extGone': [
    "no task {}", "no note {}", "no open loop {}", // ledger.rs, notes.rs, roles.rs, sessions.rs: merge card, role card, Settings > Notes, way menu (ticket 991)
    "no teammate {}", // team.rs (ticket 970)
   
    'ask {} already timed out', 'unknown account "{}" for {}; see nunchiro account list', 'unknown account "{}"; the accounts are: {} (or own)', 'unknown {} account', "this conversation's account is no longer in the account list", 'no agent "{}" in agents.toml',
    'the agent no longer reports this sign-in method', 'no update is running', 'board decision not found', 'board session not found', 'linked board session not found', 'manual card not found', 'waits_on card not found: {}', 'attached session not found: {}',
    'board column not found', 'board card not found: {}', 'new board card not found', 'integration source not found', 'integration source card not found', 'fork message unavailable',
    'not a changed file', 'unknown service', 'no such device', 'browser connection revoked or not tracked', 'conversation {} is not in the agents\' folders', 'not a transcript under the agent\'s folder',
    'that library is not pinned', 'remote decision not found', 'retry needs a listed machine alias', 'unknown clone', 'no such schedule', 'session has no log', 'unknown group {}', 'token not found', 'decision not found',
    'message not found in this room', 'ask not found in this room', 'send not found', 'send is not queued', 'worktree not managed or outside grants', 'worktree not managed',
  ],
  'err.h.fileBad': [
    'a set-aside sessions.json is kept: its sessions would stay at the old folder', // sessions/locate.rs: Locate (ticket 1040); the Problems row names the folder
    "ledger.json: {}", "ledger.json has version {}, this build reads 1", "notes.json: {}", "notes.json has version {}, this build reads 1", "loops.json: {}", "loops.json has version {}, this build reads 1", "roles.json: {}", "roles.json has version {}, this build reads 1", "{}.json: {}", // ledger.rs, notes.rs, roles.rs, sessions.rs: merge card, role card, Settings > Notes, way menu (ticket 991)
    // team/bots.rs (ticket 1168): a bots.json this build cannot read, and what a bot in it may not say.
    "bots.json is too large", "bots.json: {}", "bots.json has version {}, this build reads 1", "bots.json holds an id that is not a bot id: \"{}\"", "bots.json: {}: a face is two plain words", "bots.json: {}: {}", "team.json has too many backups; move some away", "SOUL.md: {}",
    "a bot runs Claude, Codex or an ACP agent", "a bot in a seat has no other project", "a pinned model has its own effort", "a lead seat names its project, another seat names none", "unknown variant `{}`, expected `none`, `chief` or `lead`", "a pinned rule names its model, a follow rule names none", "unknown variant `{}`, expected `follow` or `pinned`",
    'schedules.json has no folder', "team.json is too large", "team.json: {}", "team.json has version {}, this build reads 1", "team.json holds an id that is not a teammate id: \"{}\"", "teammate project {}: {}", // team.rs (ticket 970)
   
    'the conversation\'s record could not be copied: {}', 'the other account holds something that is not a record under this conversation\'s name; nothing was copied', '{} must not be a symlink', '{} is not a regular file', 'invalid {}: {}', 'invalid {}: larger than 1 MiB', 'invalid {}: version', 'invalid {}: account entry',
    'agents.toml is too large', 'invalid agents.toml: {}', 'invalid agents.toml: {}: display: that name belongs to another agent', 'invalid agents.toml: bad or repeated name "{}"', 'invalid agents.toml: {}: command must be an absolute path', 'invalid agents.toml: {}: bad args', 'invalid agents.toml: {}: env holds variable names only', 'invalid agents.toml: {}: display: {}',
    '{}; fix agents.toml, then run the check again', '{} command: {}', 'unsupported approvals store version', 'invalid approvals store relationship',
    'settings.stale_minutes must be 1 to 1440', 'settings.done_days must be 1, 7 or 30', 'invalid board store: {}', 'unsupported board store version', 'invalid board seen markers', 'invalid board held drag relationship', 'invalid board resolutions', 'invalid board store columns', 'invalid board store column relationship', 'duplicate board store state', 'invalid board manual card relationship', 'invalid board card history', 'invalid board waits_on relationship', 'board.toml disappeared during reload', 'board store exceeds 8 MiB', 'invalid or oversized {}', 'board file exceeds limit',
    'unsupported sources version', 'line 1: {}', 'line 1: integration source must be a regular file', 'line 1: integration source exceeds 1 MiB', 'line {}: {}', 'line 1: at most 4096 cards', 'line 1: invalid or duplicate card id', 'line 1: invalid card text', 'line 1: invalid card URL', 'line 1: URL must use http or https with a host',
    'board.toml: settings is not a table', 'board.toml: {}', 'board.toml would exceed 1 MiB', 'invalid chat cache file', 'invalid legacy metadata', 'legacy extension conflicts with new metadata', 'oversized legacy extension metadata',
    'chat log is not a regular file', 'oversized chat log record', 'invalid chat log event', 'invalid chat log identity', 'invalid empty chat log', 'chat log count overflow', 'incomplete chat log', 'invalid chat append event', 'oversized chat append event', 'invalid chat log range', 'invalid chat data offset', 'invalid chat cursor relation',
    'invalid or oversized chat metadata', 'invalid chat metadata: {}', 'unsupported Stop store version', 'invalid Stop lock', 'invalid or unsupported chat metadata', 'transcript is not a regular file',
    'the log is too large', 'trust_level for {} is not trusted or untrusted', 'cannot read {} ({})', 'over {} bytes', 'sandbox_mode in {} is not a string', 'send log limit exceeded', 'invalid send log relationship', 'invalid send queue relationship',
    '{} (kept untouched: fix or remove it to save layout changes)', '{}: {} (kept untouched: fix or remove it to save layout changes)', '{} (kept untouched)', 'layout: {}',
    '{} is not a regular file under 4 MiB', 'libs.json: not a regular file', 'version {} is not read here', 'entry {}{} is not consistent', 'too many entries', 'auto-allow names something other than one cdnjs library', 'defaults_offered names something other than distinct cdnjs libraries', 'manifest: {}', 'manifest: version 1 expected',
    'invalid machines store: {}', 'unsupported machines store version', 'ssh control folder {}: {}', 'ssh control folder {} is not a plain folder; refused', 'ssh control folder {} is owned by another user; refused', 'ssh control folder {} has mode {}, not 0700; refused', 'ssh control path {} is too long', 'invalid machines settings: {}',
    'invalid queue file', 'invalid queue: {}', 'invalid queue: expected an object', 'queue limit exceeded', 'invalid queue session', 'invalid queue relationship', 'invalid event identity', 'invalid owner item', 'queue store exceeds limit', 'invalid resume queue identity', 'prior queue session missing', 'invalid room log',
    '{} is not a regular file or is too large', '{} is too short', '{}: unknown version {}', '{}: entry {} was not written by this core', '{}: duplicate id or relative project in {}', 'export folder is not a private folder', 'data folder must not be a symlink', 'scrollback is not a file',
    'invalid settings: {}', 'invalid worktree store', 'invalid worktree store: {}', 'invalid worktree store relationship/version',
    'invalid metadata: {}', 'invalid metadata: expected an object', 'invalid metadata relationship', 'state file has no name', 'state file is not a regular file', 'state file has no folder', 'no free name to set the state file aside', 'state file changed while it was set aside', '{} would be {} bytes, over its {}-byte limit; nothing was written',
    'tree.toml: {}', 'tree.toml is not a regular file or is too large', 'tree.toml: unsupported version', 'tree.toml is not a regular file', 'tree.toml would exceed its size limit', 'widget cache must not be a symlink', 'widgets folder must not be a symlink',
    'invalid {} name', '{} folder must not be a symlink',
    'sessions.json: {}', 'invalid outbox domains', 'queue store is not an object', 'the Home seat lock hook could not be written', // ticket 1002 (Home chief of staff, Outbox), worktree sharing; nightly 11-21
  ],
  'err.h.limit': [
    "the ledger is full: close or drop tasks first", "the list holds at most {} notes; remove some first", "at most {} roles", // ledger.rs, notes.rs, roles.rs, sessions.rs: merge card, role card, Settings > Notes, way menu (ticket 991)
    "a team holds at most {} teammates", // team.rs (ticket 970)
    "{} open loops already: close some first", // loops.rs: the yes on a "Keep track?" card (ticket 1003)
   
    'this conversation\'s record is too large to copy', 'deeper than {} folders; left in place', 'board seen marker limit exceeded', 'board manual card limit exceeded', 'board held drag limit exceeded',
    'at most 64 integration sources', 'search lists 1 to {} sessions', 'too many servers', '{} is larger than 256 KiB; it is not shown here', 'too many watched chat sessions', 'too many watched sessions', 'image over 20 MiB', 'a listing takes at most {} projects', 'import takes 1 to {} conversations',
    'at most {} libraries per page', 'too many pending decisions',
    'body over 8 KB: write it to a file and send the path', 'cache over {} MiB', 'at most {} schedules', '{} would be too large: remove a schedule or shorten a task', 'too many watched pull requests', 'composed input exceeds 64 KiB', '{} secret variable(s) too long for one keychain item', 'too many {}', 'too many project names', 'too many waiting items', 'too many waiting owner items',
    '{} already has {} running sessions in this project; stop one first', 'too many terminals', 'too many requests wait for this machine', 'pin_full: this room has {} pins; unpin one first',
    '{}: at most {} files and {} folders per project', // ticket 1002 (Home chief of staff, Outbox), worktree sharing; nightly 11-21
  ],
  'err.h.value': [
    "a role note names its role", // ledger.rs, notes.rs, roles.rs, sessions.rs: merge card, role card, Settings > Notes, way menu (ticket 991)
    "a SOUL needs at least one line", "a SOUL has at most 16 KB and no control characters", // team/bots.rs (ticket 1168)
    "a teammate runs Claude, Codex or an ACP agent", "a model or effort is 1 to 100 characters", "a teammate's name has 1 to {} characters and no control characters", "a teammate needs a job: one or two lines on what it is for", "a teammate's job has at most {} characters and no control characters", "a teammate's project must be a real folder, not through a symlink", 'a worktree is handed to the lead of its project', // team.rs (tickets 970, 990)
   
    'a saved machine is already named {}; forget it first or use a link with another label', // machines/share.rs: Add machine from a link
    'invalid resume session id', 'two {} accounts are named "{}"; remove one', 'not an account variable', 'invalid account id', 'env holds variable names only (A-Z, 0-9, _), names only; values stay in your environment', 'the command and its arguments cannot hold control characters',
    'the path names no folder', "the path's folder holds a colon", 'board title must have 1 to 256 bytes; note at most 65536 bytes', 'receipt fields (sha, command, result) need 1 to {} bytes each', 'receipt must be plain text: no control characters', 'board text must be plain: no control characters',
    'the board has no Done column', 'expected 1 to 64 columns', 'integration source path must be absolute', 'invalid or duplicate integration source name', 'search text must be 1 to {} bytes', 'search text needs at least one plain character', 'invalid send text',
    'command: one to 64 non-empty arguments', 'path: 1 to 6 names joined by /, each 1 to 100 bytes, not . or .., no control characters', 'description: one line of 1 to 300 characters', 'query must be 1 to 256 bytes', 'pick a port from 1024 to 65535',
    'a test origin must be http://127.0.0.1:<port>/', 'not auto-allowed: the manifest does not list this file', 'auto-allow is only for cdnjs libraries', 'empty body', 'thread names are 1-40 of a-z, 0-9, - and _',
    'a schedule runs Claude or Codex only', "a schedule's task has 1 to {} characters and no control characters", "a teammate's schedule needs a teammate and a task", 'schedule name is too long or has control characters', 'schedule project must be a real path, not through a symlink', 'schedule time "{}" is not HH:MM', 'schedule date "{}" is not YYYY-MM-DD HH:MM', 'a daily schedule has a time, not a date',
    'hand off to an ACP agent by name', 'only a hand-off to an ACP agent names an agent', 'hand off to another agent: Claude, Codex or an ACP agent', 'nothing to send', 'label exceeds 256 bytes', 'an instruction cannot start with /, ! or #',
    'start folder is not a managed worktree of this project', 'folder cannot be combined with worktree or resume', 'invalid repository name', 'the repository has no parent folder', 'worktrees_dir must be absolute', 'invalid project',
    'project must be an absolute path of at most {} bytes without NUL', 'duplicate in {}', 'a project is in two groups', '{} is not a folder', 'invalid widget name: use a-z, 0-9, - and _ (up to 64, not starting with - or _)', 'invalid network host "{}"',
    '{}: a Home seat runs with the mode in Settings > Assistants and its lock; this argument is not taken', 'shared path "{}" {}', // ticket 1002 (Home chief of staff, Outbox), worktree sharing; nightly 11-21
    "fast mode runs on Opus 5.5 or Fable 5.2; pick one of them first", // sessions/claude_modes.rs (fast mode, ultracode, restart); nightly 11-21
  ],
  'err.h.notFor': [
    'not a repository of a PR an agent created or you watch', "no config folder for the agent's own account", 'only Claude and Codex have a command to approve', 'this service has no sign-in command', 'this service has no sign-out command', 'merge is only for a PR an agent made or you pinned', 'a shell session has no model picker', "an ACP agent has no model picker here", "an ACP agent's effort is set in the agent",
    'only Claude and Codex have a permission setting', 'only Claude sessions have a live permission-mode cycle', 'skip permissions is not in this session\'s mode cycle: {}', 'this session\'s mode cycle has no {}', 'Side chat requires Claude or Codex', 'an account is only for claude or codex sessions', 'an account is only for claude or codex seats',
    'an ACP agent has no PTY', 'an ACP session takes its agent name only (acp:<name>)', "an ACP agent's model and effort are set in the agent", 'an ACP agent has no account; it signs in on its own', 'an ACP agent takes a text prompt or Esc', 'this agent does not offer sign-out',
    '{} is not a script widget', '{} is not a web widget', 'shell sessions have no agent transcript',
    'this worktree has no setup script to approve', 'setup scripts are off for this project', 'not a worktree Nunchiro made', // ticket 259
    "the chief of staff's seat is not handed off in v1", "Home seats are Claude in v1 (the chief of staff's lock is for Claude seats)", // ticket 1002 (Home chief of staff, Outbox), worktree sharing; nightly 11-21
    "ultracode is Claude's only", "fast mode is Claude's only", "only Claude and Codex restart", "this session keeps the settings it started with", // sessions/claude_modes.rs (fast mode, ultracode, restart); nightly 11-21
  ],
  'err.h.nothingUndo': ['nothing to undo on this card', 'nothing to undo (up to {} steps)'],
  'err.h.noLimit': ["no usage limit with a reset time ahead is on this session's screen"],
  'err.h.nothingInterrupt': ['nothing to send now'],
  'err.h.signIn': ['glab reports no signed-in host'],
  'err.h.ghAnswer': ['gh gave no squash message for this PR', 'gh output too large', 'gh output is not a PR', 'gh answered for another PR', 'gh gave no head commit', 'gh output is not a PR list', 'gh output is not JSON', 'gh output has no repository', 'gh failed: {}'],
  'err.h.checkFirst': [
    'this entry is identical to one in agents.toml and is not approved: press Run check on its row in Settings > Agents (an entry you typed here that matches the file counts as that entry)', 'check the command first', 'the command changed since it was checked; check it again', 'merge needs the confirmed head commit',
  ],
  'err.h.agentStart': [
    '{} was ended by signal {}{}', 'acp agent {}: {}', 'no agent stdin', 'no agent stdout', 'initialize: {}', 'the agent speaks ACP version {}; Nunchiro speaks version {}', 'the agent cannot load a session', 'session start: {}', 'session/new answered no session id', 'the agent closed its output before answering ACP',
    'check folder: {}', 'the agent is not reading its input: {}', 'the agent did not answer {} within {} s', 'the agent closed its output before answering {}', 'a check failed', '--version did not finish: {}', '--version failed ({})', '--version printed nothing',
    '{} --version: probe ended without an answer', '{} --version: {}', 'version probe ended without an answer',
  ],
  'err.h.inside': [
    "ledger unavailable", "notes unavailable", "roles unavailable", "open loops unavailable", // ledger.rs, notes.rs, roles.rs, sessions.rs: merge card, role card, Settings > Notes, way menu (ticket 991)
    "team store unavailable", // team.rs (ticket 970)
    'team unavailable', // team.rs: Locate moves a project's teammates (ticket 1040)
   
    'handoff not sent', 'sha256 does not match the bytes received', 'theme fetcher unavailable', 'update list unavailable', 'sign-in list unavailable', 'account registry unavailable', 'session registry unavailable', 'the entry did not round-trip through agents.toml', 'Stop store unavailable', 'session list unavailable', 'chat store unavailable', 'chat source unavailable', 'transcript source unavailable', 'chat unavailable',
    'sessions unavailable', 'cache unavailable', 'browser broker unavailable', 'integration source state unavailable', 'clone list unavailable', 'room cache unavailable', 'room pins unavailable', 'token store unavailable', 'widget state unavailable', 'widget act state unavailable', 'version probe thread: {}',
  ],
  'err.h.io': [
    'room: {}', // sessions/locate.rs: Locate could not move the project's room folder (ticket 1040)
    "the goal was not sent: {}", // sessions.rs: the goal card (Home view)
    "the {} was not recorded: {}", // ledger.rs, notes.rs, roles.rs, sessions.rs: merge card, role card, Settings > Notes, way menu (ticket 991)
    'account folder: {}', 'could not make {}: {}', 'logout status: {}', 'account trash: {}', 'account remove: {}', 'agents.toml: {}', '{} could not be saved: {}', '{} is unreadable: {}', 'could not save the library: {}', 'worktree start failed: {}', 'worktree metadata failed: {}; inspect {}',
    'the home\'s path cannot be named to the keychain', 'secrets not encoded', 'could not run curl: {}',
  ],
  'err.h.changed': [
    "{} has another leader or none now: the goal was not sent", // sessions.rs: the goal card (Home view)
    "task {} is closed; nothing is kept from a closed task", "this task has no merge card: a lesson is kept from its card", "task {} is closed; there is nothing to merge", // ledger.rs, notes.rs, roles.rs, sessions.rs: merge card, role card, Settings > Notes, way menu (ticket 991)
    'account folder changed during the remove; nothing was removed', 'could not save the library: its stored file was removed meanwhile', 'card changed', 'fork message changed; select it again', 'chat changed while reading', 'transcript identity changed during read', 'the agent command changed since this start was prepared; start it again',
    'the branch changed while the worktree was made; try again', 'the worktree folder is there again; nothing was removed', 'handoff target changed; try again', 'this card offers another fix', 'act grant changed before the send; nothing sent', 'widget changed since the confirm; nothing sent (review {} again)',
    'setup script changed since it was shown; review it again', // ticket 259
    'it is already sending: only Undo answers it now', // ticket 1002 (Home chief of staff, Outbox), worktree sharing; nightly 11-21
  ],
  // Ticket 259: the owner's cleanup script refused a remove; the worktree stays.
  // sessions.rs teammate_removed: the window's Remove teammate; the core's sentence under Details names what is left.
  'err.h.teamLeft': ['The teammate is removed, but {}.'],
  'err.h.outboxOpen': ['it did not open, the card stays: {}'], // ticket 1002: Open on an Outbox card, mail app or Calendar
  'err.h.cleanup': ['cleanup script did not finish in {} s; the worktree is kept', 'cleanup script failed (exit {}); the worktree is kept', 'cleanup script ended without an exit code; the worktree is kept'],
  'err.h.widgetBad': [
    'unsafe path or symlink: {}', 'non-UTF-8 path', 'unsafe approval path', 'widget folder nesting exceeds limit', 'widget folder has too many files', 'widget folder is too large', 'non-UTF-8 file name', 'approval folder metadata exceeds limit', 'approval subject contains a symlink or special file',
    'widget.toml is too large', 'invalid widget.toml: {}', 'unsupported widget.toml version {}', 'command has a hidden, control or bidi character (U+{}) the sheet cannot show', 'script needs a non-empty `command` and no `entry`', 'web needs `entry` inside its folder and no `command`', 'kind must be script, web or integration',
    'command path "{}" is outside the widget folder; name a file in the folder, or as the program a binary in {}', 'interval must be 1..=86400 seconds and only for commands', 'permissions must include read', 'author must not contain hidden, control or bidi characters', '[act] is only for script widgets whose permissions include act',
    '[act] needs exactly one of session = "<label>" or start = "claude"|"codex"', 'read is only for script widgets', 'read lists at most {} paths', 'invalid read path "{}": use ~, ~/<path> or an absolute path, without . or .. parts', 'program name "{}" must be ASCII (after case folding) so the sheet shows which program runs', 'inline script ({}) for {} is refused; put the script in a file in the widget folder',
    'invalid integration source name', 'missing widget.toml', 'widget.toml is not UTF-8', '{} does not declare "{}" permission', 'integration source manifest kind must be integration', 'entry {} is missing', 'entry over {} MiB', 'entry is not UTF-8',
    'cache is a symlink', 'non-UTF-8 sandbox path', 'invalid sandbox path', 'sandbox could not count processes', 'sandbox spawn: {}', 'missing stdout', 'missing stderr', 'sandbox could not stop the run', 'stdout reader failed', 'stderr reader failed', 'sandbox output cap exceeded', 'sandbox command failed: {}', 'cache parent missing', 'sandbox self-check: nc missing', 'sandbox self-check allowed a denied write', 'sandbox self-check failed: {}', 'sandbox environment key {} not allowed', 'runner unavailable',
  ],
  'err.h.machineFail': ['remote reply exceeds 8 MiB limit', 'machine {}: SSH {}', '{} sent no ed25519 host key', 'machine {}: SSH {}: {}', 'ssh failed: {}', 'the relay did not start with a valid hello', '{} discovery failed: {}', 'command timed out after {} ms'],
  'err.h.actRefused': [
    'act text contains an invisible, bidi or control character (U+{}); nothing sent', 'act text stacks more than {} combining marks on one character; nothing sent', 'act text has a joiner or variation selector run that follows no visible character; nothing sent', 'the table hides rows past {}; act sends only rows it shows', 'the table hides columns past {}; act needs output it shows whole',
    'invalid [act] template: {}', 'invalid [act] template: `{}`', 'act needs rows that are JSON objects', 'this row has no field {}', 'field {} is a number the table shows differently; print it as a string', 'field {} is not a string, number or boolean', 'field {} contains a newline', 'no session named {}', '{} sessions named {}',
    '{} has no [act] in widget.toml', 'act needs the placement\'s session for its project', 'act needs JSON array output', 'session {} is a shell; act sends only to Claude or Codex sessions', '{} has no [act] target', 'the page was framed without act; nothing sent (reload {})', 'act target is one of session = <label> or start = claude|codex', 'one act per second; nothing sent',
    'act text is empty; nothing sent', 'act text over {} characters; nothing sent', 'act text contains a control character (U+{}); nothing sent', 'act text contains a space other than U+0020 (U+{}); nothing sent', 'act text has more than 2 spaces in a row; nothing sent',
  ],
  'err.h.ownSignin': ["the agent's own account signs in only in a terminal; browser sign-in is for added accounts", "only the agent's own account signs in through this step"],
  'err.h.signOutFail': ['the agent did not finish signing out', 'the agent could not sign out'],
  'err.h.gitOld': ['git: version {} is too old to read safely; git 2.31 or later is needed'],
  'err.h.homeFolder': ['an ACP agent cannot run in your home folder itself; pick a project folder'],
  'err.h.boardCycle': ['waits_on would make a cycle', 'undo would make a waits_on cycle'],
  'err.h.notText': ['{} is not UTF-8 text', 'not a file'],
  'err.h.onMac': ['answer this on the Mac'],
  'err.h.riskyCard': ['risky: allow it in the decision card (focus, then Enter)'],
  'err.h.shellPath': ['no PATH in the shell output', 'the shell printed an empty PATH'],
  'err.h.answerDecisions': ['a request you have not seen is pending: answer it in the Decisions widget, then try again'],
  'err.g.notApproved': ['review it in the permission sheet to approve it', 'needs approval: {}', 'needs approval: integration source changed during check'],
  'err.g.answerTerminal': ['no verified allow-once screen option', 'confirmation_required: option changes user settings'],
  'err.c.notReady': ['the terminal output is behind: the footer cannot be trusted; mode not confirmed', 'the footer did not change; mode not changed', 'did not reach {} in a full cycle'],
  // The same wording is an agent's program (acp/add.rs, acp/probe.rs, approval/command.rs) and an extension file (extensions.rs): the file line fits both.
  'err.missing': ['{} was not found', "{}'s folder is gone; resume it from the session"],
  'err.session': ['Side chat parent is not running', 'session has no live replay after restart'],
  'err.git': ['git: the read timed out', 'git {}: the listing is too long to read safely', 'git: submodules nested too deep to read safely', 'git: too many filters configured to switch off safely', 'git {}: {}', 'origin/HEAD is not on origin'],
  'err.g.notGit': ['not a git top level'],
  'err.g.diffNoBase': ['no changes to show'],
  'err.g.themeGone': ['not a valid theme file: {}'],
  'err.g.themeNet': ['the theme index is not UTF-8', 'the theme index lists no themes', 'the theme index has no licence for "{}"'],
};
// `err.git` is an existing line with its own next step.
const TODO: Record<string, Key> = { 'err.git': 'err.git.todo', 'err.missing': 'err.missing.todo', 'err.session': 'err.session.todo' };

export const GROUP_ROWS: [RegExp, Key, Key?][] = Object.entries(GROUPS)
  .filter(([, t]) => t.length)
  .map(([key, templates]) => row(key as Key, templates, TODO[key]));
