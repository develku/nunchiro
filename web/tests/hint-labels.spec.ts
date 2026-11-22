// Hint labels (V1A-48; needs 25, 30, 61, 118): pure label model, no page. The alphabet and kind-key contract is in hint-alphabet.spec.ts.
import { expect, test } from '@playwright/test';
import { assign, DEFAULT_HINT_KEYS, letterOf, resetHintBindings, type HintItem, type HintKeys } from '../src/hintLabels';
import { captureKeys, clashes, DEFAULT_BINDINGS, keyCapture, resolve } from '../src/keys';

/** Labels as the letters a user reads and types (`p1`, `q`). */
const text = (items: HintItem[], keys: HintKeys = DEFAULT_HINT_KEYS) => assign(items, keys).map((l) => l.join(''));

const projects = (n: number): HintItem[] => Array.from({ length: n }, (_, i) => ({ kind: 'project', order: i }));
const sessions = (n: number): HintItem[] => Array.from({ length: n }, (_, i) => ({ kind: 'session', order: i }));
const window1: HintItem[] = [...projects(2), ...sessions(3), { kind: 'tab', order: 0 }, { kind: 'tab', order: 1 }];

test('the same targets get the same labels on two runs', () => {
  expect(text(window1)).toEqual(text(window1));
  // Ticket 389: projects p1 p2, sessions s1-s3; a tab shares its session's label (tab slot 0 = s1 = Cmd-1).
  expect(text(window1)).toEqual(['p1', 'p2', 's1', 's2', 's3', 's1', 's2']);
});

test('a session’s order is its session.jump.N slot: a file tab earlier in the strip leaves a gap, not a shift', () => {
  // Strip: session, file tab, session. The second session is prefix + 3 (slot 2), so it follows the first with the gap kept in order.
  expect(text([{ kind: 'session', order: 2 }, { kind: 'session', order: 0 }])).toEqual(['s3', 's1']);
});

test('every new icon letter is a free prefix key on main', () => {
  // needs 166 (f34bb5cf): the ⌘ keymap leads with a direct chord where it has one; the prefix letter stays as the second binding.
  for (const [id, code, bindings] of [
    ['sidebar.left.toggle', 'KeyB', ['Meta+KeyB', 'prefix KeyB']],
    ['files.show', 'KeyX', ['Shift+Meta+KeyE', 'prefix KeyX']],
    ['artifacts.toggle', 'KeyM', ['prefix KeyM']],
    ['board.toggle', 'KeyK', ['prefix KeyK']],
    ['preview.toggle', 'KeyQ', ['prefix KeyQ']], // v was free in r1; terminal.edit (V1A-38b) holds it on main
  ] as const) {
    expect(DEFAULT_BINDINGS[id]).toEqual(bindings);
    expect(Object.entries(DEFAULT_BINDINGS).filter(([, bs]) => bs.includes(`prefix ${code}`)).map(([k]) => k)).toEqual([id]);
  }
});

test('no two default bindings share a chord, so resolve() never shadows one', () => {
  // Ticket 534: a pair keys.ts lets share a key (SHARED: settings.search, only while Settings is open, and terminal.find,
  // shut behind it) is no clash, as resolve() gives the key to each in its own scope. Any other shared key is.
  expect(clashes(DEFAULT_BINDINGS)).toEqual([]);
  expect(clashes({ 'palette.open': ['Meta+KeyF'], 'terminal.find': ['Meta+KeyF'] })).toEqual(['Meta+KeyF: palette.open and terminal.find']);
  expect(resolve(DEFAULT_BINDINGS, 'Meta+KeyF', false)).toEqual({ kind: 'command', id: 'terminal.find' });
  expect(resolve(DEFAULT_BINDINGS, 'Meta+KeyF', false, true)).toEqual({ kind: 'command', id: 'settings.search' });
});

test('the drawing reads physical codes as their QWERTY letters (owner 11-10: no layout setting)', () => {
  expect(letterOf('KeyE')).toBe('e');
  expect(letterOf('Semicolon')).toBe(';');
  expect(letterOf('Digit3')).toBe('3');
  expect(letterOf('F13')).toBe('');
});

test('Reset to defaults clears only the bindings the Hints section adds, never search, settings, diff or layout', () => {
  const mine = { 'search.open': ['prefix KeyJ'], 'settings.open': ['Meta+KeyU'], 'diff.open': ['prefix KeyH'], 'layout.edit': ['prefix KeyU'], 'board.toggle': ['prefix KeyA'], 'files.show': ['prefix KeyH'], 'session.next': ['Alt+KeyJ'] };
  expect(resetHintBindings(mine)).toEqual({ 'search.open': ['prefix KeyJ'], 'settings.open': ['Meta+KeyU'], 'diff.open': ['prefix KeyH'], 'layout.edit': ['prefix KeyU'], 'session.next': ['Alt+KeyJ'] });
});

test('two key captures: ending one keeps the other active', () => {
  const endTable = captureKeys();
  const endHints = captureKeys();
  endTable();
  expect(keyCapture.active).toBe(true);
  endTable(); // a second call is a no-op
  expect(keyCapture.active).toBe(true);
  endHints();
  expect(keyCapture.active).toBe(false);
});
