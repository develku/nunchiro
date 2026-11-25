// Command registry and key bindings (needs 25, 30). Bindings use physical key codes (KeyboardEvent.code),
// so they work under a Korean input source; nothing is taken while an IME composition is active.
import type { Dir } from './layout/model';
import { makeT, type Key, type Language } from './i18n';
import type { PaletteState } from './chrome/paletteState';

export interface Command {
  id: string;
  title: string;
  /** The first tab jump only: the title of the one row the nine jumps share (Keys page, prefix help). */
  group?: string;
  /** A session row of the palette (V2.5-56): the tree row's state dot, and the worktree's branch when it has one. */
  state?: PaletteState;
  branch?: string;
  /** A session row of the palette: the session's shown name, which the palette ranks by (the title is translated). */
  name?: string;
  /** Disabled commands stay listed (07b, 08, 10 fill them) but do nothing. */
  enabled?: boolean;
  /** Why a disabled command is disabled: the context menu shows it as the item's tooltip (ticket 299). */
  why?: string;
  /** Context menu: whether the command can run on this target (the row's session and `data-menu-arg`). When present it
   *  decides for the menu in place of `enabled`; the palette still reads `enabled`. */
  enabledFor?: (target: { session?: string; arg?: string }) => boolean;
  /** Why `enabledFor` says no for that target (`why` is about the active session): the context menu's tooltip for the
   *  greyed item, and what the status line says when it is pressed. */
  whyFor?: (target: { session?: string; arg?: string }) => string | undefined;
  /** The context menu's title for that target, when it differs by session (Restart or Resume). */
  titleFor?: (target: { session?: string; arg?: string }) => string;
  run: (arg?: string) => void;
}

/** A binding is either a direct chord ("Meta+KeyK") or a key after the prefix ("prefix KeyF"). */
export type Binding = string;
export type Bindings = Record<string, Binding[]>;

export const DEFAULT_BINDINGS: Bindings = {
  prefix: ['Control+Period', 'Control+Space'], // herdr's pair (needs 60); either arms it
  'palette.open': ['Meta+KeyK', 'Shift+Meta+KeyP'], // needs 166: the ⌘ chord first, so tooltips and first-run text show it; old prefix keys stay as the second binding
  'settings.open': ['Meta+Comma'],
  'settings.search': ['Meta+KeyF'], // ticket 516: only while Settings is open (SETTINGS_ONLY), so it shares ⌘F with terminal.find
  // Ticket 1071: these zoom the whole window, as T3 Code and Orca do; the terminal font commands (v1a-39) lost them.
  // Not view.*: chat.spec.ts pins that the removed view.* commands (REMOVED below) stay out of the palette.
  'zoom.in': ['Meta+Equal', 'Shift+Meta+Equal'],
  'zoom.out': ['Meta+Minus'],
  'zoom.reset': ['Meta+Digit0'],
  'hints.show': ['prefix KeyF'],
  'keys.help': ['prefix Shift+Slash'], // v1a-57: `?` after the prefix shows the prefix keys at once
  'keys.sheet': ['Meta+Slash'], // ticket 1099 (mockup panel 5): ⌘/ is the whole sheet, every key; was keys.help's second key (needs 170 (3))
  'hints.copy': ['prefix KeyY'], // v1a-37
  'terminal.find': ['Meta+KeyF'], // v1a-35
  'terminal.copy': ['prefix BracketLeft'], // v1a-42 (tmux copy-mode)
  'terminal.edit': ['prefix KeyV'], // v1a-38b
  'zone.zoom': ['prefix KeyZ'], // v1a-37
  'worktree.create': ['Meta+KeyN'], // was a hard-wired listener in App.tsx (needs 166)
  'session.new.worktree': ['Shift+Meta+KeyN'], // ticket 1130 C2: the default agent in a new worktree, one chord
  'tab.close': ['Meta+KeyW'], // the app menu's Close Window moved to ⌘⇧W, so the page owns ⌘W
  'session.new': ['Meta+KeyT', 'prefix KeyC'],
  // v25-new-tab (ticket 290, needs 209): the New tab popover's rows, each with a key of its own (a session in the current
  // session's project; the browser beside it). The popover shows these and closes when one is pressed.
  'session.new.terminal': ['Control+Shift+Backquote'], // ticket 299: ⇧⌘T is Reopen closed tab, as in a browser; ⌃⇧` is the editors' new terminal
  'tab.reopen': ['Shift+Meta+KeyT'],
  'tab.new.browser': ['Shift+Meta+KeyB'],
  // Ticket 328: My browser's tab strip, after the prefix (the ⌘ chords a browser uses are the session tabs'): } { W T.
  'browser.tab.next': ['prefix Shift+BracketRight'],
  'browser.tab.prev': ['prefix Shift+BracketLeft'],
  'browser.tab.close': ['prefix Shift+KeyW'],
  'browser.tab.new': ['prefix Shift+KeyT'],
  'session.new.claude': ['Shift+Meta+KeyC'],
  'session.new.codex': ['Shift+Meta+KeyO'],
  'session.next': ['Shift+Meta+BracketRight', 'prefix KeyN'],
  'session.prev': ['Shift+Meta+BracketLeft', 'prefix KeyP'],
  'session.last': ['prefix Tab'], // v1a-37
  'decision.back': ['Meta+BracketLeft'], // V2-8e: back from a decision jump (the card's breadcrumb)
  'tab.rename': ['prefix Comma', 'F2'], // v1a-41 (tmux ,); F2 never fires inside a terminal (TERMINAL_PASSTHROUGH)
  'tab.move.left': ['prefix Shift+Comma'], // v1a-41 (tmux <)
  'tab.move.right': ['prefix Shift+Period'], // v1a-41 (tmux >)
  'session.jump.1': ['Meta+Digit1', 'prefix Digit1'],
  'session.jump.2': ['Meta+Digit2', 'prefix Digit2'],
  'session.jump.3': ['Meta+Digit3', 'prefix Digit3'],
  'session.jump.4': ['Meta+Digit4', 'prefix Digit4'],
  'session.jump.5': ['Meta+Digit5', 'prefix Digit5'],
  'session.jump.6': ['Meta+Digit6', 'prefix Digit6'],
  'session.jump.7': ['Meta+Digit7', 'prefix Digit7'],
  'session.jump.8': ['Meta+Digit8', 'prefix Digit8'],
  'session.jump.9': ['Meta+Digit9', 'prefix Digit9'],
  // Ticket 570: the tree's projects 1-9 (herdr: prefix+Shift+digit; Orca: ⌘+digit); ⌘ digits stay the tabs of the shown project.
  'project.jump.1': ['Control+Digit1'],
  'project.jump.2': ['Control+Digit2'],
  'project.jump.3': ['Control+Digit3'],
  'project.jump.4': ['Control+Digit4'],
  'project.jump.5': ['Control+Digit5'],
  'project.jump.6': ['Control+Digit6'],
  'project.jump.7': ['Control+Digit7'],
  'project.jump.8': ['Control+Digit8'],
  'project.jump.9': ['Control+Digit9'],
  'window.detach': ['prefix KeyD'],
  'waiting.next': ['prefix KeyW'],
  'layout.edit': ['prefix KeyL'],
  'pane.mode': ['prefix KeyR'], // v1a-43
  'composer.toggle': ['prefix KeyT'],
  'session.side-chat': ['prefix KeyA'], // ticket 1099: the side chat had only its header button (a = aside)
  // v25-sendkeys: Claude Code's chat:sendNow and a background start from the composer.
  'composer.steerNow': ['Control+Enter'],
  'composer.backgroundSend': ['Meta+Enter'],
  'focus.tree': ['prefix KeyE'],
  'focus.composer': ['prefix KeyI'],
  'focus.terminal': ['prefix KeyO'],
  'pane.toggle': ['Meta+KeyJ'], // AGENTVIEW: the session's side pane (the Right bar's Terminal icon)
  'pane.shell.new': ['Control+Backquote'], // ticket 1130 C4: Claude Desktop's terminal key; shows the pane's shell, or starts one
  'pane.maximize': ['Shift+Meta+Enter'],
  // SPLITKEYS: split the focused pane (the chat: a split beside it; a side-pane terminal: the terminal grid), as iTerm, VS Code
  // and t3code do, and tmux's prefix % and ". split.close has no default key.
  'split.right': ['Meta+KeyD', 'prefix Shift+Digit5'],
  'split.down': ['Shift+Meta+KeyD', 'prefix Shift+Quote'],
  // v1b-11
  'diff.open': ['prefix KeyG'],
  'search.open': ['Shift+Meta+KeyF', 'prefix KeyS'], // v1b-10
  'search.sessions': ['Alt+Meta+KeyF'], // ticket 1130 C3: the Sessions scope had no key
  // v1a-48: icons without a shortcut get one, so each icon's hint key is its own shortcut's key
  'sidebar.left.toggle': ['Meta+KeyB', 'prefix KeyB'],
  'sidebar.right.toggle': ['Alt+Meta+KeyB'], // v25f F13
  'bars.toggle': ['Shift+Meta+Backslash'],
  'files.show': ['Shift+Meta+KeyE', 'prefix KeyX'],
  'files.quickOpen': ['Meta+KeyP'], // ticket 821: Orca's and T3 Code's go-to-file key; ⇧⌘P stays the palette
  'artifacts.toggle': ['prefix KeyM'],
  'board.toggle': ['prefix KeyK'],
  'preview.toggle': ['prefix KeyQ'], // v went to terminal.edit (V1A-38b)
  'projects.pick': ['prefix KeyJ'], // v2-9a: status picker (waiting.next stays on w)
  // Ctrl+O cycles the chat's transcript view (was a chat-local listener); inside a terminal it stays the agent's.
  'chat.cycleView': ['Control+KeyO'],
  // needs 170 (3): focus the neighbouring zone; Option alone stays the agent's, so these carry Meta too.
  'pane.focus.left': ['Alt+Meta+ArrowLeft'],
  'pane.focus.right': ['Alt+Meta+ArrowRight'],
  'pane.focus.up': ['Alt+Meta+ArrowUp'],
  'pane.focus.down': ['Alt+Meta+ArrowDown'],
};

/** Commands whose direct chord is left to the terminal when the key goes to a terminal (the target is inside `.xterm`):
 *  the agent's own Ctrl+O and a TUI's F2. A chord with Meta never reaches a PTY, so it is not held back. */
export const TERMINAL_PASSTHROUGH = ['chat.cycleView', 'tab.rename'];

/** The fixed reset chord (needs 170 (3)): not a binding, so it cannot be rebound, shadowed or recorded. It clears the
 *  user's key overrides (one Undo) and is matched before anything else, also while recording and inside a terminal. */
export const RESET_CHORD = 'Control+Alt+Shift+Escape';

/** Settings > Keys sections (V1A-56; needs 64), in page order. */
export const AREAS = ['Palette and window', 'Sessions and tabs', 'Chat composer', 'Panes and layout', 'Focus', 'Views and docks', 'Terminal', 'Font', 'Other'] as const;
export type Area = (typeof AREAS)[number];
const [WINDOW, SESSIONS, COMPOSER, PANES, FOCUS, VIEWS, TERMINAL, FONT, OTHER] = AREAS;
/** The nine session jumps: one row on the Keys page, rebound together. */
export const JUMPS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `session.jump.${n}`);
/** Ticket 570: the nine project jumps, one row too. */
export const PROJECT_JUMPS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `project.jump.${n}`);
/** The area of each command; `session.open` and `pane.focus` style stems cover ids made per session or direction. */
export const AREA: Record<string, Area> = {
  'palette.open': WINDOW,
  'chat.find': SESSIONS, // Find in this chat, Copy the whole chat: palette commands with no key and, until now, no area
  'chat.copyThread': SESSIONS,
  'about.copy': WINDOW, // ticket 262: Copy build info
  'settings.open': WINDOW,
  'settings.search': WINDOW,
  'hints.show': WINDOW,
  handoff: SESSIONS, // stems for handoff.<agent> and worktree.<action>, which had no area and drew an "Other" card
  worktree: SESSIONS,
  'providers.signin': WINDOW, // ticket 610: opens Settings > Providers, as firstrun.open opens Onboarding
  'firstrun.open': WINDOW, // v2-5a had no area, which drew an "Other" card of one unbound command
  'keys.help': WINDOW,
  'keys.sheet': WINDOW,
  'window.detach': WINDOW,
  'quit.all': WINDOW,
  'session.new': SESSIONS,
  'session.new.terminal': SESSIONS,
  'tab.new.browser': SESSIONS,
  'browser.tab.next': SESSIONS, // ticket 328
  'browser.tab.prev': SESSIONS,
  'browser.tab.close': SESSIONS,
  'browser.tab.new': SESSIONS,
  'session.new.claude': SESSIONS,
  'session.new.codex': SESSIONS,
  'session.new.worktree': SESSIONS, // ticket 1130 C2
  'worktree.create': SESSIONS, // needs 166: the stem `worktree` covers the others, this id is bound
  'tab.close': SESSIONS,
  'tab.close.others': SESSIONS,
  'tab.close.right': SESSIONS, // v25-tab-menu-close
  'tab.close.all': SESSIONS,
  'tab.reopen': SESSIONS, // ticket 299
  'session.stop': SESSIONS, // v1a-59
  'session.next': SESSIONS,
  'session.prev': SESSIONS,
  'session.last': SESSIONS,
  'decision.back': SESSIONS, // V2-8e
  'tab.rename': SESSIONS,
  'tab.move.left': SESSIONS,
  'tab.move.right': SESSIONS,
  ...Object.fromEntries([...JUMPS, ...PROJECT_JUMPS].map((id) => [id, SESSIONS])),
  'session.open': SESSIONS,
  'session.side-chat': SESSIONS, // shown while a session has a side chat, so Other never fills
  'session.rename': SESSIONS, // V2.5-55: a main-folder session row's inline rename and Copy path (tree row menu), not an Other section
  'session.copy-path': SESSIONS,
  'session.open-editor': SESSIONS, // ticket 375: the tree row menu's Open session in editor
  'session.settle': SESSIONS, // Q7 point 4
  'waiting.next': SESSIONS,
  'zone.zoom': PANES,
  'pane.mode': PANES,
  'pane.focus': FOCUS,
  'pane.focus.left': FOCUS, // needs 170 (3): bound by default, so each names its area
  'pane.focus.right': FOCUS,
  'pane.focus.up': FOCUS,
  'pane.focus.down': FOCUS,
  'pane.swap': PANES,
  'layout.edit': PANES,
  'titlebar.show': PANES, // LAYOUT D5b A33
  'layout.done': PANES,
  'layout.cancel': PANES,
  'layout.reset': PANES,
  'layout.undo': PANES,
  'undo.last': WINDOW, // V2-6a
  'split.right': PANES, // SPLITKEYS
  'split.down': PANES,
  'split.left': PANES, // V2.5-34 (needs 153): palette-only, like the layout actions
  'split.up': PANES,
  'split.close': PANES,
  'terminal.find': TERMINAL,
  'terminal.copy': TERMINAL,
  'terminal.edit': TERMINAL,
  'terminal.clear': TERMINAL,
  'hints.copy': TERMINAL,
  'focus.tree': FOCUS,
  'focus.composer': FOCUS,
  'focus.terminal': FOCUS,
  'composer.toggle': COMPOSER,
  'composer.steerNow': COMPOSER, // v25-sendkeys
  'composer.backgroundSend': COMPOSER,
  'pane.toggle': PANES,
  'pane.maximize': PANES,
  'chat.cycleView': COMPOSER,
  'pane.shell.new': VIEWS,
  'diff.open': VIEWS,
  'pr.list': VIEWS, // ticket 373: opens the PR list view, like diff.open
  'search.open': VIEWS,
  'search.sessions': VIEWS, // v2-7
  'sidebar.left.toggle': VIEWS,
  'sidebar.right.toggle': VIEWS,
  'bars.toggle': VIEWS,
  'sidebars.wider': VIEWS, // v25-shell-chrome (ticket 283): palette-only, steps the shared Sidebar width
  'sidebars.narrower': VIEWS,
  'session.restart': SESSIONS, // v25-shell-chrome (ticket 282 item 2): tab menu and palette
  'session.close': SESSIONS, // v25-exit-widgets (ticket 286 item 2): an ended session, from the tab menu, the palette and the tree row
  'files.show': VIEWS,
  'files.quickOpen': VIEWS,
  'files.dock.side': VIEWS, // v1a-65
  'search.dock.side': VIEWS,
  'artifacts.toggle': VIEWS,
  'board.toggle': VIEWS,
  'preview.toggle': VIEWS,
  // v2-9a
  'projects.pick': VIEWS,
  'project.add': VIEWS,
  'project.rename': VIEWS,
  'project.remove': VIEWS, // ticket 370: the project row menu, beside add and rename
  'tree.expand-all': VIEWS,
  'group.create': VIEWS,
  'group.rename': VIEWS,
  'group.dissolve': VIEWS,
  'group.move': VIEWS,
  'group.remove': VIEWS,
  'project.pin': VIEWS,
  'lead.add': VIEWS, // ticket 990: the project row menu's Add a leader…, beside the other project rows
  'room.open': VIEWS, // look 1117 v11-A-S3-1: the palette's way back to a lead's Room (Team view) as a tab
  'lead.fresh': VIEWS, // ticket 1096: New Lead conversation
  // Ticket 1099: palette commands that had no area (Keys page "Other"), and the ones the cohesion pass adds.
  'bars.autohide': VIEWS,
  'tree.clear-finished': VIEWS,
  'history.open': VIEWS,
  'usage.page': WINDOW,
  'team.page': WINDOW,
  'assistants.page': WINDOW,
  'decisions.open': VIEWS,
  'schedules.open': VIEWS,
  'schedules.new': VIEWS,
  'context.open': VIEWS,
  'notify.session': SESSIONS, // stem: notify.session.all | waiting | off
  'font.bigger': FONT,
  'font.smaller': FONT,
  'font.reset': FONT,
  'zoom.in': WINDOW,
  'zoom.out': WINDOW,
  'zoom.reset': WINDOW,
};
export const areaOf = (id: string): Area => AREA[id] ?? AREA[id.slice(0, id.lastIndexOf('.'))] ?? OTHER;
/** Bound ids with no area of their own (a stem does not count): a new default binding must name its area. */
export const unassigned = (bindings: Bindings) => Object.keys(bindings).filter((id) => id !== 'prefix' && !AREA[id]);

// v1a-43: pane mode keys by physical code (arrows act as hjkl) and the keys that leave it; App.tsx dispatches on these.
export const PANE_DIRS: Record<string, Dir> = { KeyH: 'left', ArrowLeft: 'left', KeyJ: 'down', ArrowDown: 'down', KeyK: 'up', ArrowUp: 'up', KeyL: 'right', ArrowRight: 'right' };
export const PANE_LEAVE = ['Escape', 'Enter', 'NumpadEnter', 'KeyQ'];

/**
 * v1a-42 copy mode keys as the Keys page lists them (V1A-57); copyKey below is what copy mode does with each. A space
 * separates keys pressed in sequence.
 */
export const COPY_KEYS: { keys: string[]; does: string }[] = [
  { keys: ['KeyH', 'KeyJ', 'KeyK', 'KeyL', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight'], does: 'move the cursor' },
  { keys: ['KeyW', 'KeyB', 'KeyE'], does: 'next word, back a word, end of word' },
  { keys: ['Digit0', 'Shift+Digit6', 'Shift+Digit4'], does: 'line start, first character, line end' },
  { keys: ['KeyG KeyG', 'Shift+KeyG'], does: 'top, bottom of the scrollback' },
  { keys: ['Control+KeyU', 'Control+KeyD'], does: 'half a screen up, down' },
  { keys: ['KeyV', 'Shift+KeyV'], does: 'select characters, select lines' },
  { keys: ['KeyY', 'Enter'], does: 'copy the selection and leave' },
  { keys: ['Escape', 'KeyQ'], does: 'leave' },
];

/** What a key does in copy mode, by physical code with its Shift and Control (⌘ never reaches the mode and ⌥ is
 *  swallowed before it); null for a key the mode ignores. COPY_KEYS lists these keys; terminal/copymode.tsx dispatches on this,
 *  and keys-cards.spec.ts runs every COPY_KEYS entry through it, both ways. */
export type CopyKey = 'leave' | 'copy' | 'g' | 'select' | 'select-lines' | 'left' | 'right' | 'up' | 'down' | 'half-up' | 'half-down' | 'line-start' | 'first' | 'line-end' | 'bottom' | 'w' | 'b' | 'e';
export function copyKey(code: string, shift: boolean, ctrl: boolean): CopyKey | null {
  if (code === 'Escape' || (code === 'KeyQ' && !ctrl)) return 'leave';
  if (code === 'KeyY' || code === 'Enter') return 'copy';
  if (code === 'KeyG' && !shift && !ctrl) return 'g'; // `g g`: the first press waits for the second
  if (code === 'KeyV' && !ctrl) return shift ? 'select-lines' : 'select';
  if (ctrl) return code === 'KeyU' ? 'half-up' : code === 'KeyD' ? 'half-down' : null;
  switch (code) {
    case 'KeyH': case 'ArrowLeft': return 'left';
    case 'KeyL': case 'ArrowRight': return 'right';
    case 'KeyK': case 'ArrowUp': return 'up';
    case 'KeyJ': case 'ArrowDown': return 'down';
    case 'Digit0': return shift ? null : 'line-start';
    case 'Digit6': return shift ? 'first' : null;
    case 'Digit4': return shift ? 'line-end' : null;
    case 'KeyG': return 'bottom'; // Shift: the plain press is `g` above
    case 'KeyW': case 'KeyB': case 'KeyE': return shift ? null : (code.slice(3).toLowerCase() as 'w' | 'b' | 'e');
  }
  return null;
}

const MODS = ['Control', 'Alt', 'Shift', 'Meta'] as const;

/** v25-sendkeys: which composer Enter this chord is, as bound (the two the composer handles itself). */
export function composerKey(all: Bindings, chord: string): 'steerNow' | 'backgroundSend' | null {
  // Q9 en-a-J8-1: every chord bound to it, and none when unbound (an empty list), not the default.
  if ((all['composer.steerNow'] ?? ['Control+Enter']).includes(chord)) return 'steerNow';
  if ((all['composer.backgroundSend'] ?? ['Meta+Enter']).includes(chord)) return 'backgroundSend';
  return null;
}

/** Chord string from a keydown, modifiers in a fixed order. */
export function chordOf(e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string {
  const on = [e.ctrlKey, e.altKey, e.shiftKey, e.metaKey];
  return [...MODS.filter((_, i) => on[i]), e.code].join('+');
}

export const isModifier = (code: string) => /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(code);

/**
 * True while an IME composes: such keys belong to the input, never to a binding. keyCode 229 alone is not
 * composing: macOS reports it for every key a Korean input source handles, so it must not block bindings.
 */
export const composing = (e: KeyboardEvent) => e.isComposing;

/** Ticket 516: the pairs that may share a key because they never fire together: the Settings search (only while Settings
 *  is open) and the terminal's find (shut behind it). Any other key a Settings-only command takes is a clash as usual. */
const SHARED: [string, string][] = [['settings.search', 'terminal.find']];
export const apart = (a: string, b: string) => SHARED.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
/** Ticket 534: every key two commands hold that resolve() would let one shadow (`<key>: <a> and <b>`); a pair `apart`
 *  allows is none. The specs that check the defaults use this, so the shared-key rule lives only in SHARED. */
export function clashes(bindings: Bindings): string[] {
  const seen = new Map<string, string[]>();
  const found: string[] = [];
  for (const [id, bs] of Object.entries(bindings))
    for (const b of bs) {
      const held = seen.get(b) ?? [];
      for (const other of held) if (!apart(other, id)) found.push(`${b}: ${other} and ${id}`);
      seen.set(b, [...held, id]);
    }
  return found;
}
/** Every other command already holding `binding` (shown at capture time). */
export function conflicts(bindings: Bindings, binding: Binding, except: string): string[] {
  return Object.entries(bindings)
    .filter(([id, bs]) => id !== except && bs.includes(binding) && !apart(id, except))
    .map(([id]) => id);
}

/** Defaults under the user's overrides; a key the user gave one command leaves the default that held it (V1A-57), so a
 *  new default never takes over a key the user already bound. */
/** Ticket 1099: the window's bindings as App drew them last, so a help line says the user's own key, not a fixed one.
 *  shortcut: set during App's render (as setKindNames), so a line drawn before a rebind changes on its next render. */
let live: Bindings | null = null;
export const setLiveBindings = (b: Bindings) => void (live = b);
/** A command's first key as text (`⌘T`, `◆ k`), or '' when it has none. */
export const keyText = (id: string) => ((b?: Binding) => (b ? label(b) : ''))((live ?? DEFAULT_BINDINGS)[id]?.[0]);

export function merge(overrides: Bindings): Bindings {
  const taken = new Set(Object.values(overrides).flat());
  const defaults = Object.fromEntries(Object.entries(DEFAULT_BINDINGS).map(([id, bs]) => [id, id in overrides ? bs : bs.filter((b) => !taken.has(b))]));
  return { ...defaults, ...overrides };
}

const KEY_LABEL: Record<string, string> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘', Space: '␣', Comma: ',', Period: '.', Slash: '/', Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Backquote: '`', Backslash: '\\', Enter: '↵', Escape: 'esc', ArrowLeft: '←', ArrowDown: '↓', ArrowUp: '↑', ArrowRight: '→' };

/** What Shift types on these keys (US layout): `prefix + <` reads better than `prefix + ⇧,`. */
const SHIFTED: Record<string, string> = { Comma: '<', Period: '>', Slash: '?', Equal: '+', Minus: '_', BracketLeft: '{', BracketRight: '}', Semicolon: ':', Quote: '"', Backquote: '~', Backslash: '|' };

/** A binding's own keys without the prefix: `s` after the prefix, `⌘K` for a direct chord. */
function keys(binding: Binding): string {
  const after = binding.startsWith('prefix ');
  const typed = (parts: string[]) => {
    const key = parts[parts.length - 1];
    return parts.includes('Shift') && SHIFTED[key] ? [...parts.slice(0, -1).filter((p) => p !== 'Shift'), SHIFTED[key]] : parts;
  };
  // After the prefix a letter reads lower case (`⌃␣ then s`); a direct chord keeps `⌘K`.
  const chord = (c: string) =>
    typed(c.split('+'))
      .map((p) => KEY_LABEL[p] ?? (after ? p.replace(/^Key([A-Z])$/, (_, l: string) => l.toLowerCase()) : p.replace(/^Key/, '')).replace(/^Digit/, ''))
      .join('');
  return after ? chord(binding.slice(7)) : chord(binding);
}

/** The chord shown for "the prefix": the user's first one, so it follows the Keys setting live. */
const firstPrefix = (bindings?: Bindings) => (bindings?.prefix ?? DEFAULT_BINDINGS.prefix)[0] ?? '';

/** Owner 11-17 (five symbols shown, ◆ picked): the one symbol that stands for the prefix wherever a key after it is shown. */
export const PREFIX_SYMBOL = '◆';

/** A binding as text: `◆ x` for a key after the prefix, `⌘K` for a direct chord. `_bindings` is kept for the callers. */
export function label(binding: Binding, _bindings?: Bindings): string {
  return binding.startsWith('prefix ') ? `${PREFIX_SYMBOL} ${keys(binding)}` : keys(binding);
}

/** The same with the prefix's real keys, for a tooltip: `⌃. then x` (the user's first prefix chord). */
export function spelled(binding: Binding, bindings?: Bindings): string {
  // Ticket 492: the joining word follows the window's language (<html lang>); English where there is no document.
  const then = typeof document === 'undefined' ? 'then' : makeT((document.documentElement.lang || 'en') as Language, navigator.language)('mw.keys.then');
  return binding.startsWith('prefix ') ? `${keys(firstPrefix(bindings))} ${then} ${keys(binding)}` : keys(binding);
}

/** A key after the prefix without the prefix (the Keys page and the prefix help show the prefix once); a direct chord as is. */
export const bare = (binding: Binding) => keys(binding);

/** Keys whose spoken name is a word (`a11y.key.<code>`); any other key is said as its label. */
const SPOKEN = new Set(['Control', 'Alt', 'Shift', 'Meta', 'Space', 'Comma', 'Period', 'Slash', 'Equal', 'Minus', 'Enter', 'Escape', 'Tab']);

/** What a screen reader says for a chip: `Control Space, then x`. Ticket 812: in the window's language (<html lang>), as `label`. */
export function spoken(binding: Binding, bindings?: Bindings): string {
  const t = makeT((typeof document === 'undefined' ? 'en' : document.documentElement.lang || 'en') as Language, typeof navigator === 'undefined' ? 'en' : navigator.language);
  const say = (b: Binding) =>
    b
      .replace(/^prefix /, '')
      .split('+')
      .map((p) => (SPOKEN.has(p) ? t(`a11y.key.${p}` as Key) : keys(p).toUpperCase()))
      .join(' ');
  return binding.startsWith('prefix ') ? t('a11y.key.then', { first: say(firstPrefix(bindings)), next: say(binding) }) : say(binding);
}

/** A mode key (copy or pane mode) as typed: lower-case letters, shifted punctuation by its character. */
export const modeKey = (code: string) => code.split(' ').map((c) => bare(`prefix ${c}`)).join(' ');

/** An icon button's tooltip: its name and its first key (V1A-57; needs 69), or the name alone when unbound. */
export function tip(name: string, id: string, bindings: Bindings): string {
  const b = bindings[id]?.[0];
  return b ? `${name} (${label(b, bindings)})` : name;
}

/** The prefix as shown where it is set: every chord, e.g. `⌃. ⌃␣`. */
export const prefixLabel = (bindings: Bindings) => (bindings.prefix ?? []).map((c) => keys(c)).join(' ');

export type Match = { kind: 'command'; id: string } | { kind: 'prefix' } | { kind: 'prefix-twice' } | { kind: 'none' };

/** Ids that no longer exist: the Chat | Terminal switch went with AGENTVIEW. A stored override of one is ignored, not run. */
export const REMOVED = ['view.chat', 'view.terminal', 'view.toggle'];

/** Ticket 516: commands that hold a key only while Settings is open, where they come before every other command (⌘F
 *  focuses the Settings search there and finds in the terminal everywhere else). */
export const SETTINGS_ONLY = ['settings.search'];

/** Resolves one keydown given whether the prefix is armed and whether Settings is open. */
export function resolve(all: Bindings, chord: string, armed: boolean, inSettings = false): Match {
  const kept = Object.entries(all).filter(([k]) => !REMOVED.includes(k) && (inSettings || !SETTINGS_ONLY.includes(k)));
  const bindings = Object.fromEntries(inSettings ? [...kept.filter(([k]) => SETTINGS_ONLY.includes(k)), ...kept.filter(([k]) => !SETTINGS_ONLY.includes(k))] : kept);
  const prefix = bindings.prefix ?? [];
  if (armed) {
    if (prefix.includes(chord)) return { kind: 'prefix-twice' };
    const id = Object.keys(bindings).find((k) => k !== 'prefix' && bindings[k].includes(`prefix ${chord}`));
    return id ? { kind: 'command', id } : { kind: 'none' };
  }
  if (prefix.includes(chord)) return { kind: 'prefix' };
  const id = Object.keys(bindings).find((k) => k !== 'prefix' && bindings[k].includes(chord));
  return id ? { kind: 'command', id } : { kind: 'none' };
}

/** Bytes an agent receives for the prefix chord when it is pressed twice (Ctrl+Space is NUL). */
export function chordBytes(chord: string): string | null {
  const m = /^Control\+(?:Key([A-Z])|(Space))$/.exec(chord);
  if (!m) return null;
  return m[2] ? '\x00' : String.fromCharCode(m[1].charCodeAt(0) - 64);
}

/**
 * Set while Settings captures keys, so the global handler lets every key through to it. Counted, because the key
 * table and the Hints section capture independently and one ending must not end the other.
 */
let captures = 0;
export const keyCapture = {
  get active() {
    return captures > 0;
  },
};
/** Starts a capture; the returned function ends it (once). */
export function captureKeys(): () => void {
  captures++;
  let ended = false;
  return () => {
    if (!ended) (ended = true), captures--;
  };
}

/** Why a direct chord is risky, or null: a bare key fires while typing, Ctrl+C is the agent's interrupt. */
export function risk(binding: Binding): string | null {
  if (binding.startsWith('prefix ')) return null;
  if (binding === 'Control+KeyC') return 'Ctrl+C is the interrupt agents rely on';
  if (!/(^|\+)(Control|Alt|Meta)\+/.test(binding)) return 'no modifier: this key runs the command while you type';
  return null;
}
