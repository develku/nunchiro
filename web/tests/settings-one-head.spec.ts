// One head per Settings page (the scorecard's design check): every page in the Settings nav, built-in and registered,
// draws exactly one head (`header.phd`) with exactly one title, the page's own name. On a built-in page the title and the
// description are the ones its label table names, and focus follows the page to the title. English only: the Korean
// lines used to be compared with a mockup that is not part of this repository.
import type { Page } from '@playwright/test';
import { BUILTIN_PAGES } from '../src/features/builtin';
import { en as common } from '../src/i18n/areas/common';
import { en as settingsArea } from '../src/i18n/areas/settings';
import { expect, openWindow, stripOnTop, test } from './fixtures';
import { openSettings } from './settings-modal';

const LABELS: Record<string, string> = { ...common, ...settingsArea };

test.beforeEach(({ core }) => stripOnTop(core));

const nav = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });
const button = (app: Page, id: string) => nav(app).locator(`button[data-page="${id}"]`);

test('settings_one_head: every Settings page has exactly one head, with its own title', async ({ app, core }) => {
  test.setTimeout(90_000);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openSettings(app);
  const pages = await nav(app)
    .locator('button[data-page]')
    .evaluateAll((all) => all.map((b) => [(b as HTMLElement).dataset.page!, b.textContent!.trim()]));
  // Every built-in page is walked, and the registered ones with them.
  expect(pages.map(([id]) => id).filter((id) => BUILTIN_PAGES.includes(id))).toEqual(BUILTIN_PAGES);
  expect(pages.length).toBeGreaterThan(BUILTIN_PAGES.length);
  const head = app.locator('.settings header.phd');
  await button(app, 'terminal').click(); // so General, first in the loop, is a change
  for (const [id, name] of pages) {
    await button(app, id).click();
    await expect(button(app, id), id).toHaveAttribute('aria-current', 'page');
    await expect(head, id).toHaveCount(1);
    await expect(head.locator('h1'), id).toHaveCount(1);
    const builtin = BUILTIN_PAGES.includes(id);
    expect(!builtin || LABELS[`settings.page.${id}`], id).toBeTruthy();
    await expect(head.locator('h1'), id).toHaveText(builtin ? LABELS[`settings.page.${id}`] : name);
    if (!builtin) continue;
    await expect(head.locator('h1'), id).toBeFocused(); // focus follows the chosen page to its title
    await expect(head.locator('p'), id).toHaveText(LABELS[`settings.desc.${id}`]);
  }
});
