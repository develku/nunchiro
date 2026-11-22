// Settings store parse (V1A-34 fields): validated field by field, old stores still load. Pure, no page.
import { expect, test } from '@playwright/test';
import { DEFAULTS, isHelpDelay, parse } from '../src/settings';
import { DARK_PICK, LIGHT_PICK } from '../src/themes/nunchiro';
import { parseGhostty } from '../src/themes/ghostty';

const mocha = { id: 'catalog:Catppuccin Mocha', name: 'Catppuccin Mocha', colors: parseGhostty('background = #1e1e2e\nforeground = #cdd6f4\n') };

test('defaults: system mode with the two Nunchiro themes, terminal font as before, Appearance page', () => {
  const { settings, clean } = parse(null);
  expect(clean).toBe(true);
  expect(settings).toMatchObject({ themeMode: 'system', themeLight: LIGHT_PICK, themeDark: DARK_PICK, themeFixed: LIGHT_PICK, termFontSize: 12, settingsPage: 'general', themesImported: [] }); // v25-fix-settings: General is the first page
  expect(settings.termFont).toBe(DEFAULTS.termFont);
  expect(DEFAULTS.termFont).toContain('SF Mono');
});

test('new fields round-trip; picks keep their resolved colours', () => {
  const s = { ...DEFAULTS, themeMode: 'fixed', themeFixed: mocha, themeDark: mocha, termFont: 'Menlo', termFontSize: 15, settingsPage: 'appearance', themesImported: [{ ...mocha, id: 'imported:Mine', name: 'Mine' }] };
  const { settings, clean } = parse(JSON.stringify(s));
  expect(clean).toBe(true);
  expect(settings).toEqual(s);
});

test('old store with theme: dark loads as fixed Nunchiro Dark; light as fixed Nunchiro Light; system stays system', () => {
  expect(parse(JSON.stringify({ theme: 'dark', density: 'spacious' }))).toMatchObject({ settings: { themeMode: 'fixed', themeFixed: DARK_PICK, density: 'spacious' }, clean: true });
  expect(parse(JSON.stringify({ theme: 'light' })).settings).toMatchObject({ themeMode: 'fixed', themeFixed: LIGHT_PICK });
  expect(parse(JSON.stringify({ theme: 'system' })).settings).toMatchObject({ themeMode: 'system' });
});

test('broken new fields fall back one by one and mark the store unclean', () => {
  const bad = (patch: Record<string, unknown>) => parse(JSON.stringify({ strip: 'off', ...patch }));
  for (const patch of [
    { themeMode: 'auto' },
    { themeLight: { ...mocha, colors: { ...mocha.colors, background: 'red;}' } } },
    { themeDark: { id: 1, name: 'x', colors: mocha.colors } },
    { themeFixed: { ...mocha, colors: { ...mocha.colors, palette: [] } } },
    { termFont: 'Menlo; } body { display: none' },
    { termFont: '' },
    { termFontSize: 9 },
    { termFontSize: 21 },
    { termFontSize: '14' },
    { settingsPage: 'secret' },
    { settingsPage: 'language' }, // the page moved into Appearance (needs 144)
    { chatWidth: 59 }, // v25-chat-calm: 60 to 160 only
    { chatWidth: 161 },
    { chatWidth: '100' },
    { themesImported: [mocha, { ...mocha, name: 3 }] },
  ]) {
    const { settings, clean } = bad(patch);
    const key = Object.keys(patch)[0] as keyof typeof DEFAULTS;
    expect(clean, key).toBe(false);
    expect(settings[key], key).toEqual(DEFAULTS[key]);
    expect(settings.strip).toBe('off');
  }
  // A broken old theme value is dropped like any other.
  expect(parse(JSON.stringify({ theme: 'sepia' }))).toMatchObject({ settings: { themeMode: 'system' }, clean: false });
});

test('picks are rebuilt from checked fields: Nunchiro ids keep their own colours, extra keys dropped, ids capped, imports unique', () => {
  const light = LIGHT_PICK.colors;
  // A Nunchiro id always means the bundled colours, whatever the store says.
  expect(parse(JSON.stringify({ themeDark: { id: 'nunchiro:dark', name: 'Evil', colors: light } })).settings.themeDark).toEqual(DARK_PICK);
  const extra = parse(JSON.stringify({ themeLight: { ...mocha, extra: 1, colors: { ...mocha.colors, extra: 2 } } })).settings.themeLight;
  expect(extra).toEqual(mocha);
  expect(parse(JSON.stringify({ themeLight: { ...mocha, id: 'x'.repeat(301) } }))).toMatchObject({ settings: { themeLight: LIGHT_PICK }, clean: false });
  const dup = { ...mocha, id: 'imported:A', name: 'A' };
  expect(parse(JSON.stringify({ themesImported: [dup, dup] }))).toMatchObject({ settings: { themesImported: [] }, clean: false });
});

test('terminal font list: quoted names must close; unquoted names, commas and spaces pass', () => {
  // needs 152 (22b7c527): the old default list `"SF Mono", Menlo, "D2Coding", monospace` reads as the new default (it names the bundled symbols face).
  for (const ok of ['"SF Mono", Menlo, "Symbols Nerd Font Mono", monospace', "'JetBrains Mono', monospace", 'Menlo', '나눔고딕코딩, monospace']) expect(parse(JSON.stringify({ termFont: ok })).settings.termFont, ok).toBe(ok);
  expect(parse(JSON.stringify({ termFont: '"SF Mono", Menlo, "D2Coding", monospace' })).settings.termFont).toBe(DEFAULTS.termFont);
  for (const bad of ['"SF Mono, Menlo', "Menlo, 'Fira", 'Me"nlo', '"A" B', 'Menlo,, monospace', '"", Menlo']) {
    expect(parse(JSON.stringify({ termFont: bad })), bad).toMatchObject({ settings: { termFont: DEFAULTS.termFont }, clean: false });
  }
});

test('an imported pick keeps a valid source URL; a bad one is refused like any broken field', () => {
  const mine = { ...mocha, id: 'imported:Mine', name: 'Mine', source: 'https://example.com/mine.conf' };
  expect(parse(JSON.stringify({ themesImported: [mine] }))).toMatchObject({ settings: { themesImported: [mine] }, clean: true });
  expect(parse(JSON.stringify({ themesImported: [{ ...mine, source: 'javascript:alert(1)' }] }))).toMatchObject({ settings: { themesImported: [] }, clean: false });
});

// V1A-62 item 9: the eight themes dropped from the bundle stay where the owner picked them, as imported themes.
test('gallery-migrate-dropped (parse): a stored catalog pick of a dropped theme becomes imported with its colours, licence and copyright', () => {
  const nord = { id: 'catalog:Nord', name: 'Nord', colors: parseGhostty('background = #2e3440\nforeground = #d8dee9\n') };
  const rose = { id: 'catalog:Rose Pine', name: 'Rose Pine', colors: parseGhostty('background = #191724\nforeground = #e0def4\n') };
  const { settings, clean } = parse(JSON.stringify({ themeDark: nord, themeFixed: rose, themeLight: rose, themeMode: 'fixed' }));
  expect(clean).toBe(true);
  const nordImported = { id: 'imported:Nord', name: 'Nord', colors: nord.colors, licence: 'MIT', source: 'https://github.com/nordtheme/iterm2', copyright: ['Copyright (c) 2016-present Sven Greb <development@svengreb.de> (https://www.svengreb.de)'] };
  const roseImported = { id: 'imported:Rose Pine', name: 'Rose Pine', colors: rose.colors, licence: 'MIT', source: 'https://github.com/rose-pine/build', copyright: ['Copyright (c) mvllow'] };
  expect(settings.themeDark).toEqual(nordImported);
  expect(settings.themeFixed).toEqual(roseImported);
  expect(settings.themeLight).toEqual(roseImported);
  // Each joins Imported once, in slot order; the applied colours are the stored ones.
  expect(settings.themesImported).toEqual([roseImported, nordImported]);
  // Kept catalog themes and an already imported copy are left as they are.
  const mine = { ...nordImported, colors: parseGhostty('background = #000000\nforeground = #ffffff\n') };
  const kept = parse(JSON.stringify({ themeLight: mocha, themeDark: nord, themesImported: [mine] })).settings;
  expect(kept.themeLight).toEqual(mocha);
  expect(kept.themeDark).toEqual({ ...nordImported });
  expect(kept.themesImported).toEqual([mine]);
  // A full Imported list keeps the migrated slot but does not grow past the cap (a longer list would be refused whole).
  const full = Array.from({ length: 200 }, (_, i) => ({ ...mocha, id: `imported:T${i}`, name: `T${i}` }));
  const capped = parse(JSON.stringify({ themeDark: nord, themesImported: full }));
  expect(capped.settings.themeDark).toEqual(nordImported);
  expect(capped.settings.themesImported).toHaveLength(200);
  expect(parse(JSON.stringify(capped.settings)).settings.themesImported).toHaveLength(200);
});

test('a stored copyright list is short strings only; anything else is refused like a broken field', () => {
  const mine = { ...mocha, id: 'imported:Mine', name: 'Mine', copyright: ['Copyright (c) 2021 Someone'] };
  expect(parse(JSON.stringify({ themesImported: [mine] }))).toMatchObject({ settings: { themesImported: [mine] }, clean: true });
  for (const copyright of ['x', [1], ['x'.repeat(301)], Array(21).fill('c')]) {
    expect(parse(JSON.stringify({ themesImported: [{ ...mine, copyright }] })), JSON.stringify(copyright).slice(0, 40)).toMatchObject({ settings: { themesImported: [] }, clean: false });
  }
});

test('hidden built-ins: a list of built-in ids; anything else falls back to none', () => {
  expect(parse(null).settings.themesHidden).toEqual([]);
  expect(parse(JSON.stringify({ themesHidden: ['catalog:Catppuccin Latte', 'nunchiro:dark'] })).settings.themesHidden).toEqual(['catalog:Catppuccin Latte', 'nunchiro:dark']);
  for (const themesHidden of ['nunchiro:dark', [3], Array(201).fill('catalog:x')]) expect(parse(JSON.stringify({ themesHidden }))).toMatchObject({ settings: { themesHidden: [] }, clean: false });
});

test('delay-range: one check for the prefix help delay, 0 to 5000 whole ms, used by the store', () => {
  for (const ok of [0, 50, 5000]) expect(isHelpDelay(ok), String(ok)).toBe(true);
  for (const bad of [-1, 5001, 2.5, '300', null, NaN]) expect(isHelpDelay(bad), String(bad)).toBe(false);
  expect(parse(JSON.stringify({ prefixHelpDelay: 5000 })).settings.prefixHelpDelay).toBe(5000);
  const broken = parse(JSON.stringify({ prefixHelpDelay: 5001 }));
  expect(broken.settings.prefixHelpDelay).toBe(DEFAULTS.prefixHelpDelay);
  expect(broken.clean).toBe(false);
});
