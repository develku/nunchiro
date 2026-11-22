// Ticket 570: tabs belong to the selected project. Switching shows only that project's tabs, keeps the others running, and
// restores each project's own active tab; Ctrl+1-9 switch projects (rebindable); a saved layout from before still loads.
import type { Page } from '@playwright/test';
import { expect, openWindow, terminalText, test, type Core } from './fixtures';

const ids = (p: Page) => p.locator('.tab[data-tab]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
const activeTab = (p: Page) => p.locator('.tab[aria-selected="true"]').getAttribute('data-tab');
/** A project's name in the tree: the click that shows its tabs. */
const goto = (p: Page, path: string) => p.locator(`.row.head[data-project-path="${path}"] b`).click();
const seed = (core: Core) => {
  const [a, b] = [core.project('alpha'), core.project('beta')];
  const [a1, a2] = ['a-one', 'a-two'].map((l) => core.shell(a, l).id);
  const [b1, b2] = ['b-one', 'b-two'].map((l) => core.shell(b, l).id);
  return { a, b, a1, a2, b1, b2 };
};

test('switch: only the selected project\'s tabs show, and the other project\'s tabs come back', async ({ app, core }) => {
  const { a, b, a1, a2, b1, b2 } = seed(core);
  await openWindow(app, {}, core);
  expect(await ids(app)).toEqual([a1, a2]); // the first project's session opened first
  await goto(app, b);
  await expect(app.locator('.tab[data-tab]')).toHaveCount(2);
  expect(await ids(app)).toEqual([b1, b2]);
  await expect(app.locator(`.row.head[data-project-path="${b}"]`)).toHaveAttribute('data-selected', '');
  await goto(app, a);
  expect(await ids(app)).toEqual([a1, a2]);
});

test('restore: each project comes back on its own active tab', async ({ app, core }) => {
  const { a, b, a2, b1, b2 } = seed(core);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a2}"]`).click();
  await goto(app, b);
  expect(await activeTab(app)).toBe(b1); // never shown before: its first tab
  await app.locator(`.tab[data-tab="${b2}"]`).click();
  await goto(app, a);
  expect(await activeTab(app)).toBe(a2);
  await goto(app, b);
  expect(await activeTab(app)).toBe(b2);
  await app.reload(); // the choice survives a restart
  await expect(app.locator('.tab[data-tab]')).toHaveCount(2);
  expect(await activeTab(app)).toBe(b2);
  await goto(app, a);
  expect(await activeTab(app)).toBe(a2);
});

test('survive: a terminal in a project that is not shown keeps its process and its screen', async ({ app, core }) => {
  const { a, b, a1, a2 } = seed(core);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a1}"]`).click();
  await app.locator(`.term[data-session="${a1}"] .xterm-helper-textarea`).focus();
  await app.keyboard.type('marker-570');
  await expect.poll(() => terminalText(app, a1)).toContain('marker-570');
  // The terminal element is tagged: a remount (a restart of the view) would lose the tag.
  await app.locator(`.term[data-session="${a1}"]`).evaluate((e) => ((e as HTMLElement & { kept?: number }).kept = 570));
  await goto(app, b);
  await expect(app.locator(`.tab[data-tab="${a1}"]`)).toHaveCount(0);
  expect(await app.locator(`.term[data-session="${a1}"]`).count()).toBe(1);
  await goto(app, a);
  await expect(app.locator(`.tab[data-tab="${a1}"]`)).toHaveAttribute('aria-selected', 'true');
  expect(await app.locator(`.term[data-session="${a1}"]`).evaluate((e) => (e as HTMLElement & { kept?: number }).kept)).toBe(570);
  expect(await terminalText(app, a1)).toContain('marker-570');
  const running = (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).filter((s) => [a1, a2].includes(s.id) && s.state === 'running');
  expect(running).toHaveLength(2);
});

test('keys: Ctrl+1-9 switch projects', async ({ app, core }) => {
  const { a1, a2, b1, b2 } = seed(core);
  await openWindow(app, {}, core);
  await app.keyboard.press('Control+Digit2');
  expect(await ids(app)).toEqual([b1, b2]);
  await app.keyboard.press('Control+Digit1');
  expect(await ids(app)).toEqual([a1, a2]);
  await app.keyboard.press('Control+Digit9'); // no ninth project: nothing happens
  expect(await ids(app)).toEqual([a1, a2]);
  await app.keyboard.press('Meta+Digit2'); // ⌘ digits stay the shown project's tabs
  expect(await activeTab(app)).toBe(a2);
});

test('keys: rebound to Alt+1-9, the new key switches and Ctrl+2 does not', async ({ app, core }) => {
  const { a1, a2, b1, b2 } = seed(core);
  const bindings = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`project.jump.${n}`, [`Alt+Digit${n}`]]));
  await app.addInitScript((b) => localStorage.getItem('nunchiro.settings.v1') === null && localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ bindings: b })), bindings);
  await openWindow(app, {}, core);
  await app.keyboard.press('Control+Digit2');
  expect(await ids(app)).toEqual([a1, a2]);
  await app.keyboard.press('Alt+Digit2');
  expect(await ids(app)).toEqual([b1, b2]);
});

test('keys page: the project jumps are one row, "Go to project 1-9", ⌃1-9', async ({ app, core }) => {
  seed(core);
  await openWindow(app, {}, core);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  const row = app.locator('[data-keys-list] tr[data-command="project.jump"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.ktitle')).toHaveText('Go to project 1-9');
  await expect(row.locator('td').nth(1)).toHaveText(/^⌃1-9$/);
});

test('old layout: a saved window with no project fields loads; its tabs show under the project that has them', async ({ app, core }) => {
  const { a, a1, a2, b1, b2 } = seed(core);
  await app.addInitScript(([tabs, active]) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    // The state as it was written before this ticket: no selected, activeBy or tabProj.
    localStorage.setItem('nunchiro.window.v1', JSON.stringify({ tabs, active, seen: tabs, scroll: {}, at: Date.now() }));
  }, [[a1, b1, a2, b2], b2] as const);
  await openWindow(app, {}, core);
  await expect(app.locator('.tab[data-tab]')).toHaveCount(2);
  expect(await ids(app)).toEqual([b1, b2]); // the active tab's project is the selected one
  expect(await activeTab(app)).toBe(b2);
  await goto(app, a);
  expect(await ids(app)).toEqual([a1, a2]);
});

test('closing and moving a tab stay inside the shown project', async ({ app, core }) => {
  const { b, a1, a2, b1, b2 } = seed(core);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a2}"]`).click();
  await app.keyboard.press('Meta+KeyW');
  expect(await activeTab(app)).toBe(a1); // the neighbour in this strip
  await goto(app, b);
  expect(await ids(app)).toEqual([b1, b2]);
  await app.keyboard.press('Control+Digit1');
  expect(await ids(app)).toEqual([a1]);
});

test('empty strip: a session that starts in another project does not move the window', async ({ app, core }) => {
  const { a, b, a1, a2, b1, b2 } = seed(core);
  await openWindow(app, {}, core);
  await app.keyboard.press('Meta+KeyW');
  await app.keyboard.press('Meta+KeyW');
  await expect(app.locator('.tab[data-tab]')).toHaveCount(0); // the shown project has no tab left
  const late = core.shell(b, 'late').id;
  await expect(app.locator(`.row.head[data-project-path="${b}"]`)).toBeVisible();
  await app.waitForTimeout(1500); // the window has had its snapshot
  await expect(app.locator('.tab[data-tab]')).toHaveCount(0);
  await expect(app.locator(`.row.head[data-project-path="${a}"]`)).toHaveAttribute('data-selected', '');
  // Look 1117 v12 C-V8: the empty centre says the other project has tabs, and shows them.
  await expect(app.locator('.pane .empty')).toContainText('No tab open in alpha. beta has open tabs.');
  await app.locator('.pane .empty').getByRole('button', { name: 'Show beta' }).click();
  await expect.poll(() => ids(app)).toEqual([b1, b2, late]);
  expect([a1, a2]).not.toContain(await activeTab(app));
});

test('gone session: the next tab is in the shown project, not another project', async ({ app, core }) => {
  const { b, b1, b2 } = seed(core);
  const gone = new Set<string>();
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((raw) => {
      const m = typeof raw === 'string' ? JSON.parse(raw) : null;
      if (m?.event === 'snapshot') return ws.send(JSON.stringify({ ...m, sessions: m.sessions.filter((s: { id: string }) => !gone.has(s.id)) }));
      ws.send(raw);
    });
  });
  await openWindow(app, {}, core);
  await goto(app, b);
  expect(await activeTab(app)).toBe(b1);
  gone.add(b1); // the core no longer lists it; the next snapshot comes with a new session
  core.shell(core.project('alpha'), 'x');
  await expect(app.locator(`.tab[data-tab="${b1}"]`)).toHaveCount(0);
  expect(await ids(app)).toEqual([b2]);
  expect(await activeTab(app)).toBe(b2); // the old rule picked the tab before b1 in the flat list: alpha's
});
