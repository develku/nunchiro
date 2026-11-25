// Ticket 453 (pick A): every Settings row that edits a stored value with a default gets ticket 311's reset arrow; a card
// with three or more such rows gets its "Reset to defaults". Each test changes a value, presses the arrow and sees the
// default back and the arrow gone. Real core.
import type { Locator, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test } from './fixtures';
import { openSettings } from './settings-modal';

test.beforeEach(({ core }) => void core.shell(core.project('demo'), 'alpha'));

async function go(app: Page, id: string) {
  await openWindow(app);
  await openSettings(app);
  await app.locator(`.settings > nav button[data-page="${id}"]`).click();
}
const body = (app: Page) => app.locator('.sbody');
const arrow = (app: Page, label: string) => body(app).getByRole('button', { name: `Reset ${label} to default`, exact: true });
const card = (app: Page, section: string) => body(app).getByRole('button', { name: `Reset ${section} to defaults`, exact: true });

/** Presses the arrow and checks it is gone. */
async function reset(app: Page, label: string) {
  await expect(arrow(app, label)).toBeVisible();
  await arrow(app, label).click();
  await expect(arrow(app, label)).toHaveCount(0);
}

test('reset_chat_type_rows: a number, a switch and a choice go back to their defaults', async ({ app }) => {
  await go(app, 'appearance');
  const size = body(app).getByRole('spinbutton', { name: 'Chat text size', exact: true });
  await expect(arrow(app, 'Chat text size')).toHaveCount(0);
  await size.fill('16');
  await reset(app, 'Chat text size');
  await expect(size).toHaveValue('14.5');

  const math = body(app).getByRole('switch', { name: 'Math in chat', exact: true });
  await math.check();
  await reset(app, 'Math in chat');
  await expect(math).not.toBeChecked();

  const code = body(app).getByRole('radiogroup', { name: 'Code font', exact: true });
  await code.getByRole('radio', { name: 'Terminal font' }).click();
  await reset(app, 'Code font');
  await expect(code.getByRole('radio', { name: 'Default' })).toBeChecked();
});

test('reset_diff_rows_and_card: a switch, a choice, and the card in one click with undo', async ({ app }) => {
  await go(app, 'appearance');
  const wrap = body(app).getByRole('switch', { name: 'Wrap long lines', exact: true });
  await expect(card(app, 'Diff')).toHaveCount(0);
  await wrap.check();
  await reset(app, 'Wrap long lines');
  await expect(wrap).not.toBeChecked();

  const colours = body(app).getByRole('radiogroup', { name: 'Diff colours', exact: true });
  await colours.getByRole('radio', { name: 'Colour-blind safe' }).click();
  await reset(app, 'Diff colours');
  await expect(colours.getByRole('radio', { name: 'Theme' })).toBeChecked();

  await wrap.check();
  await colours.getByRole('radio', { name: 'Colour-blind safe' }).click();
  await card(app, 'Diff').click();
  await expect(wrap).not.toBeChecked();
  await expect(colours.getByRole('radio', { name: 'Theme' })).toBeChecked();
  await expect(card(app, 'Diff')).toHaveCount(0);
  await app.keyboard.press('Meta+z');
  await expect(wrap).toBeChecked();
});

test('reset_browser_defaults: a select, a number, a typed address and a switch; the card resets the rest', async ({ app }) => {
  await go(app, 'inapp-browser');
  const engine = body(app).getByLabel('Search engine', { exact: true });
  await engine.selectOption('kagi');
  await reset(app, 'Search engine');
  await expect(engine).toHaveValue('google');

  const zoom = body(app).getByRole('spinbutton', { name: 'Default zoom', exact: true });
  await zoom.fill('120');
  await reset(app, 'Default zoom');
  await expect(zoom).toHaveValue('100');

  const home = body(app).getByLabel('Home page', { exact: true });
  await home.fill('mail.example');
  await home.press('Enter');
  await expect(home).toHaveValue('https://mail.example/');
  await reset(app, 'Home page');
  await expect(home).toHaveValue('');

  const pane = body(app).getByRole('switch', { name: 'Show the browser when an agent opens a page', exact: true });
  await pane.uncheck();
  await reset(app, 'Show the browser when an agent opens a page');
  await expect(pane).toBeChecked();

  await engine.selectOption('bing');
  await card(app, 'Browser defaults').click();
  await expect(engine).toHaveValue('google');
  await expect(card(app, 'Browser defaults')).toHaveCount(0);
});

test('reset_link_routing: a choice and a switch, and the Links card', async ({ app }) => {
  await go(app, 'inapp-browser');
  const openIn = body(app).getByRole('radiogroup', { name: 'Open http(s) links in', exact: true });
  await openIn.getByRole('radio', { name: 'In-app browser' }).click();
  await reset(app, 'Open http(s) links in');
  await expect(openIn.getByRole('radio', { name: 'In-app browser' })).not.toBeChecked();

  const shift = body(app).getByRole('switch', { name: 'Shift+click opens the other browser', exact: true });
  await shift.uncheck();
  await reset(app, 'Shift+click opens the other browser');
  await expect(shift).toBeChecked();

  const bg = body(app).getByRole('switch', { name: 'Open in the background', exact: true });
  await bg.check();
  await card(app, 'Links').click();
  await expect(bg).not.toBeChecked();
  await app.keyboard.press('Meta+z');
  await expect(bg).toBeChecked();
});

test('reset_general_rows: the close question and the display language', async ({ app }) => {
  await go(app, 'general');
  const ask = body(app).getByRole('switch', { name: 'Ask before closing a running session tab', exact: true });
  await ask.check();
  await reset(app, 'Ask before closing a running session tab');
  await expect(ask).not.toBeChecked();

  const language = app.locator('[data-setting="language"]');
  await language.selectOption('en');
  await reset(app, 'Display language');
  await expect(language).toHaveValue('system');
});

test('reset_git_rows: the typed branch prefix and the credits switch', async ({ app }) => {
  await go(app, 'git');
  const prefix = body(app).getByRole('textbox', { name: 'Branch name prefix for new worktrees', exact: true });
  await prefix.fill('team');
  await prefix.press('Enter');
  await reset(app, 'Branch name prefix for new worktrees');
  await expect(prefix).toHaveValue('');

  const credits = body(app).getByRole('switch', { name: 'Remove agent credits when merging', exact: true });
  await credits.click(); // the core answers, then the box follows
  await expect(credits).toBeChecked();
  await reset(app, 'Remove agent credits when merging');
  await expect(credits).not.toBeChecked();
});

test('reset_keyboard_rows: the session order and the hint alphabet', async ({ app }) => {
  await go(app, 'keys');
  const order = body(app).getByRole('radiogroup', { name: 'Next/previous session order', exact: true });
  await order.getByRole('radio', { name: 'Most recently used' }).click();
  await reset(app, 'Next/previous session order');
  await expect(order.getByRole('radio', { name: 'Most recently used' })).not.toBeChecked();

  const alphabet = body(app).getByRole('textbox', { name: 'Hint alphabet', exact: true });
  const was = await alphabet.inputValue();
  await alphabet.fill('jkl');
  await expect(alphabet).toHaveValue('jkl');
  await reset(app, 'Hint alphabet');
  await expect(alphabet).toHaveValue(was);
});

test('reset_onboarding_notify_level: the level goes back to its default', async ({ app }) => {
  await go(app, 'onboarding');
  await app.locator('.ob-step[data-step="notify"]').click();
  const level = body(app).getByLabel('Default for new sessions', { exact: true });
  await level.selectOption('muted');
  await reset(app, 'Notification level');
  await expect(level).toHaveValue('all');
});

// Ticket 543: "every row", not a sample. Walks every Settings nav page with every fold open and, for each switch, select,
// stepper and segmented choice that is not on the exempt list, changes it, expects the row's reset, presses it, expects the
// first value back and the reset gone. A control that is disabled is `why_every_page`'s (settings-why.spec.ts).
// A control with no built-in default, or one whose "default" is not a value to go back to, is exempt with its reason; the
// key is `<page>: <row label>` (a control outside any row: `<page>: <card title> / <its label>`). An entry that matches no
// control fails the test, so the list cannot hide a row that moved or went.
const EXEMPT: { match: RegExp; why: string }[] = [
  { match: /^providers: Providers \/ Use (Claude|Codex) \(no row\)$/, why: "the card head's own on/off switch: off closes the card and shows Off, and the switch itself is the way back" },
  { match: /^providers: Providers \/ (?!Default account|Permission|Default model|Effort|Use )[^]*\(no row\)$/, why: 'a per-item row: one switch for each model of the list, which "All on" puts back together; the list has no single default' },
  { match: /^usage: /, why: 'a view filter of the Usage dashboard (range, scope, account), not a stored setting' },
  { match: /^team: How this place works.* \/ Project \(no row\)$/, why: "picks which project's section is shown (ticket 1099 A); not a stored setting" },
];

type Kind = 'switch' | 'select' | 'number' | 'group';
const CONTROLS = 'input[role="switch"], select, .sstep input[type="number"], [role="radiogroup"]';

/** The value a control shows now, as one comparable string. */
async function shows(c: Locator, kind: Kind): Promise<string> {
  if (kind === 'switch') return String(await c.isChecked());
  if (kind === 'group') return c.evaluate((g) => g.querySelector<HTMLInputElement>('input:checked')?.value ?? '');
  return c.inputValue();
}

/** Changes a control to some other value it offers; returns false when it has none to offer. */
async function change(c: Locator, kind: Kind): Promise<boolean> {
  if (kind === 'switch') return (await c.click(), true);
  if (kind === 'select') {
    const now = await c.inputValue();
    const other = await c.evaluate((s, now) => [...(s as HTMLSelectElement).options].find((o) => !o.disabled && o.value !== now)?.value ?? null, now);
    return other === null ? false : (await c.selectOption(other), true);
  }
  if (kind === 'number') {
    const box = c.locator('xpath=..');
    const up = box.getByRole('button', { name: /^Increase/ });
    const down = box.getByRole('button', { name: /^Decrease/ });
    const btn = (await up.isDisabled()) ? down : up;
    return (await btn.isDisabled()) ? false : (await btn.dispatchEvent('click'), true); // tabindex -1, and a list may overlap it
  }
  const radio = c.locator('input[type="radio"]:not(:checked):not(:disabled)').first();
  return (await radio.count()) === 0 ? false : (await radio.locator('xpath=..').click(), true);
}

/** Puts a control back by hand after a row whose reset did not come, so the walk goes on from the first state. */
async function put(c: Locator, kind: Kind, was: string) {
  if (kind === 'switch') return void ((await c.isChecked()) !== (was === 'true') && (await c.click()));
  if (kind === 'select') return void (await c.selectOption(was));
  if (kind === 'group') return void (await c.locator(`input[type="radio"][value="${was}"]`).locator('xpath=..').click());
  await c.fill(was);
  await c.blur();
}

test('reset_every_row: every switch, select, stepper and choice on every Settings page shows a reset while changed and goes back with it', async ({ app }) => {
  test.setTimeout(420_000);
  app.setDefaultTimeout(6000);
  await openWindow(app);
  await openSettings(app);
  const pages = await app.locator('.settings > nav button[data-page]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.page!));
  expect(pages.length).toBeGreaterThanOrEqual(17);
  expect(pages).toContain('extensions');
  const bad: string[] = [];
  const matched = new Set<RegExp>();
  const driven: string[] = []; // every control that was changed and reset
  for (const id of pages) {
    if (process.env.WALK_PAGES && !process.env.WALK_PAGES.split(',').includes(id)) continue; // a dev aid: WALK_PAGES=terminal,alerts
    await app.locator(`.settings > nav button[data-page="${id}"]`).click();
    await expect(app.locator(`.settings > nav button[data-page="${id}"]`)).toHaveAttribute('aria-current', 'page');
    await app.waitForTimeout(500); // the page's core reads settle
    // Every closed fold and add form opened first.
    const closed = body(app).locator('[aria-expanded="false"]:not([role="combobox"], [aria-haspopup])'); // a picker or menu is not a fold
    for (let n = await closed.count(); n > 0; n--) {
      const next = closed.first();
      if (!(await next.isVisible()) || (await next.isDisabled())) break;
      await next.click();
    }
    // And every <details> (the terminal page's "More", the hint page's "Advanced").
    await body(app).locator('details:not([open])').evaluateAll((els) => els.forEach((e) => e.setAttribute('open', '')));
    await app.waitForTimeout(200);
    const all = body(app).locator(CONTROLS);
    for (let i = 0, n = await all.count(); i < n; i++) {
      const c = all.nth(i);
      let key = `${id}: control ${i}`;
      try {
        if (i >= (await all.count()) || !(await c.isVisible()) || (await c.isDisabled()) || (await c.getAttribute('aria-disabled')) === 'true') continue;
        const kind: Kind = (await c.getAttribute('role')) === 'switch' ? 'switch' : (await c.getAttribute('role')) === 'radiogroup' ? 'group' : (await c.evaluate((e) => e.tagName)) === 'SELECT' ? 'select' : 'number';
        const row = c.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " srow ") or contains(concat(" ", normalize-space(@class), " "), " prv-ln ")][1]');
        const lone = await c.evaluate((e) => `${e.closest('section')?.querySelector('h2')?.textContent ?? '?'} / ${e.getAttribute('aria-label') ?? e.getAttribute('name') ?? e.className}`);
        const name = ((await row.count()) ? await row.locator('.snm > span, .prv-k > span').first().textContent() : null) ?? lone;
        key = `${id}: ${name.trim()}${(await row.count()) ? '' : ' (no row)'}`;
        const exempt = EXEMPT.find((e) => e.match.test(key));
        if (exempt) { matched.add(exempt.match); continue; }
        if (!(await row.count())) { bad.push(key); continue; }
        const reset = row.locator('.sreset');
        const was = await shows(c, kind);
        if ((await reset.count()) > 0) { bad.push(`${key}: reset shown before any change`); continue; }
        if (!(await change(c, kind))) continue;
        const came = await reset.first().waitFor({ timeout: 2500 }).then(() => true, () => false);
        if (!came) { bad.push(`${key}: no reset after a change (${kind})`); await put(c, kind, was).catch(() => {}); continue; }
        await reset.first().click();
        const back = await expect.poll(() => shows(c, kind), { timeout: 3000 }).toBe(was).then(() => true, () => false);
        const gone = await expect(reset).toHaveCount(0, { timeout: 3000 }).then(() => true, () => false);
        driven.push(key);
        if (!back || !gone) { bad.push(`${key}: reset ${back ? '' : 'did not bring the first value back'}${gone ? '' : ' did not go away'}`); await put(c, kind, was).catch(() => {}); }
      } catch (e) {
        bad.push(`${key}: could not be driven: ${String((e as Error).message).replace(/\s+/g, ' ').slice(0, 1200)}`);
      }
    }
  }
  // The exempt list names rows that exist: a stale entry would hide a row that moved or went.
  const stale = EXEMPT.filter((e) => !matched.has(e.match)).map((e) => String(e.match));
  if (process.env.ROWS_OUT) fs.writeFileSync(process.env.ROWS_OUT, driven.join('\n'));
  expect(driven.length, 'the walk reached the rows').toBeGreaterThanOrEqual(40);
  expect([...new Set(bad)], 'rows without a working reset').toEqual([]);
  expect(stale, 'exempt entries that match no row').toEqual([]);
});

// SHOTS=<dir> SHOTS_TAG=before|after, chromium only: Lifetime (General), Git and Accounts (Codex card, add form) in light with a
// few values changed, for the lane report's before/after. The same steps run on main, where the reset marks are missing.
test('reset_shots', async ({ app, core }) => {
  const shots = process.env.SHOTS;
  test.skip(!shots || test.info().project.name !== 'chromium', 'SHOTS=<dir> on chromium only');
  const tag = process.env.SHOTS_TAG ?? 'after';
  // A signed-out codex on the PATH, so its card shows the new-session defaults (permission, model, effort).
  fs.writeFileSync(path.join(core.home, 'bin', 'codex'), `#!/bin/sh\n[ "$1" = --version ] && { echo 'codex 1.0.0'; exit 0; }\n[ "$1 $2" = 'login status' ] && { echo 'Not logged in' >&2; exit 1; }\nexec /bin/cat\n`, { mode: 0o700 });
  await app.emulateMedia({ colorScheme: 'light' });
  const shot = (l: Locator, name: string) => l.screenshot({ path: `${shots}/543-${tag}-${name}.png` });
  await go(app, 'general');
  await expect(body(app).locator('[data-setting="keepAwake"]')).toBeVisible();
  await body(app).locator('label:has(input[name="lifetime"][value="end_with_app"])').click();
  for (const setting of ['keepAwake', 'startAtLogin']) {
    await body(app).locator(`[data-setting="${setting}"]`).click();
    await expect(body(app).locator(`[data-setting="${setting}"]`)).toBeChecked();
  }
  await shot(body(app).locator('#s-lifetime'), 'lifetime');
  await app.locator('.settings > nav button[data-page="git"]').click();
  // The core answers, then the box follows: click and wait for the switch to read On.
  for (const setting of ['autoPull', 'autoCleanWorktrees']) {
    await body(app).locator(`[data-setting="${setting}"]`).click();
    await expect(body(app).locator(`[data-setting="${setting}"]`)).toBeChecked();
  }
  await shot(body(app), 'git');
  await app.locator('.settings > nav button[data-page="providers"]').click();
  const row = body(app).locator('#s-accounts [data-row="codex"] .prv-chv');
  await row.waitFor();
  await expect(body(app).locator('#s-accounts [data-row="codex"] .prv-chips')).not.toHaveText('Checking…', { timeout: 25_000 });
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  const card = body(app).locator('#s-accounts .acct-agent[data-agent="codex"]');
  await card.locator('[data-field="permission"] select').selectOption('ask');
  await card.locator('[data-row="newDefaultEffort"] select').selectOption({ index: 1 });
  await card.getByRole('button', { name: 'Add account', exact: true }).click();
  await card.getByRole('textbox', { name: 'Name' }).fill('a​b');
  await app.waitForTimeout(400);
  await shot(card.locator('.acct-add'), 'accounts-add');
  await card.locator('[data-row="newDefaultEffort"]').scrollIntoViewIfNeeded();
  await shot(body(app), 'accounts-defaults');
});

// Ticket 543: the walk above drives switches, selects, steppers and choices; the two typed values it cannot drive blindly.
test('reset_text_rows: the folder for new worktrees and a hint kind key go back to their defaults', async ({ app }) => {
  await go(app, 'git');
  const root = body(app).getByRole('textbox', { name: 'Folder for new worktrees', exact: true });
  // The test core starts with its own folder set (fixtures.ts), so the arrow may already show here.
  await root.fill('../.wt');
  await root.press('Enter');
  await reset(app, 'Folder for new worktrees');
  await expect(root).toHaveValue('');

  await app.locator('.settings > nav button[data-page="keys"]').click();
  const project = body(app).locator('input[data-setting="hintKinds"]').first();
  const was = await project.inputValue();
  await expect(arrow(app, 'Show one kind only')).toHaveCount(0);
  await project.fill(was === 'q' ? 'z' : 'q');
  await reset(app, 'Show one kind only');
  await expect(project).toHaveValue(was);
});
