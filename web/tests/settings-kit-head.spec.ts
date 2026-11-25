// Settings kit, reference page (Providers): one head on every page. The scope line is an eyebrow over the title, the title
// line holds one action, what belongs to a section sits on that section's heading, and a page of rows has one column, so
// the title stays where it is from page to page. The agents are fakes in the test's bin, never a real login.
import type { Page } from '@playwright/test';
import { stripOnTop, expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

test.beforeEach(({ core }) => stripOnTop(core));

const nav = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });
async function page(app: Page, name: string) {
  await nav(app).getByRole('button', { name, exact: true }).click();
  await expect(app.locator('.settings header.phd h1')).toHaveText(name);
}
const left = (app: Page, sel: string) => app.locator(sel).first().evaluate((e) => Math.round(e.getBoundingClientRect().left));

test('kit_head: Providers has one action on its title line, Check again on Connected, and the agent list file as its last row', async ({ app }) => {
  await app.setViewportSize({ width: 1440, height: 1000 });
  await openWindow(app);
  await openSettings(app);
  await page(app, 'Providers');
  // One action beside the title.
  await expect(app.locator('.settings header.phd').getByRole('button')).toHaveText(['Add an agent']); // one name for the button and its section since d4294e012
  // Check again and its "Checked" time belong to the Connected section, named Your agents since d4294e012.
  const connected = app.locator('#s-accounts .prv-head').filter({ hasText: 'Your agents' });
  await expect(connected.getByRole('button', { name: 'Check again' })).toBeVisible();
  await expect(connected.locator('[data-field="agents-checked"]')).toHaveText(/Checked/);
  // The agent list file is the last block of the page, a row with the path and its two actions; nothing sits between the
  // lede and the first section any more.
  const blocks = app.locator('#s-accounts > .prv-sec');
  await expect(blocks.last().locator('[data-row="agentsFile"]')).toBeVisible();
  await expect(blocks.last().getByRole('button')).toHaveText(['Copy', 'Show in Finder']);
  await expect(app.locator('#s-accounts > :not(h2)').first()).toHaveClass(/prv-sec/);
});

test('kit_head: the title starts at the same place on every page of rows', async ({ app }) => {
  await app.setViewportSize({ width: 1440, height: 1000 });
  await openWindow(app);
  await openSettings(app);
  await page(app, 'General');
  const general = await left(app, '.settings header.phd h1');
  const size = (sel: string) => app.locator(sel).first().evaluate((e) => getComputedStyle(e).fontSize + ' ' + getComputedStyle(e).fontWeight);
  const sectionTitle = await size('.settings .sbody section.ssec > h2');
  for (const name of ['Providers', 'Git & worktrees', 'Appearance']) {
    await page(app, name);
    expect(await left(app, '.settings header.phd h1'), name).toBe(general);
  }
  // A section title is the same small muted title on every page.
  await page(app, 'Providers');
  expect(await size('#s-accounts .prv-head h3')).toBe(sectionTitle);
});

// Look v36 (S3-2): Usage's column started at x=642, every other page's at x=722. Usage stays 160 px wider (the hours grid
// needs it, inventory) and grows to the right only.
test('kit_head: Usage keeps its wider column and starts where every other page starts', async ({ app }) => {
  await app.setViewportSize({ width: 1440, height: 1000 });
  await openWindow(app);
  await openSettings(app);
  const column = () =>
    app.locator('.settings .spage > .sbody').evaluate((e) => {
      const s = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return { left: Math.round(r.left + parseFloat(s.paddingLeft)), width: Math.round(r.width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)) };
    });
  await page(app, 'General');
  const general = await column();
  const title = await left(app, '.settings header.phd h1');
  await page(app, 'Usage');
  await expect(app.locator('#s-usage')).toBeVisible();
  expect(await column()).toEqual({ left: general.left, width: general.width + 160 });
  expect(await left(app, '.settings header.phd h1')).toBe(title);
});

test('kit_head: the default agent row shows a reset only while it differs from Last used', async ({ app }) => {
  await openWindow(app);
  await openSettings(app);
  await page(app, 'Providers');
  const row = app.locator('[data-row="newDefaultAgent"]');
  const reset = row.getByRole('button', { name: /Reset/ });
  await expect(reset).toHaveCount(0);
  await row.getByRole('combobox').selectOption({ label: 'Claude' });
  await reset.click();
  await expect(row.getByRole('combobox')).toHaveValue('');
  await expect(reset).toHaveCount(0);
});
