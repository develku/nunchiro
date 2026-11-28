// Tickets 312, 476: an error in plain words (what happened, what to do) from the catalogue; the core's or the OS's own
// text shows only under a closed Details line. The known-failures-to-sentences idea is Orca's
// (src/renderer/src/components/settings/accounts-pane-action-errors.ts, MIT License, Copyright (c) 2026 Lovecast Inc.;
// idea only, no code taken).
import { useEffect, useState } from 'react';
import { makeT, type Key, type Language } from './i18n';
import { GROUP_ROWS } from './errors-groups';
import { copyText } from './terminal/clipboard';

type T = (key: Key, args?: Record<string, string | number>) => string;

/** pressure.rs HELD*: a new seat held while the Mac is low on memory. */
const LOW_MEMORY = /^(Your|This) Mac is low on memory, so the new session was not started/;
/** Whether a start was refused by the low-memory hold, which the owner's "Start anyway" passes. */
export const isLowMemory = (e: unknown) => LOW_MEMORY.test(rawError(e));
/** plugins.rs STOPPED_START: the owner's start a plugin's check refused ("Quiet hours stopped this start: ..."). */
const STOPPED = / stopped this start: /;
/** A start the owner's Start anyway passes: a low-memory hold or a plugin's check. */
export const isHeld = (e: unknown) => isLowMemory(e) || STOPPED.test(rawError(e));
/** A window start as sent: `anyway` wraps it as the owner's Start anyway, past a low-memory hold; `wait` as a start that,
 *  when held, waits for memory and starts by itself (its reply is `memory_waiting`, the status bar lists it). */
export const startOp = (start: { op: 'start'; [k: string]: unknown }, anyway = false, wait = false) =>
  anyway ? { op: 'start_anyway', start } : wait ? { op: 'start_or_wait', start } : start;

// [pattern, what happened, what to do]. The web gets only the core's message string (no code), so patterns are the
// core's own wording. Order matters: the first match wins. A named group (`(?<name>...)`) fills that placeholder.
export const KNOWN: [RegExp, Key, Key?][] = [
  // git_write.rs: the Diff panel's Push. First, as git's own lines under the sentence may hold "fatal: " (the git row).
  [/^nothing was sent: the branch changed after this was shown \(new head (?<head>\S+)\)/, 'gitActions.err.changed'],
  [/^nothing was sent: the push URL of (?<remote>\S+) changed after this was shown/, 'gitActions.err.url'],
  [/^nothing was sent: where this pushes changed after this was shown \(now (?<remote>[^/\s]+)\/(?<branch>\S+)\)/, 'gitActions.err.target'],
  [/^not pushed: (?<remote>\S+) has newer commits on (?<branch>\S+)/, 'gitActions.err.newer'],
  [/^not pushed: git needs you to sign in/, 'gitActions.err.signin'],
  [/^not pushed: the pre-push hook failed/, 'gitActions.err.hook'],
  [/^not pushed: (?<remote>\S+) refused the push/, 'gitActions.err.refused'],
  [/^not pushed: this branch has no remote set and there are several/, 'gitActions.err.several'],
  [/^not pushed: this is the default branch$/, 'gitActions.err.default'],
  [/^not pushed: there are no new commits to push$/, 'gitActions.err.nothing'],
  [/^not pushed: /, 'gitActions.err.failed', 'gitActions.err.failed.todo'],
  [/^a pull request for this branch already exists: #(?<pr>\d+)/, 'gitActions.err.exists'],
  [/^pushed, but the pull request was not created: gh (is not logged in|was not found)/, 'gitActions.err.pushedNoGh'],
  [/^pushed, but the pull request was not created/, 'gitActions.err.pushedNoPr', 'gitActions.err.failed.todo'],
  [/^no pull request: the title/, 'gitActions.err.title'],
  [/^no pull request: the description/, 'gitActions.err.body'],
  [/^no pull request: (?<remote>\S+) is not a GitHub repository/, 'gitActions.err.notGithub'],
  [/^no pull request: /, 'gitActions.err.noPr', 'gitActions.err.failed.todo'],
  [/^the pull request was created, but gh printed no link/, 'gitActions.err.noLink'],
  [/^Write with AI runs in Claude sessions only$/, 'gitActions.ai.claudeOnly'],
  [/^(?<agent>\S+) could not write it: (?<reason>[\s\S]+?)\.?$/, 'gitActions.ai.failed'],
  [/core disconnected|core is stopping/i, 'settings.err.core'],
  // The core's own wording only: SSH and agent output also says "timed out" or "Permission denied (publickey)".
  [/too many requests in flight/, 'settings.err.busy'],
  [/\(os error (1|13|30)\)/, 'settings.err.denied'],
  [/\(os error 28\)/, 'settings.err.full'],
  [/unknown (op|variant|field)|missing field/i, 'settings.err.version'],
  [/write the full path instead of ~/, 'settings.err.folderTilde'],
  [/absolute worktree folder may not contain/, 'settings.err.folderDots'],
  [/leaves the repository/, 'settings.err.folderOut'],
  [/worktree folder must be a path/, 'settings.err.folderLong'],
  // Ticket 993, schedule/mod.rs `resume_ms`: a switched-off schedule whose date passed is switched on. Before the row below,
  // whose words it also holds.
  [/: change its time or remove it$/, 'schedule.pastOff'],
  [/schedule date is in the past/, 'schedule.past'],
  // codex_reset.rs: "codex is not signed in for this account".
  [/not signed in/i, 'err.signin', 'err.signin.todo'],
  // An agent's program that is not there: "claude --version: No such file or directory (os error 2)", "acp agent /x: ...".
  [/^(acp agent \S+|\S+ --version): No such file/, 'err.agentMissing', 'err.agentMissing.todo'],
  // process.rs git_run: "git <subcommand>: <stderr>"; projects/mod.rs: git's last stderr line or "git failed".
  [/\bfatal: |^git failed$|^git [a-z-]+: /, 'err.git', 'err.git.todo'],
  // An OS "(os error 2)"; files/confine.rs: "not found", and "root unavailable" when the session's folder is gone (480).
  [/\(os error 2\)|No such file or directory|^not found$|^root unavailable$/, 'err.missing', 'err.missing.todo'],
  [/^session not found/, 'err.session', 'err.session.todo'],
  [/close live worktree sessions first/, 'err.liveSessions'],
  // sessions.rs: a composer Enter while a start question is on the screen (a queued row's send shows it).
  [/^agent_blocked: a question is on the screen/, 'err.agentBlocked'],
  // team.rs set_next_level (ticket 992): a level picked in a window that has not yet heard of the teammate's custom model.
  [/^a teammate with a custom model has no levels$/, 'level.customOn'],
  // Ticket 534: fixed core refusals that say what to do. account_signin.rs: `account {label:?} is in use; close its sessions
  // first` (Rust's quoted form); extensions.rs: `an extension named {name} already exists`; tree.rs: `duplicate group name {name}`.
  [/^account "(?<quoted>(?:[^"\\]|\\.)*)" is in use; close its sessions first$/, 'err.accountInUse', 'err.accountInUse.todo'],
  [/^an extension named (?<name>.+) already exists$/, 'err.extensionExists', 'err.nameTaken.todo'],
  [/^duplicate group name (?<name>.+)$/, 'err.groupExists', 'err.nameTaken.todo'],
  // Ticket 456, extensions.rs check_enabled: a window whose list is stale (another window turned an item off) sends it back unconfirmed.
  [/^(?<name>.+) was not turned on: it can run commands/, 'err.extensionUnread', 'err.extensionUnread.todo'],
  // Ticket 1059, session_context.rs may_refresh: the Context widget's Show breakdown raced a turn, a question or typed words.
  [/^context breakdown not sent: (?<why>.+)$/, 'err.contextNotSent'],
  // Ticket 536: the rest of 534's list that the window can show (the ticket's table names each place).
  // pressure/wait.rs `answer`: Start anyway or Cancel on a start that left the list meanwhile (it started or was dropped).
  [/^this start is no longer waiting for memory$/, 'err.memWait.gone'],
  // plugins.rs check_send: a message a plugin's check refused; its reason stays under Details.
  // plugins_online.rs get: Browse plugins could not read the online list (curl, HTTP or time limit); the cause stays under Details.
  // plugins_online.rs install: the kill list could not be read and none was read before, so the install waits.
  [/^(the plugin list could not be read: |the plugin safety list could not be read; try again later$)/, 'err.pluginNet', 'err.pluginNet.todo'],
  // plugins_online.rs: Browse plugins > Install met a catalogue this Nunchiro cannot use; nothing was installed.
  [/^(the catalogue entry .+ is not valid|the catalogue is not valid: |the catalogue's version \d+ is newer than this Nunchiro reads|the kill list is not valid: |the kill list's version \d+ is newer than this Nunchiro reads|.+ of .+ does not match the catalogue \(it changed after the catalogue was made\); nothing was installed)/, 'err.pluginCatalogBad', 'err.pluginCatalogBad.todo'],
  [/^Not sent\. The plugin "(?<name>[^"]+)" refused it: /, 'err.pluginRefusedSend', 'err.pluginRefusedSend.todo'],
  [/^answer the waiting decision first$/, 'err.decisionWaiting', 'err.decisionWaiting.todo'], // sessions.rs:6284
  [/^approve the agent first$/, 'err.agentNotApproved', 'err.agentNotApproved.todo'], // acp/add.rs:187,224
  [/^start a session in a project folder first$/, 'agents.sheet.startFirst'], // acp/add.rs:318
  [/^maximum 32 retained PTYs; close an exited session first$/, 'err.sessionsMax', 'err.sessionsMax.todo'], // sessions.rs:4790
  [/^off: the PR view uses your gh; turn on live PR status first$/, 'err.prLiveOff', 'err.prLiveOff.todo'], // pr/mod.rs:694
  [/^a pairing from this address is already waiting; answer it on the Mac first$/, 'err.pairWaiting', 'err.pairAnswer.todo'], // http/pair.rs:191
  [/^too many pairings waiting; answer them on the Mac first$/, 'err.pairsMax', 'err.pairAnswer.todo'], // http/pair.rs:195
  [/^too many refused pairings from this address; try later$/, 'err.pairRefused', 'err.pairRefused.todo'], // http/pair.rs:186
  [/^browser-devices\.json is unreadable; fix or remove it first$/, 'err.devicesFile', 'err.devicesFile.todo'], // http/pair.rs:55
  [/^too many groups$/, 'err.groupsMax', 'err.groupsMax.todo'], // tree.rs:163
  [/^too many grouped projects$/, 'err.groupedMax', 'err.groupedMax.todo'], // tree.rs:179
  [/^session holder did not answer; the agent still runs$/, 'err.holderSilent', 'err.later.todo'], // sessions.rs:4189
  [/^codex did not answer in time$/, 'err.codexSlow', 'err.later.todo'], // codex_reset.rs:219
  [LOW_MEMORY, 'err.lowMemory', 'err.lowMemory.todo'], // pressure.rs HELD*
  [/^This Mac is low on memory, so the scheduled run was not started/, 'err.lowMemorySchedule', 'err.lowMemorySchedule.todo'], // pressure.rs HELD_SCHEDULE
  [/^too many themes loading; try again$/, 'err.themesBusy', 'err.later.todo'], // themes_online.rs:318
  // Ticket 551: files/search.rs:63 and :66, the two refusals a search shows.
  [/^search busy: try again in a moment$/, 'err.searchBusy', 'err.later.todo'],
  [/^not a folder$/, 'err.missing', 'err.missing.todo'],
  [/^no access to that folder$/, 'a11y.err.noAccess', 'a11y.err.noAccess.todo'], // tree.rs NO_ACCESS (ticket 880)
  [/^no permission to [r]ead (?<folder>.+)$/s, 'own.file.mode'], // tree.rs add_refusal: the folder's mode, which System Settings cannot fix ([r]: the own-sentences scan reads literals)
  // board/write.rs:7 and board/config.rs:89: the board's own refusals; the parser's reason stays under Details.
  [/^board\.toml changed, reloaded$/, 'err.boardChanged', 'err.boardChanged.todo'],
  [/^board\.toml line (?<line>\d+): /, 'err.boardLine', 'err.boardLine.todo'],
  // Ticket 578: the fixed core refusals a window request can return that 476 to 551 did not list. One line each: what happened
  // and what to do. sessions.rs (restart, resume, model and mode, worktrees), account_signin.rs, accounts.rs, files/confine.rs.
  [/^only an ended session can be restarted$/, 'err.c.restartLive'],
  [/^start this shell again by hand$/, 'err.c.restartShell'],
  [/^this session ran in a worktree; start it again there by hand$/, 'err.c.restartWorktree'],
  [/^(no resumable session of this agent|no conversation to continue)$/, 'err.c.noConversation'],
  [/^conversation is already running$/, 'err.c.convOpen'],
  [/^continuing on another account is for Claude sessions/, 'err.c.accountCarry'],
  [/^project is not a directory$/, 'err.c.projectFolder'],
  [/^no such path$/, 'err.c.noPath'],
  [/^(model switch in progress|a model switch is already running for this session|a mode change is already running for this session)$/, 'err.c.modelBusy'],
  [/^(the agent is working; switch when it is idle|a prompt is being submitted; switch when it is idle|Claude is still answering an earlier message; switch when it is idle)$/, 'err.c.agentBusy'],
  [/^(agent is not running|session is not running|the session ended)$/, 'err.session', 'err.session.todo'],
  [/^(Codex's input box is not on the screen|Claude is not at its prompt|agent is not at its composer)/, 'err.c.notReady'],
  [/^bypass permissions is turned off by Claude's settings/, 'err.c.bypassOff'],
  [/^(unknown model|unknown effort for this model|invalid model or effort|pick one of the agent's models)$/, 'err.c.modelUnknown'],
  [/^this (session was resumed meanwhile; it can no longer be undone|close can no longer be undone)$/, 'err.c.undoLate'],
  [/^Side chat is temporary; open a new side chat$/, 'err.c.sideChat'],
  [/^worktree has unsaved work$/, 'err.c.wtDirty'],
  [/^invalid branch name$/, 'err.c.branchName'],
  [/^branch .+ no longer exists$/, 'err.c.branchGone'],
  [/^worktree removal in progress$/, 'err.c.wtRemoving'],
  [/^(managed worktree is missing|not a worktree of this project)$/, 'err.c.wtMissing'],
  [/^at most (?<count>\d+) accounts$/, 'err.c.accountMax'],
  [/^at most (?<count>\d+) sign-ins at once$/, 'err.c.signinMax'],
  [/ is already signing in$/, 'err.c.signinRunning'],
  [/^that does not look like a sign-in code$/, 'err.c.codeBad'],
  [/^(a code was already sent; start the sign-in again|the login no longer reads a code|this sign-in does not take a code now|unknown sign-in)$/, 'err.c.codeGone'],
  [/^account name must be 1-64 visible characters/, 'err.c.labelBad'],
  [/^(a registered account folder is never discarded|.+ is the agent's own config and is never removed)$/, 'err.c.accountKeep'],
  [/^(path not allowed|outside root)$/, 'err.c.pathOutside'],
  [/^(not readable|not a regular file or folder)$/, 'err.c.notReadable'],
  [/^not a PNG, JPEG, GIF or WebP image$/, 'err.c.imageKind'],
  [/^not a GitHub pull request link$/, 'err.c.prLink'],
  [/^icon (is over 256 KiB|must be a PNG, JPEG or SVG image)$/, 'err.c.iconBad'],
  [/^the editor did not open/, 'err.c.editorFailed'],
  [/^unknown project$/, 'err.c.projectGone'],
  [/^machine alias already listed/, 'err.c.machineName'],
  [/^Stop its sessions first$/, 'err.c.machineSessions'],
  [/^agents\.toml (is busy|changed)$/, 'err.c.agentsFile'],
  [/^(server|skill) name: letters, digits, - and _ only$/, 'err.c.nameChars'],
  [/^text is larger than 256 KiB; nothing was saved$/, 'err.c.textBig'],
  // Ticket 820: files/mod.rs `write`, the file view's Save (the window says the same for a text too big to send).
  [/^the file changed on disk since it was opened; nothing was saved$/, 'err.c.fileChanged'],
  [/^not a text file; it is not edited here$/, 'err.c.notText'],
  [/^(file is over 512 KiB; it is not edited here|the text is over 512 KiB; nothing was saved)$/, 'err.c.editBig'],
  // The window's own wording (chat/pending.ts:101 and :95, chat/useComposerSend.ts:391), no core text.
  [/^core did not answer$/, 'err.c.coreSlow'],
  [/^the core started nothing$/, 'err.c.startNothing'],
  [/^already answered$/, 'err.c.answered'],
  // http/layout.rs: `layout.toml line N: why`; the status bar adds that the last good layout is used.
  [/^layout\.toml line (?<line>\d+): /, 'err.layoutLine'],
  // Ticket 601 (F9): the reasons tests/errors-core-reasons.spec.ts found a user can reach with no line of their own. Each
  // pattern is the core's wording; the file names where it is written (crates/nunchiro-core/src).
  [/^text is in .*input box; send or clear it first$/, 'err.g.inputText'], // sessions.rs
  [/^account .* is signing in; (finish or )?cancel the sign-in first$/, 'err.g.accountSigning'], // sessions.rs, accounts.rs
  [/^account .* is in use by .*; close them first$/, 'err.g.accountBusy'], // sessions.rs, accounts.rs
  [/is the default for new sessions; pick another default first$/, 'err.g.accountDefault'], // accounts.rs
  [/^an? .+ account named .+ already exists$/, 'err.g.accountExists'], // accounts.rs
  [/^(theme server answered HTTP \d+|the request failed \(curl exit \d+\)|the request was stopped)$/, 'err.g.themeNet'], // themes_online.rs
  [/^that theme is not in the index$/, 'err.g.themeGone'], // themes_online.rs
  [/^(invalid machine (alias|host or user|port \(1-65535\))|duplicate machine alias)$/, 'err.g.machineInput'], // machines.rs, machines/discovery.rs
  [/^machine alias is not listed$/, 'err.g.machineGone'], // machines.rs, sessions.rs
  [/^(project )?name must be 1-\d+ characters/, 'err.g.nameRule'], // tree.rs, projects/mod.rs
  [/^path is outside every project$/, 'err.g.pathProject'], // projects/mod.rs
  [/^this tool is not installed$/, 'err.g.updNotInstalled'], // agent_update.rs
  [/^(this tool is already updating|another npm update is running)$/, 'err.g.updBusy'], // agent_update.rs
  [/^(no confirmed update command for this tool|this install is not one its update command is for)$/, 'err.g.updManual'], // agent_update.rs
  // The subject is SubjectKind::label (approval/mod.rs) or `<agent> command` (approval/command.rs); `7` is the stand-in tests/core-reasons.ts gives a value.
  [/^(?:(?:widget|integration source|agent|agent command|7|\w+ command) (?:is not approved|changed since it was approved)|(?:widget|integration source|agent|agent command|7) changed since it was shown; review it again)$/, 'err.g.notApproved'],
  [/^(no branch to compare with|this branch shares no history with .+)$/, 'err.g.diffNoBase'], // diff/mod.rs
  [/^not a git folder$/, 'err.g.notGit'], // diff/mod.rs
  [/^no (server|extension) \S+$/, 'err.g.extGone'], // extensions.rs
  [/ is (a folder|a link|not a regular file); (nothing was saved|links are not followed)$/, 'err.g.extFile'], // extensions.rs
  [/^this pairing request has expired$/, 'err.g.pairExpired'], // http/pair.rs
  [/^gh is not logged in; run `gh auth login`/, 'err.g.ghLogin'], // pr_live.rs
  [/^act is not allowed for .+: turn on act in its permission sheet$/, 'err.g.actOff'], // widgets/act.rs
  [/^this Codex session was resumed or restored, so its launch arguments are not known/, 'err.g.codexArgs'], // sessions.rs
  [/^Codex arguments cannot set check_for_update_on_startup/, 'err.g.codexUpdateArg'], // sessions.rs, ticket 692
  [/^(decision needs live reconciliation|a permission request is not on the screen yet: try again|screen not current, try again|decision screen changed; refresh before answering)$/, 'err.g.answerRetry'], // sessions.rs, acp/mod.rs
  [/^(dialog choices must be answered in the agent terminal; only deny\/Esc is allowed|the screen cannot prove this request; answer in the terminal|decision is no longer on screen|persistent user configuration changes must be answered in the agent terminal|a permission takes allow once or deny only \(other options: answer in the terminal\)|the agent offers no allow-once option; reject it or answer in the agent)$/, 'err.g.answerTerminal'], // sessions.rs, acp/mod.rs
  [/^(agent is starting|agent is busy|switch when the agent is idle)$/, 'err.c.agentBusy'], // acp/mod.rs
  [/^(this agent reports no models|this agent did not report that model)$/, 'err.c.modelUnknown'], // acp/mod.rs
  [/^a teammate named (?<name>.+) already exists$/, 'err.nameTaken'], // team.rs; look 1117 v4f Home N-A: says the name, by the name field
  // approval/command.rs builds it from a const the core-reasons scan cannot see (`{agent} {DAMAGED}`), so it is not in GROUPS.
  [/^\S+ command file is damaged$/, 'err.h.fileBad'],
  // sessions.rs writes it inside `restore(format!(..))`, which the core-reasons scan cannot see, so it is not in GROUPS.
  [/^settings\.json write failed: .*; machines\.json rollback failed: .*; stores diverged$/, 'err.h.fileBad'],
  // sessions.rs worktree_parent and make_root build it in `map_err(|e| { format!(..) })` closures the scan cannot see either.
  [/^worktree folder [^;]+: /, 'err.h.io'],
  // Ticket 1122: core refusals a window request can return that had no line (errors-core-reasons.spec.ts).
  [/^invalid label in link$/, 'machines.linkBad'], // machines/share.rs: a label of dots passes the form's check
  [/^cannot read this Mac's ed25519 host key$/, 'err.g.hostKeyRead'], // machines/share.rs: Share this Mac
  [/^the Nunchiro home path has a space; a link's host key cannot be used$/, 'err.g.homeSpace'], // machines/discovery.rs
  // team.rs fresh_lead: LeaderDialog reads the same line for its own card; these rows are for any other place it shows.
  [/^(?<name>.+) did not finish its turn within (?<minutes>\d+) minutes, so it is still open and no new conversation started; the handover message was withdrawn$/, 'lead.freshStuck'],
  // The core's only other ending is LATE_HANDED ("it already has the handover message ...").
  [/^(?<name>.+) did not finish its turn within (?<minutes>\d+) minutes, so it is still open and no new conversation started; /, 'lead.freshStuckHanded'],
  // Ticket 1130 B-L3, team.rs open_seat: Undo of a new conversation whose old one has no finished turn to continue.
  [/^the old conversation cannot be continued here; it is still in History$/, 'lead.newConvNoUndo'],
  // Round 6, team.rs fresh_lead: no one-press new conversation on a seat whose conversation could not be continued.
  [/^this agent cannot continue an old conversation, so a new one would lose this one$/, 'lead.newConvNoContinue'],
  // Round 4, team.rs UNDO_STALE and undo_kept: an Undo that was refused or could not start changed and deleted nothing.
  [/^this seat changed since the new conversation opened, so nothing was undone; both conversations are in History$/, 'lead.newConvUndoStale'],
  [/^(?<error>[\s\S]+); nothing was deleted, and both conversations are in History$/, 'lead.newConvUndoKept'],
  // Ticket 601 r2: the reasons that share a next step (src/errors-groups.ts).
  ...GROUP_ROWS,
];

/** Known lines that name the whole failure, so no raw text is kept under Details. */
const SAYS_ALL: Key[] = ['schedule.past', 'schedule.pastOff', 'gitActions.err.changed'];

/** A refusal in the window's own plain words (the layout editor's): shown as written, never the generic line (ticket 599). */
export class OwnWords extends Error {}

/** `group`: a ticket 601 group line, shared by many reasons, so the raw words are the only part that names this one. */
export type Explained = { what: string; todo: string; details: string; known: boolean; group?: boolean };

/** The raw text of an error: what goes under Details. */
export const rawError = (e: unknown) => String(e instanceof Error ? e.message : e).trim();

/** `t` in the window's shown language, for code with no `t` of its own (hooks, class components). */
export const docT = () => makeT((typeof document === 'undefined' ? 'en' : document.documentElement.lang || 'en') as Language, typeof navigator === 'undefined' ? 'en' : navigator.language);

/** A status-bar note: plain words, and for a failure the raw text it shows as the note's tooltip. */
/** `session`: the session the failure is about (v9-Home-S3-5): the note leaves when another one is shown, and fades. */
/** `action`: one quiet button after the words (a held start's Start anyway); a press closes the note and runs it. */
export type Note = string | { text: string; details: string; session?: string; action?: { label: string; tip: string; run: () => void } };
export const errorNote = (text: string, e: unknown, session?: string): Note => ({ text, details: rawError(e), ...(session ? { session } : {}) });

/** A window start's low-memory hold as a note naming the agent, with Start anyway (`again`: the same start, past the hold);
 *  null for any other refusal. */
export const heldNote = (t: T, e: unknown, agent: string, again: () => void): Note | null =>
  isHeld(e) ? { text: isLowMemory(e) ? t('err.lowMemory.agent', { agent }) : rawError(e), details: rawError(e), action: { label: t('err.startAnyway'), tip: t(isLowMemory(e) ? 'err.startAnyway.tip' : 'plugins.startAnyway.tip'), run: again } } : null;

/** What happened, what to do, and the raw text for Details. `foreign`: the text comes from another program (SSH), so it is
 *  never matched to a sentence about Nunchiro. Anything not listed gets the generic line and keeps its words in Details. */
export function explainError(t: T, e: unknown, foreign = false): Explained {
  const details = rawError(e);
  if (e instanceof OwnWords) return { what: details, todo: '', details: '', known: true };
  const known = foreign ? undefined : KNOWN.find(([re]) => re.test(details));
  if (!known) return { what: t('err.failed'), todo: t('err.failed.todo'), details, known: false };
  const groups = known[0].exec(details)?.groups;
  // `quoted`: a name in Rust's `{:?}` form; only `\"` and `\\` are undone (an account label has no control characters).
  const args = groups?.quoted === undefined ? groups : { name: groups.quoted.replace(/\\(["\\])/g, '$1') };
  // Ticket 991 C2: a plain check whose sentence says everything has no Details (the core's words add nothing).
  return { what: t(known[1], args), todo: known[2] ? t(known[2], args) : '', details: SAYS_ALL.includes(known[1]) ? '' : details, known: true, group: GROUP_ROWS.includes(known) || undefined };
}

/** For a one-line place with no Details (the pairing page, a theme's line): a known failure's plain line, else the raw
 *  words, which there say more than "Details below.". */
export function knownOrRaw(t: T, e: unknown): string {
  const { what, todo, details, known } = explainError(t, e);
  return known ? (todo ? `${what} ${todo}` : what) : details;
}

/** The message line alone, for a place with no room for Details (a tooltip, a short note). */
export function plainError(t: T, e: unknown, foreign = false): string {
  const { what, todo } = explainError(t, e, foreign);
  return todo ? `${what} ${todo}` : what;
}

/** For a one-line place with no Details below it and no click to copy: a known failure's plain line, else "That did not
 *  work." The raw words stay out of the window. */
export function lineError(t: T, e: unknown, foreign = false): string {
  const { what, todo, known } = explainError(t, e, foreign);
  return known && todo ? `${what} ${todo}` : what;
}

/** The message for a status-bar note or a tooltip, where the raw text is not "below": a click copies it instead. */
export function notePlain(t: T, e: unknown, foreign = false): string {
  const { what, todo, known } = explainError(t, e, foreign);
  return known ? (todo ? `${what} ${todo}` : what) : `${what} ${t('err.failed.tip')}`;
}

/** For a tooltip, where nothing sits below: the plain line, and the raw words in brackets after it when the line does not name
 *  this failure (an unknown one, or a group line such as "Details below say why", where nothing is below). */
export function tipError(t: T, e: unknown, foreign = false): string {
  const { what, todo, details, known, group } = explainError(t, e, foreign);
  const line = todo ? `${what} ${todo}` : what;
  return !known ? `${what} (${details})` : group ? `${line} (${details})` : line;
}

/** A failure: the plain line, `retry` (for a read that left the page with nothing to show), and the raw text under a
 *  closed Details. */
/** `anyway`: a low-memory hold's Start anyway, the same start past the hold. */
export function ErrorLine({ t, error, retry, anyway, className = 'conflict', foreign, field }: { t: T; error: unknown; retry?: () => void; anyway?: () => void; className?: string; foreign?: boolean; field?: string }) {
  if (!error) return null;
  const { details } = explainError(t, error, foreign);
  return (
    <div className={className} role="alert" data-error="plain" data-field={field}>
      {plainError(t, error, foreign)}
      {retry && (
        <button type="button" className="btn q sm sretry" onClick={retry} /* design book, error line: Retry is quiet small */>
          {t('settings.kit.retry')}
        </button>
      )}
      {anyway && isHeld(error) && (
        <span className="held-act">
          <button type="button" className="btn" data-tip={t(isLowMemory(error) ? 'err.startAnyway.tip' : 'plugins.startAnyway.tip')} onClick={anyway}>
            {t('err.startAnyway')}
          </button>
        </span>
      )}
      <ErrorDetails t={t} details={details} />
    </div>
  );
}

/** The raw text, closed under a Details line; nothing when there is none. */
export function ErrorDetails({ t, details }: { t: T; details?: string }) {
  if (!details) return null;
  return (
    <details className="err-details">
      <summary>{t('err.details')}</summary>
      {details}
    </details>
  );
}

/** Ticket 476: a failure's note: plain words; a click (or Enter) copies the raw reason, also shown as its tooltip; × closes it. */
export function FailedNote({ t, note, onDismiss }: { t: T; note: Exclude<Note, string>; onDismiss?: () => void }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const id = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  return (
    <>
      {/* Written inside the click: WebKit drops a clipboard write once the gesture is gone. */}
      <button type="button" className="pane-note" data-tip={note.details} onClick={() => void copyText(note.details).then(setCopied)}>
        {copied === null ? note.text : t(copied ? 'about.copied' : 'about.copyFailed')}
      </button>
      {note.action && (
        <button type="button" className="btn pane-note-act" data-tip={note.action.tip} onClick={() => (onDismiss?.(), note.action!.run())}>
          {note.action.label}
        </button>
      )}
      {onDismiss && (
        <button type="button" className="pane-note-x" aria-label={t('tree.dismiss')} onClick={onDismiss}>
          ×
        </button>
      )}
    </>
  );
}
