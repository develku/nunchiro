// UI language, V2-14c (needs 93; ticket 118): the tree, the group dialogs, the worktree dialogs (New, Discard, Tidy) and the toast
// take their window text from the catalogue. Pure model and source checks, no page.
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { type Key } from '../src/i18n';
import { EN, makeT } from './i18n-tables';

const src = path.resolve(import.meta.dirname, '../src');
const read = (f: string) => fs.readFileSync(path.join(src, f), 'utf8');
const OWN = ['tree/kids.tsx', 'tree/Tidy.tsx', 'tree/worktrees.tsx', 'tree/Dialogs.tsx', 'tree/SubViews.tsx', 'tree/RowIcon.tsx', 'tree/commands.ts', 'tree/state.ts', 'tree/KidPeek.tsx', 'Sidebar.tsx', 'tree/dragProject.ts'];

const mine = (k: string) => k.startsWith('tree.') || k.startsWith('dialog.');

// Literals that are not window text: kinds, ids, keys, a machine's own name, class lists.
const DATA = new Set(['this Mac', 'Esc', 'Escape', 'Enter', 'Tab', 'ArrowDown', 'ArrowUp', 'Backspace', 'Delete', 'KeyZ', 'F2', 'contextmenu', 'listbox', 'combobox', 'alertdialog', '(prefers-reduced-motion: reduce)', 'Claude', 'Codex']); // 'Claude' and 'Codex' are product names (worktrees.tsx), data like a machine's own name (needs 93, 162)
const CSS_CONTEXT = /(className=|querySelector(All)?(<[^>]*>)?\(|closest\(|matches\(|data-[\w-]+=|classList\.\w+\()\s*(\{)?\s*$/;

/** Window text left in a source file: JSX text, and any string or template literal that reads as English (two words, a
 * capitalised word, or … or ·) outside a class list, selector or data attribute. */
function literals(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/ \/\/ .*$/gm, '');
  const out: string[] = [];
  for (const m of code.matchAll(/(?<![=\-])>\s*([A-Za-z][^<>{}]*?)\s*<(?=[\/A-Za-z])/g)) if (!/&&|\|\||\?|=>/.test(m[1]) && !DATA.has(m[1])) out.push(`JSX text: ${m[1]}`);
  for (const m of code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
    const raw = (m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]*\}/g, '');
    if (!/[A-Za-z]{2,}/.test(raw) || DATA.has(raw)) continue;
    if (CSS_CONTEXT.test(code.slice(Math.max(0, m.index! - 40), m.index!))) continue;
    if (/^(\.\.?\/|@|[\w.-]+\/[\w./-]+$)/.test(raw)) continue; // an import path
    if (/^[a-z][\w-]*(\.[\w-]+)+$/.test(raw) || /^[a-z]+(-[a-z0-9]+)*$/.test(raw) || /^[a-z][A-Za-z0-9]*$/.test(raw)) continue; // a key, kind or identifier
    if (/^[.#[]/.test(raw) || /^[a-z0-9-]+( [a-z0-9-]+)+$/.test(raw)) continue; // a selector or class list
    if (/[ …·]/.test(raw) || /^[A-Z][a-z]{2,}/.test(raw)) out.push(`literal: ${raw}`);
  }
  return out;
}
/** The tree half of Sidebar.tsx: the Agents widget above it is another surface. */
const sidebarTree = (text: string) => text.slice(text.indexOf('export function Tree('));

test('no_hardcoded_in_extracted_files: the Own files hold no English literal outside the catalogue (and the check catches one)', () => {
  for (const f of OWN) {
    const text = f === 'Sidebar.tsx' ? sidebarTree(read(f)) : read(f);
    expect(literals(text), f).toEqual([]);
  }
  // Mutation: a literal in each of the shapes the files use must be caught.
  const bad = `export const a = <button aria-label="Close dialog" title={\`Remove it\`}>Hello there</button>; say('Could not do that'); const x = { title: 'Pin' };`;
  expect(literals(bad)).toEqual(['JSX text: Hello there', 'literal: Close dialog', 'literal: Remove it', 'literal: Could not do that', 'literal: Pin']);
});

// The strings main held, written out by hand (the source before this slice), with the arguments the code gave them.
const BEFORE: [Key, Record<string, string | number> | undefined, string][] = [
  ['tree.group.move', undefined, 'Move to group'],
  ['tree.group.new', undefined, 'New group…'],
  ['tree.group.newTitle', undefined, 'New group'],
  ['tree.group.rename', undefined, 'Rename group'],
  ['tree.group.remove', undefined, 'Remove from group'],
  ['tree.group.dissolve', undefined, 'Dissolve group'],
  ['tree.group.name', undefined, 'Group name'],
  ['tree.group.needsName', undefined, 'A group needs a name'],
  ['tree.group.hint', { title: 'New group' }, 'New group · Enter to save · Esc to cancel'],
  ['tree.pin', undefined, 'Pin'],
  ['tree.unpin', undefined, 'Unpin'],
  ['tree.expandAllCmd', undefined, 'Expand all projects, or restore the previous open and closed state'],
  ['tree.picker.title', undefined, 'Projects by status'],
  ['tree.picker.placeholder', undefined, 'Projects · type a name or a group'],
  ['tree.list.search', { label: 'Move to group' }, 'Move to group search'],
  ['tree.list.none', undefined, 'No match'],
  ['tree.status.waiting', undefined, 'waiting'],
  ['tree.status.failed', undefined, 'failed'],
  ['tree.status.unread', undefined, 'unread'],
  ['tree.status.working', undefined, 'working'],
  ['tree.status.stale', undefined, 'stale'],
  ['tree.status.idle', undefined, 'idle'],
  ['tree.view.tag', undefined, 'view'],
  ['tree.view.remove', undefined, 'Remove this view'],
  ['tree.view.removeLabel', { title: 'Files', name: 'repo' }, 'Remove Files view from repo'],
  // V2-CF4: the session's sub-agents.
  ['tree.subagents.count', { n: 2, working: 1 }, '2 sub-agents, 1 working'],
  ['tree.subagents.expand', { name: 'repo', n: 2, working: 1 }, "Show repo's 2 sub-agents, 1 working"],
  ['tree.subagents.collapse', { name: 'repo', n: 2, working: 1 }, "Hide repo's 2 sub-agents, 1 working"],
  ['tree.subagents.working', undefined, 'working'],
  ['tree.subagents.done', undefined, 'done'],
  ['tree.subagents.failed', undefined, 'failed'],
  ['tree.row.label', { name: 'v1a-62', tips: 'Merged. Branch kept' }, 'v1a-62, Merged. Branch kept'],
  ['tree.row.labelWaiting', { name: 'v1a-62', count: 3, tips: 'Your turn' }, 'v1a-62, 3 waiting. Your turn'],
  ['tree.cleanup.summary', { n: 2 }, 'Ready to clean up (2)'],
  ['tree.cleanup.action', undefined, 'Clean up…'],
  ['tree.loadFailed', undefined, 'could not load the project tree'],
  ['tree.counts', { running: 1, working: 2, waiting: 3, attention: 4 }, '1 running, 2 working, 3 waiting, 4 need attention'],
  ['tree.countsGroup', { working: 2, waiting: 3, attention: 4 }, '2 working, 3 waiting, 4 need attention'],
  ['tree.rowMenuTitle', { name: 'v1a-62' }, 'v1a-62 · worktree row'],
  ['tree.actionsFor', { name: 'v1a-62' }, 'Actions for v1a-62'],
  ['tree.projectLabel', { name: 'repo', urgency: 'waiting' }, 'repo: waiting'],
  ['tree.expand', { name: 'repo' }, 'Expand repo'],
  ['tree.collapse', { name: 'repo' }, 'Collapse repo'],
  ['tree.expandGroup', { name: 'work' }, 'Expand group work'],
  ['tree.collapseGroup', { name: 'work' }, 'Collapse group work'],
  ['tree.pinned', undefined, 'Pinned'],
  ['tree.main', undefined, 'main'],
  ['tree.newWaiting.one', { n: 1 }, '1 new waiting item'],
  ['tree.newWaiting.other', { n: 2 }, '2 new waiting items'],
  ['tree.newChip', { n: 2 }, 'new 2'],
  ['tree.newChipGroup', { n: 2 }, '2 new'],
  ['tree.newSession', { name: 'repo' }, 'New session in repo'],
  ['tree.newWorktree', { name: 'repo' }, 'New worktree in repo'],
  ['tree.worktreeAdd', undefined, '⌄ worktree'],
  ['tree.more', { n: 3 }, '+3'],
  ['tree.moreWaiting', { n: 3 }, '+3 waiting'],
  ['tree.showFewer', undefined, 'Show fewer'],
  ['tree.status.unreadTip', undefined, 'Finished · not seen yet'],
  ['tree.status.dialogTip', undefined, 'Prompt in the terminal'],
  ['tree.pillWaiting', { n: 2 }, '2 waiting · open the first'],
  ['tree.pillFailed', { n: 2 }, '2 failed · open the first'],
  ['tree.creatingLabel', { name: 'x' }, 'Creating worktree x'],
  ['tree.creating', undefined, 'Creating worktree…'],
  ['tree.mergedRemoveLabel', { name: 'x' }, 'x: Merged - remove'],
  ['tree.mergedRemove', undefined, 'Merged - remove'],
  ['tree.projects.one', { n: 1 }, '1 project'],
  ['tree.projects.other', { n: 2 }, '2 projects'],
  ['tree.projectsTitle', undefined, 'Projects'],
  ['tree.groupTitle', { name: 'work', projects: '2 projects' }, 'work · 2 projects'],
  ['tree.addProject', undefined, '+ Project'],
  ['tree.addProjectHint', undefined, 'Add a project: choose its folder, then pick an agent'],
  ['tree.expandAllHint', undefined, 'Opens every group; Alt-click also opens the clean-up lines (rows that list merged worktrees)'],
  ['tree.restore', undefined, 'Restore'],
  ['tree.expandAll', undefined, 'Expand all'],
  ['tree.retry', undefined, 'Retry'],
  ['tree.dismiss', undefined, 'Dismiss'],
  ['tree.empty', undefined, 'Add a project to get started.'],
  ['tree.newSessionAction', undefined, 'Add project'],
  ['tree.root', undefined, 'Tree'],
  ['tree.thisMac', undefined, 'This Mac'],
  ['dialog.cancel', undefined, 'Cancel'],
  ['dialog.undo', undefined, 'Undo'],
  ['dialog.tidy.title', { worktrees: '2 worktrees', projects: '1 project' }, 'Tidy · 2 worktrees in 1 project'],
  ['dialog.tidy.worktree.one', { n: 1 }, '1 worktree'],
  ['dialog.tidy.worktree.other', { n: 2 }, '2 worktrees'],
  ['dialog.tidy.project.one', { n: 1 }, '1 project'],
  ['dialog.tidy.project.other', { n: 2 }, '2 projects'],
  ['dialog.tidy.unsavedFile.one', { n: 1 }, '1 unsaved file'],
  ['dialog.tidy.unsavedFile.other', { n: 2 }, '2 unsaved files'],
  ['dialog.tidy.ignored.one', { n: 1 }, '1 git-ignored entry would be deleted'],
  ['dialog.tidy.ignored.other', { n: 2 }, '2 git-ignored entries would be deleted'],
  ['dialog.tidy.commitsOnly', undefined, 'commits not on a branch'],
  ['dialog.tidy.recordOnly', undefined, 'Only the record is removed'],
  ['dialog.tidy.merged', undefined, 'Merged'],
  ['dialog.tidy.mergedPr', { number: 48 }, 'Merged · #48'],
  ['dialog.tidy.group.merged', undefined, 'Merged'],
  ['dialog.tidy.group.gone', undefined, 'Folder gone'],
  ['dialog.tidy.group.dirty', undefined, 'Needs a decision'],
  ['dialog.tidy.groupLabel', { title: 'Merged', count: 2 }, 'Merged (2)'],
  ['dialog.tidy.allProjects', undefined, 'All projects'],
  ['dialog.tidy.nothing', undefined, 'Nothing to tidy.'],
  ['dialog.tidy.resolve', undefined, 'Resolve'],
  ['dialog.tidy.resolveFor', { name: 'x' }, 'Resolve x'],
  ['dialog.tidy.openShell', undefined, 'Open a shell in it'],
  ['dialog.tidy.discard', undefined, 'Discard and remove…'],
  ['dialog.tidy.removeSelected', { n: 2 }, 'Remove 2 selected'],
  ['dialog.tidy.done.one', { n: 1 }, 'Removed 1 worktree · branches kept'],
  ['dialog.tidy.done.other', { n: 2 }, 'Removed 2 worktrees · branches kept'],
  ['dialog.tidy.goneCleaned.one', { n: 1 }, '1 gone record cleaned'],
  ['dialog.tidy.goneCleaned.other', { n: 2 }, '2 gone records cleaned'],
  ['dialog.tidy.cleaned.one', { n: 1 }, 'Cleaned 1 gone record'],
  ['dialog.tidy.cleaned.other', { n: 2 }, 'Cleaned 2 gone records'],
  ['dialog.tidy.left', { n: 2, why: 'unsaved files, git-ignored files' }, '2 not removed: unsaved files, git-ignored files'],
  ['dialog.tidy.whyFiles', undefined, 'unsaved files'],
  ['dialog.tidy.whyIgnored', undefined, 'git-ignored files'],
  ['dialog.tidy.failed', { n: 1 }, '1 could not be removed'],
  ['dialog.worktree.title', undefined, 'New worktree'],
  ['dialog.worktree.nameLabel', undefined, 'New worktree name, task, or GitHub PR or issue URL'],
  ['dialog.worktree.placeholder', { project: 'repo' }, 'repo: a name, a task, or a PR or issue URL'],
  ['dialog.worktree.base', undefined, 'Base branch'],
  ['dialog.worktree.basePlaceholder', undefined, "Base branch (default: current branch)"],
  ['dialog.worktree.branch', undefined, 'Branch name'],
  ['dialog.worktree.branchPlaceholder', undefined, 'Branch name (default: from the text)'],
  ['dialog.worktree.previewCreates', undefined, 'Creates'],
  ['dialog.worktree.previewFrom', { base: 'main' }, 'from main'],
  ['dialog.worktree.previewCurrent', undefined, 'current branch'],
  ['dialog.worktree.previewAuto', undefined, 'Creates an auto name'],
  ['dialog.worktree.previewPr', undefined, "fetches the PR's code from GitHub"], // ticket 374: reworded on purpose
  ['dialog.worktree.hintAdvancedOpen', undefined, 'Advanced: base and branch'],
  ['dialog.worktree.labelField', undefined, 'Worktree label (the branch and folder are not renamed)'],
  ['dialog.worktree.labelHint', undefined, 'Enter saves · Esc cancels · label only'],
  ['dialog.worktree.newName', undefined, 'new worktree'],
  ['dialog.worktree.autoCleaned', { name: 'v1a-62' }, 'Auto-cleaned v1a-62 · merged, branch kept'],
  ['dialog.worktree.createFailed', { error: 'boom' }, 'Could not create the worktree: boom'],
  ['dialog.worktree.removed', { name: 'x' }, 'Removed x'],
  ['dialog.worktree.removedKept', { name: 'x' }, 'Removed x · branch kept'],
  ['dialog.worktree.removeFailed', { name: 'x', error: 'boom' }, 'Could not remove x: boom'],
  ['dialog.worktree.restored', { name: 'x' }, 'Restored x'],
  ['dialog.worktree.restoredMany', { n: 2 }, 'Restored 2 worktrees'],
  ['dialog.worktree.nothingToUndo', { error: 'boom' }, 'Nothing to undo: boom'],
  ['dialog.worktree.openFailed', { error: 'boom' }, 'Could not open: boom'],
  ['dialog.worktree.cmd.new', undefined, 'New worktree…'],
  ['dialog.worktree.cmd.tidy', undefined, 'Tidy worktrees…'],
  ['dialog.worktree.cmd.open', undefined, 'Open worktree (a shell in it)'],
  ['dialog.worktree.cmd.copyPath', undefined, 'Copy path'],
  ['dialog.worktree.cmd.reveal', undefined, 'Reveal in Finder'],
  ['dialog.worktree.cmd.rename', undefined, 'Rename label…'],
  ['dialog.worktree.cmd.remove', undefined, 'Remove worktree…'],
  ['dialog.worktree.cmd.removeAsks.one', { n: 1 }, 'Remove worktree… (1 change to review)'],
  ['dialog.worktree.cmd.removeAsks.other', { n: 3 }, 'Remove worktree… (3 changes to review)'],
  ['dialog.discard.title', { name: 'x' }, 'x has unsaved work'],
  ['dialog.discard.lostLabel', undefined, 'Lost if discarded'],
  ['dialog.discard.lost.one', { n: 1 }, 'Lost if discarded (1 file)'],
  ['dialog.discard.lost.other', { n: 2 }, 'Lost if discarded (2 files)'],
  ['dialog.discard.ignoredLabel', undefined, 'Git-ignored, deleted too'],
  ['dialog.discard.ignored.one', { n: 1 }, 'Also deleted: 1 git-ignored entry. Build output (target/, node_modules/) is not listed.'],
  ['dialog.discard.ignored.other', { n: 2 }, 'Also deleted: 2 git-ignored entries. Build output (target/, node_modules/) is not listed.'],
  ['dialog.discard.unpushedLabel', undefined, 'Not pushed'],
  ['dialog.discard.unpushedOn.one', { branch: 'main', n: 1 }, 'Not pushed, stays on branch main: 1 commit'],
  ['dialog.discard.unpushedOn.other', { branch: 'main', n: 2 }, 'Not pushed, stays on branch main: 2 commits'],
  ['dialog.discard.detached.one', { n: 1 }, 'Not on any branch (detached HEAD), lost if discarded: 1 commit'],
  ['dialog.discard.detached.other', { n: 2 }, 'Not on any branch (detached HEAD), lost if discarded: 2 commits'],
  ['dialog.discard.more', { n: 4 }, '+4 more'],
  ['dialog.discard.action', undefined, 'Discard and remove'],
  // V2.5-10: create-and-start; V2.5-24: the age of a row. Added after the first table was written (kept literal here).
  ['tree.age.subMinute', undefined, '<1 min'],
  ['tree.age.minutes.one', { n: 1 }, '1 min'],
  ['tree.age.minutes.other', { n: 2 }, '2 min'],
  ['tree.age.hours.one', { n: 1 }, '1h'],
  ['tree.age.hours.other', { n: 2 }, '2h'],
  ['tree.age.days.one', { n: 1 }, '1d'],
  ['tree.age.days.other', { n: 2 }, '2d'],
  ['dialog.worktree.account', undefined, 'Account'],
  ['dialog.worktree.agent', undefined, 'Agent'],
  ['dialog.worktree.model', undefined, 'Model'],
  ['dialog.worktree.prompt', undefined, 'First prompt (optional)'],
  ['dialog.worktree.createStart', undefined, 'Create and start'],
  ['dialog.worktree.startAgent', undefined, 'Start an agent here'],
  ['dialog.worktree.starting', undefined, 'Starting…'],
  ['dialog.worktree.retryStart', undefined, 'Retry start'],
  ['dialog.worktree.kept', { name: 'x' }, 'Worktree x is kept.'],
  ['dialog.worktree.startFailed', { error: 'boom' }, 'Could not start the agent: boom'],
  ['dialog.worktree.notRunning', undefined, 'The agent is not running.'],
  ['dialog.worktree.wrongFolder', undefined, 'The agent started in a different folder. Check the session and update Nunchiro before trying again.'],
  ['dialog.worktree.promptUncertain', undefined, 'The first prompt may have been sent; check the session before sending again'],
  ['dialog.worktree.unknown', { error: 'boom' }, 'The reply was lost. Check the session and its send log before sending again: boom'],
  // V2.5-61 B8 (ticket 220): the existing-branch list in the New worktree dialog.
  ['dialog.worktree.branches', undefined, 'Existing branches'],
  ['dialog.worktree.useExisting', { name: 'feat-x' }, 'Use existing branch feat-x'],
  ['dialog.worktree.inWorktree', undefined, 'in worktree'],
  ['dialog.worktree.previewExisting', { name: 'feat-x' }, 'Uses existing branch feat-x'],
  // needs 169: opening a sub-agent's own output.
  ['tree.subagents.open', { name: 'x' }, 'Open sub-agent: x'],
  ['tree.subagents.readOnly', undefined, "Read-only: this is the sub-agent's own transcript"],
  ['tree.subagents.close', undefined, 'Close sub-agent output'],
  ['tree.subagents.empty', undefined, 'The sub-agent has written nothing yet'],
  ['tree.subagents.callOlder', undefined, 'That sub-agent was launched earlier than the chat shows: scroll up to find it.'],
  // V2.5-55 (ticket 214): a main-folder session row's own menu items and its inline rename field.
  ['tree.cmd.renameRow', undefined, 'Rename session'],
  ['tree.cmd.copyPath', undefined, 'Copy path'],
  ['tree.cmd.openEditor', undefined, 'Open session in editor'], // nightly 11-21: told apart from the worktree's Open in editor in the palette
  ['tree.sessionLabelField', undefined, 'Session name'],
  ['tree.sessionLabelHint', undefined, 'Enter saves · Esc cancels'],
  ['tree.sessionNeedsName', undefined, 'A session name cannot be empty'],
  // ticket 195 (needs 171): drag a project head onto a group head; the keys live in their own area file.
  ['tree.drag.over', { group: 'Web' }, 'Move to Web'],
  ['tree.drag.moved', { name: 'alpha', group: 'Web' }, 'Moved alpha to Web'],
  ['tree.move.removed', { name: 'alpha', group: 'Web' }, 'Removed alpha from Web'],
  // F15 r2: an added project with no session leaves the tree by its own remove.
  ['tree.removeAdded', { name: 'alpha' }, 'Remove alpha from the tree'],
  // 370: a project's own name.
  ['tree.project.rename', undefined, 'Rename…'],
  ['tree.project.renameTitle', undefined, 'Rename project'],
  ['tree.project.name', undefined, 'Project name'],
  ['tree.project.renameHint', { title: 'Rename project' }, 'Rename project · Enter to save · Esc to cancel · empty returns to the folder name'],
  // 370 item 1: Remove from tree.
  ['tree.project.remove', undefined, 'Remove from Nunchiro…'],
  ['tree.project.removeTitle', { name: 'alpha' }, 'Remove ‘alpha’ from Nunchiro?'],
  ['tree.project.removeAction', undefined, 'Remove from Nunchiro'],
  ['tree.project.removeCloses.one', { n: 1 }, 'Closes 1 session.'],
  ['tree.project.removeCloses.other', { n: 2 }, 'Closes 2 sessions.'],
  ['tree.project.count.resumable', { n: 2 }, '2 resumable'],
  ['tree.project.count.exited', { n: 2 }, '2 exited'],
  ['tree.project.count.failed', { n: 2 }, '2 failed'],
  ['tree.project.removeResumable.one', { n: 1 }, '1 resumable session cannot be resumed after this.'],
  ['tree.project.removeResumable.other', { n: 2 }, '2 resumable sessions cannot be resumed after this.'],
  ['tree.project.removeHistory', undefined, 'Deletes the session history: scrollback, exports, session logs.'],
  ['tree.project.removeNoUndo', undefined, 'This cannot be undone.'],
  ['tree.project.removeStays', undefined, 'The folder and its files stay on disk.'],
  ['tree.project.removeChanged', undefined, 'The sessions changed. Check the list and confirm again.'],
  ['tree.project.removeFailed', { closed: 1, total: 2, error: 'no.' }, 'Closed 1 of 2 sessions, then stopped: no. The project stays in the tree.'],
  ['tree.project.blockedTitle', { name: 'alpha' }, '‘alpha’ cannot be removed yet'],
  ['tree.project.blockedRunning.one', { n: 1 }, '1 running session'],
  ['tree.project.blockedRunning.other', { n: 2 }, '2 running sessions'],
  ['tree.project.blockedRunningRow', { kind: 'Claude', state: 'idle' }, 'Claude · idle'],
  ['tree.project.blockedRunningFix', undefined, 'Stop the sessions, then try again.'],
  ['tree.project.blockedWorktrees.one', { n: 1 }, '1 worktree'],
  ['tree.project.blockedWorktrees.other', { n: 2 }, '2 worktrees'],
  ['tree.project.blockedWorktree', undefined, 'Worktree'],
  ['tree.project.blockedStop.one', { n: 1 }, 'Stop 1 session'],
  ['tree.project.blockedStop.other', { n: 2 }, 'Stop 2 sessions'],
  ['tree.project.blockedWorktreeMerge', { title: 'docs' }, 'Task “docs” waits for a merge. If you remove this worktree, the work of the task is lost.'],
  ['tree.project.blockedWorktreeFix', undefined, 'Nunchiro shows the project again while worktrees remain. Remove the worktrees first.'],
  ['tree.project.removeClose', undefined, 'Close'],
  // Ticket 388: the head rows' colour strip (new words, no source on main).
  ['tree.strip.r', { n: 2 }, '2 failed'],
  ['tree.strip.o', { n: 2 }, '2 your turn'],
  ['tree.strip.w', { n: 1 }, '1 limited'],
  ['tree.strip.y', { n: 2 }, '2 stale'],
  ['tree.strip.b', { n: 3 }, '3 working'],
  ['tree.strip.g', { n: 4 }, '4 idle'],
  ['tree.strip.gDone', { n: 1 }, '1 finished'], // ticket 991 A7
  ['tree.strip.open', { what: '2 failed' }, '2 failed · open the longest waiting'],
  ['tree.strip.next', { name: 'rehfix' }, 'Most urgent rehfix'],
  ['tree.strip.above', { name: 'Trading' }, 'Above Trading'],
  ['tree.strip.below', { name: 'Trading' }, 'Below Trading'],
  ['tree.strip.scrollUp', undefined, 'Scroll up to the hidden urgent sessions'],
  ['tree.strip.scrollDown', undefined, 'Scroll down to the hidden urgent sessions'],
  // Ticket 410: the base field's refusal (new words, no source on main).
  ['tree.wtbase.notBranch', { base: 'nope' }, '‘nope’ is not a branch of this project. Pick one from the list, or leave the field empty.'],
  // Ticket 403 (5dee0dd6): the discard dialog's cap when a worktree has too many changes to list (new words, no source on main).
  ['dialog.discard.tooLarge', { n: 500 }, 'Too many changes to list: at least 500 files. Removing discards them all.'],
  // Ticket 991 A3, A14 (new words, no source on main).
  ['dialog.stopRemove.title', { name: 'feat-x' }, 'feat-x has running sessions'],
  ['dialog.stopRemove.label', undefined, 'Stopped if removed'],
  ['dialog.stopRemove.action.one', { n: 1 }, 'Stop 1 session and remove'],
  ['dialog.stopRemove.action.other', { n: 2 }, 'Stop 2 sessions and remove'],
  ['tree.sessionMenuTitle', { name: 'shell-1' }, 'shell-1 · session'],
  ['tree.cmd.settle', undefined, 'Move to done'], // Q7 point 4 (new words, no source on main)
  ['tree.settled', { name: 'calm' }, 'Moved calm to done'], // seventh look A S3-4 (new words, no source on main)
  ['tree.cmd.clearFinished', undefined, 'Clear finished'], // ticket 1063 (new words, no source on main)
  ['tree.clearKept', { names: 'a, b' }, 'Kept the worktrees with unsaved work: a, b'], // ticket 1063
  ['tree.needYou', { n: 2 }, '2 need you'], // ticket 1067 (new words, no source on main)
  ['tree.workers.badge', { n: 3 }, '3 working'], // ticket 1115 (new words, no source on main)
  ['tree.workers.more', { n: 2 }, '▸ 2 more working'], // ticket 1115
  ['tree.workers.moreIdle', { n: 3 }, '▸ 3 more'], // ticket 1115 review r1
];

test('english_text_unchanged: every new EN key holds the string the source had on main', () => {
  const t = makeT('en', 'en-US');
  for (const [key, args, was] of BEFORE) expect(t(key, args), key).toBe(was);
  // No new key without an entry above, and none above that is not in the catalogue.
  expect(BEFORE.map(([k]) => k).sort()).toEqual(Object.keys(EN).filter(mine).sort());
});

test('fallback_per_string: a ko table with one new key shows it in Korean; any other new key stays English', () => {
  const t = makeT('ko', 'en-US', { en: EN, ko: { 'tree.cleanup.summary': '정리할 항목 ({n})' } });
  expect(t('tree.cleanup.summary', { n: 2 })).toBe('정리할 항목 (2)');
  expect(t('tree.cleanup.action')).toBe('Clean up…');
  expect(t('dialog.discard.action')).toBe('Discard and remove');
});

test('fallback_per_string (surface): CleanupLine renders the Korean key and keeps the English one', async () => {
  const { CleanupLine } = await import('../src/tree/RowIcon');
  const t = makeT('ko', 'en-US', { en: EN, ko: { 'tree.cleanup.summary': '정리할 항목 ({n})' } });
  const items = [{ key: 'a', name: 'v1a-62', state: { kind: 'gone' as const, tone: 'idle' as const, tip: ['Folder gone'] as [string] } }];
  const html = renderToStaticMarkup(createElement(CleanupLine, { items, open: false, onToggle: () => {}, onCleanUp: () => {}, t }));
  expect(html).toContain('정리할 항목 (1)');
  expect(html).toContain('Clean up…');
});

test('plural_pairs: every .one key has its .other, and both take {n}', () => {
  const keys = Object.keys(EN).filter(mine);
  for (const k of keys.filter((x) => x.endsWith('.one'))) {
    const other = k.replace(/\.one$/, '.other') as Key;
    expect(EN[other], other).toBeTruthy();
    expect(EN[k as Key], k).toContain('{n}');
    expect(EN[other], other).toContain('{n}');
  }
  for (const k of keys.filter((x) => x.endsWith('.other'))) expect(EN[k.replace(/\.other$/, '.one') as Key], k).toBeTruthy();
});

test('no_catalogue_collision: new keys start with tree., dialog. or projects.new., sit in the tree and dialog area tables, and no other key uses those prefixes', () => {
  // V2.5-33b (ticket 167) moved them out of the v2-14c block of i18n/index.ts into the area files (needs 93, 162).
  const names = (f: string) => [...(read(f).split('export const en = {')[1]?.split(/^};/m)[0] ?? '').matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]);
  const inTables = [...names('i18n/areas/tree.ts'), ...names('i18n/areas/dialog.ts'), ...['tree-drag', 'tree-strip'].flatMap((a) => [...(read(`i18n/areas/${a}.ts`).split('export const en = {')[1]?.split('};')[0] ?? '').matchAll(/"([^"]+)":/g)].map((m) => m[1]))];
  expect(inTables.length).toBeGreaterThan(100);
  const all = Object.keys(EN);
  expect(inTables.sort()).toEqual(all.filter((k) => mine(k) || k.startsWith('projects.new.')).sort());
  // Equality with the two tables means no key outside them (any other area) uses tree., dialog. or projects.new.
  expect(new Set(all).size).toBe(all.length);
});

// The per-row "Merged - remove" button went with the TREEROWS fold (needs 92); ticket 167's no_key_dropped baseline keeps its two keys.
// Ticket 388 took the head count pills out; their two keys stay for the same baseline.
const RETIRED = ['tree.mergedRemove', 'tree.mergedRemoveLabel', 'tree.pillWaiting', 'tree.pillFailed'];

test('every_new_key_is_used: each key appears in an Own file, directly or as a plural base', () => {
  const used = [...OWN, 'tree/strip.tsx', 'tree.ts', 'chrome/commands.ts'].map(read).join('\n'); // tree.ts: ticket 701 moved the age and tip keys there; commands.ts: 1063's Clear finished
  const dead = Object.keys(EN)
    .filter(mine)
    .filter((k) => !RETIRED.includes(k))
    .filter((k) => !used.includes(`'${k}'`) && !(/\.(one|other)$/.test(k) && used.includes(`'${k.replace(/\.(one|other)$/, '')}'`)));
  expect(dead).toEqual([]);
});

// ko1 (ticket 991, look 1117): `main` after a project's name, and in "<project> / main" in the session header, names the
// main checkout as git calls it. It is a git word, kept as git spells it in every language (it read 기본, メイン, principal).
test('main_checkout_word_is_git_main_in_every_language (ko1)', () => {
  for (const lang of ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt'] as const) expect(makeT(lang, lang)('tree.main'), lang).toBe('main');
});
