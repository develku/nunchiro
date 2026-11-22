// Hint labels from user letters and kind letters (needs 118, ticket 75, ticket 389): pure model, no page.
import { expect, test } from '@playwright/test';
import { assign, cleanHintKeys, DEFAULT_HINT_KEYS, effectiveAlphabet, REGIONS, kindOfMark, letterOf, parseAlphabet as parseWith, soleTarget, typedKey, type HintItem, type HintKeys, type Kind } from '../src/hintLabels';
import { DEFAULT_BINDINGS } from '../src/keys';
import { makeT } from './i18n-tables';
import { defaultBars, icons } from '../src/layout/bars';

const parseAlphabet = (a: string) => parseWith(a, makeT('en', 'en'));
const text = (labels: string[][]) => labels.map((l) => l.join(''));
const items = (kind: Kind, n: number): HintItem[] => Array.from({ length: n }, (_, i) => ({ kind, order: i }));
const keys = (alphabet: string, kinds: Partial<HintKeys['kinds']> = {}): HintKeys => {
  const parsed = parseAlphabet(alphabet);
  if (!parsed.ok) throw new Error(parsed.error);
  return { alphabet: parsed.keys, kinds: { ...DEFAULT_HINT_KEYS.kinds, ...kinds } };
};

test('alphabet_example_is_letters', () => {
  const r = parseAlphabet("qyou=ciae-',.;/12345");
  expect(r.ok && r.keys.join('')).toBe("qyou=ciae-',.;/12345");
  expect(r.ok && r.keys).toHaveLength(20);
  // Upper case reads as its letter; Backquote and Backslash are on the drawing, so "any printable key" is reachable.
  expect(parseAlphabet('QW')).toEqual({ ok: true, keys: ['q', 'w'] });
  expect(parseAlphabet('`\\')).toEqual({ ok: true, keys: ['`', '\\'] });
});

test('alphabet_duplicates_and_unknown_refused', () => {
  const dup = parseAlphabet('qwq');
  expect(!dup.ok && dup.error).toContain('“q”');
  const space = parseAlphabet('q w');
  expect(!space.ok && space.error).toMatch(/space/i);
  const unknown = parseAlphabet('qé');
  expect(!unknown.ok && unknown.error).toContain('“é”');
  expect(parseAlphabet('q').ok).toBe(false); // one key cannot count past one
  expect(parseAlphabet('').ok).toBe(false);
});

test('kind_keys_leave_alphabet', () => {
  // Ticket 389: only the p and s prefix letters leave the labels; t l r w f u h o are Shift filters and label too.
  const k = keys('qwertyasdfgzxcvb123456');
  expect(text([effectiveAlphabet(k)])).toEqual(['qwertyadfgzxcvb123456']);
  expect(k.alphabet).toContain('s'); // storage keeps it
  // Moving the session prefix off s brings s back, in its place in the alphabet.
  const moved = { ...k, kinds: { ...k.kinds, session: 'k' } };
  expect(text([effectiveAlphabet(moved)])).toEqual(['qwertyasdfgzxcvb123456']);
  expect(text([effectiveAlphabet(DEFAULT_HINT_KEYS)])).toEqual(['adfjklghewruioqtyvcmnxzb1234567890']);
});

test('labels_shortest_first_prefix_free', () => {
  const k = keys("qyou=ciae-',.;/12345");
  // A Shift filter labels from the first key; o and u are filter keys now, so they label too.
  expect(text(assign(items('tab', 3), k, 'tab'))).toEqual(['q', 'y', 'o']);
  const many = text(assign(items('tab', 25), k, 'tab'));
  expect(new Set(many).size).toBe(25);
  for (const a of many) for (const b of many) if (a !== b) expect(b.startsWith(a)).toBe(false);
  const len = many.map((l) => l.length);
  expect(len).toEqual([...len].sort((a, b) => a - b)); // earlier targets never get longer labels
  // 20 usable keys, 25 targets: the last key gives way to two-key labels, so 19 stay one key and 6 take two.
  expect(len.filter((n) => n === 1)).toHaveLength(19);
  expect(len.filter((n) => n === 2)).toHaveLength(6);
  // Unfiltered, targets with no region take letters before digits, the last keys turning into prefixes past 32.
  const rest = text(assign(items('other', 40), DEFAULT_HINT_KEYS));
  expect(rest.slice(0, 3)).toEqual(['a', 'd', 'f']);
  expect(rest.filter((l) => l.length === 1).at(-1)).toMatch(/^\d$/);
  for (const a of rest) for (const b of rest) if (a !== b) expect(b.startsWith(a)).toBe(false);
});

test('labels_stable_within_kind', () => {
  const k = DEFAULT_HINT_KEYS;
  const base: HintItem[] = [...items('project', 2), ...items('session', 3), ...items('tab', 2)];
  expect(assign(base, k)).toEqual(assign(base, k));
  const withUrl = [...base, { kind: 'url' as const, order: 0 }];
  // A kind-filtered view depends only on that kind's own targets.
  for (const kind of ['project', 'session', 'tab'] as const) expect(assign(withUrl, k, kind).slice(0, base.length)).toEqual(assign(base, k, kind));
  // A filtered kind relabels from the alphabet start.
  expect(text(assign(base, k, 'tab').filter((l) => l.length))).toEqual(['a', 'd']);
  expect(text(assign(base, k, 'session').filter((l) => l.length))).toEqual(['a', 'd', 'f']);
  // Unfiltered: p1 p2, s1 s2 s3, and a tab reads its session's label.
  expect(text(assign(base, k))).toEqual(['p1', 'p2', 's1', 's2', 's3', 's1', 's2']);
  // The order of discovery does not matter, only the slot.
  expect(text(assign([{ kind: 'session', order: 2 }, { kind: 'session', order: 0 }, { kind: 'session', order: 1 }], k))).toEqual(['s3', 's1', 's2']);
  // Past ten the slot keys go on with the letters: s0 is the tenth, then sa.
  expect(text(assign(items('session', 12), k)).slice(9)).toEqual(['s0', 'sa', 'sd']);
});

/** The owner's screen on 11-10 (final.md section 1), in DOM order: the targets the labels table names. */
function ownerScreen(): { items: HintItem[]; names: string[] } {
  const list: [string, HintItem][] = [];
  const add = (name: string, item: Omit<HintItem, 'order'> & { order?: number }) => list.push([name, { order: list.length, ...item }]);
  for (const n of ['Tree', 'Files', 'Search', 'Settings']) add(n, { kind: 'left', region: 'left' });
  add('+Project', { kind: 'other', region: 'left' });
  add('Expand all', { kind: 'other', region: 'left', quiet: true });
  add('macmini', { kind: 'project', order: 0 });
  add('claude 3a964f', { kind: 'session', order: 2 });
  add('shell 747cf3', { kind: 'session', order: 3 });
  add('+1 more', { kind: 'other', region: 'left', quiet: true });
  add('nunchiro', { kind: 'project', order: 1 });
  add('claude a5b463', { kind: 'session', order: 0 });
  add('acp 452d64', { kind: 'session', order: 1 });
  add('palette', { kind: 'other', region: 'top' });
  add('layout pane', { kind: 'pane' });
  add('tab 1', { kind: 'tab', order: 0 });
  add('tab 2', { kind: 'tab', order: 1 });
  add('new tab', { kind: 'other', quiet: true });
  for (const n of ['Side chat', 'Notifications', 'Thinking']) add(n, { kind: 'other', region: 'top' });
  for (let i = 1; i <= 7; i++) add(`right ${i}`, { kind: 'right', region: 'right' });
  for (const n of ['message', 'button 1', 'button 2', 'button 3', 'button 4', 'model', 'effort', 'permission']) add(n, { kind: 'other', region: 'composer' });
  add('diff count', { kind: 'other' });
  add('Lock', { kind: 'other', quiet: true });
  add('url', { kind: 'url', order: 1e9 });
  return { items: list.map(([, it]) => it), names: list.map(([n]) => n) };
}

test('owner_screen_matches_the_section_1_table', () => {
  const { items: list, names } = ownerScreen();
  const got = Object.fromEntries(names.map((n, i) => [n, text(assign(list, DEFAULT_HINT_KEYS))[i]]));
  expect(got).toEqual({
    Tree: 'a', Files: 'd', Search: 'f', Settings: 'g', '+Project': 'q', 'Expand all': '',
    macmini: 'p1', 'claude 3a964f': 's3', 'shell 747cf3': 's4', '+1 more': '',
    nunchiro: 'p2', 'claude a5b463': 's1', 'acp 452d64': 's2',
    palette: 'w', 'layout pane': '', 'tab 1': 's1', 'tab 2': 's2', 'new tab': '',
    'Side chat': 'e', Notifications: 'r', Thinking: 't',
    'right 1': 'j', 'right 2': 'k', 'right 3': 'l', 'right 4': 'h', 'right 5': 'u', 'right 6': 'i', 'right 7': 'o',
    message: 'z', 'button 1': 'x', 'button 2': 'c', 'button 3': 'v', 'button 4': 'b', model: 'n', effort: 'm', permission: 'y',
    'diff count': '1', Lock: '', url: '2',
  });
  // Quiet targets come back under Shift + their kind key, from the first key.
  expect(text(assign(list, DEFAULT_HINT_KEYS, 'other')).filter(Boolean).slice(0, 3)).toEqual(['a', 'd', 'f']);
  expect(text(assign(list, DEFAULT_HINT_KEYS, 'pane')).filter(Boolean)).toEqual(['a']);
});

test('adding_a_project_or_session_never_moves_a_one_key_label', () => {
  const { items: list } = ownerScreen();
  const one = (ls: string[][]) => ls.map((l) => (l.length === 1 ? l[0] : ''));
  const before = one(assign(list, DEFAULT_HINT_KEYS));
  // A new project and a new session, placed in the tree before everything else and before the tabs' rows.
  const more: HintItem[] = [{ kind: 'project', order: 2 }, { kind: 'session', order: 4 }, { kind: 'tab', order: 2 }, ...list];
  expect(one(assign(more, DEFAULT_HINT_KEYS)).slice(3)).toEqual(before);
  // A new chip in one region moves only the spill-over, never another region's keys.
  const chip: HintItem[] = [...list, { kind: 'other', region: 'left', order: 5.5 }];
  const after = one(assign(chip, DEFAULT_HINT_KEYS)).slice(0, list.length);
  const own = list.flatMap((it, i) => (it.region && (REGIONS[it.region] as readonly string[]).includes(assign(list, DEFAULT_HINT_KEYS)[i][0]) ? [i] : []));
  expect(own.length).toBeGreaterThan(20);
  for (const i of own) expect(after[i]).toBe(before[i]);
});

test('typed_letter_not_physical_key: any layout or remap types the letter shown; an input method falls back to QWERTY', () => {
  // Owner 11-10: the character typed decides (Colemak, Dvorak, Karabiner, firmware): key p on the physical KeyR is p.
  expect(typedKey({ key: 'p', code: 'KeyR' })).toBe('p');
  expect(typedKey({ key: 'P', code: 'KeyR' })).toBe('p'); // Shift+p
  expect(typedKey({ key: '1', code: 'Digit1' })).toBe('1');
  // Korean or Chinese input on: no plain letter, so the key's QWERTY letter stands in (never a jamo).
  expect(typedKey({ key: 'Process', code: 'KeyP' })).toBe('p');
  expect(typedKey({ key: 'ㅔ', code: 'KeyP' })).toBe('p');
  expect(typedKey({ key: 'Escape', code: 'Escape' })).toBe('');
  // Prefixes and regions are letters: p1 is p then 1, and the left bar labels a d f g q on any layout.
  const list: HintItem[] = [{ kind: 'project', order: 0 }, ...items('left', 5).map((it) => ({ ...it, region: 'left' as const }))];
  expect(text(assign(list, DEFAULT_HINT_KEYS))).toEqual(['p1', 'a', 'd', 'f', 'g', 'q']);
  expect(REGIONS.left.slice(0, 5)).toEqual([...'adfgq']);
  expect(letterOf('KeyR')).toBe('r');
});

test('custom_alphabet: regions take only its keys, in its order', () => {
  const k = keys('kjzxqw1234'); // no a or d; j before k reversed
  const list: HintItem[] = [...items('right', 3).map((it) => ({ ...it, region: 'right' as const })), ...items('left', 2).map((it) => ({ ...it, order: 10 + it.order, region: 'left' as const }))];
  // Right takes k j (its order), then spills to the unused letters (z x w) before digits; left takes q.
  expect(text(assign(list, k))).toEqual(['k', 'j', 'z', 'q', 'x']);
  // Keys outside the alphabet are never used.
  for (const l of assign(items('other', 30), k).flat()) expect(k.alphabet).toContain(l);
});

test('single_target_kind_by_key_alone', () => {
  const list: HintItem[] = [...items('project', 1), ...items('session', 2)];
  expect(soleTarget(list, 'project')).toBe(0);
  expect(soleTarget(list, 'session')).toBeNull();
  expect(soleTarget(list, 'tab')).toBeNull();
});

test('icons_grouped_by_bar', () => {
  const bars = defaultBars();
  const left = icons(bars, 'left');
  const right = icons(bars, 'right');
  expect(left.length).toBeGreaterThan(0);
  expect(right.length).toBeGreaterThan(0);
  const list: HintItem[] = [...left.map((w, order) => ({ kind: 'left' as const, order, icon: w, region: 'left' as const })), ...right.map((w, order) => ({ kind: 'right' as const, order: 100 + order, icon: w, region: 'right' as const }))];
  // Each bar labels from its own keys: the left hand's for the left bar, the right hand's for the right.
  expect(text(assign(list, DEFAULT_HINT_KEYS)).slice(0, Math.min(left.length, 5))).toEqual(['a', 'd', 'f', 'g', 'q'].slice(0, left.length));
  expect(text(assign(list, DEFAULT_HINT_KEYS)).slice(left.length, left.length + Math.min(right.length, 7))).toEqual(['j', 'k', 'l', 'h', 'u', 'i', 'o'].slice(0, right.length));
  // Shift+L and Shift+R label one bar from the alphabet start.
  expect(text(assign(list, DEFAULT_HINT_KEYS, 'left')).slice(0, 2)).toEqual(['a', 'd']);
  expect(text(assign(list, DEFAULT_HINT_KEYS, 'right')).slice(left.length, left.length + 2)).toEqual(['a', 'd']);
  // An icon's label is not its shortcut letter, and the shortcuts themselves stay.
  expect(DEFAULT_BINDINGS['search.open']).toEqual(['Shift+Meta+KeyF', 'prefix KeyS']); // needs 166 (f34bb5cf): ⇧⌘F first, prefix s kept
  expect(DEFAULT_BINDINGS['diff.open']).toEqual(['prefix KeyG']);
  expect(DEFAULT_BINDINGS['settings.open']).toEqual(['Meta+Comma']);
});

test('migrate_v1a48_hint_keys', () => {
  const old = {
    kinds: { project: 'KeyP', agent: 'KeyA', tab: 'KeyT', url: 'KeyU', path: 'KeyF', hash: 'KeyH', other: 'KeyO' },
    index: ['KeyJ', 'KeyK', 'KeyL'],
    layout: 'colemak',
  };
  // Codes become their QWERTY letters once; the stored layout is ignored and dropped.
  expect(cleanHintKeys(old)).toEqual({
    kinds: { project: 'p', session: 'a', tab: 't', left: 'l', right: 'r', pane: 'w', url: 'u', path: 'f', hash: 'h', other: 'o' },
    alphabet: ['j', 'k', 'l'], // a custom alphabet is kept
  });
  // A saved key that another kind already uses sends the new kind to the first free drawn letter.
  const clash = cleanHintKeys({ ...old, kinds: { ...old.kinds, tab: 'KeyL' } })!;
  expect(clash.kinds.tab).toBe('l');
  expect(clash.kinds.left).not.toBe('l');
  expect(new Set(Object.values(clash.kinds)).size).toBe(10);
  // Saved bindings are not part of hintKeys, so a rebinding survives untouched.
  expect(Object.keys(clash).sort()).toEqual(['alphabet', 'kinds']);
  // The new shape round-trips.
  expect(cleanHintKeys(DEFAULT_HINT_KEYS)).toEqual(DEFAULT_HINT_KEYS);
});

test('migrate_stored_codes_to_letters', () => {
  const codes = (s: string) => [...s].map((c) => (c >= '0' && c <= '9' ? `Digit${c}` : `Key${c.toUpperCase()}`));
  const kinds = { project: 'KeyP', session: 'KeyS', tab: 'KeyT', left: 'KeyL', right: 'KeyR', pane: 'KeyW', url: 'KeyU', path: 'KeyF', hash: 'KeyH', other: 'KeyO' };
  // A stored code alphabet (any layout) becomes letters; the 10-28 default becomes the new default.
  expect(cleanHintKeys({ kinds, alphabet: codes('qwertyasdfgzxcvb123456'), layout: 'dvorak' })).toEqual({ kinds: DEFAULT_HINT_KEYS.kinds, alphabet: [...'qwertyasdfgzxcvb123456'] });
  expect(cleanHintKeys({ kinds, alphabet: codes('123456qwertyasdfgzxcvb'), layout: 'qwerty' })).toEqual(DEFAULT_HINT_KEYS);
  expect(cleanHintKeys({ kinds, alphabet: ['Semicolon', 'Quote', 'KeyA'], layout: 'colemak' })!.alphabet).toEqual([';', "'", 'a']);
});

test('clean_rejects_malformed', () => {
  const ok = DEFAULT_HINT_KEYS;
  const bad: unknown[] = [
    null,
    [],
    { ...ok, extra: 1 },
    { ...ok, alphabet: [] },
    { ...ok, alphabet: ['q'] },
    { ...ok, alphabet: ['q', 'q'] },
    { ...ok, alphabet: ['q', 'é'] },
    { ...ok, alphabet: ['q', 'qw'] },
    { ...ok, alphabet: 'qwe' },
    { ...ok, kinds: { ...ok.kinds, pane: ok.kinds.tab } },
    { ...ok, kinds: { ...ok.kinds, pane: 'F13' } },
    { ...ok, kinds: { project: 'p' } },
    { ...ok, alphabet: ['KeyQ', 'F13'], layout: 'qwerty' }, // a code that is no drawn key
    // Every alphabet letter is a prefix: nothing left to label with.
    { ...ok, alphabet: ['p', 's'] },
  ];
  for (const b of bad) expect(cleanHintKeys(b)).toBeNull();
});

test('pane_hook_attribute', () => {
  expect(kindOfMark('pane')).toBe('pane');
  expect(kindOfMark('left')).toBe('left');
  expect(kindOfMark('right')).toBe('right');
  expect(kindOfMark('agent')).toBe('session'); // Sidebar and RowIcon still say agent
  expect(kindOfMark('session')).toBe('session');
  expect(kindOfMark('nonsense')).toBeNull();
  expect(kindOfMark(undefined)).toBeNull();
});
