// V1A-65 item 4 (needs 72): one app tooltip replaces the native `title` on the rail icons, Files and Search rows, tabs
// and AGENTS rows. About 300 ms on hover, at once on keyboard focus; name plus binding; rows only when truncated;
// role="tooltip" with aria-describedby; Esc hides it and nothing else; no fade under reduced motion.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core, stripOnTop } from './fixtures';
import { row, setup } from './fixtures/files/harness';

test.beforeEach(({ core }) => stripOnTop(core));

const tip = (app: Page) => app.getByRole('tooltip');
const icon = (app: Page, id: string) => app.locator(`[data-hint-icon="${id}"]`);
const start = async (app: Page, core: Core) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
};
const LONG = 'a-very-long-file-name-that-will-never-fit-in-the-two-hundred-fifty-six-pixel-dock.txt';

/** ms from the pointer entering `sel` to the tooltip showing (in-page clock, so Playwright's own latency is out). */
async function delay(app: Page, sel: string) {
  await app.evaluate((s) => {
    const w = window as unknown as { __t: { over?: number; shown?: number } };
    w.__t = {};
    document.querySelector(s)!.addEventListener('pointerover', () => (w.__t.over ??= performance.now()), { once: true });
    new MutationObserver((_, o) => {
      const t = document.querySelector('[role="tooltip"]');
      if (t && !t.hasAttribute('hidden')) (w.__t.shown = performance.now()), o.disconnect();
    }).observe(document.body, { subtree: true, attributes: true, childList: true });
  }, sel);
  await app.locator(sel).hover();
  await expect(tip(app)).toBeVisible();
  return app.evaluate(() => {
    const t = (window as unknown as { __t: { over: number; shown: number } }).__t;
    return t.shown - t.over;
  });
}

test('tooltip-delay: a rail icon shows no tooltip at 200 ms and one by 400 ms; leaving hides it', async ({ app, core }) => {
  await start(app, core);
  await expect(tip(app)).toBeHidden();
  const ms = await delay(app, '.ai[data-hint-icon="files.show"]');
  expect(ms).toBeGreaterThanOrEqual(200);
  expect(ms).toBeLessThanOrEqual(400);
  await expect(tip(app)).toHaveText('Files (⇧⌘E)');
  // Moving to a neighbour while one shows switches at once.
  await icon(app, 'search.open').hover();
  await expect(tip(app)).toHaveText('Search (⇧⌘F)', { timeout: 150 });
  await app.mouse.move(700, 400);
  await expect(tip(app)).toBeHidden();
});

test('tooltip-content: name and binding, the new binding after a rebind, the name alone when unbound', async ({ app, core }) => {
  await start(app, core);
  await icon(app, 'settings.open').hover();
  await expect(tip(app)).toHaveText('Settings (⌘,)');
  // Kept inside the window, beside the icon.
  const box = (await tip(app).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(app.viewportSize()!.height);
  await icon(app, 'layout.edit').hover();
  const right = (await tip(app).boundingBox())!;
  expect(right.x + right.width).toBeLessThanOrEqual(app.viewportSize()!.width);
  // The right bar's icons name their toggle keys too.
  await icon(app, 'artifacts.toggle').hover();
  await expect(tip(app)).toContainText('Artifacts');
  await expect(tip(app)).toContainText('(◆ m)');
  await icon(app, 'diff.open').hover();
  await expect(tip(app)).toContainText('Diff');
  await app.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}');
    s.bindings = { ...s.bindings, 'files.show': ['Alt+KeyX'], 'search.open': [] };
    localStorage.setItem('nunchiro.settings.v1', JSON.stringify(s));
  });
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await icon(app, 'files.show').hover();
  await expect(tip(app)).toHaveText('Files (⌥X)');
  await icon(app, 'search.open').hover();
  await expect(tip(app)).toHaveText('Search');
});

test('tooltip-truncated-only: Files rows and tabs show the full name only when truncated', async ({ app, core }) => {
  await setup(app, core, { extra: (d) => fs.writeFileSync(path.join(d, LONG), 'x\n') });
  await row(app, 'hello.ts').hover();
  await app.waitForTimeout(600);
  await expect(tip(app)).toBeHidden();
  await row(app, LONG).hover();
  await expect(tip(app)).toHaveText(LONG);

  // A file tab with a long name truncates; a short one does not.
  await row(app, LONG).click();
  await app.locator(`.tab[data-tab$="${LONG}"]`).hover();
  await expect(tip(app)).toHaveText(LONG);
  await app.mouse.move(700, 500);
  await expect(tip(app)).toBeHidden();
  const short = app.locator('.tab', { has: app.locator('.tname', { hasText: /^files$/ }) });
  await expect(short).toHaveCount(1);
  await short.hover();
  await app.waitForTimeout(600);
  await expect(tip(app)).toBeHidden();

});

test('tooltip-keyboard-focus: Tab to a rail icon shows it at once with aria-describedby; focus stays', async ({ app, core, browserName }) => {
  // WebKit (as Safari by default) reaches buttons with Option-Tab only.
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  await start(app, core);
  await icon(app, 'sidebar.left.toggle').focus();
  await app.keyboard.press(tab);
  const files = icon(app, 'files.show');
  await expect(files).toBeFocused();
  await expect(tip(app)).toBeVisible({ timeout: 150 });
  const id = await tip(app).getAttribute('id');
  expect(id).toBeTruthy();
  await expect(files).toHaveAttribute('aria-describedby', id!);
  await expect(files).toBeFocused();
  // The tooltip is never focusable.
  expect(await tip(app).evaluate((t) => (t as HTMLElement).tabIndex)).toBe(-1);
  await app.keyboard.press(tab);
  await expect(files).not.toHaveAttribute('aria-describedby');
});

test('tooltip-esc: Esc hides the tooltip, focus stays, and no other Esc action runs', async ({ app, core }) => {
  await start(app, core);
  await app.keyboard.press('Meta+KeyK');
  const input = app.getByRole('combobox', { name: 'Command palette search' });
  await expect(input).toBeFocused();
  // A hover that does not move focus (the palette's backdrop covers the rail for a real pointer).
  await icon(app, 'files.show').dispatchEvent('pointerover');
  await expect(tip(app)).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(tip(app)).toBeHidden();
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  // Any other key hides it and goes through, so the Esc after it is never taken (vim in a terminal under a resting
  // pointer).
  await icon(app, 'search.open').dispatchEvent('pointerover');
  await expect(tip(app)).toBeVisible();
  await app.keyboard.type('x');
  await expect(tip(app)).toBeHidden();
  await expect(input).toHaveValue('x');
  await app.keyboard.press('Escape');
  await expect(input).toBeHidden();
});

test('tooltip-reduced-motion: the tooltip fades normally and has no transition under reduced motion', async ({ app, core }) => {
  await start(app, core);
  await icon(app, 'files.show').hover();
  await expect(tip(app)).toBeVisible();
  expect(await tip(app).evaluate((t) => getComputedStyle(t).transitionDuration)).not.toBe('0s');
  await app.mouse.move(700, 400);
  await app.emulateMedia({ reducedMotion: 'reduce' });
  await icon(app, 'search.open').hover();
  await expect(tip(app)).toBeVisible();
  expect(await tip(app).evaluate((t) => getComputedStyle(t).transitionDuration)).toBe('0s');
});

test('tooltip-no-native-title: no native title on rail icons, Files and Search rows or tabs', async ({ app, core }) => {
  await setup(app, core);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Search', exact: true }).click();
  await app.getByRole('searchbox').or(app.locator('.sfield input')).first().fill('hello');
  await expect(app.locator('.hit').first()).toBeVisible();
  const none = async (sels: string[]) => {
    for (const sel of sels) {
      await expect(app.locator(sel).first(), sel).toBeAttached();
      expect(await app.locator(`${sel}[title]`).count(), sel).toBe(0);
    }
  };
  await none(['.ib .ai', '.hit', '.sfile', '.tab', '.tab > span']);
  // One sidebar shows one widget now: the Files rows come after the Search hits.
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Files', exact: true }).click();
  await none(['.frow']);
  await expect(app.locator('[role="tooltip"]')).toHaveCount(1);
});

// V1A-73 follow-ups.
const DEEP = 'a-deep-folder-name/that-goes-on/and-on-past-the-dock-edge/needle-file.ts';
const LINE = `const needle = 'a match line long enough that the two-hundred-fifty-six pixel dock cuts it off well before its end';`;
const withDeep = (d: string) => (fs.mkdirSync(path.join(d, path.dirname(DEEP)), { recursive: true }), fs.writeFileSync(path.join(d, DEEP), `${LINE}\n`));
async function searchNeedle(app: Page) {
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Search', exact: true }).click();
  await app.locator('.sbar .sfield input').fill('needle');
  await expect(app.locator('.sbar .hit').first()).toBeVisible();
}

test('tooltip-edge-placement: a target at the window edge places its tooltip the same after one showed elsewhere first', async ({ app, core }) => {
  await start(app, core);
  // The right bar's Artifacts icon sits at the right edge and its tooltip is long: a squeezed box would wrap and move.
  const edge = icon(app, 'artifacts.toggle');
  await edge.hover();
  await expect(tip(app)).toContainText('Artifacts');
  const first = await tip(app).boundingBox();
  for (const other of ['settings.open', 'layout.edit']) {
    await app.mouse.move(700, 400);
    await expect(tip(app)).toBeHidden();
    await icon(app, other).hover();
    await expect(tip(app)).toBeVisible();
    await app.mouse.move(700, 400);
    await expect(tip(app)).toBeHidden();
    await edge.hover();
    await expect(tip(app)).toContainText('Artifacts');
    expect(await tip(app).boundingBox(), `after ${other}`).toEqual(first);
  }
});

test('tooltip-hide: a click, a scroll of an ancestor of the target, or the target leaving the page hides it', async ({ app, core }) => {
  const names = Array.from({ length: 60 }, (_, i) => `z${String(i).padStart(2, '0')}-${LONG}`);
  await setup(app, core, { extra: (d) => names.forEach((n) => fs.writeFileSync(path.join(d, n), 'x\n')) });
  // Click.
  await icon(app, 'search.open').hover();
  await expect(tip(app)).toBeVisible();
  await app.mouse.down();
  await expect(tip(app)).toBeHidden();
  await app.mouse.up();
  await app.mouse.move(700, 400);
  await icon(app, 'files.show').evaluate((b) => (b as HTMLElement).click()); // the click above opened Search on the left
  // Scroll of the tree holding the row.
  await row(app, names[0]).hover();
  await expect(tip(app)).toHaveText(names[0]);
  await row(app, names[0]).evaluate((r) => {
    let s = r.parentElement;
    while (s && s.scrollHeight <= s.clientHeight) s = s.parentElement;
    s!.scrollTop += 40;
  });
  await expect(tip(app)).toBeHidden();
  // The target leaves the page with the pointer resting on it: the Files dock closes (a click event, no pointerdown).
  await app.mouse.move(700, 400);
  await row(app, names[5]).hover();
  await expect(tip(app)).toHaveText(names[5]);
  await icon(app, 'files.show').evaluate((b) => (b as HTMLElement).click());
  await expect(row(app, names[5])).toHaveCount(0);
  await expect(tip(app)).toBeHidden();
});

// Nightly 11-21 (browser_centre_tab_covered_hides): a click before the hover delay ran out left the tip pending; it then
// showed over the popover the click opened and took that popover's Esc.
test('tooltip-click-before-delay: a target clicked before the hover delay ran out shows no tip until the pointer leaves', async ({ app, core }) => {
  await start(app, core);
  await icon(app, 'files.show').click(); // the pointer arrives and presses at once
  await app.waitForTimeout(600);
  await expect(tip(app)).toBeHidden();
  await app.mouse.move(700, 400);
  await icon(app, 'files.show').hover();
  await expect(tip(app)).toBeVisible();
});

test('tooltip-search: Search hit and file header rows show their full text', async ({ app, core }) => {
  await setup(app, core, { extra: withDeep });
  await searchNeedle(app);
  await app.locator('.sbar .hit').first().hover();
  await expect(tip(app)).toHaveText(LINE);
  await app.mouse.move(700, 400);
  await expect(tip(app)).toBeHidden();
  await app.locator(`.sbar .sfile[data-path="${DEEP}"]`).hover();
  await expect(tip(app)).toHaveText(DEEP);
});

test('tooltip-read-once: a Search hit whose label already holds the line gets no aria-describedby with the same text', async ({ app, core }) => {
  await setup(app, core, { extra: withDeep });
  await searchNeedle(app);
  const hit = app.locator('.sbar .hit').first();
  await hit.hover();
  await expect(tip(app)).toHaveText(LINE);
  expect(await hit.getAttribute('aria-label')).toBe(`${DEEP} line 1: ${LINE}`);
  await expect(hit).not.toHaveAttribute('aria-describedby');
  // A tooltip that adds something (a binding) is still described.
  await icon(app, 'files.show').hover();
  await expect(tip(app)).toHaveText('Files (⇧⌘E)');
  await expect(icon(app, 'files.show')).toHaveAttribute('aria-describedby', 'app-tip');
});

// Look 1117 v5 (A S3-4): "Close split" kept its tooltip after the split closed: a target with keyboard focus that leaves
// the page fires no pointer or focus event. The tooltip goes with its target.
test('tooltip-gone-with-focused-target', async ({ app, core, browserName }) => {
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  await start(app, core);
  await icon(app, 'sidebar.left.toggle').focus();
  await app.keyboard.press(tab);
  await expect(tip(app)).toBeVisible();
  await icon(app, 'files.show').evaluate((b) => b.remove());
  await expect(tip(app)).toBeHidden();
});

// Eighth look (B S2-2): the Team icon's tooltip said "Open Team · 1 needs you" after its badge had gone: the tooltip
// read its text once, when it showed. While it shows it says what its target says now.
test('tooltip-follows-its-target (v8 B S2-2)', async ({ app, core }) => {
  await start(app, core);
  const files = icon(app, 'files.show');
  await files.evaluate((b) => (b.dataset.tip = 'Files · 1 needs you'));
  await files.hover();
  await expect(tip(app)).toHaveText('Files · 1 needs you (⇧⌘E)');
  await files.evaluate((b) => (b.dataset.tip = 'Files'));
  await expect(tip(app)).toHaveText('Files (⇧⌘E)');
  await files.evaluate((b) => b.removeAttribute('data-tip')); // nothing left to say: it hides
  await expect(tip(app)).toBeHidden();
});
