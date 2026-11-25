// fidelity-residue (STYLE 2026-10-28, ticket 63): rules read token roles, glyphs are Octicons from the icon module,
// scales replace equal literals. Source greps run without a browser; the glyph checks open the window at 1440x900.
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { Icon } from '../src/layout/icons';
import { PATHS } from '../src/icons/Icon';
import { ENTRIES } from '../src/layout/registry';
import { expect, openWindow, test } from './fixtures';
import { bar, card, endEdit, icon, lib, sidebar, startEdit } from './d5b';

const SRC = path.resolve(import.meta.dirname, '../src');
// App.tsx and the modules needs 183 (APPSPLIT) split out of it: the glyph scan reads them all.
const APP_SPLIT = ['App.tsx', 'chrome/commands.ts', 'chrome/useGlobalKeys.ts', 'chrome/useTabs.ts', 'chrome/CentreView.tsx', 'chrome/StatusBar.tsx', 'chrome/useCoreLink.ts', 'layout/useRails.tsx', 'layout/usePaneMode.ts', 'split/useSplitGlue.ts', 'chat/useComposerSend.ts', 'chat/ComposerWidget.tsx', 'chat/useSideChats.ts', 'settings/useAppSettings.ts', 'settings/lifetime/useLifetime.ts', 'tree/useSessionStart.ts', 'decisions/useDecisionJump.ts', 'board/useBoardRail.ts'];
const walk = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const sources = walk(SRC).filter((f) => /\.(css|tsx?)$/.test(f) && !f.endsWith('catalog.gen.ts'));
const rel = (f: string) => path.relative(SRC, f);

/** Strict-layer stylesheets (grandfathered: their alias reads stay) and the lanes whose files this one does not edit. */
const NOT_OURS = [/^queue\//, /^approval\//, /^widgets\//, /^webwidgets\//, /^sandbox\//, /^artifacts-widget\//, /^pane\//, /^split\//, /^decisions\//, /^undo\//, /^tokens\.css$/];
const ours = sources.filter((f) => !NOT_OURS.some((re) => re.test(rel(f))));

const ALIASES = ['bg', 'g0', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'ink', 'icon', 'focus', 'signal', 'signal-text', 'signal-soft', 'mark-bg', 'mark-ink', 'hover-key', 'term-bg', 'youbg', 'onpill', 'pbg', 'fg', 'mut', 'hov'];
const READ = new RegExp(`var\\(\\s*--(${ALIASES.join('|')})\\s*[,)]`, 'g');

test('r8_names_unread: no rule reads an R8 or mockup-name alias outside the grandfathered stylesheets', () => {
  const left: string[] = [];
  for (const f of ours) for (const m of fs.readFileSync(f, 'utf8').matchAll(READ)) left.push(`${rel(f)}: ${m[0]}`);
  expect(left.slice(0, 20), `${left.length} reads left`).toEqual([]);
  // The mockup-name block at the top of styles.css is gone.
  expect(fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')).not.toMatch(/^\s*--(pbg|fg|mut|hov)\s*:/m);
});

test('r8_names_unread: an alias defined in tokens.css has a reader somewhere', () => {
  const tokens = fs.readFileSync(path.join(SRC, 'tokens.css'), 'utf8');
  // web/tests/visual/r8-map.ts copies the app's computed value of each R8 name into the R8 drafts, so it reads them by name.
  const all = sources.filter((f) => rel(f) !== 'tokens.css').map((f) => fs.readFileSync(f, 'utf8')).join('\n') + fs.readFileSync(path.join(SRC, '../tests/visual/r8-map.ts'), 'utf8');
  const dead = ALIASES.filter((a) => new RegExp(`^\\s*--${a}\\s*:`, 'm').test(tokens) && !new RegExp(`var\\(\\s*--${a}\\s*[,)]|'--${a}'`).test(all));
  expect(dead, 'aliases defined in tokens.css with no read left').toEqual([]);
});

test('scales_used_where_equal: no scale-equal font size or radius literal in the files this lane owns', () => {
  const left: string[] = [];
  for (const f of ours) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/font-size:\s*(11|12|13|14|16)px\b/.test(line) || /border-radius:\s*[^;]*\b(4|6|8|10)px\b/.test(line) || /0 6px 24px #0004/.test(line)) left.push(`${rel(f)}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(left.slice(0, 20), `${left.length} literals left`).toEqual([]);
});

const KINDS: Record<string, string> = {
  tree: 'git-branch', files: 'file-directory', search: 'search', diff: 'diff', preview: 'browser', board: 'project', artifacts: 'package',
  terminal: 'terminal', composer: 'pencil', waiting: 'list-unordered', layout: 'apps', settings: 'gear', '': 'code', 'no-such-user-widget': 'code',
};
test('layout_icons_from_module: every kind renders its mapped Octicon and an unknown widget renders code', () => {
  for (const [kind, name] of Object.entries(KINDS)) {
    const html = renderToStaticMarkup(createElement(Icon, { kind }));
    expect(html, kind).toContain(`data-icon="${name}"`);
    expect(html, kind).toContain(PATHS[name as keyof typeof PATHS]);
  }
  // The Decisions widget keeps the hand mark of the tree's status icon: Octicons has no hand.
  expect(renderToStaticMarkup(createElement(Icon, { kind: 'decisions' }))).toContain('data-icon="hand"');
});

const BANNED = /[☰▤⌕⚙◧±▶▦⊞■▾▸✕]/;
const textOf = (l: import('@playwright/test').Locator) => l.evaluateAll((els) => els.map((e) => e.textContent ?? '').join('|'));

test('glyphs_replaced_by_octicons: bars, sidebar headers, edit mode and the library hold no text glyph', async ({ app }) => {
  await openWindow(app);
  // The palette hint in the title bar.
  const cmd = app.getByRole('button', { name: 'Open command palette' });
  expect(await textOf(cmd)).not.toMatch(BANNED);
  await expect(cmd.locator('svg[data-icon="search"]')).toHaveCount(1);
  // Icon bars and the Layout and Settings buttons: every icon is an svg of the module and keeps its accessible name.
  for (const side of ['left', 'right'] as const) {
    const buttons = bar(app, side).locator('button.ai');
    expect(await textOf(buttons)).not.toMatch(BANNED);
    for (const b of await buttons.all()) {
      await expect(b.locator('svg[data-icon]')).toHaveCount(1);
      expect(await b.getAttribute('aria-label')).toBeTruthy();
    }
  }
  await expect(app.getByRole('button', { name: 'Layout' }).locator('svg[data-icon="apps"]')).toHaveCount(1);
  await expect(app.getByRole('button', { name: 'Settings' }).locator('svg[data-icon="gear"]')).toHaveCount(1);
  // Sidebar headers: Files, then Diff (the ± title).
  await icon(app, 'left', 'Files').click();
  await icon(app, 'right', 'Diff').click();
  for (const side of ['left', 'right'] as const) {
    const head = sidebar(app, side).locator('.sbh');
    expect(await textOf(head)).not.toMatch(BANNED);
    await expect(head.locator('svg[data-icon]').first()).toBeVisible();
  }
  const diffTitle = app.getByRole('complementary', { name: 'Diff' }).locator('.ph');
  if (await diffTitle.count()) {
    expect(await textOf(diffTitle)).not.toMatch(BANNED);
    await expect(diffTitle.locator('svg[data-icon="diff"]')).toHaveCount(1);
  }
  // Edit mode: close buttons are x, the library cards and their previews carry module icons.
  await startEdit(app);
  expect(await textOf(app.locator('.rx, [aria-label^="Remove"]'))).not.toMatch(BANNED);
  await expect(app.locator('.rx svg[data-icon="x"]').first()).toBeVisible();
  const library = lib(app);
  expect(await textOf(library)).not.toMatch(BANNED);
  for (const e of ENTRIES) {
    const c = card(app, e.kind);
    if (await c.count()) await expect(c.locator('svg[data-icon]').first()).toBeVisible();
  }
  expect(await textOf(app.locator('[aria-label^="Remove"]'))).not.toMatch(BANNED);
  await endEdit(app);
});

test('glyphs_replaced_by_octicons: the appearance font picker caret is a chevron', async ({ app }) => {
  await openWindow(app);
  await icon(app, 'left', 'Settings').click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Terminal', exact: true }).click(); // needs 192: the font is on Terminal
  const picker = app.locator('button[aria-haspopup="listbox"]').filter({ has: app.locator('span[style*="font-family"]') }).first();
  await expect(picker).toBeVisible();
  expect(await textOf(picker)).not.toMatch(BANNED);
  await expect(picker.locator('svg[data-icon="chevron-down"]')).toHaveCount(1);
});

test('glyphs_replaced_by_octicons: the new-session target line and the palette hint draw module icons', () => {
  // The target chip is checked on the rendered page (fidelity-chip.spec.ts). The session tab strip (the `⚙ Settings` tab name and the `▤` file-tab
  // marker) and the footer belong to ticket 62 and keep their glyphs.
  const app = APP_SPLIT.flatMap((f) => fs.readFileSync(path.join(SRC, f), 'utf8').split('\n')).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).map((l) => l.replace(/\s\/\/ .*$/, ''));
  const left = app.filter((l) => BANNED.test(l) && !/SETTINGS_TAB \? '⚙ Settings'|className="tfile"/.test(l));
  expect(left).toEqual([]);
});

test('axe_clean: rail, both bars with a sidebar open, edit mode with the library, Settings > Appearance, light and dark', async ({ app }) => {
  await openWindow(app);
  const found: string[] = [];
  const axe = async (what: string, include: string[]) => {
    // needs 212 (themes as written) + ticket 250 r3: a theme card's preview shows that theme's own palette (incidental text,
    // WCAG 1.4.3), now in view on the compact Appearance page; the rest of Settings is still checked.
    const r = await new AxeBuilder({ page: app }).include(include).exclude('.tw').analyze();
    found.push(...r.violations.map((v) => `${what}: ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`));
  };
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    await expect(app.locator('html')).toHaveAttribute('data-theme', scheme);
    await icon(app, 'left', 'Files').click();
    await icon(app, 'right', 'Diff').click();
    await axe(`${scheme} bars and sidebars`, ['nav.ib', 'aside.sbar']);
    await icon(app, 'left', 'Files').click();
    await icon(app, 'right', 'Diff').click();
    await startEdit(app);
    await axe(`${scheme} edit mode with library`, ['nav.ib', '.lib']);
    await endEdit(app);
    await icon(app, 'left', 'Settings').click();
    await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click();
    await expect(app.getByRole('spinbutton', { name: 'Row height' })).toBeVisible();
    await axe(`${scheme} Appearance`, ['.settings']);
    await app.keyboard.press('Escape'); // v25f: the modal covers the rail
  }
  expect(found).toEqual([]);
});
