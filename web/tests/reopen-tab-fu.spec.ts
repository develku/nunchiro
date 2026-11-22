// v25-reopen-tab-fu (V2.5-84, follow-up of ticket 299): the closed-tab list is module-local, a closed session tab keeps its own
// Session copy and `byId` is global. Two things to prove: a tab of another project reopens in its own project, and two windows
// of one origin keep separate lists. Each spec starts from a real core; closing is the tab's × button, reopening the key.
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';

type Row = { id: string; kind: string; project: string; label: string; state: string };
const snap = (core: Core) => core.cli('snapshot', '--json').sessions as Row[];
const tabIds = (p: Page) => p.locator('.tab[data-tab]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
const tab = (p: Page, id: string) => p.locator(`.tab[data-tab="${id}"]`);
const closeTab = async (p: Page, id: string) => (await tab(p, id).hover(), await tab(p, id).locator('..').locator('button.x').click()); // the × shows on hover
const reopen = (p: Page) => p.keyboard.press('Shift+Meta+KeyT');
const plus = (p: Page) => p.getByRole('button', { name: 'New session', exact: true });
const pop = (p: Page) => p.getByRole('dialog', { name: 'New tab' });
const REOPEN = 'Reopen closed tab';
const project = (p: Page, path: string) => p.locator(`.row.head[data-project-path="${path}"] b`).click();

test('reopen_other_project_tab_stays_in_its_project: a closed tab of project B reopens in B from a window whose active tab is in A, running or ended', async ({ app, core }) => {
  const a = core.project('alpha');
  const b = core.project('beta');
  const inA = core.shell(a, 'in-alpha').id;
  const inB = core.shell(b, 'in-beta').id;
  const ended = core.shell(b, 'ended-beta').id;
  await openWindow(app);
  await project(app, b); // ticket 570: the strip shows one project's tabs
  await closeTab(app, inB);
  await closeTab(app, ended);
  core.cli('session', 'close', ended); // this one ends while it is closed: reopening brings back its ended tab (look 1117 v10)
  await expect.poll(() => snap(core).find((x) => x.id === ended)?.state).toBe('closed');
  await project(app, a);
  await tab(app, inA).click(); // the window's active project is alpha
  await expect(tab(app, inA)).toHaveAttribute('aria-selected', 'true');
  // Not yet heard by the window: wait until "+" lists the ended shell as a finished Session (⇧⌘T decides from what the window knows).
  await plus(app).click();
  await app.keyboard.type('ended-beta');
  await expect(pop(app).getByRole('option', { name: 'ended-beta' })).toContainText('Session');
  await app.keyboard.press('Escape');
  await expect(pop(app)).toHaveCount(0);

  await reopen(app); // the newest closed: the ended shell of beta
  await expect(tab(app, ended)).toHaveAttribute('aria-selected', 'true');
  expect(snap(core).filter((x) => x.label === 'ended-beta').map((x) => x.state)).toEqual(['closed']);

  await reopen(app); // the still-running shell of beta
  await expect(tab(app, inB)).toHaveAttribute('aria-selected', 'true');
  expect(snap(core).find((x) => x.id === inB)!.project).toBe(b);
  expect(snap(core).filter((x) => x.project === a && x.state === 'running').map((x) => x.id)).toEqual([inA]); // nothing new in alpha
  expect(await tabIds(app)).toEqual([inB, ended]); // the reopened tabs brought the window to beta
});

test('reopen_list_is_per_window: closing a tab in one window gives a second window of the same origin nothing to reopen', async ({ app, core }) => {
  const p = core.project('demo');
  const [one, two, three] = ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  const other = await app.context().newPage();
  await other.addInitScript((boot) => { window.__NUNCHIRO__ = boot; }, core.boot());
  await other.goto('/');
  await expect(other.locator('.tab[data-tab]')).toHaveCount(3);

  await closeTab(app, one);
  // Window 1 can reopen; window 2 shows the row disabled with its reason, and its key does nothing.
  await plus(app).click();
  await expect(pop(app).getByRole('option', { name: REOPEN })).not.toHaveAttribute('aria-disabled', 'true');
  await app.keyboard.press('Escape');
  await plus(other).click();
  const row = pop(other).getByRole('option', { name: REOPEN });
  await expect(row).toHaveAttribute('aria-disabled', 'true');
  await expect(row).toHaveAttribute('title', /closed/i);
  await other.keyboard.press('Escape');
  await reopen(other);
  await other.waitForTimeout(300);
  expect(await tabIds(other)).toEqual([one, two, three]);
  expect(await tabIds(app)).toEqual([two, three]); // and window 2's key did not touch window 1

  // Each window reopens only what it closed itself.
  await closeTab(other, three);
  await reopen(app);
  await expect.poll(() => tabIds(app)).toEqual([one, two, three]); // window 1: its own `one`, not window 2's `three` first
  await reopen(app);
  await other.waitForTimeout(300);
  expect(await tabIds(other)).toEqual([one, two]); // window 2 still has `three` to reopen
  await reopen(other);
  await expect.poll(() => tabIds(other)).toEqual([one, two, three]);
});
