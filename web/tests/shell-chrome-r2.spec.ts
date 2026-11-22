// v25-shell-chrome round 2 (tickets 282 items 1-2, 283; needs 205-207, 213): the merge with v25-quiet-chat (C1), scroll
// restore (S1), i18n of the lane's strings (S2), the waiting dot's name (S3), Restart session on an agent (S4), the icon
// bar edge line only on hover or focus (S5). Round 1's 24 tests stay in shell-chrome.spec.ts.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { en as areaEn, ko as areaKo } from '../src/i18n/areas/shell-chrome';
import { ko as shellKo } from '../src/i18n/areas/shell';
import { REPO, expect, openWindow, test, type Core } from './fixtures';
import { append, chat, openChat, rec, test as chatTest } from './fixtures/chat/harness';
import { fakes, gitRepo, PERMISSION, show } from './decision-rows-seed';
import { bar } from './d5b';

const WINDOW_KEY = 'nunchiro.window.v1';
const tabIds = (p: Page) => p.locator('.tab[data-tab]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
const snap = (core: Core) => core.cli('snapshot', '--json').sessions as { id: string; kind: string; project: string; label: string; state: string; agent_session_id: string | null }[];

// ---- C1: both lanes on the merged tree ------------------------------------------------------------------------------------

chatTest('ended_session_restart_after_both_lanes: an ended chat tab shows no resume, exit or decision strip (quiet-chat) and restarts from its menu and the palette (shell-chrome)', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.user('닫기 전 질문'), rec.assistant('닫기 전 답'));
  await openChat(page, s.id);
  chatCore.windowClose(s.id); // ticket 1013 F6: the window's own Close keeps the done tab
  await expect.poll(() => snap(chatCore).find((x) => x.id === s.id)?.state).toBe('closed');
  const view = chat(page, s.id);
  await expect(view.getByText('닫기 전 답')).toBeVisible();
  // Quiet chat: no strip over or under the transcript; shell chrome: no Resume strip either.
  await expect(page.locator('.resume')).toHaveCount(0);
  // Ticket 371 item 17 (owner 11-09): the one Resume is the button beside the composer's reason line; still no strip.
  await expect(page.getByRole('button', { name: /^Continue/ })).toHaveCount(1);
  await expect(page.locator('.composer .whyline').getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Sessions to resume' })).toHaveCount(0);
  await expect(view.locator('.qline, .decline, [data-decision-line]')).toHaveCount(0);
  await expect(page.locator('.composer .why')).toHaveText('chat is closed: read only');
  // The tab survives a reload, still read-only, and its menu restarts it.
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  const tab = page.locator(`.tab[data-tab="${s.id}"]`);
  await expect(tab).toBeVisible();
  await expect(page.locator('.resume')).toHaveCount(0);
  await tab.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Resume session' }).click();
  await expect.poll(() => snap(chatCore).some((x) => x.state === 'running')).toBe(true);
  const live = snap(chatCore).find((x) => x.state === 'running')!;
  await expect(page.locator(`.tab[data-tab="${live.id}"]`)).toHaveAttribute('aria-selected', 'true'); // the tab followed the session
  await expect(page.locator(`.tab[data-tab="${s.id}"]`)).toHaveCount(0);
  // End it again: the palette restarts it too.
  chatCore.windowClose(live.id); // ticket 1013 F6: the window's own Close keeps the done tab
  await expect(page.locator(`.tab[data-tab="${live.id}"] .tdot`)).toHaveAttribute('data-s', 'done');
  await page.keyboard.press('Meta+KeyK');
  await page.getByRole('dialog', { name: 'Command palette' }).getByRole('combobox').fill('Resume session');
  await page.keyboard.press('Enter');
  await expect.poll(() => snap(chatCore).filter((x) => x.state === 'running').length).toBe(1);
  expect(snap(chatCore).find((x) => x.state === 'running')!.id).not.toBe(live.id);
});

// ---- S1: scroll position per session ------------------------------------------------------------------------------------

chatTest('scroll_restored_per_session: a chat scrolled up comes back to its place after a reload; a chat left at the bottom still opens at the bottom', async ({ page, chatCore }) => {
  const a = chatCore.chat('first');
  const b = chatCore.chat('second');
  for (const s of [a, b]) append(s.file, Array.from({ length: 120 }, (_, i) => rec.assistant(`${s === a ? 'A' : 'B'} 메시지 ${i}`)));
  await openChat(page, a.id);
  await page.locator(`.row.head[data-project-path="${b.cwd}"] b`).click(); // ticket 570: each chat is in its own project, and the strip shows one
  await page.locator(`.tab[data-tab="${b.id}"]`).click();
  await expect(chat(page, b.id).getByText('B 메시지 119', { exact: true })).toBeVisible();
  await page.locator(`.row.head[data-project-path="${a.cwd}"] b`).click();
  await page.locator(`.tab[data-tab="${a.id}"]`).click();
  const view = chat(page, a.id);
  await expect(view.getByText('A 메시지 119', { exact: true })).toBeVisible();
  const scroller = view.locator('.cscroll');
  await scroller.hover();
  await scroller.evaluate((el) => (el.scrollTop = 1200));
  await page.mouse.wheel(0, -1); // a real scroll event from the user
  const placed = await scroller.evaluate((el) => el.scrollTop);
  expect(placed).toBeGreaterThan(300);
  expect(await scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(200); // not at the bottom
  // The shell keeps it for this session only.
  await expect.poll(async () => (await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}'), WINDOW_KEY)).scroll?.[a.id]).toBeGreaterThan(300);
  expect((await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}'), WINDOW_KEY)).scroll?.[b.id]).toBeUndefined();
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(page.locator(`.tab[data-tab="${a.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(chat(page, a.id).locator('.clist')).toHaveAttribute('aria-busy', 'false');
  // Back at the saved place (within a few rows: the list measures its rows again), not at the bottom.
  await expect.poll(async () => Math.abs((await chat(page, a.id).locator('.cscroll').evaluate((el) => el.scrollTop)) - placed), { timeout: 10_000 }).toBeLessThan(160);
  expect(await chat(page, a.id).locator('.cscroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(200);
  // A scroll the user makes after the restore stays put when a message arrives: the restore runs once per chat, never again.
  const again = chat(page, a.id).locator('.cscroll');
  await again.hover();
  await again.evaluate((el, to) => (el.scrollTop = to), Math.max(40, placed - 400));
  await page.mouse.wheel(0, -1);
  const user = await again.evaluate((el) => el.scrollTop);
  await page.waitForTimeout(120); // before the shell has even saved it: the list re-renders its rows, and nothing may pull the view back to the older place
  expect(Math.abs((await again.evaluate((el) => el.scrollTop)) - user)).toBeLessThan(6);
  append(a.file, rec.assistant('A 새 메시지'));
  await expect(chat(page, a.id).locator('.crow', { hasText: 'A 새 메시지' })).toHaveCount(1, { timeout: 10_000 }).catch(() => {}); // it may sit below the viewport
  await page.waitForTimeout(800);
  expect(Math.abs((await again.evaluate((el) => el.scrollTop)) - user)).toBeLessThan(6);
  // The other session was left at the bottom: it opens there.
  await page.locator(`.row.head[data-project-path="${b.cwd}"] b`).click();
  await page.locator(`.tab[data-tab="${b.id}"]`).click();
  await expect(chat(page, b.id).getByText('B 메시지 119', { exact: true })).toBeVisible();
  expect(await chat(page, b.id).locator('.cscroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(40);
});

// ---- S2: strings in the catalogue ---------------------------------------------------------------------------------------

test('shell_chrome_strings_in_i18n: the lane\'s strings have English and Korean in areas/shell-chrome.ts, no source keeps a literal, and the window shows Korean', async ({ app, core }) => {
  // The catalogue: the same keys in both languages, none empty.
  expect(Object.keys(areaKo).sort()).toEqual(Object.keys(areaEn).sort());
  for (const [k, v] of [...Object.entries(areaEn), ...Object.entries(areaKo)]) expect(v.length, k).toBeGreaterThan(2);
  // Every key the sources use exists; the old literals are gone from them.
  const src = (f: string) => fs.readFileSync(path.join(REPO, 'web/src', f), 'utf8');
  const used = new Set([...['layout/IconBar.tsx', 'layout/Sidebars.tsx', 'chrome/commands.ts', 'chrome/useTabs.ts'].flatMap((f) => [...src(f).matchAll(/shell\.chrome\.[A-Za-z]+/g)].map((m) => m[0]))]);
  for (const k of used) expect(Object.keys(areaEn), k).toContain(k);
  for (const k of ['sidebarEdgeTitle', 'sidebarsWider', 'sidebarsNarrower', 'restartSession', 'notRestarted', 'waiting']) expect(used.has(`shell.chrome.${k}`), k).toBe(true); // the four hide / show keys are built from the side and state; the window check below reads them
  expect(src('layout/IconBar.tsx')).not.toMatch(/'Hide'|'Show'|Resize the icon bars|Drag to narrow/);
  expect(src('layout/Sidebars.tsx')).not.toContain('Drag to resize both sidebars');
  expect(src('chrome/commands.ts')).not.toMatch(/title: 'Sidebars (wider|narrower)'|title: 'Restart session'/);
  expect(src('chrome/useTabs.ts')).not.toContain('Not restarted:');
  // In the window: Korean names on the button and the palette commands (ticket 1041: the bar edge is gone).
  core.shell(core.project('demo'), 'one');
  await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: 'ko' })));
  await app.goto('/'); // the status line speaks Korean too, so openWindow's "Connected" wait does not apply
  // Ticket 408 (1797b96e) named the bars in every language, so `bar()`'s English names do not apply here.
  const koBar = (side: 'left' | 'right') => app.getByRole('navigation', { name: shellKo[side === 'left' ? 'shell.rail.left' : 'shell.rail.right'], exact: true });
  await expect(koBar('left').getByRole('button', { name: areaKo['shell.chrome.hideLeft'] })).toBeVisible();
  await expect(koBar('right').getByRole('button', { name: areaKo['shell.chrome.showRight'] })).toBeVisible();
  await expect(koBar('left').getByRole('separator')).toHaveCount(0);
  await app.keyboard.press('Meta+KeyK');
  const palette = app.getByRole('dialog', { name: /Command palette|명령/ });
  await expect(palette.locator('[data-command="sidebars.wider"]')).toContainText(areaKo['shell.chrome.sidebarsWider']);
  await expect(palette.locator('[data-command="sidebars.narrower"]')).toContainText(areaKo['shell.chrome.sidebarsNarrower']);
});

// ---- S3: the waiting dot has a name -------------------------------------------------------------------------------------

test('waiting_dot_named: the dot is an image named "waiting for you", the icon describes itself with it and the tooltip says it', async ({ app, core }) => {
  fakes(core);
  const a = core.agent(gitRepo(core, 'repo'), 'wt-a', 'go-a', true);
  await openWindow(app);
  show(a.cwd, 'go-a', PERMISSION('rm x'));
  const dec = bar(app, 'right').locator('button.ai[aria-label="Decisions"]'); // the icon's own name is unchanged
  const dot = dec.locator('.wdot');
  await expect(dot).toBeVisible({ timeout: 8000 });
  await expect(dot).toHaveAttribute('role', 'img');
  await expect(dot).toHaveAttribute('aria-label', areaEn['shell.chrome.waiting']);
  await expect(dec).toHaveAccessibleDescription(areaEn['shell.chrome.waiting']);
  await expect(dec).toHaveAttribute('data-tip', /waiting for you$/);
  // Only the icon with something waiting says it.
  await expect(bar(app, 'left').locator('button.ai[aria-describedby]')).toHaveCount(0);
});

// ---- S4: Restart session on an agent -----------------------------------------------------------------------------------

test('restart_agent_session: an ended agent session restarts from the tab menu and the palette in its own project and label', async ({ app, core }) => {
  const project = core.project('agent-proj');
  const first = core.agent(project, 'planner', 'never-created');
  await openWindow(app);
  const before = snap(core).find((s) => s.id === first.id)!;
  expect(before).toMatchObject({ kind: 'claude', label: 'planner', state: 'running' });
  await app.locator(`.tab[data-tab="${first.id}"]`).click();
  core.windowClose(first.id); // ticket 1013 F6: the window's own Close keeps the done tab
  const tab = app.locator(`.tab[data-tab="${first.id}"]`);
  await expect(tab.locator('.tdot')).toHaveAttribute('data-s', 'done');
  await tab.click({ button: 'right' });
  await app.getByRole('menuitem', { name: 'Resume session' }).click();
  await expect.poll(() => snap(core).filter((s) => s.state === 'running').length).toBe(1);
  const second = snap(core).find((s) => s.state === 'running')!;
  expect(second).toMatchObject({ kind: 'claude', label: 'planner' });
  expect(fs.realpathSync(second.project)).toBe(fs.realpathSync(project));
  expect(second.id).not.toBe(first.id);
  await expect(app.locator(`.tab[data-tab="${second.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator(`.tab[data-tab="${first.id}"]`)).toHaveCount(0);
  // A running agent offers it greyed; the palette restarts it once it has ended.
  await app.locator(`.tab[data-tab="${second.id}"]`).click({ button: 'right' });
  await expect(app.getByRole('menuitem', { name: 'Restart session' })).toHaveAttribute('aria-disabled', 'true');
  await app.keyboard.press('Escape');
  core.windowClose(second.id); // ticket 1013 F6: the window's own Close keeps the done tab
  await expect(app.locator(`.tab[data-tab="${second.id}"] .tdot`)).toHaveAttribute('data-s', 'done');
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).getByRole('combobox').fill('Resume session');
  await app.keyboard.press('Enter');
  await expect.poll(() => snap(core).filter((s) => s.state === 'running').length).toBe(1);
  const third = snap(core).find((s) => s.state === 'running')!;
  expect(third).toMatchObject({ kind: 'claude', label: 'planner' });
  expect(third.id).not.toBe(second.id);
  expect((await tabIds(app)).includes(third.id)).toBe(true);
});
