// V1A-58 usability quick wins from the live-window audit: one named spec per ticket item, each red on 2edd92c's window
// before its fix (REPORT.md has the receipts). Real core per test (fixtures.ts), nothing touches ~/.nunchiro.
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { contrast } from '../src/themes/derive';
import { windowTokens } from './window-tokens';
import { DARK_PICK, LIGHT_PICK } from '../src/themes/nunchiro';
import { expect, openWindow, REPO, test, stripOnTop } from './fixtures';
import { openQuiet } from './tree-seed';

test.beforeEach(({ core }) => stripOnTop(core));

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(REPO, '.scratch/shots', `v1a58-${name}-${test.info().project.name}.png`) });
const hex = (rgb: string) => `#${rgb.match(/\d+/g)!.slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;

/** Text colour, size and the opaque surface behind every element `sel` matches, under the given theme tokens. */
const measure = (page: Page, tokens: Record<string, string>, sel: string) =>
  page.evaluate(
    ({ tokens, sel }) => {
      for (const [k, v] of Object.entries(tokens)) document.documentElement.style.setProperty(k, v);
      // Ticket 1041 lane 6: a translucent fill (a tint step, a glass layer) is laid over the first opaque one behind it, as
      // the window paints it; read alone, rgba(255 255 255 / .1) measured as white.
      const behind = (e: Element | null): string => {
        // A color-mix() fill (book-tokens.css --you-bg) computes as color(srgb r g b / a), channels 0-1.
        const rgba = (c: string) => { const v = c.match(/[\d.]+/g)!.map(Number); const k = c.startsWith('color(') ? 255 : 1; return [v[0] * k, v[1] * k, v[2] * k, v[3] ?? 1]; };
        const layers: number[][] = [];
        for (; e; e = e.parentElement) {
          const b = getComputedStyle(e).backgroundColor;
          if (/rgba\(.*, 0\)$|transparent/.test(b)) continue;
          layers.push(rgba(b));
          if (layers[layers.length - 1][3] >= 1) break;
        }
        // Under everything: the first opaque of body and html (the canvas), else white.
        const base = [document.body, document.documentElement].map((x) => rgba(getComputedStyle(x).backgroundColor)).find((c) => c[3] >= 1) ?? [255, 255, 255, 1];
        if (!layers.length || layers[layers.length - 1][3] < 1) layers.push(base);
        const out = layers.reduceRight((under, top) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1));
        return `rgb(${out.slice(0, 3).map(Math.round).join(', ')})`;
      };
      return [...document.querySelectorAll(sel)]
        .filter((e) => (e as HTMLElement).innerText.trim() && getComputedStyle(e).display !== 'none')
        .map((e) => ({ text: (e as HTMLElement).innerText.trim().slice(0, 30), fg: getComputedStyle(e).color, bg: behind(e), size: getComputedStyle(e).fontSize }));
    },
    { tokens, sel },
  );

/** Every selector's text reaches 4.5:1 in Nunchiro Light and Dark; returns the failures. */
async function lowContrast(page: Page, sels: string[]) {
  const low: string[] = [];
  for (const t of [LIGHT_PICK, DARK_PICK])
    for (const sel of sels) {
      const found = await measure(page, windowTokens(t.colors), sel);
      expect(found.length, `${sel} renders text`).toBeGreaterThan(0);
      for (const m of found) {
        const r = contrast(hex(m.fg), hex(m.bg));
        if (r < 4.5) low.push(`${t.name} ${sel} "${m.text}": ${hex(m.fg)} on ${hex(m.bg)} = ${r.toFixed(2)}:1`);
      }
    }
  return low;
}

test('diff-line-text-visible: Diff line 1 text is visible and left-aligned (chat card: chat-diff-card.spec, drag label: layout.spec)', async ({ app, core }) => {
  const dir = core.project('repo');
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a]);
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'old\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  core.shell(dir, 'edit');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'first line of the new text\n');
  await openWindow(app);
  await app.getByRole('button', { name: 'Diff', exact: true }).click();
  await app.getByRole('list', { name: 'Changed files' }).locator('[data-path="a.txt"]').click();
  const view = app.getByRole('region', { name: 'Diff of a.txt' });
  const line = view.locator('tr.add td.c').first();
  await expect(line).toContainText('first line of the new text');
  const box = await line.evaluate((td) => {
    const table = td.closest('table')!.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(td);
    const text = range.getBoundingClientRect();
    return { display: getComputedStyle(td.closest('table')!).display, align: getComputedStyle(td).textAlign, textLeft: text.left - table.left, textW: text.width, tableW: table.width };
  });
  expect(box.display).toBe('table');
  expect(['left', 'start']).toContain(box.align);
  expect(box.textW).toBeGreaterThan(0);
  // The text starts right after the two line-number columns, not centred in the row.
  expect(box.textLeft).toBeLessThan(box.tableW / 3);
  await shot(app, 'diff');
});

// V1A-60b: the empty strip draws nothing (answer-strip.spec.ts), so its text is measured with one item waiting.
test('answer-strip-contrast: strip text is 12 px at 4.5:1 in light and dark', async ({ app, core }) => {
  const asks = core.agent(core.project('demo'), 'asks', 'go');
  await openWindow(app);
  fs.writeFileSync(path.join(asks.cwd, 'go'), '');
  await expect(app.locator('#waiting-strip .qcard')).toHaveCount(1, { timeout: 15_000 });
  for (const t of [LIGHT_PICK, DARK_PICK])
    for (const m of await measure(app, windowTokens(t.colors), '.strip .sh')) expect(m.size, `${t.name} "${m.text}"`).toBe('12px');
  expect(await lowContrast(app, ['.strip .sh'])).toEqual([]);
  await shot(app, 'strip');
});

test('meta-text-contrast: strip card meta and palette meta reach 4.5:1 in light and dark', async ({ app, core }) => {
  const p = core.project('demo');
  const asks = core.agent(p, 'asks', 'go');
  await openWindow(app);
  fs.writeFileSync(path.join(asks.cwd, 'go'), '');
  await expect(app.locator('#waiting-strip .qcard')).toHaveCount(1, { timeout: 15_000 });
  const low = await lowContrast(app, ['#waiting-strip .qcard .dim']);
  await app.keyboard.press('Meta+k');
  // palette-groups: the first li is a group header (li.gh). Look 1117 v6r: a session row shows no id, so a command's row.
  const first = app.locator('.palette li[data-command]:not([data-command^="session.open."])').first();
  await first.hover();
  low.push(...(await lowContrast(app, ['.palette li:hover .id'])));
  await shot(app, 'palette-hover');
  expect(low).toEqual([]);
});

test('project-ring-count: no empty ring on a project row; a running shell counts in the head label, with no pill', async ({ app, core }) => {
  core.shell(core.project('demo'), 'running');
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  const head = app.locator('.grp[data-project="demo"] .row.head');
  await expect(head).toBeVisible();
  // The live region stays in the tree but draws nothing while empty.
  const chip = head.locator('.chip');
  await expect(chip).toHaveText('');
  const drawn = await chip.evaluate((e) => {
    const s = getComputedStyle(e);
    return { border: parseFloat(s.borderTopWidth) + parseFloat(s.borderLeftWidth), w: e.getBoundingClientRect().width };
  });
  expect(drawn.border === 0 || drawn.w === 0, `empty chip draws a ${drawn.w}px ring`).toBe(true);
  await expect(head.locator('.r')).toHaveAttribute('aria-label', /1 running/);
  // TREEROWS (needs 92) and needs 128: a head draws only the your-turn and broken pills; running lives in the label.
  await expect(head.locator('.r')).toHaveText('');
  await shot(app, 'ring');
});

test('terminal-accessible-name: the terminal input is named by session name and kind', async ({ app, core }) => {
  core.shell(core.project('demo'), 'build-box');
  await openWindow(app);
  await app.locator('.tab[data-tab]').first().click(); // D5b: the board fixture layout has no AGENTS zone
  await expect(app.getByRole('textbox', { name: 'Terminal: build-box (shell)' })).toBeAttached();
});

test('palette-hides-ids: no command id or UUID text shows in the resting palette list', async ({ app, core }) => {
  core.shell(core.project('demo'), 'a');
  await openWindow(app);
  await app.mouse.move(2, 2);
  await app.keyboard.press('Meta+k');
  const list = app.getByRole('listbox', { name: 'Commands' });
  await expect(list.locator('li').first()).toBeVisible();
  const text = await list.innerText();
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  expect(text).not.toMatch(/\b(palette\.open|settings\.open|session\.open\.)/);
});

test('ui-english-labels: no Hangul in the Artifacts widget, its gallery card or the default board columns', async ({ app, core }) => {
  core.shell(core.project('demo'), 'a');
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures/board/layout.toml'), path.join(core.home, 'layout.toml'));
  await openWindow(app);
  await app.locator('.tab[data-tab]').first().click(); // D5b: the board fixture layout has no AGENTS zone
  await expect(app.locator('.board .bch b')).toHaveCount(5);
  expect(await app.locator('.board .bch b').allInnerTexts()).toEqual(['To do', 'Working', 'Needs decision', 'Review', 'Done']);
  await app.getByRole('button', { name: 'Artifacts', exact: true }).click();
  const dock = app.getByRole('complementary', { name: 'Artifacts' });
  await expect(dock).toBeVisible();
  expect(await dock.innerText()).not.toMatch(/[ㄱ-힝]/);
  await shot(app, 'english');
  for (const name of await dock.locator('[aria-label]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!))) expect(name).not.toMatch(/[ㄱ-힝]/);
});

test('tab-font-value: Appearance shows the real 13 px tab font default', async ({ app, core }) => {
  core.shell(core.project('demo'), 'a');
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click(); // Settings opens on General (needs 149)
  // Ticket 162: a number field with steppers replaced the slider; the default is the field's heading note.
  const field = app.getByRole('spinbutton', { name: 'Tab font size' });
  await expect(field).toHaveValue('13'); // ticket 1041 lane 1 (owner 15.1 item 7): the new default
  await expect(app.locator('.srow').filter({ has: field })).toContainText('Default 13 px'); // needs 192 (ticket 250 r3): the row's description
});

test('board-header-state-agree: the board card and the session header show the same state for one shell', async ({ app, core }) => {
  core.shell(core.project('demo'), 'same');
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures/board/layout.toml'), path.join(core.home, 'layout.toml'));
  await openWindow(app);
  await app.locator('.tab[data-tab]').first().click(); // D5b: the board fixture layout has no AGENTS zone
  const header = app.locator('.shead');
  await expect(header).toContainText('same');
  const headerState = await header.locator('.st').getAttribute('data-s');
  const word = (await header.locator('.dim').first().innerText()).split(' · ').pop();
  const card = app.locator('.board .bcard').filter({ hasText: 'same' });
  await expect(card).toBeVisible();
  // Board draft B (needs 155): a session card says it is automatic and carries its state as a chip; the project is its lane.
  await expect(card.locator('.bmeta')).toHaveText(new RegExp(`^auto · session card—○ ${word}$`));
  await expect(card.locator('.st')).toHaveAttribute('data-s', headerState!);
  await expect(card).toHaveAttribute('aria-label', new RegExp(`^same, ${word}, demo`));
  await shot(app, 'board');
});
