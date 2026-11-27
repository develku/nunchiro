// Design book, buttons, fields and focus: controls are 28 high (small 24), radius 7. Primary is the warm fill, secondary
// the --tint-2 soft fill, quiet only text. One warm primary per view. One focus ring: 2 px --accent (no second token).
// Checked controls are ink (--text), never blue.
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { openSettings } from './settings-modal';

const SRC = path.resolve(import.meta.dirname, '../src');
const token = (app: Page, name: string, inside = 'body') =>
  app.evaluate(
    ([n, sel]) => {
      const probe = document.createElement('i');
      probe.style.color = `var(${n}, rgb(1, 2, 3))`;
      (document.querySelector(sel) ?? document.body).append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    },
    [name, inside] as const,
  );
const css = (l: Locator, ...props: string[]) => l.evaluate((e, p) => Object.fromEntries(p.map((k) => [k, getComputedStyle(e).getPropertyValue(k)])), props);
const nav = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });

/** Visible primaries (warm filled, or marked .btn.p), each as "class: text". */
// The Settings modal is its own view; the window behind it is another.
const SETTINGS = '[role="dialog"][aria-label="Settings"]';
const warm = (app: Page, primary: string, inSettings: boolean) =>
  app.evaluate(
    ([p, sel, inside]) => {
      const out: string[] = [];
      for (const e of document.querySelectorAll<HTMLElement>('button, a, [role="button"]')) {
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height || getComputedStyle(e).visibility === 'hidden' || !!e.closest(sel) !== inside) continue;
        if (getComputedStyle(e).backgroundColor === p || e.matches('.btn.p')) out.push(`${e.className}: ${(e.textContent ?? '').trim().slice(0, 40)}`);
      }
      return out;
    },
    [primary, SETTINGS, inSettings] as const,
  );

/** Every visible .btn in Settings: its height and corner. */
const btns = (app: Page) =>
  app.locator(`${SETTINGS} .btn`).evaluateAll((els) =>
    els
      .filter((e) => (e as HTMLElement).offsetWidth > 0 && !e.closest('.ob-quick-x'))
      .map((e) => ({ t: `${e.className}: ${(e.textContent ?? '').trim().slice(0, 30)}`, h: (e as HTMLElement).getBoundingClientRect().height, r: getComputedStyle(e).borderTopLeftRadius })),
  );

async function seedSession(app: Page, core: Core) {
  core.shell(core.project('demo'), 'one');
  await openWindow(app);
}

test('button_kinds: primary is the warm fill, secondary the soft --tint-2 fill, 28 high (small 24), radius 7', async ({ app, core }) => {
  await seedSession(app, core);
  await openSettings(app);
  await nav(app).locator('button[data-page="keys"]').click();
  const [primary, onPrimary, tint2] = [await token(app, '--primary'), await token(app, '--on-primary'), await token(app, '--tint-2')];
  // A secondary: the page header's Reset all to defaults.
  const second = app.locator('.settings[role="region"] .phd .btn').first();
  await expect(second).toBeVisible();
  expect(await css(second, 'height', 'border-top-left-radius', 'background-color', 'border-top-width', 'padding-left')).toEqual({ height: '28px', 'border-top-left-radius': '7px', 'background-color': tint2, 'border-top-width': '0px', 'padding-left': '12px' });
  const p = await app.evaluate(() => {
    const b = document.createElement('button');
    b.className = 'btn p';
    b.textContent = 'Go';
    document.querySelector('.settings[role="region"]')!.append(b);
    const s = getComputedStyle(b);
    const q = document.createElement('button');
    q.className = 'btn q';
    q.textContent = 'Later';
    b.after(q);
    const sm = document.createElement('button');
    sm.className = 'btn sm';
    sm.textContent = 'Small';
    q.after(sm);
    const out = { bg: s.backgroundColor, fg: s.color, h: s.height, r: s.borderTopLeftRadius, qbg: getComputedStyle(q).backgroundColor, smh: getComputedStyle(sm).height };
    b.remove();
    q.remove();
    sm.remove();
    return out;
  });
  expect(p).toEqual({ bg: primary, fg: onPrimary, h: '28px', r: '7px', qbg: 'rgba(0, 0, 0, 0)', smh: '24px' });
});

test('button_sizes_everywhere: every visible button on every Settings page is 24 or 28 high with radius 7', async ({ app, core }) => {
  await seedSession(app, core);
  await openSettings(app);
  const pages = await nav(app).locator('button[data-page]').evaluateAll((b) => b.map((e) => e.getAttribute('data-page')!));
  const bad: string[] = [];
  for (const page of pages) {
    await nav(app).locator(`button[data-page="${page}"]`).click();
    await app.waitForTimeout(150);
    for (const b of await btns(app)) if (![24, 28].includes(Math.round(b.h)) || b.r !== '7px') bad.push(`${page} ${b.t} ${b.h} ${b.r}`);
  }
  expect(bad).toEqual([]);
});

test('one_focus_ring: one token, the 2 px --accent ring, on a button and a field, in the window and in Settings', async ({ app, core }) => {
  await seedSession(app, core);
  await openSettings(app);
  const accent = await token(app, '--accent');
  // The second focus token has no use left: no stylesheet reads it (its alias stays in the token files only).
  const uses = fs
    .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(css|tsx?)$/.test(f) && !/tokens\.css$|derive\.ts$/.test(f))
    .filter((f) => fs.readFileSync(path.join(SRC, f), 'utf8').includes('var(--ring-focus)'));
  expect(uses).toEqual([]);
  expect(await token(app, '--focus-ring', '.settings[role="region"]')).toBe(accent);
  await nav(app).locator('button[data-page="keys"]').click();
  const b = app.locator('.settings[role="region"] .btn:not(:disabled)').first();
  // Keyboard focus (:focus-visible): a key press after focus, as contrast.spec's keyFocus.
  await b.focus();
  await app.keyboard.press('Shift');
  if (!(await b.evaluate((e) => e.matches(':focus-visible')))) {
    await app.keyboard.press('Shift+Tab');
    await app.keyboard.press('Tab');
    await b.focus();
  }
  expect(await b.evaluate((e) => e.matches(':focus-visible'))).toBe(true);
  expect(await css(b, 'outline-style', 'outline-width', 'outline-color', 'outline-offset')).toEqual({ 'outline-style': 'solid', 'outline-width': '2px', 'outline-color': accent, 'outline-offset': '2px' });
  const f = app.locator('.settings[role="region"] > nav input').first();
  await f.focus();
  expect(await css(f, 'outline-style', 'outline-width', 'outline-color', 'height', 'border-top-left-radius')).toEqual({ 'outline-style': 'solid', 'outline-width': '2px', 'outline-color': accent, height: '28px', 'border-top-left-radius': '7px' });
});

test('checked_is_ink: a switch that is on and a checked segment are ink, not blue', async ({ app, core }) => {
  await seedSession(app, core);
  await openSettings(app);
  const text = await token(app, '--text');
  const on = app.locator('.settings[role="region"] input.stog:checked').first();
  for (const page of await nav(app).locator('button[data-page]').evaluateAll((b) => b.map((e) => e.getAttribute('data-page')!))) {
    await nav(app).locator(`button[data-page="${page}"]`).click();
    if (await on.isVisible()) break;
  }
  await expect(on).toBeVisible();
  // The track is drawn by the switch's ::before; the input keeps a 24 high hit box.
  expect(await on.evaluate((e) => getComputedStyle(e, '::before').backgroundColor)).toBe(text);
  expect(await css(on, 'height')).toEqual({ height: '24px' });
  expect(await on.evaluate((e) => [getComputedStyle(e, '::before').width, getComputedStyle(e, '::before').height])).toEqual(['30px', '18px']);
  const seg = app.locator('.settings[role="region"] .sseg').first();
  if (await seg.count()) expect(await css(seg, 'height', 'border-top-left-radius')).toEqual({ height: '28px', 'border-top-left-radius': '9px' });
});

test('one_warm_primary_per_view: the window and every Settings page show at most one warm button', async ({ app, core }) => {
  await seedSession(app, core);
  const primary = await token(app, '--primary');
  const inWindow = await warm(app, primary, false);
  expect(inWindow.length, `window: ${inWindow.join(' | ')}`).toBeLessThanOrEqual(1);
  await openSettings(app);
  const pages = await nav(app).locator('button[data-page]').evaluateAll((b) => b.map((e) => e.getAttribute('data-page')!));
  const many: string[] = [];
  for (const page of pages) {
    await nav(app).locator(`button[data-page="${page}"]`).click();
    await app.waitForTimeout(150);
    const w = await warm(app, primary, true);
    if (w.length > 1) many.push(`${page}: ${w.join(' | ')}`);
  }
  expect(many).toEqual([]);
});

test.describe('first run', () => {
  test.use({ firstRun: true });
  test('one_warm_primary_onboarding: the first screen has one warm button', async ({ app }) => {
    await app.goto('/');
    await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
    await expect(app.locator('.ob-step').first()).toBeVisible();
    const primary = await token(app, '--primary');
    const w = await warm(app, primary, true);
    expect(w, w.join(' | ')).toHaveLength(1);
    expect(await app.locator(`${SETTINGS} .btn.p`).evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(primary);
  });
});
