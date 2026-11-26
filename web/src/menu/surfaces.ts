// V2-6a: which palette commands each context-menu surface offers. The menu lists them in the palette's own order, with
// their bindings; web/tests/context-menu.spec.ts checks every id here against the live palette.
const SESSION = ['session.new', 'session.stop', 'session.close', 'tab.rename', 'focus.terminal', 'diff.open'];

export const SURFACES: Record<string, string[]> = {
  tree: [...SESSION, 'worktree.tidy', 'tree.clear-finished'], // ticket 1063: so the project head's menu has it
  // V2-CF3: a managed worktree's row: its own actions beside the session ones (they act on the row, which the click selects).
  // Mockup 05 (owner-approved): the items it draws, in its order. "New worktree" is the project row's button, not repeated here (NODUP).
  // Q6 A14: one row menu: a worktree row with a session also restarts, closes and diffs it (the `treerow` session items).
  worktree: ['worktree.open', 'session.new', 'worktree.hand', 'worktree.rename', 'worktree.copy-path', 'worktree.reveal', 'worktree.open-editor', 'session.stop', 'session.restart', 'session.close', 'session.settle', 'diff.open', 'worktree.remove'], // 1063: Move to done
  // V2.5-55 (needs 178 B1): a main-folder session's row: the `tree` items with the inline rename (not the tab's) and Copy path.
  treerow: ['session.new', 'session.stop', 'session.restart', 'session.close', 'session.settle', 'session.rename', 'session.copy-path', 'session.open-editor', 'focus.terminal', 'diff.open', 'worktree.tidy'],
  tab: ['session.new', 'session.stop', 'session.restart', 'session.close', 'tab.close', 'tab.close.others', 'tab.close.right', 'tab.close.all', 'tab.reopen', 'tab.rename', 'tab.move.left', 'tab.move.right', 'tab.split.right', 'tab.split.down', 'terminal.find'],
  // needs 171: a file or Settings tab has no session commands.
  tabx: ['tab.close', 'tab.close.others', 'tab.close.right', 'tab.close.all', 'tab.reopen', 'tab.move.left', 'tab.move.right'],
  // Ticket 375: a row hands its full path (data-menu-arg) to Copy path, Reveal and Add to chat; the rest act on the widget.
  files: ['path.copy', 'path.reveal', 'file.mention', 'files.show', 'files.dock.side', 'search.open', 'focus.terminal'],
  search: ['search.open', 'search.dock.side', 'diff.open', 'focus.terminal'],
  // needs 171 (board r7): a card or list row hands its key (data-menu-arg) to the card items; the rest act on the board.
  board: ['board.card.open', 'board.card.edit', 'board.card.next', 'board.card.prev', 'board.card.pr', 'board.card.delete', 'board.toggle', 'waiting.next', 'focus.composer'],
  chat: ['pane.toggle', 'focus.composer', 'diff.open'],
  // system4: rows that carry text in data-menu-arg (chat5 attaches them: a path, a message).
  path: ['path.copy', 'path.reveal'],
  message: ['message.copy'],
  // system5 (ticket 196): a rail icon hands its widget id (data-menu-arg) to the three items.
  icon: ['icon.hide', 'icon.move', 'icon.split'],
};

/** Items a row menu offers only when the row has a session (else they would act on the active one). */
export const ROW_SESSION = new Set(['session.stop', 'session.restart', 'session.close']);

/** Ticket 991 A10: items that act only on the row a menu was opened on (its data-menu-arg: a path, a message, a widget,
 *  a card). With no row they have nothing to act on, so the palette leaves them out; the menu still offers them. */
export const MENU_ONLY = new Set(['file.mention', ...SURFACES.path, ...SURFACES.message, ...SURFACES.icon, ...SURFACES.board.filter((id) => id.startsWith('board.card.'))]);

/** 370: a project row's items that act on its folder. */
export const FILING = ['group.move', 'group.create', 'project.pin'];
export const FOLDER = ['path.copy', 'path.reveal', 'project.rename'];
/** Only these read a row's data-menu-project; any other item on the row keeps its own argument (Open Diff's is a file). */
export const TAKES_PROJECT = new Set([...FILING, 'group.remove', ...FOLDER, 'project.remove', 'lead.add', 'lead.fresh', 'tree.clear-finished']); // ticket 990: lead.add; 1063; 1096: lead.fresh

/** Look 1117 v7 (S2-2): on a worktree row these take the row's own folder (its wrap's `data-wt`) as their argument, so
 *  "Create a new session…" opens with that worktree chosen, not the project's main checkout. */
export const TAKES_WORKTREE = new Set(['session.new']);

/** A rule is drawn above these items (mockup 05). */
export const SEPARATE_BEFORE = new Set(['files.show', 'worktree.rename', 'session.stop', 'board.card.delete', 'path.copy', 'project.remove']);
/** Items drawn in red: they remove something. */
export const DANGER = new Set(['worktree.remove', 'board.card.delete', 'project.remove']);
/** A key shown on an item whose key is a row key, not a palette binding. */
export const HINT: Record<string, string> = { 'worktree.rename': 'F2' };
