// UI language, V2-14d (needs 93; ticket 119): the chat and composer catalogue. Model checks plus a source check, no page.
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { EN, makeT } from './i18n-tables';

// The text the chat and composer files carried on main before this slice (key -> the English literal), one entry per new key.
const BEFORE: Record<string, string> = {
  // V2.5-25 (ticket 146, 17ed2130): the approved working row adds two keys in areas/chat.ts; the spec follows, no string changed.
  // v25-quiet-chat (ticket 294 item 2): the held first message in areas/chat.ts.
  'chat.held.lead': 'Waiting for the agent to be ready:',
  'chat.held.cancel': 'Cancel send',
  'chat.held.second': 'One message is already waiting; yours stays in the box.',
  'chat.held.cancelTip': 'Cancel send: put the words back in the box (Esc)',
  // Look 1117 v14 N14-S3-1: a message the core holds behind a permission or question card.
  'chat.held.card': 'Held until you answer:',
  'chat.v25.working': 'Working',
  'chat.v25.workingFor': 'Working for {time}',
  // ticket 212 (needs 178, lane L3): the waiting row and the no-transcript line, all eight languages in areas/chat.ts.
  'chat.v25.waitingForYou': 'Waiting for you',
  'chat.noTranscript': 'no transcript: {reason}',
  // ticket 216 (needs 178 B2, lane L7; 6f4a0435, merged 337bd3ca): the terminal path popover and hover hint in areas/chat.ts.
  'chat.termPath.hint': 'Click for actions, Cmd+click to open',
  'chat.termPath.open': 'Open in Nunchiro',
  'chat.termPath.copy': 'Copy path',
  'chat.termPath.reveal': 'Reveal in Finder',
  // needs 168 (plan strip, v25-area-chat r3): the strip's keys in areas/chat.ts, all eight languages.
  'chat.plan.region': 'Plan',
  'chat.plan.count': '{done}/{total} · {step}',
  'chat.plan.done': '{done}/{total} · done',
  'chat.plan.expand': 'Show the plan',
  'chat.plan.collapse': 'Hide the plan',
  // CF5: owner-approved Side chat copy extends the catalogue without changing earlier English strings.
  'chat.side.title': 'Side chat',
  'chat.side.starting': 'Starting Side chat…',
  'chat.side.mode': '(plan / read-only mode)',
  'chat.side.notice': "This is the agent's read-only mode, not a sandbox.",
  'chat.side.handoff': 'handoff: last 5 turns',
  'chat.side.send': 'sent only on Enter',
  'chat.side.readOnly': 'Read-only',
  'chat.side.locked': 'Side chat stays in read-only mode',
  'chat.handoff.unknown': 'Message may have been sent. Check the conversation before sending again.',
  'chat.handoff.retry': 'The text was sent but not submitted. Press Enter or Send again to submit it.',
  'chat.side.error': 'Side chat not started: {error}',
  'chat.message.actions': 'Message actions',
  'chat.message.fork': 'Fork from here',
  'chat.context': 'Context {used} / {window}',
  'composer.label': 'Message {name}',
  'composer.sessionFallback': 'session',
  // Ticket 371 item 15: the queued list's own words; no string changed.
  'composer.queue.head': "{n} queued",
  'composer.queue.note': "When the turn ends, the messages are sent one at a time, from the top.",
  'composer.queue.stopped': "Stopped",
  'composer.queue.stoppedNote': "Nothing is sent automatically. Press the message you want to send.",
  'composer.queue.edit': "Edit",
  'composer.queue.remove': "Discard",
  'composer.queue.send': "Send",
  'composer.queue.sendTitle': "Send this message now",
  'composer.queue.label': "Queued messages",
  'composer.queue.rowAction': "{n} {action}",
  'composer.queue.notSent': "Not sent: {error}",
  'composer.queue.notSaved': "Not queued: the browser storage refused it. Your text is still in the box.",
  // needs 130: the working state moves into its own row above the input, so the placeholder keeps its idle words.
  'composer.placeholder': 'Message {name}… (@ files, / commands)',
  'composer.notRunning': '{pin} is not running',
  'composer.open': 'Open a session to type',
  'composer.exited': '{name} has exited: read only',
  'composer.state': '{name} is {state}: read only',
  'composer.send': 'Send',
  'composer.stop': 'Stop',
  'composer.stopTitle': 'Stop (Esc)',
  'composer.keys': 'Composer keys',
  'composer.hintSend': 'send',
  'composer.hintNewline': 'newline',
  'composer.hintStop': 'stop',
  // v25-sendkeys: Ctrl+Enter (send now) and Cmd+Enter (start a session with the text, stay here).
  'composer.steerNow': 'Send now',
  'composer.steerNowTitle': 'Send now. The running turn stops and this message is sent.',
  'composer.steerNoInterrupt': 'This agent cannot take a message while it works; it stays queued.',
  // ticket 286 item 1 (card C-20261106-03): the composer refused after the agent ended, all eight languages in areas/composer.ts.
  'composer.agentEnded': 'The agent has ended: type in the terminal.',
  'composer.backgroundSend': 'Start a new session with this text and stay here',
  'composer.backgroundSent': 'Started in the background: {name}',
  'composer.backgroundFailed': 'Not started: {error}',
  'composer.commands': 'Commands and skills',
  'composer.mention': 'Mention a file',
  'composer.files': 'Files',
  'composer.none': 'No match',
  'composer.hint.projectCommand': 'Project command',
  'composer.hint.projectSkill': 'Project skill',
  'composer.hint.userCommand': 'User command',
  'composer.hint.userSkill': 'User skill',
  'composer.hint.userPrompt': 'User prompt',
  'composer.hint.folder': 'Folder',
  'composer.hint.modified': 'Modified',
  'composer.hint.new': 'New',
  'composer.cmd.claude.add-dir': 'Add a working directory',
  'composer.cmd.claude.agents': 'Manage subagents',
  'composer.cmd.claude.btw': 'Side question',
  'composer.cmd.claude.clear': 'Start a new conversation',
  'composer.cmd.claude.code-review': 'Review changes',
  'composer.cmd.claude.compact': 'Compact the conversation',
  'composer.cmd.claude.config': 'Settings',
  'composer.cmd.claude.context': 'Context usage',
  'composer.cmd.claude.cost': 'Token cost',
  'composer.cmd.claude.doctor': 'Check the install',
  'composer.cmd.claude.help': 'Help',
  'composer.cmd.claude.hooks': 'Hooks',
  'composer.cmd.claude.init': 'Create CLAUDE.md',
  'composer.cmd.claude.mcp': 'MCP servers',
  'composer.cmd.claude.memory': 'Edit memory files',
  'composer.cmd.claude.model': 'Switch model',
  'composer.cmd.claude.permissions': 'Permission rules',
  'composer.cmd.claude.resume': 'Resume a conversation',
  'composer.cmd.claude.review': 'Review a pull request',
  'composer.cmd.claude.rewind': 'Rewind the conversation',
  'composer.cmd.claude.security-review': 'Security review of changes',
  'composer.cmd.claude.status': 'Status',
  'composer.cmd.codex.approvals': 'Approval mode',
  'composer.cmd.codex.compact': 'Summarize the conversation',
  'composer.cmd.codex.diff': 'Show the git diff',
  'composer.cmd.codex.fork': 'Fork the conversation',
  'composer.cmd.codex.init': 'Create AGENTS.md',
  'composer.cmd.codex.mcp': 'MCP tools',
  'composer.cmd.codex.mention': 'Mention a file',
  'composer.cmd.codex.model': 'Switch model',
  'composer.cmd.codex.new': 'New conversation',
  'composer.cmd.codex.review': 'Review changes',
  'composer.cmd.codex.status': 'Status',
  'composer.cmd.codex.undo': 'Undo the last turn',
  'chat.perm.label': 'Permission mode',
  'chat.perm.title': 'Press Shift+Tab to change the permission mode',
  'chat.perm.mode': 'Mode',
  'chat.handoff.divider': 'Switching to {agent} · handoff',
  'chat.handoff.group': 'Handoff',
  'chat.handoff.from': 'Handoff from {agent} · prompts {prompts} · files {files} · {kb} KB',
  'chat.handoff.reading': 'Handoff from {agent} · reading…',
  'chat.handoff.view': 'View/Edit',
  'chat.handoff.cancel': 'Cancel handoff',
  'chat.handoff.cancelTitle': 'Cancel handoff (Esc)',
  'chat.handoff.text': 'Handoff text',
  'chat.pr.prefix': 'PR',
  'chat.pr.draft': 'Draft',
  'chat.pr.open': 'Open',
  'chat.pr.checks_pass': 'Checks pass',
  'chat.pr.checks_fail': 'Checks fail',
  'chat.pr.approved': 'Approved',
  'chat.pr.merged': 'Merged',
  'chat.pr.closed': 'Closed',
  'chat.pr.live': 'live',
  'chat.pr.justNow': 'just now',
  'chat.pr.minutes': '{n} min ago',
  'chat.pr.hours': '{n} h ago',
  'chat.pr.days': '{n} d ago',
  'chat.pr.watch': 'Watch PR',
  'chat.pr.watching': 'Watching',
  'chat.pr.watchTitle': 'Check this PR regularly with the GitHub CLI (gh), also when no agent created it',
  'chat.pr.offerGroup': 'Live PR status',
  'chat.pr.offer': 'Show live PR status? This uses the GitHub CLI (gh) while this window is active.',
  'chat.pr.turnOn': 'Turn on',
  'chat.pr.noThanks': 'No thanks',
  'chat.claudeLink.title': 'Claude artifact',
  'chat.claudeLink.open': 'Open in browser',
  'chat.view.normal': 'Normal',
  'chat.view.thinking': 'Thinking',
  'chat.view.verbose': 'Verbose',
  'chat.view.aria': 'Transcript view: {view}',
  'chat.view.tip': 'Transcript view ({key} cycles Normal, Thinking, Verbose)',
  'chat.banner.tail': "is an untested version: chat shows each turn's final text only{extra}.",
  'chat.openTerminal': 'Open terminal',
  'chat.terminal': 'Terminal',
  'chat.retry': 'Retry',
  'chat.skipped': 'Some lines could not be shown',
  'chat.error': 'Chat stopped updating: {error}',
  'chat.empty': 'No messages yet. The chat fills in as {name} writes its transcript.',
  // v25-empty (needs 140, draft A): the empty state invites the first message instead of describing the state.
  'chat.empty.title': 'What should we build in {project}?',
  'chat.empty.hint': 'Write what you want the agent to do, and this conversation starts.',
  'chat.theAgent': 'the agent',
  'chat.feed': 'Chat',
  'chat.decisions.many': '{n} decisions waiting',
  'chat.permissions.one': '{n} permission request',
  'chat.permissions.other': '{n} permission requests',
  'chat.openDecisions': 'Answer in Decisions', // fid-chat reworded the key that was here; keep its text
  'chat.newBelow': 'new ↓',
  // needs 130: the notify control is a button with a menu, so its label and three levels are chat.* strings.
  'chat.notify.label': 'Notifications for {name}',
  'chat.notify.all': 'notify: all',
  'chat.notify.waiting': 'notify: waiting only',
  'chat.notify.muted': 'notify: muted',
  'chat.header.diff': 'Diff',
  // Real-app 11-10 defect 10: the count starts at the commit the session started on, not at the folder as it was.
  'chat.header.diffTitle': 'Diff: changes since the commit the session started on',
  'chat.header.changes': 'Changes since the session started, in this checkout and all its sessions: +{add} −{del}',
  'chat.chain.nav': 'Conversation',
  'chat.chain.same': 'Already this agent',
  'chat.chain.back': 'Hand off back to {agent} (starts on Enter)',
  'chat.chain.turns': '{agent} {n} turns',
  'chat.chain.switched': 'Switched to {agent} · handoff',
  'chat.row.copy': 'Copy',
  'chat.row.copied': 'Copied',
  'chat.row.copyMessage': 'Copy message', // chat5 item 9 (ticket 198): the message Copy button's accessible name; its visible text stays 'Copy'
  'chat.row.showFirst': 'Show first {n} lines',
  'chat.row.showAll': 'Show all {n} lines',
  'chat.row.done': 'done',
  'chat.row.input': 'Input',
  'chat.row.output': 'Output',
  'chat.row.running': 'Running…',
  'chat.row.runningShort': 'running',
  'chat.row.view': 'View',
  'chat.row.accept': 'Accept',
  'chat.row.reject': 'Reject',
  'chat.row.fileDeleted': 'file deleted · Diff opened without a file',
  'chat.row.outsideFolder': 'outside the session folder · Diff opened without a file',
  'chat.row.deleted': 'deleted',
  'chat.row.failed': 'failed',
  'chat.row.thinking': 'Thinking',
  'chat.row.toolResult': 'Tool result',
  'chat.row.orphan': 'The tool call is in older messages',
  'chat.row.interrupted': 'Interrupted',
  'chat.row.tests': '· tests {tests}',
  'chat.row.changed.one': '{n} file changed',
  'chat.row.changed.other': '{n} files changed',
  'chat.row.viewInDiff': 'View in Diff',
  'chat.row.thisTurn': 'this turn', // B18 (ticket 991)
  'chat.row.linkBlocked': 'Link blocked: only public web addresses open, in your browser',
  'chat.row.imageFallback': 'image',
  'chat.row.notLocal': 'not a local path or web address',
  'chat.row.notReadable': 'outside the readable folders',
  // Ticket 371 items 17 and 20.
  'composer.resumeTitle': 'Continue from where it stopped',
  'composer.restart': 'Restart',
  'composer.restartTitle': 'Start again in the same folder with the same model',
  'chat.message.rewind': 'Rewind',
  'chat.message.rewindTip': "Opens Claude's rewind picker in the terminal. Files change back only if you confirm there.",
  'chat.message.rewindBusy': "The agent is working, so it can't be rewound. You can press this when the turn ends.",
  'chat.message.rewindFailed': 'Not rewound: {error}',
  // Ticket 412: the notify chip's accessible name carries its level (a new string, all eight languages in areas/chat-base.ts).
  'chat.notify.chip': 'Notifications for {name}, {level}',
  // Ticket 603: a failed session's composer line names the state in the window's language (all eight in areas/composer.ts).
  'composer.failed': '{name} failed: read only',
  // Tickets 581 and 199: the waiting edit card and the strip's "+N" button (all eight languages in areas/chat.ts).
  'chat.row.waitingApproval': 'waiting for approval',
  'chat.strip.next': 'Show the next waiting item',
  // Ticket 991 B11: the folded handoff part of a user message (all eight languages in areas/chat-base.ts).
  'chat.row.handoff': 'Handoff',
  // Ticket 990: the folded brief of a teammate's seat.
  'chat.row.brief': 'Brief',
  // Verify look 11-16 (A9, C7): the empty chat of an agent that asks first, and of a teammate's seat.
  'chat.empty.waitTitle': '{name} asks you something first',
  'chat.empty.waitHint': 'Answer in the terminal at the side. The conversation starts after that.',
  'chat.empty.seatTitle': 'What should {name} do?',
  'composer.waitsHint': 'Answer its question first. A message you send now waits until you answer.', // A9 (ticket 991)
  'composer.toCard': 'Shift+Tab: to the card.', // ticket 1030
  // Ticket 1044: a clipboard image's chip name, and /new in Claude's slash menu (English only until ticket 1035).
  'composer.imageN': 'Image #{n}',
  'composer.cmd.claude.new': 'Start a new conversation (same as /clear)',
  // Ticket 1056: the true reason a held message waits, and Send now for Claude (English only until ticket 1035).
  'chat.held.working': 'Waiting for the agent to finish its turn:',
  'chat.held.behind': 'Waiting for earlier messages to go first ({n}):',
  // Ticket 1094 (English only until ticket 1035).
  'chat.held.retry': 'The agent did not take it yet. It goes again when the agent is ready:',
  // Ticket 1121 (English only until ticket 1035).
  'chat.held.stopped': 'The agent did not take it and it will not be pasted again. Cancel send puts it back in the box:',
  'composer.steerNowTitleClaude': "Send now. The message goes in at the agent's next step; the turn goes on.",
  'composer.queue.sentWaiting': 'Sent. Waiting for the agent to take it.',
  // Ticket 1087: the composer's shell look and the chat's shell row (English only until ticket 1035).
  'composer.shell': 'Shell',
  'composer.shellHint': 'Runs as a shell command in {folder}',
  // Ticket 1097: the composer answers a question's "Type something" (English only until ticket 1035).
  'composer.answersCard': 'What you send answers its question as "{option}".',
  'chat.empty.waitCard': 'Answer on the card above the message box. The conversation starts after that.',
  // Ticket 1130 B-L4 (C6): the offer row for a pasted `claude mcp add` line (English only until ticket 1035).
  'composer.mcp.offer': 'Add MCP server "{name}"',
  'composer.mcp.restart': 'Add and restart session',
  'composer.mcp.forNew': 'Add for new sessions',
  'composer.mcp.runs': 'This command will run in every Nunchiro session from now on.',
  'composer.mcp.keeps': 'Restart keeps this conversation.',
  'composer.mcp.busy': '{session} is busy, so this session is not restarted. It gets {name} after its next restart.',
  'composer.mcp.restarted': 'Added {name}. This session restarted with it.',
  'composer.mcp.sealed': 'Sealed',
  'composer.mcp.kept': 'The conversation is kept.',
  'composer.mcp.listed': 'Listed in Settings > Skills & hooks, where you can remove it.',
};

const src = path.resolve(import.meta.dirname, '../src');
const OWN = ['ComposerMenu', 'PermChip', 'ChatView', 'Rows', 'HandoffChip', 'PrChip', 'ClaudeLink'].map((f) => `chat/${f}.tsx`);
const PREFIX = /^(chat|composer)\./;

test('english_text_unchanged: every new EN key holds exactly the string main had', () => {
  const mine = Object.keys(EN).filter((k) => PREFIX.test(k));
  expect(mine.sort()).toEqual(Object.keys(BEFORE).sort());
  for (const [k, v] of Object.entries(BEFORE)) expect(EN[k as keyof typeof EN], k).toBe(v);
});

test('fallback_per_string: an injected ko table with one new key shows it in Korean, any other new key in English', () => {
  const t = makeT('ko', 'ko-KR', { en: EN, ko: { 'chat.openTerminal': '터미널 열기' } });
  expect(t('chat.openTerminal')).toBe('터미널 열기');
  expect(t('chat.retry')).toBe('Retry');
  expect(t('composer.send')).toBe('Send');
  expect(t('chat.skipped')).toBe('Some lines could not be shown');
});

test('no_catalogue_collision: new keys carry the slice prefix and no earlier key is reused', () => {
  const keys = Object.keys(EN);
  expect(new Set(keys).size).toBe(keys.length);
  const other = keys.filter((k) => !PREFIX.test(k));
  for (const k of other) expect(Object.hasOwn(BEFORE, k), k).toBe(false);
  // Ticket 167 (e6a4cead) moved the flat catalogue into area files, so the `// --- v2-14d ---` marker in index.ts is gone;
  // the same promise (the slice's keys live in the catalogue source) now reads the chat area's files.
  const areaSrc = ['chat', 'chat-base', 'composer', 'drafts'].map((f) => fs.readFileSync(path.join(src, `i18n/areas/${f}.ts`), 'utf8')).join('\n');
  for (const k of Object.keys(BEFORE)) expect(areaSrc.includes(`'${k}'`) || areaSrc.includes(`"${k}"`), k).toBe(true);
});

test('no_hardcoded_in_extracted_files: the chat and composer files hold no English literal outside the catalogue', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/ \/\/ .*$/gm, '');
  const jsx = /(?<![=\-])>\s*([A-Za-z][^<>{}]*?)\s*<(?=[\/A-Za-z])/g;
  const attr = /(?:placeholder|aria-label|title|data-tip)="([^"]+)"/g;
  const bad: string[] = [];
  for (const f of OWN) {
    const code = strip(fs.readFileSync(path.join(src, f), 'utf8'));
    for (const m of code.matchAll(jsx)) bad.push(`${f} JSX: ${m[1]}`);
    for (const m of code.matchAll(attr)) bad.push(`${f} attr: ${m[1]}`);
    // Template and string literals with a word of prose handed to the screen through props.
    for (const m of code.matchAll(/(?:label|title|placeholder|detail)=\{?[`'"]([A-Z][a-z]+[^`'"]*)[`'"]/g)) bad.push(`${f} prop: ${m[1]}`);
  }
  expect(bad).toEqual([]);
  // The check sees a literal: a mutated copy fails it.
  expect([...strip('<button aria-label="Permission mode">Stop</button>').matchAll(jsx)].length).toBe(1);
  expect([...strip('<button aria-label="Permission mode" />').matchAll(attr)].length).toBe(1);
});
