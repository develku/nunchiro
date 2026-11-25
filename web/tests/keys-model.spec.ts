// Keys page model (V1A-56; needs 64): every default binding sits in an area, and shifted keys read as typed. Pure.
import { expect, test } from '@playwright/test';
import { AREA, AREAS, DEFAULT_BINDINGS, areaOf, label, merge, resolve, unassigned } from '../src/keys';

test('keys-area-complete: every DEFAULT_BINDINGS id but prefix has an area, and a new id without one is caught', () => {
  expect(unassigned(DEFAULT_BINDINGS)).toEqual([]);
  expect(Object.values(AREA).every((a) => AREAS.includes(a))).toBe(true);
  expect(unassigned({ ...DEFAULT_BINDINGS, 'brand.new': ['prefix KeyJ'] })).toEqual(['brand.new']);
  expect(AREA['tab.rename']).toBe(AREA['session.next']);
  expect(AREA['tab.move.left']).toBe('Sessions and tabs');
  // Commands with no default key still land in an area: dynamic ids by their stem, the rest under Other.
  expect(areaOf('session.open.abc')).toBe('Sessions and tabs');
  expect(areaOf('pane.focus.left')).toBe('Focus');
  expect(areaOf('nobody.knows')).toBe('Other');
});

test('keys-shifted-glyphs: shifted punctuation reads as the typed character', () => {
  const b = DEFAULT_BINDINGS;
  expect(label(b['tab.move.left'][0], b)).toBe('◆ <');
  expect(label(b['tab.move.right'][0], b)).toBe('◆ >');
  expect(b['zoom.in'].map((k) => label(k, b))).toEqual(['⌘=', '⌘+']);
  // A shifted letter has no other glyph, so it keeps ⇧.
  expect(label('prefix Shift+KeyH', b)).toBe('◆ ⇧h');
});

test('keys-override-wins: a key the user bound keeps working when a new default (prefix ?) holds it too', () => {
  const b = merge({ 'layout.reset': ['prefix Shift+Slash'] });
  expect(resolve(b, 'Shift+Slash', true)).toEqual({ kind: 'command', id: 'layout.reset' });
  expect(b['keys.help'] ?? []).toEqual([]); // the prefix key is the user's now
  expect(b['keys.sheet']).toEqual(['Meta+Slash']); // ticket 1099: ⌘/ is the whole sheet's own command, untouched
  // With no override the default holds it.
  expect(resolve(merge({}), 'Shift+Slash', true)).toEqual({ kind: 'command', id: 'keys.help' });
});
