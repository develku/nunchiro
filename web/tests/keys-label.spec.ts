// Key notation and defaults (needs 25, 30, 60; V1A-45, V1A-39). Pure functions, no page.
import { expect, test } from '@playwright/test';
import { DEFAULT_BINDINGS, chordBytes, label, resolve } from '../src/keys';

const b = DEFAULT_BINDINGS;

test('after-prefix bindings read prefix + key, letters lower case, modifiers as symbols', () => {
  expect(label('prefix KeyS', b)).toBe('◆ s');
  expect(label('prefix Digit1', b)).toBe('◆ 1');
  expect(label('prefix Shift+Comma', b)).toBe('◆ <'); // V1A-56: shifted keys read as typed
  expect(label('prefix Tab', b)).toBe('◆ Tab');
  expect(label('prefix Shift+KeyH', b)).toBe('◆ ⇧h');
});

test('hints-other-index-and-bracket: punctuation keys read as their glyph, so copy mode shows prefix + [', () => {
  expect(label(b['terminal.copy'][0], b)).toBe('◆ [');
  expect(label('prefix BracketRight', b)).toBe('◆ ]');
  expect(label('Meta+Semicolon', b)).toBe('⌘;');
  expect(label('Meta+Quote', b)).toBe("⌘'");
  expect(label('Meta+Backquote', b)).toBe('⌘`');
  expect(label('Meta+Backslash', b)).toBe('⌘\\');
});

test('direct chords keep their symbols', () => {
  expect(label('Meta+KeyK', b)).toBe('⌘K');
  expect(label('Meta+Comma', b)).toBe('⌘,');
  expect(label('Meta+Equal', b)).toBe('⌘=');
  expect(label('Meta+Minus', b)).toBe('⌘-');
  expect(label('Meta+Digit0', b)).toBe('⌘0');
});

test('the prefix itself lists every chord, and the default is herdr\'s pair', () => {
  expect(b.prefix).toEqual(['Control+Period', 'Control+Space']);
  expect(label('Control+Period', b)).toBe('⌃.');
  expect(label('Control+Space', b)).toBe('⌃␣');
});

test('either default prefix chord arms the prefix; prefix twice on ⌃. sends no bytes, ⌃␣ sends NUL', () => {
  expect(resolve(b, 'Control+Period', false)).toEqual({ kind: 'prefix' });
  expect(resolve(b, 'Control+Space', false)).toEqual({ kind: 'prefix' });
  expect(resolve(b, 'Control+Period', true)).toEqual({ kind: 'prefix-twice' });
  expect(chordBytes('Control+Period')).toBeNull();
  expect(chordBytes('Control+Space')).toBe('\x00');
});

test('window zoom commands are bound to Cmd+= (and Cmd++), Cmd+-, Cmd+0; the terminal font ones have no key (ticket 1071)', () => {
  expect(b['zoom.in']).toEqual(['Meta+Equal', 'Shift+Meta+Equal']);
  expect(b['zoom.out']).toEqual(['Meta+Minus']);
  expect(b['zoom.reset']).toEqual(['Meta+Digit0']);
  expect(resolve(b, 'Meta+Equal', false)).toEqual({ kind: 'command', id: 'zoom.in' });
  for (const id of ['font.bigger', 'font.smaller', 'font.reset']) expect(b[id]).toBeUndefined();
});
