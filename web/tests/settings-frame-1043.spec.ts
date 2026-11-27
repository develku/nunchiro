// Ticket 1043 (mockup docs/design/settings-1122, version A): the large title with one summary line of the page's values,
// a coloured tile per page with no orange, red or blue, and the chosen segment raised on the panel.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

const nav = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });
const go = (app: Page, id: string) => nav(app).locator(`button[data-page="${id}"]`).click();

test('frame_1043: summary line under the title, none on a page without one', async ({ app }) => {
  await openWindow(app);
  await openSettings(app);
  await go(app, 'appearance');
  const sum = app.locator('.settings header.phd .ssum');
  // Look v35 c S3-5: the mockup's summary names the chat text size, not the tab text.
  await expect(sum).toHaveText(/^Theme Nunchiro (Light|Dark) \(follows the system\) · Rows 32 px · Chat text 14\.5 px$/);
  expect(await app.locator('.settings header.phd h1').evaluate((e) => getComputedStyle(e).fontSize)).toBe('26px');
  // A value change shows at once.
  await app.locator('[data-row="type.chatSize"] input').fill('16');
  await app.locator('[data-row="type.chatSize"] input').blur();
  await expect(sum).toContainText('Chat text 16 px');
});

// Look v35 c S3-3: every page has its summary line, read from values the page already has (Permissions is app-only).
test('frame_1043: every Settings page shows a summary line under its title', async ({ app }) => {
  test.setTimeout(90_000);
  await openWindow(app);
  await openSettings(app);
  const ids = await nav(app).locator('button[data-page]').evaluateAll((all) => all.map((e) => (e as HTMLElement).dataset.page!));
  expect(ids.length).toBeGreaterThanOrEqual(21);
  const sum = app.locator('.settings header.phd .ssum');
  for (const id of ids) {
    await go(app, id);
    await expect(app.locator(`#snav-${id}`)).toHaveAttribute('aria-current', 'page');
    await expect(sum, id).toHaveText(/\S/, { timeout: 15_000 });
    await expect(sum.locator('b').first(), id).toBeVisible();
  }
});

test('frame_1043: page tiles are coloured, never the your-turn, broken or working hue; chosen segment is raised', async ({ app }) => {
  await openWindow(app);
  await openSettings(app);
  const tiles = await nav(app).locator('button[data-page] .nico').evaluateAll((all) => all.map((e) => getComputedStyle(e).backgroundColor));
  expect(tiles.length).toBeGreaterThan(10);
  const banned = await app.evaluate(() => ['--you', '--bad', '--run'].map((v) => {
    const d = document.createElement('i');
    d.style.color = `var(${v})`;
    document.body.append(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  }));
  for (const c of tiles) expect(banned).not.toContain(c);
  expect(new Set(tiles).size).toBeGreaterThan(3);
  await go(app, 'appearance');
  const on = app.locator('.settings .sseg label:has(input:checked)').first();
  const s = await on.evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, sh: getComputedStyle(e).boxShadow }));
  // Design book (segmented): the chosen part is the raised surface (--raised) with the card shadow.
  const raised = await app.evaluate(() => {
    const d = document.createElement('i');
    d.style.color = 'var(--raised)';
    document.body.append(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  });
  expect(s.bg).toBe(raised);
  expect(s.sh).not.toBe('none');
});

// Look v35 c S3-5: group headings in sentence case, as the mockup ("Agents & sessions", "Git & worktrees").
test('frame_1043: nav group headings are sentence case', async ({ app }) => {
  await openWindow(app);
  await openSettings(app);
  await expect(nav(app).locator('.sgrp h3')).toHaveText(['Interface', 'Agents & sessions', 'Git & worktrees', 'Remote hosts', 'Privacy & permissions', 'Advanced']);
});

// Review w111 M2: a page that reads its values first keeps the summary line's place, so its body does not move down when
// the values arrive. Samples the body's top on every frame from the click until the line is filled.
test("frame_1043: the body does not move when a page's summary arrives", async ({ app }) => {
  test.setTimeout(90_000);
  await openWindow(app);
  await openSettings(app);
  const sum = app.locator('.settings header.phd .ssum');
  // The rule itself: an empty line (a page still reading) is as tall as a filled one.
  await go(app, 'general');
  const heights = await sum.evaluate((e) => {
    const empty = e.cloneNode() as HTMLElement;
    e.after(empty);
    const h = [e.getBoundingClientRect().height, empty.getBoundingClientRect().height];
    empty.remove();
    return h;
  });
  expect(heights[1]).toBe(heights[0]);
  for (const id of ['team', 'notes', 'extensions', 'git', 'machines', 'browser', 'libraries', 'history', 'providers']) {
    await go(app, 'general');
    await expect(sum).toHaveText(/\S/);
    await app.evaluate(() => {
      const w = window as unknown as { __tops: [string, number][]; __stop: boolean };
      w.__tops = [];
      // Each frame: the title shown and the body's top; only the new page's frames count (a description of another length moves it).
      w.__stop = false;
      const tick = () => {
        const b = document.querySelector('.settings .sbody');
        if (b) w.__tops.push([document.querySelector('.settings header.phd h1')?.textContent ?? '', Math.round(b.getBoundingClientRect().top)]);
        if (!w.__stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await go(app, id);
    await expect(sum, id).toHaveText(/\S/, { timeout: 15_000 });
    await app.waitForTimeout(100);
    const title = await app.locator('.settings header.phd h1').textContent();
    const all = await app.evaluate(() => ((window as unknown as { __stop: boolean }).__stop = true, (window as unknown as { __tops: [string, number][] }).__tops));
    const tops = all.filter(([h]) => h === title).map(([, top]) => top);
    expect(tops.length, id).toBeGreaterThan(0);
    expect(new Set(tops), `${id}: ${tops.join(',')}`).toEqual(new Set([tops[0]]));
  }
});

// Review w111 M1: Skills & hooks counts every switch it shows, and follows one switched off.
test("frame_1043: Skills & hooks summary counts the page's switches", async ({ app }) => {
  await openWindow(app);
  await openSettings(app);
  await go(app, 'extensions');
  const sum = app.locator('.settings header.phd .ssum');
  const count = () => app.locator('.settings .sbody input[role="switch"]').evaluateAll((all) => [all.filter((e) => (e as HTMLInputElement).checked).length, all.length]);
  await expect(sum).toContainText('Turned on');
  const [on, all] = await count();
  expect(all).toBeGreaterThanOrEqual(3);
  await expect(sum).toContainText(`Turned on ${on} of ${all}`);
  await app.locator('[data-setting="orchEnabled"]').click();
  await expect(sum).toContainText(`Turned on ${on - 1} of ${all}`);
});
