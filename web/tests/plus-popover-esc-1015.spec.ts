// Ticket 1015 (look v23 g): the "+" popover opened with the mouse closes on the first Esc from every place focus or the
// pointer can be (the strip, the search field, a row), and the first click outside both closes it and does its own job.
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';

const plus = (app: Page) => app.getByRole('button', { name: 'New session', exact: true });
const pop = (app: Page) => app.getByRole('dialog', { name: 'New tab' });
const tab = (app: Page, name: string) => app.getByRole('tab', { name: new RegExp(name) });
const tip = (app: Page) => app.locator('#app-tip');

async function open(app: Page, core: Core) {
  const alpha = core.project('alpha');
  core.shell(alpha, 'one-shell');
  core.shell(alpha, 'two-shell');
  await openWindow(app);
  await expect(tab(app, 'two-shell')).toBeVisible();
}

/** Opens the popover with the mouse, puts focus or the pointer at `place`, presses Esc once. */
async function escFrom(app: Page, place: 'strip' | 'search' | 'row') {
  await plus(app).click();
  await expect(pop(app)).toBeVisible();
  if (place === 'strip') {
    // The pointer rests on a strip control long enough for its tooltip, and focus is on the strip.
    await tab(app, 'one-shell').focus();
    await plus(app).hover({ position: { x: 4, y: 4 } });
    await app.mouse.move(1, 1);
    await plus(app).hover();
    await expect(tip(app)).toBeVisible();
  } else if (place === 'row') {
    await pop(app).getByRole('option').first().hover();
  } else {
    await expect(pop(app).getByRole('combobox')).toBeFocused();
  }
  await app.keyboard.press('Escape');
  await expect(pop(app)).toHaveCount(0);
}

for (const place of ['strip', 'search', 'row'] as const) {
  test(`plus_popover_esc_from_${place}: one Esc closes the "+" popover with the ${place} in use (ticket 1015)`, async ({ app, core }) => {
    await open(app, core);
    await escFrom(app, place);
  });

  test(`plus_popover_click_outside_from_${place}: the first click outside closes it and selects the clicked tab (ticket 1015)`, async ({ app, core }) => {
    await open(app, core);
    await plus(app).click();
    await expect(pop(app)).toBeVisible();
    if (place === 'strip') await tab(app, 'two-shell').focus();
    if (place === 'row') await pop(app).getByRole('option').first().hover();
    const other = (await tab(app, 'one-shell').getAttribute('aria-selected')) === 'true' ? 'two-shell' : 'one-shell';
    await tab(app, other).click();
    await expect(pop(app)).toHaveCount(0);
    await expect(tab(app, other)).toHaveAttribute('aria-selected', 'true');
  });
}
