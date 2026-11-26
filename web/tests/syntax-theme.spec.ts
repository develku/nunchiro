// Ticket 482 (owner 2026-11-12): syntax colours follow the window's theme. In the Diff pane and the Files viewer every
// coloured span is `var(--syn-<role>)`, and reads at 4.5:1 or more on what is behind it (the panel, or an added or removed
// line's tint), for the two Nunchiro themes and catalog/imported themes. SHOTS_DIR=<dir> also saves a shot per theme.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { THEMES } from '../src/themes/catalog/catalog.gen';
import { parseGhostty } from '../src/themes/ghostty';
import { DARK_PICK, LIGHT_PICK, type ThemePick } from '../src/themes/nunchiro';
import { expect, test } from './fixtures';
import { ChatCore, openChat, test as chatTest } from './fixtures/chat/harness';
import { openFile, setup as filesSetup } from './fixtures/files/harness';

const DRACULA = parseGhostty(`background = #282a36
foreground = #f8f8f2
palette = 1=#ff5555
palette = 2=#50fa7b
palette = 3=#f1fa8c
palette = 4=#bd93f9
palette = 5=#ff79c6
palette = 6=#8be9fd
`);
const PICKS: ThemePick[] = [
  LIGHT_PICK,
  DARK_PICK,
  { id: 'catalog:Catppuccin Latte', name: 'Catppuccin Latte', colors: parseGhostty(THEMES['Catppuccin Latte']) },
  { id: 'catalog:Catppuccin Mocha', name: 'Catppuccin Mocha', colors: parseGhostty(THEMES['Catppuccin Mocha']) },
  { id: 'imported:Dracula', name: 'Dracula', colors: DRACULA },
];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const shotsDir = process.env.SHOTS_DIR;
async function shot(target: Locator, name: string) {
  if (!shotsDir) return;
  fs.mkdirSync(shotsDir, { recursive: true });
  await target.screenshot({ path: path.join(shotsDir, `${name}-${test.info().project.name}.png`), animations: 'disabled' });
}
const usePick = (page: Page, p: ThemePick) => page.addInitScript((p) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ themeMode: 'fixed', themeFixed: p })), p);

/** Each `.sh` span inside `root`: its inline colour and its contrast on the first opaque background behind it. */
const measure = (root: Locator) =>
  root.evaluate((r) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([a, b, c]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(a) + 0.7152 * f(b) + 0.0722 * f(c);
    };
    const bg = (e: Element | null): string => {
      for (; e; e = e.parentElement) {
        const c = getComputedStyle(e).backgroundColor;
        if (c && c !== 'transparent' && (rgb(c)[3] ?? 1) > 0.5) return c;
      }
      return 'rgb(255, 255, 255)';
    };
    return [...r.querySelectorAll<HTMLElement>('.sh')].map((e) => {
      const [x, y] = [lum(rgb(getComputedStyle(e).color)), lum(rgb(bg(e)))];
      return { style: e.style.color, text: e.textContent, ratio: (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) };
    });
  });
function readable(spans: { style: string; text: string | null; ratio: number }[]) {
  expect(spans.length).toBeGreaterThan(3);
  for (const s of spans) {
    expect.soft(s.style, `"${s.text}"`).toMatch(/^var\(--syn-(keyword|string|func|const|type|comment|punct)\)$/);
    expect.soft(s.ratio, `"${s.text}" ${s.style}`).toBeGreaterThanOrEqual(4.5);
  }
}

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'gc.auto=0', ...args], { encoding: 'utf8' });
const BEFORE = `// The row heights.\nexport const row = 22;\nexport function size(name: string): number {\n  return name.length;\n}\n`;
const AFTER = `// The row heights, by density.\nexport const row = 30;\nexport class Density {\n  compact: boolean = false;\n}\nexport function size(name: string): number {\n  return name.length + 1; // one more\n}\n`;
function session(core: ChatCore) {
  const dir = core.project('demo');
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'size.ts'), BEFORE);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  const s = core.chat('demo');
  fs.writeFileSync(path.join(dir, 'size.ts'), AFTER);
  return s;
}

for (const pick of PICKS)
  chatTest(`diff_syntax_follows_theme: ${pick.name}`, async ({ page, chatCore }) => {
    await usePick(page, pick);
    const s = session(chatCore);
    await openChat(page, s.id);
    await page.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Diff', exact: true }).click();
    const sec = page.getByRole('complementary', { name: 'Diff' }).getByRole('region', { name: 'Diff of size.ts' });
    // The first highlight loads the highlighter and the grammar: seconds on a cold, slow WebKit runner.
    await expect(sec.locator('tr.add .sh').first()).toBeVisible({ timeout: 15_000 });
    await expect(sec.locator('tr.del .sh').first()).toBeVisible();
    await shot(page.getByRole('complementary', { name: 'Diff' }), `diff-${slug(pick.name)}`);
    readable(await measure(sec));
  });

const MARKUP = '<?xml version="1.0"?>\n<!-- sample markup -->\n<page lang="en">\n  <title id="t">Hello &amp; welcome</title>\n  <item n="1"/>\n</page>\n';
for (const pick of PICKS)
  test(`files_syntax_follows_theme: ${pick.name}`, async ({ app, core }) => {
    await usePick(app, pick);
    await filesSetup(app, core, { extra: (dir) => fs.writeFileSync(path.join(dir, 'page.xml'), MARKUP) });
    for (const f of ['hello.ts', 'page.xml']) {
      await openFile(app, f);
      const code = app.locator(`.fview[data-file="${f}"] .fv-code`);
      await expect(code.locator('.sh').first()).toBeVisible();
      await shot(app.locator(`.fview[data-file="${f}"]`), `files-${f.replace('.', '-')}-${slug(pick.name)}`);
      readable(await measure(code));
    }
  });
