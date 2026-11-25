// ux-polish-3 (UXFIX follow-ups from the 2026-10-28 conformance audit): the composer chip names the agent, a project row
// opens New worktree, the decision text keeps its room at 256 px, the Chat | Terminal switch speaks English, the Keys
// cards sit in two columns and a key jump through a search shows its row. One named test per acceptance item.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, test } from './fixtures';
import { fakes, gitRepo, PERMISSION, show } from './decision-rows-seed';
import { openQuiet } from './tree-seed';
import { openChat, test as chatTest } from './fixtures/chat/harness';

const FIXTURES = path.join(REPO, 'crates/nunchiro/tests/fixtures');
const axe = async (app: Page, selector: string) => expect((await new AxeBuilder({ page: app }).include(selector).analyze()).violations).toEqual([]);
const openKeys = async (app: Page) => {
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
};

test('chip_names_agent_after_switch: the model chip reads "<Agent> · <model>", also after a hand-off to Codex', async ({ app, core }) => {
  fs.copyFileSync(path.join(FIXTURES, 'claude-picker'), path.join(core.home, 'bin/claude'));
  fs.copyFileSync(path.join(FIXTURES, 'codex-picker'), path.join(core.home, 'bin/codex'));
  const s = core.cli('session', 'start', '--kind', 'claude', '--project', core.project('demo'), '--label', 'claude').session as { id: string };
  await openWindow(app);
  await expect.poll(() => core.read(s.id)).toContain('❯');
  const chip = app.locator('[data-picker="model"]');
  // needs 130 round 3: a session with no model shows the agent alone; "Default" is the menu's row, not a model.
  await expect(chip).toHaveText('Claude');
  await chip.click();
  await app.locator('[data-menu="model"] [data-item="more"]').click(); // W35: the hand-off group is under More models ›
  await app.locator('[data-menu="model"] [data-item="handoff-codex"]').click();
  await expect(app.locator('[data-handoff-chip]')).toBeVisible();
  await expect(app.locator('[data-handoff-chip]')).toContainText(/\d/); // the preview arrived
  await app.locator('#composer').fill('go on');
  await app.locator('#composer').press('Enter');
  await expect(chip).toHaveText('Codex');
});

test('project_row_worktree_button: hover and focus show "+ session" and "⌄ worktree"; the latter opens New worktree', async ({ app, core }) => {
  gitRepo(core, 'demo');
  core.shell(core.project('demo'), 'alpha');
  openQuiet(core);
  await openWindow(app);
  const head = app.locator('.grp[data-project] .row.head').first();
  const add = head.getByRole('button', { name: 'New worktree in demo' });
  await expect(add).toBeHidden();
  await head.hover();
  await expect(head.getByRole('button', { name: /^New session in/ })).toBeVisible();
  await expect(add).toBeVisible();
  await expect(add).toHaveText('⌄ worktree');
  await app.mouse.move(700, 500);
  await expect(add).toBeHidden();
  await head.locator('button').first().focus(); // keyboard focus inside the row shows both
  await expect(add).toBeVisible();
  await expect(head.getByRole('button', { name: /^New session in/ })).toBeVisible();
  await add.focus();
  await app.keyboard.press('Enter');
  await expect(app.getByRole('dialog', { name: 'New worktree' })).toBeVisible();
});

test('decision_text_at_256: a short question shows in full; a long one keeps one line with an ellipsis and its full text in the tooltip (HIDEROWS r6, STYLE 2026-10-28)', async ({ app, core }) => {
  fakes(core);
  const p = gitRepo(core, 'repo');
  const a = core.agent(p, 'wt-a', 'go-a', true) as { id: string; cwd: string };
  const b = core.agent(p, 'wt-b', 'go-b', true) as { id: string; cwd: string };
  await openWindow(app);
  const line = (x: { id: string }) => app.locator(`.q[data-line="${x.id}"]`);
  show(a.cwd, 'go-a', PERMISSION('npm test'));
  show(b.cwd, 'go-b', PERMISSION('npm run build-everything and then deploy staging and run smoke checks afterwards'));
  await expect(line(a)).toBeVisible({ timeout: 8000 });
  await expect(line(b)).toBeVisible({ timeout: 8000 });
  await app.evaluate(() => document.querySelectorAll<HTMLElement>('aside').forEach((e) => (e.getBoundingClientRect().width > 200 && e.getBoundingClientRect().width < 400 ? (e.style.width = '256px') : 0)));
  const text = line(a).locator('.qt');
  // HIDEROWS r6 (needs 92, 95; 02be66ec): a risky question leads with its red Caution label inside the same span.
  await expect(text).toHaveText('Caution Run npm test'); // B20 (ticket 991): the line names the ask
  expect(await text.evaluate((e) => e.scrollWidth <= e.clientWidth && e.getClientRects()[0].height < 20)).toBe(true);
  const long = line(b).locator('.qt');
  const lh = await long.evaluate((e) => parseFloat(getComputedStyle(e).lineHeight) || 16);
  const h = (await long.boundingBox())!.height;
  expect(h).toBeLessThan(lh * 1.5); // one line, as ko/hiderows-r6.html draws it
  expect(await long.evaluate((e) => e.scrollWidth > e.clientWidth && getComputedStyle(e).textOverflow === 'ellipsis')).toBe(true);
  await expect(long).toHaveAttribute('title', /npm run build-everything and then deploy staging and run smoke checks afterwards/); // the full prompt
  // Settled colours before axe reads them: the rows re-sort once the git worktree list names them (data-menu turns
  // "worktree"), and a row React moves replays its 150 ms fade-in (`qin`), which axe reads as low contrast. Wait for both
  // rows to be listed, then for every finite animation in the tree to end (Orca tab-hover-card.spec.ts, MIT: getAnimations).
  await expect(app.locator('.sess .row.wt2[data-menu="worktree"]')).toHaveCount(2);
  await expect
    .poll(() => app.locator('aside.dock.l').evaluate((e) => e.getAnimations({ subtree: true }).filter((x) => x.playState === 'running' && x.effect?.getTiming().iterations !== Infinity).length))
    .toBe(0);
  await axe(app, '.sess');
});

// AGENTVIEW: the Chat | Terminal switch is gone (the terminal is the side pane's PTY tab), in every locale.
test.describe('toggle_gone_in_every_locale', () => {
  chatTest('English locale has no View switch', async ({ page, chatCore }) => {
    const s = chatCore.chat();
    await openChat(page, s.id);
    await expect(page.getByRole('group', { name: 'View' })).toHaveCount(0);
  });
  test.describe('Korean', () => {
    chatTest.use({ locale: 'ko-KR' });
    chatTest('Korean locale has no 채팅 | 터미널 switch', async ({ page, chatCore }) => {
      const s = chatCore.chat();
      // openChat waits for the English "Connected"; V2-14g put the status text in the catalogue, so the Korean
      // window reads "연결됨" (areas/common.ts chrome.connected). Same steps, the locale's own text.
      await page.goto('/');
      await expect(page.getByRole('status').filter({ hasText: '연결됨' })).toBeVisible();
      await page.locator(`.tab[data-tab="${s.id}"]`).click();
      await expect(page.locator(`.chat[data-session="${s.id}"] .clist`)).toHaveAttribute('aria-busy', 'false');
      await expect(page.getByRole('group', { name: 'View' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^(채팅|터미널)$/ }).and(page.locator('button:not(.ai)'))).toHaveCount(0); // V2.5-54 A12: the Terminal rail icon (.ai) reads 터미널 now; no other control does
    });
  });
});

test('keys_cards_two_columns: the area sections share one column at 1440 px and at 800 px', async ({ app, core }) => {
  // needs 166 (page A) replaced the two-column cards of needs 104 with one list; the 800 px case keeps its meaning (one column).
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openKeys(app);
  const xs = async () => (await app.locator('[data-keys-list] section.karea').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().x))));
  expect(new Set(await xs()).size).toBe(1);
  await app.setViewportSize({ width: 800, height: 900 });
  await expect.poll(async () => new Set(await xs()).size).toBe(1);
  await axe(app, '[data-keys-list]');
});

test('keys_jump_hidden_row: a jump whose row the search hides clears the search and shows the row', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openKeys(app);
  const search = app.getByRole('searchbox', { name: 'Search actions or keys' });
  await search.fill('Go to the next tab');
  const row = app.locator('tr[data-command="diff.open"]');
  await expect(row).toHaveCount(0);
  await app.evaluate(() => window.dispatchEvent(new CustomEvent('nunchiro:keys.jump', { detail: 'diff.open' }))); // the key map's click is gone (needs 166)
  await expect(search).toHaveValue('');
  await expect(row).toHaveAttribute('data-jump', 'true');
});
