// Ticket 528: lines that stayed English. A paired browser in Korean (its own browser language: the core does not carry
// the window's setting) shows no English; the window in Korean shows the drag preview's captions and the artifact
// card's problem lines in Korean.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { english } from './fixtures/ui-scan';
import { test, expect } from './fixtures';
import { append, chat, rec, test as chatTest } from './fixtures/chat/harness';
import { showFrame } from './fixtures/artifacts/cards/host';
import { at, card, drag } from './d5b';
import { enable, freePort } from './web-access-shared';
import { ko as pf } from '../src/i18n/areas/rest-pair-files';
import { ko as left } from '../src/i18n/areas/english-leftovers';
import { ko as common } from '../src/i18n/areas/common';
import { ko as shell } from '../src/i18n/areas/shell';

/** The window in Korean, connected to the core (the harness's own wait reads the English status). */
async function korean(page: Page) {
  await page.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: 'ko' })));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(page.getByRole('status').filter({ hasText: new RegExp(`^${common['chrome.connected']}$`) })).toBeVisible();
}

test('paired_browser_page_in_korean_528: the pairing page and the paired page follow the browser language', async ({ app, browser }) => {
  const port = await freePort();
  await enable(app, port);
  const context = await browser.newContext({ locale: 'ko-KR' });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await expect(page.getByRole('heading', { name: pf['rest.pf.pair.title'] })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  const bad: string[] = (await english(page)).map((w) => `pairing: ${w}`);
  await page.getByRole('button', { name: pf['rest.pf.pair.pair'] }).click();
  const code = (await page.locator('[data-pair-code]').innerText()).trim();
  bad.push(...(await english(page)).map((w) => `waiting: ${w}`));
  const sheet = app.getByRole('dialog', { name: 'Browser pairing request' });
  await expect(sheet).toContainText(code);
  await sheet.getByRole('button', { name: 'Allow' }).click();
  await expect(page.getByRole('status').filter({ hasText: new RegExp(`^${pf['rest.pf.browser.connected']}$`) })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('heading', { name: pf['rest.pf.browser.sessions'] })).toBeVisible();
  bad.push(...(await english(page)).map((w) => `paired: ${w}`));
  expect(bad).toEqual([]);
  await context.close();
});

chatTest('drag_captions_in_korean_528: the drop preview names the result in Korean', async ({ page, chatCore }) => {
  chatCore.chat('demo');
  await korean(page);
  await page.locator('nav[data-bar="right"] .lay').click();
  await expect(page.locator('.estrip')).toBeVisible();
  await expect(page.locator('.lib')).not.toHaveAttribute('aria-busy', 'true');
  const dropl = page.locator('.dropl');
  // The zone is named as its header names it (the following terminal zone says Chat), never by its layout.toml id.
  const words = async (where: string) => (await english(page)).map((w) => `${where}: ${w}`);
  const bad: string[] = [];
  await drag(page, card(page, 'files'), await at(page, 'terminal', 0.92, 0.5), { release: false });
  await expect(dropl).toContainText(left['leftovers.drag.cap.right']);
  await expect(dropl).toContainText(left['leftovers.drag.split.right'].replace('{zone}', shell['shell.zone.chat']));
  bad.push(...(await words('split right')));
  await page.mouse.move(...(Object.values(await at(page, 'terminal', 0.5, 0.92)) as [number, number]), { steps: 4 });
  await expect(dropl).toContainText(left['leftovers.drag.cap.down']);
  bad.push(...(await words('split below')));
  await page.mouse.move(...(Object.values(await at(page, 'terminal', 0.5, 0.5)) as [number, number]), { steps: 4 });
  await expect(dropl).toContainText(left['leftovers.drag.cap.centre']);
  bad.push(...(await words('add as tab')));
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(bad).toEqual([]);
});

chatTest('artifact_card_problems_in_korean_528: a missing file and one outside the folder', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  const outside = path.join(chatCore.home, 'o.html');
  const gone = path.join(s.cwd, 'never-there.html');
  const write = (id: string, full: string) => [
    rec.use(id, 'Write', { file_path: full, content: '<p>x</p>' }),
    rec.result(id, `File created successfully at: ${full}`, { toolUseResult: { type: 'create', filePath: full, content: '<p>x</p>', structuredPatch: [] } }),
  ];
  append(s.file, write('k1', outside), write('k2', gone));
  await korean(page);
  await page.locator(`.tab[data-tab="${s.id}"]`).click();
  await expect(chat(page, s.id).locator('.clist')).toHaveAttribute('aria-busy', 'false');
  for (const [full, why] of [[outside, 'outside'], [gone, 'missing']] as const) {
    const c = chat(page, s.id).locator(`.acard[data-path="${full === gone ? 'never-there.html' : full}"]`);
    await showFrame(c);
    await expect(c.locator('.astate')).toHaveText(left[`leftovers.card.${why}`]);
    await expect(c.locator('.abody')).toHaveText(left[`leftovers.card.text.${why}`]);
  }
});
