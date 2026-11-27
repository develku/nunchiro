// fidelity-tokens (STYLE 2026-10-28): the ko/ token set in tokens.css, user themes derived onto its roles, 30px rows
// by default, the blue focus ring, the project name at full width and the Octicons icon module. Chromium and WebKit.
import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test as plain } from '@playwright/test';
import { THEMES } from '../src/themes/catalog/catalog.gen';
import { parse } from '../src/settings';
import { deriveTokens } from '../src/themes/derive';
import { parseGhostty } from '../src/themes/ghostty';
import { expect, openWindow, test, type Core } from './fixtures';
import { card, harness, openTheme } from './theme-harness';
import { openQuiet } from './tree-seed';
import { mockup } from './visual/mockups';
import { windowTokens } from './window-tokens';
import { DARK_PICK, LIGHT_PICK } from '../src/themes/nunchiro';

const SRC = path.resolve(import.meta.dirname, '../src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
const tok = (app: Page, name: string) => app.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
/** Any CSS colour as the browser's rgb() form, so #fff and #ffffff compare equal. */
const probe = (app: Page, c: string) =>
  app.evaluate((v) => {
    const d = document.createElement('i');
    d.style.color = v;
    document.body.append(d);
    const r = getComputedStyle(d).color;
    d.remove();
    return r;
  }, c);
const repo = (core: Core, name: string) => {
  const p = core.project(name);
  const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  return p;
};
const worktree = (core: Core, p: string, branch: string) => {
  const w = (core.cli('worktree', 'create', '--project', p, '--branch', branch, '--no-focus').worktrees as { path: string; branch: string }[]).find((x) => x.branch === branch)!;
  core.cli('worktree', 'open', '--path', w.path, '--label', branch, '--no-focus');
  return w.path;
};
/** A git project with one worktree session; `main` adds a session in the main folder (the head then reads "main"). */
async function tree(app: Page, core: Core, name = 'lumen', main = false) {
  const p = repo(core, name);
  worktree(core, p, 'feature-x');
  if (main) core.shell(p, 'main-shell');
  openQuiet(core, name);
  await openWindow(app);
  return { p, grp: app.locator(`.grp[data-project="${name}"]`) };
}

/** app role -> mockup variable. */
const ROLES: Record<string, string> = { '--page': '--bg', '--panel': '--pbg', '--text': '--fg', '--muted': '--mut', '--line': '--line', '--hover': '--hov', '--you': '--you', '--bad': '--bad', '--run': '--run', '--ok': '--ok', '--done': '--done' };

// The design book (book-tokens.css) replaced the hiderows-r6 values; the roles are the stylesheets' own (window-tokens.ts).
test('tokens_match_mockup: the default theme computes the design book values, light and dark; the R8 names follow', async ({ app, core }) => {
  core.shell(core.project('demo'), 'a');
  await openWindow(app);
  for (const [scheme, pick] of [['light', LIGHT_PICK], ['dark', DARK_PICK]] as const) {
    const want = windowTokens(pick.colors);
    await app.emulateMedia({ colorScheme: scheme });
    await expect(app.locator('html')).toHaveAttribute('data-theme', scheme);
    for (const role of Object.keys(ROLES)) expect(await probe(app, await tok(app, role)), `${scheme} ${role}`).toBe(await probe(app, want[role]));
    // The R8 names follow the roles, so rules that still read them paint the book's values.
    expect(await probe(app, await tok(app, '--bg'))).toBe(await probe(app, want['--panel']));
    expect(await probe(app, await tok(app, '--ink'))).toBe(await probe(app, want['--text']));
    expect(await probe(app, await tok(app, '--g3'))).toBe(await probe(app, want['--line']));
  }
});

plain('tokens_cited: every custom property in tokens.css names its ko/ mockup source or says derived:', () => {
  const lines = read('tokens.css').split('\n').filter((l) => /^\s*--[\w-]+\s*:/.test(l));
  expect(lines.length).toBeGreaterThan(40);
  const bare = lines.filter((l) => !/\/\*\s*(ko\/[\w.-]+\.html \S|derived: \S)/.test(l));
  expect(bare).toEqual([]);
});

plain('r8_values_gone: the retired R8 surface and focus hexes are out of styles.css, tree.css and tokens.css', () => {
  const r8 = /#1c1c1c|#d4d4d4|#e9e9e9|#696969|#e8590c|#1b1b1b/i;
  for (const f of ['styles.css', 'tree/tree.css', 'tokens.css', 'chat/chat.css', 'chat/problem.css']) expect(read(f).split('\n').filter((l) => r8.test(l)), f).toEqual([]);
  expect(read('chat/problem.css')).not.toContain('var(--bad,');
});

const IMPORTED = `background = #20242c\nforeground = #c8ccd4\npalette = 1=#e06c75\n`;
const PICKS = [
  { id: 'catalog:Catppuccin Latte', name: 'Catppuccin Latte', colors: parseGhostty(THEMES['Catppuccin Latte']) },
  { id: 'catalog:Catppuccin Mocha', name: 'Catppuccin Mocha', colors: parseGhostty(THEMES['Catppuccin Mocha']) },
  { id: 'imported:Mine', name: 'Mine', colors: parseGhostty(IMPORTED), source: 'https://example.invalid/mine' },
];
for (const pick of PICKS)
  test(`user_theme_maps_to_roles: ${pick.name} sets every role from the theme as written: text is the foreground, muted mixed from it and the background`, async ({ app, core }) => {
    core.shell(core.project('demo'), 'a');
    await app.addInitScript((p) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ themeMode: 'fixed', themeFixed: p })), pick);
    await openWindow(app);
    const want = deriveTokens(pick.colors);
    for (const role of ['--page', '--panel', '--raised', '--text', '--muted', '--line', '--hover', '--faint', '--you', '--you-bg', '--bad', '--run', '--ok', '--done', '--idle'])
      expect(await probe(app, await tok(app, role)), `${pick.name} ${role}`).toBe(await probe(app, want[role]));
    expect(await probe(app, await tok(app, '--panel'))).toBe(await probe(app, pick.colors.background));
    expect(await probe(app, await tok(app, '--focus-ring'))).toBe(await probe(app, want['--accent']));
    // Ticket 293 (needs 212): no contrast push on the text; D-20261108-11: muted is mixed from the theme's background and foreground.
    expect(await probe(app, await tok(app, '--text'))).toBe(await probe(app, pick.colors.foreground));
  });

const box = (l: Locator) => l.evaluate((e) => ({ h: e.getBoundingClientRect().height, r: getComputedStyle(e).borderTopLeftRadius }));
test('row_height_34_default: a fresh profile draws the design book\'s 34px session rows (was 32) with an 8px radius and 25px project heads (ko/ .proj, kept by ticket 1041); compact gives the book\'s 24px', async ({ app, core }) => {
  const { grp } = await tree(app, core);
  expect(await box(grp.locator('.row.head'))).toEqual({ h: 25, r: '8px' });
  expect(await box(grp.locator('.row.wt2'))).toEqual({ h: 34, r: '8px' });
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click(); // v25-fix-settings: Settings opens on General
  await app.getByRole('spinbutton', { name: 'Row height' }).fill('24'); // D-20261108-07: the Density presets are gone; 24 px is compact's height (design book)
  await app.keyboard.press('Escape'); // v25f: Settings is a modal over the tabs; Esc closes it first
  await app.locator('.tab:not([data-tab="settings"])').first().click(); // back to a session tab
  // 24 picks the compact preset; the tree draws the book's compact height, 24 (a hit target never under 24).
  await expect.poll(() => box(grp.locator('.row.head'))).toEqual({ h: 24, r: '8px' });
  expect((await box(grp.locator('.row.wt2'))).h).toBe(24);
});

test('density_migration: a stored compact without the explicit-choice flag (the old default saved on start) moves to comfortable once', async ({ app, core }) => {
  await app.addInitScript(() => localStorage.getItem('nunchiro.settings.v1') ?? localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ density: 'compact' })));
  const { grp } = await tree(app, core);
  expect((await box(grp.locator('.row.wt2'))).h).toBe(34); // the comfortable default, the design book's 34
  await expect.poll(() => app.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1')!))).toMatchObject({ density: 'comfortable', densityPicked: false });
});

test('density_migration: compact picked in Settings keeps 24px across a reload; a stored explicit compact survives', async ({ app, core }) => {
  const { grp } = await tree(app, core);
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click(); // v25-fix-settings: Settings opens on General
  await app.getByRole('spinbutton', { name: 'Row height' }).fill('24'); // D-20261108-07: the Density presets are gone; 24 px is compact's height (design book)
  await expect.poll(() => app.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1')!))).toMatchObject({ density: 'compact', densityPicked: true });
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect.poll(async () => (await box(grp.locator('.row.wt2'))).h).toBe(24); // the tree's compact, the design book's 24
});

plain('density_migration: parse keeps explicit picks and old non-default densities, moves the bare old default', () => {
  expect(parse(JSON.stringify({ density: 'compact' })).settings).toMatchObject({ density: 'comfortable', densityPicked: false });
  expect(parse(JSON.stringify({ density: 'compact' })).clean).toBe(true); // a migration, not a rejection
  expect(parse(JSON.stringify({ density: 'compact', densityPicked: true })).settings).toMatchObject({ density: 'compact', densityPicked: true });
  expect(parse(JSON.stringify({ density: 'spacious' })).settings).toMatchObject({ density: 'spacious', densityPicked: true });
  expect(parse(JSON.stringify({ density: 'comfortable' })).settings).toMatchObject({ density: 'comfortable', densityPicked: true });
  // A store written by this version keeps its flag as it is: the start-up save of the default is not a pick.
  expect(parse(JSON.stringify({ density: 'comfortable', densityPicked: false })).settings).toMatchObject({ density: 'comfortable', densityPicked: false });
  expect(parse(JSON.stringify({ density: 'compact', densityPicked: false })).settings).toMatchObject({ density: 'compact', densityPicked: false });
  expect(parse('{}').settings).toMatchObject({ density: 'comfortable', densityPicked: false });
});

test('focus_ring_blue: a tree row and its head button show --ring-focus, the design book --accent ring (was neutral, ticket 1041 lane 4), a Settings input the same 2px ring, light and dark', async ({ app, core, browserName }) => {
  const { grp } = await tree(app, core);
  const ring = (l: Locator) =>
    l.evaluate((e) => {
      const s = getComputedStyle(e);
      return { shadow: s.boxShadow, outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}` };
    });
  // A key press first, so programmatic focus counts as focus-visible. WebKit needs a real key: after a pointer click (the
  // session tab at the end of the light pass) a modifier-only Shift leaves it in pointer mode, so the dark pass saw no ring
  // (red 3/3 on 3a25d31c); Tab moves focus, then focus() puts it back. A live tree re-render can take focus away, so
  // focusing and reading the ring repeat together until they agree.
  const focused = (l: Locator, part: 'shadow' | 'outline') =>
    expect.poll(async () => {
      if (browserName === 'webkit') await l.evaluate((e) => (e as HTMLElement).blur());
      await app.keyboard.press(browserName === 'webkit' ? 'Tab' : 'Shift');
      await l.focus();
      return (await ring(l))[part];
    });
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    await expect(app.locator('html')).toHaveAttribute('data-theme', scheme);
    const run = await probe(app, await tok(app, '--run'));
    expect(run).not.toBe(await probe(app, await tok(app, '--text')));
    // The design book: the focus ring is --accent (the neutral ring of ticket 1041 lane 4 is replaced).
    const neutral = await probe(app, await tok(app, '--ring-focus'));
    expect(neutral).toBe(await probe(app, await tok(app, '--accent')));
    await focused(grp.locator('.row.wt2'), 'shadow').toContain(`${neutral} 0px 0px 0px 2px inset`);
    await focused(grp.locator('.row.head button.n'), 'outline').toBe(`solid 2px ${neutral}`);
    await app.getByRole('button', { name: 'Settings', exact: true }).click();
    // Ticket 1041 lane 8 (owner 15.1 item 1): Settings' controls are neutral too; its ring is --ring-focus, not blue.
    await focused(app.getByRole('searchbox', { name: 'Search settings' }), 'outline').toBe(`solid 2px ${neutral}`);
    await app.keyboard.press('Escape');
    await app.locator('.tab:not([data-tab="settings"])').first().click(); // back to a session tab
  }
});

test('project_name_not_truncated: "nunchiro" with counts and main shows in full at 256px; + stays reachable by hover and keyboard', async ({ app, core, browserName }) => {
  const { grp } = await tree(app, core, 'nunchiro', true);
  expect(await app.locator('.tree').evaluate((e) => Math.round(e.getBoundingClientRect().width))).toBeLessThanOrEqual(256);
  const name = grp.locator('.row.head button.n');
  await expect(name).toContainText('nunchiro');
  await expect(grp.locator('.row.head > .d')).toHaveText('main');
  const cut = () => name.evaluate((e) => e.scrollWidth > e.clientWidth);
  expect(await cut()).toBe(false);
  const add = grp.getByRole('button', { name: 'New worktree in nunchiro' });
  await expect(add).toBeHidden();
  await grp.locator('.row.head').hover();
  await expect(add).toBeVisible();
  expect(await cut()).toBe(false); // the buttons overlay the row; the name keeps its width
  await app.mouse.move(900, 600);
  await name.focus();
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab'; // WebKit's Tab skips buttons ("Tab to links" off)
  // Ticket 388 (2aa2ef4f): the head's colour bar (one bar: main-shell) is the stop after the name.
  await app.keyboard.press(tab);
  await expect(grp.locator('.row.head button.sg')).toBeFocused();
  // TREEHEAD (c) d1eef683: Open in editor and Set icon sit in the flow before "+", so New worktree is the fourth stop after the bar.
  for (const stop of ['Open in editor', 'Set icon', 'New session in nunchiro']) {
    await app.keyboard.press(tab);
    await expect(grp.locator('.row.head').getByRole('button', { name: stop, exact: true })).toBeFocused();
  }
  await app.keyboard.press(tab);
  await expect(add).toBeFocused();
  await expect(add).toBeVisible();
});

// ---- icons. Every control whose glyph moved to the icon module, with the file it lives in.
const INLINE_SVG = '<svg className="bglyph"';
const SWAPPED: [string, string, string][] = [
  ['tree/DecisionLine.tsx', 'choose', 'triangle-down'],
  ['picker/Picker.tsx', 'model and effort chips', 'triangle-down'],
  ['files/FilesTree.tsx', 'folder chevron', "open.has(r.path) ? 'chevron-down' : 'chevron-right'"],
  // 9fba8e77 (ticket 186, Board draft B): the header draws the mockup's own board glyph as inline svg, not an Octicon.
  ['board/Board.tsx', 'Board header', INLINE_SVG],
  ['tree/Tidy.tsx', 'Resolve', 'triangle-down'],
  // Keyboard page A (f34bb5cf, needs 166) replaced the "N commands without a key" fold with filter chips; the row's Change
  // button is the page's icon control now.
  ['settings/keys/KeysPage.tsx', 'Change (row edit)', 'pencil'],
  ['chat/Rows.tsx', 'tool row toggle', "on ? 'chevron-down' : 'chevron-right'"],
  ['settings/alerts/AlertsPage.tsx', 'Preview the sound', 'triangle-right'],
  // fid-64 d9718dc9: the head and group chevrons follow the fold state (`folded`), not `collapsed`.
  ['Sidebar.tsx', 'project, group and Other projects chevrons; AGENTS Stop', "folded ? 'chevron-right' : 'chevron-down'"],
];
const GLYPHS = /[☰▤⌕⚙◧±▶▦⊞■▾▸]/;
plain('icons_svg_not_glyphs: each swapped control draws an Octicon from the icon module, no glyph left in its file', () => {
  for (const [file, control, icon] of SWAPPED) {
    const src = read(file);
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l) && !/^\s*\{\/\*.*\*\/\}\s*$/.test(l));
    expect(code.filter((l) => GLYPHS.test(l)), `${file} (${control})`).toEqual([]);
    if (icon === INLINE_SVG) {
      expect(src, `${file} (${control})`).toContain(INLINE_SVG);
      continue;
    }
    expect(src, `${file} (${control})`).toContain(`<Icon name=${icon.includes('?') ? `{${icon}}` : `"${icon}"`}`);
    expect(src).toMatch(/import \{ Icon \} from '(\.\.\/)*\.?\.?\/?icons\/Icon';/);
  }
});

test('icons_svg_not_glyphs: live controls render the svg and keep their names (Files, Board, Keys, Alerts)', async ({ app, core }) => {
  const dir = core.project('files');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'a');
  core.shell(dir, 'a');
  await openWindow(app);
  const noGlyph = (l: Locator) => expect(l).not.toHaveText(GLYPHS);
  // Files: the folder row's chevron.
  await app.getByRole('button', { name: 'Files', exact: true }).click();
  const folder = app.getByRole('treeitem', { name: /src/ }).first();
  await expect(folder.locator('svg[data-icon="chevron-right"]')).toHaveCount(1);
  await noGlyph(folder);
  await app.getByRole('button', { name: 'Files', exact: true }).click();
  // Board header.
  const icon = app.getByRole('button', { name: /^Board( · |$)/ });
  if ((await app.locator('.board').count()) === 0) await icon.click();
  const head = app.locator('.board .bhead');
  // Board draft B (86f92246, 9fba8e77 ticket 186): the cards header names the Board with no icon; the one-line list draws
  // the board glyph as its own inline svg. No text glyph in either.
  await expect(head).toContainText('Board');
  await noGlyph(head);
  await app.getByRole('button', { name: 'Edit board widget' }).click();
  await app.getByRole('group', { name: 'Show as' }).getByRole('button', { name: 'one-line list' }).click();
  await expect(head.locator('svg.bglyph')).toHaveCount(1);
  await expect(head).toContainText('Board');
  await noGlyph(head);
  // Settings > Keys: a row's Change button (the unbound fold left with Keyboard page A, f34bb5cf); Settings > Alerts: the sound preview.
  await app.keyboard.press('Meta+Comma');
  const nav = app.getByRole('navigation', { name: 'Settings pages' });
  await nav.getByRole('button', { name: 'Keyboard' }).click();
  const change = app.locator('tr[data-command] button.kedit').first();
  await expect(change.locator('svg[data-icon="pencil"]')).toHaveCount(1);
  await noGlyph(change);
  await nav.getByRole('button', { name: 'Notifications' }).click();
  const play = app.getByRole('button', { name: 'Preview the done sound' });
  await expect(play.locator('svg[data-icon="triangle-right"]')).toHaveCount(1);
  await noGlyph(play);
});

plain('icon_licence_notice: the icon module carries the MIT text, source and pin; THIRD_PARTY_NOTICES.md has its row', () => {
  const head = read('icons/Icon.tsx');
  expect(head).toContain('https://github.com/primer/octicons');
  expect(head).toContain('9a274e212ee25c400ff666ce25a57866b7eacc25');
  expect(head).toContain('MIT License, Copyright (c) 2026 GitHub Inc.');
  expect(head).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
  expect(head).toContain('The above copyright notice and this permission notice shall be included in all copies or substantial portions of');
  const notices = fs.readFileSync(path.join(SRC, '../../THIRD_PARTY_NOTICES.md'), 'utf8');
  expect(notices).toMatch(/\| `web\/src\/icons\/Icon\.tsx`.*primer\/octicons.*9a274e212ee25c400ff666ce25a57866b7eacc25.*MIT/);
});

const axe = async (app: Page, sel: string) => {
  // needs 212 (themes as written) + ticket 250 r3: a theme card's preview shows that theme's own palette (incidental text,
  // WCAG 1.4.3), now in view on the compact Appearance page; the rest of Settings is still checked.
  const r = await new AxeBuilder({ page: app }).include(sel).exclude('.tw').analyze();
  return r.violations.map((v) => `${sel} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
};
test('axe_clean: the tree, Settings > Appearance and the Tidy panel, light and dark', async ({ app, core }) => {
  const { grp } = await tree(app, core);
  const found: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    await expect(app.locator('html')).toHaveAttribute('data-theme', scheme);
    found.push(...(await axe(app, '.tree')));
    await app.keyboard.press('Meta+Comma');
    await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click();
    await expect(app.getByRole('spinbutton', { name: 'Row height' })).toBeVisible();
    found.push(...(await axe(app, '.settings')));
    await app.keyboard.press('Escape');
    await app.locator('.tab:not([data-tab="settings"])').first().click(); // back to a session tab
    await grp.locator('button.n').click({ button: 'right' });
    await app.getByRole('menuitem', { name: /Tidy worktrees…/ }).click();
    const panel = app.getByRole('dialog', { name: /^Tidy/ });
    await expect(panel).toBeVisible();
    found.push(...(await axe(app, '[role=dialog][aria-label^="Tidy"]')));
    await app.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  }
  expect(found).toEqual([]);
});

test('theme_cards_show_their_own_colours: each gallery card paints its own theme, not the window', async ({ app, core }) => {
  core.shell(core.project('demo'), 'a');
  await harness(app, [], () => {
    throw new Error('no theme file in this spec');
  });
  await openWindow(app);
  await openTheme(app);
  const names = ['Nunchiro Light', 'Nunchiro Dark', 'Catppuccin Latte', 'Catppuccin Mocha'];
  const look = (name: string) =>
    card(app, name).locator('.tw').evaluate((e) => {
      const side = e.querySelector('.tside')!;
      const tab = e.querySelector('.ttab')!;
      return [getComputedStyle(e).backgroundColor, getComputedStyle(side).backgroundColor, getComputedStyle(side.firstElementChild!).color, getComputedStyle(tab).color].join(' / ');
    });
  const seen = await Promise.all(names.map(look));
  expect(new Set(seen).size, seen.join('\n')).toBe(names.length);
  for (const [i, name] of names.entries()) {
    const c = name.startsWith('Nunchiro') ? (name.endsWith('Dark') ? '#1b1e21' : '#fafaf9') : parseGhostty(THEMES[name]).background;
    expect(seen[i].split(' / ')[0], name).toBe(await probe(app, c));
  }
});

plain('visual_gate_fails_closed: every mockup the gate crops is in the repo, a missing one throws, and no case is an expected failure', () => {
  expect(() => mockup('not-a-mockup.html')).toThrow(/missing/);
  const spec = fs.readFileSync(path.join(import.meta.dirname, 'visual-conformance.spec.ts'), 'utf8');
  expect(spec).not.toMatch(/test\.fail|test\.fixme/);
  const used = new Set([...spec.matchAll(/'([\w.-]+\.html)'/g)].map((m) => m[1]));
  // Ticket 1041 lane 4: the tree's v2-8a crops are retired (the tree follows docs/design/polish-1121); the whole-pane measure and the sub-view stay.
  expect([...used].sort()).toEqual(['hiderows-r6.html', 'layout-d5b.html']);
  for (const f of used) expect(fs.existsSync(mockup(f))).toBe(true);
});
