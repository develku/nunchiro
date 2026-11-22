// Real-app check of 11-10 (RC from main 9ec85687): the right bar's icons, the tab strip's scroll and the tab's own press.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { bview } from './agent-pane';
import { icon } from './d5b';

const left = (app: Page) => app.getByRole('navigation', { name: 'Left bar' });
const right = (app: Page) => app.getByRole('navigation', { name: 'Right bar' });
const rightSidebar = (app: Page) => app.locator('.body > .sbar.r');

test('defect 2: with the Tree folded by an open right widget, one press of another right icon shows it open; the Tree stays folded', async ({ app, core }) => {
  core.shell(core.project('demo'), 'sh1');
  await app.setViewportSize({ width: 1100, height: 800 }); // a width where one right sidebar folds the Tree
  await openWindow(app);
  await right(app).getByRole('button', { name: 'Diff' }).click();
  await expect(rightSidebar(app)).toHaveAttribute('data-widget', 'diff');
  // The right sidebar narrows the main zone under the minimum columns, so V1A-60 folds the Tree.
  await expect(left(app).getByRole('button', { name: 'Tree (folded)' })).toBeVisible();
  for (const [w, name] of [['decisions', 'Decisions'], ['diff', 'Diff'], ['artifacts', 'Artifacts']] as const) {
    await right(app).getByRole('button', { name, exact: true }).click();
    await expect(rightSidebar(app)).toHaveAttribute('data-widget', w);
    await expect(rightSidebar(app)).not.toHaveAttribute('data-folded');
    await expect(rightSidebar(app).locator('.sbb')).toBeVisible();
    await expect(left(app).getByRole('button', { name: 'Tree (folded)' })).toBeVisible();
    await expect(rightSidebar(app)).not.toHaveAttribute('data-folded'); // still, once the folds settled
  }
});

/** The selected tab's box lies inside the strip's box (half a pixel for subpixel layout). */
const selectedInStrip = (app: Page) =>
  app.evaluate(() => {
    const strip = document.querySelector('.tabs[role="tablist"]')!.getBoundingClientRect();
    const tab = document.querySelector('.tab[aria-selected="true"]')!.getBoundingClientRect();
    return tab.left >= strip.left - 0.5 && tab.right <= strip.right + 0.5;
  });

test('defect 1: the selected tab stays inside the strip as the right sidebar opens and widens to its limit, and after selecting the first tab', async ({ app, core }) => {
  const p = core.project('demo');
  for (let i = 1; i <= 6; i++) core.shell(p, `session-number-${i}`);
  await openWindow(app);
  const tabs = app.locator('.tabs[role="tablist"] .tab[role="tab"]'); // the session tabs; ticket 571 adds the Room tab (.rtab) after them
  await expect(tabs).toHaveCount(6);
  await tabs.last().click();
  await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => selectedInStrip(app)).toBe(true);
  await right(app).getByRole('button', { name: 'Diff' }).click();
  await expect(rightSidebar(app)).toHaveAttribute('data-widget', 'diff');
  await expect.poll(() => selectedInStrip(app)).toBe(true);
  // Widen the right sidebar to its limit, checking on the way.
  const edge = rightSidebar(app).locator('.sdiv');
  const box = (await edge.boundingBox())!;
  await app.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await app.mouse.down();
  for (let x = box.x - 100; x >= 0; x -= 100) {
    await app.mouse.move(x, box.y + box.height / 2);
    await expect.poll(() => selectedInStrip(app)).toBe(true);
  }
  await app.mouse.up();
  await expect.poll(() => app.locator('.tabs[role="tablist"]').evaluate((s) => s.scrollWidth > s.clientWidth)).toBe(true); // the strip overflows now
  await expect.poll(() => selectedInStrip(app)).toBe(true);
  await tabs.first().evaluate((t) => (t as HTMLElement).click()); // a DOM click: Playwright's own click would scroll it in first
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => selectedInStrip(app)).toBe(true);
});

/** What VoiceOver's activate (AXPress) does to a role="tab" element in WebKit: AccessibilityNodeObject::actionElement hands the
 *  press to the first native control inside the tab, if any, else to the tab itself (Source/WebCore/accessibility). */
const axPress = (el: Element) => ((el.querySelector('button, select, input:not([type="hidden"])') as HTMLElement | null) ?? (el as HTMLElement)).click();

test('defect 6: pressing a tab by assistive technology selects it and stops nothing; Close is its own sibling (owner 11-17: a tab has no Stop)', async ({ app, core, browserName }) => {
  const p = core.project('demo');
  core.shell(p, 'first-shell');
  core.shell(p, 'second-shell');
  await openWindow(app);
  const strip = app.getByRole('tablist', { name: 'Sessions' });
  const first = strip.getByRole('tab', { name: /first-shell/ });
  const second = strip.getByRole('tab', { name: /second-shell/ });
  await first.click();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(second.locator('.tdot')).not.toHaveAttribute('data-s', 'done'); // the second shell runs
  // The tab's name is its own: no Close in it.
  await expect(second).toHaveAccessibleName(/^\S+ shell · second-shell$/);
  await second.evaluate(axPress);
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await expect(app.getByRole('alertdialog')).toHaveCount(0);
  await expect(second.locator('.tdot')).not.toHaveAttribute('data-s', 'done'); // still running
  // Keyboard: Tab from the tab reaches its Close (Chromium: WebKit's Tab skips buttons by default, as Safari does).
  await second.focus();
  await expect(second).toHaveAccessibleName(/^\S+ shell · second-shell$/); // focused, its buttons are drawn and still not in its name
  if (browserName !== 'webkit') {
    await app.keyboard.press('Tab');
    await expect(app.getByRole('button', { name: 'Close tab second-shell' })).toBeFocused();
  }
  // The close control, found by role and name, closes the tab as before (the session keeps running).
  await app.getByRole('button', { name: 'Close tab second-shell' }).click();
  await expect(second).toHaveCount(0);
  await expect(first).toHaveAttribute('aria-selected', 'true');
});

test('defect 17: the Browser icon lights alone and a second press closes the side pane', async ({ app, core }) => {
  const a = core.agent(core.project('a'), 'a', 'never-created');
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(app.locator(`.chat[data-session="${a.id}"]`)).toBeVisible();
  const browser = icon(app, 'right', 'Browser');
  const terminal = icon(app, 'right', 'Terminal');
  await browser.click();
  await expect(bview(app)).toBeVisible();
  await expect(browser).toHaveAttribute('aria-pressed', 'true');
  await expect(terminal).toHaveAttribute('aria-pressed', 'false');
  await browser.click();
  await expect(app.locator('[data-side-pane]:not([hidden])')).toHaveCount(0);
  await expect(browser).toHaveAttribute('aria-pressed', 'false');
  // The Terminal icon still toggles the PTY as before.
  await terminal.click();
  await expect(app.locator(`.term[data-session="${a.id}"]`)).toBeVisible();
  await expect(terminal).toHaveAttribute('aria-pressed', 'true');
  await expect(browser).toHaveAttribute('aria-pressed', 'false');
});

// Look 1117 v3 (C): dragging the right splitter selected text across the window.
test('splitter_drag_selects_no_text', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await right(app).getByRole('button', { name: 'Diff' }).click();
  const edge = rightSidebar(app).locator('.sdiv');
  const box = (await edge.boundingBox())!;
  await app.mouse.move(box.x + box.width / 2, box.y + 200);
  await app.mouse.down();
  for (let x = box.x - 50; x >= box.x - 400; x -= 50) await app.mouse.move(x, box.y + 400);
  expect(await app.evaluate(() => getSelection()?.toString() ?? '')).toBe('');
  // The browsers here select nothing even without the rule (the app's WebView did): the rule itself is what this proves.
  expect(await app.evaluate(() => getComputedStyle(document.querySelector('.tree') ?? document.body).userSelect)).toBe('none');
  await app.mouse.up();
  expect(await app.evaluate(() => getComputedStyle(document.querySelector('.tree') ?? document.body).userSelect)).not.toBe('none');
});
