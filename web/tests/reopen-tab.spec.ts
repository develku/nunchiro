// v25-reopen-tab (ticket 299): ⇧⌘T reopens the most recently closed tab of this window, like a browser; repeating it walks back
// through up to 10. A chat resumes its conversation, an ended terminal comes back as its own ended tab (look 1117 v10),
// a browser tab reopens its last URL; the tab returns to its old slot when that still exists, else at the end. Each spec starts
// from a real core; the closing is the tab's own × button, the reopening the key (and, for the basics, the visible controls).
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { chat, openChat, rec, append, test as chatTest } from './fixtures/chat/harness';

type Row = { id: string; kind: string; project: string; label: string; state: string; agent_session_id: string | null };
const snap = (core: Core) => core.cli('snapshot', '--json').sessions as Row[];
const tabIds = (p: Page) => p.locator('.tab[data-tab]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
const tab = (p: Page, id: string) => p.locator(`.tab[data-tab="${id}"]`);
const closeTab = async (p: Page, id: string) => (await tab(p, id).hover(), await tab(p, id).locator('..').locator('button.x').click()); // the × shows on hover
const reopen = (p: Page) => p.keyboard.press('Shift+Meta+KeyT');
const plus = (p: Page) => p.getByRole('button', { name: 'New session', exact: true });
const pop = (p: Page) => p.getByRole('dialog', { name: 'New tab' });
const REOPEN = 'Reopen closed tab';
/** The window has heard that the session ended: the "+" search lists it as a finished Session, not an Open tab (the core's
 *  snapshot reaches the window a moment after the CLI call returns, and ⇧⌘T decides from what the window knows). */
async function windowKnowsEnded(p: Page, label: string) {
  await plus(p).click();
  await p.keyboard.type(label);
  await expect(pop(p).getByRole('option', { name: label })).toContainText('Session');
  await p.keyboard.press('Escape');
  await expect(pop(p)).toHaveCount(0);
}

chatTest('reopen_closed_chat_resumes_conversation: a closed chat tab whose session ended comes back as the same conversation', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.user('닫기 전 질문'), rec.assistant('닫기 전 답'));
  await openChat(page, s.id);
  await closeTab(page, s.id);
  await expect(tab(page, s.id)).toHaveCount(0);
  chatCore.cli('session', 'close', s.id); // the conversation is over; only its saved session id is left
  await expect.poll(() => snap(chatCore).find((x) => x.id === s.id)?.state).toBe('closed');
  await windowKnowsEnded(page, 'chat');
  await reopen(page);
  await expect.poll(() => snap(chatCore).filter((x) => x.state === 'running').length).toBe(1);
  const live = snap(chatCore).find((x) => x.state === 'running')!;
  expect(live.id).not.toBe(s.id);
  expect(live.kind).toBe('claude');
  expect(live.agent_session_id).toBe(s.agent_session_id); // resumed by its saved id, as Restart session does
  await expect(tab(page, live.id)).toHaveAttribute('aria-selected', 'true');
  await expect(chat(page, live.id).getByText('닫기 전 답')).toBeVisible();
});

test('reopen_closed_terminal_returns_its_tab: a closed terminal tab whose shell ended comes back as that ended session, not a second shell of the same name (look 1117 v10)', async ({ app, core }) => {
  const p = core.project('demo');
  const keep = core.shell(p, 'keep').id;
  const old = core.shell(p, 'build').id;
  await openWindow(app);
  await closeTab(app, old);
  core.cli('session', 'close', old);
  await expect.poll(() => snap(core).find((x) => x.id === old)?.state).toBe('closed');
  await windowKnowsEnded(app, 'build');
  await reopen(app);
  await expect.poll(() => tabIds(app)).toEqual([keep, old]);
  await expect(tab(app, old)).toHaveAttribute('aria-selected', 'true');
  await app.waitForTimeout(300);
  expect(snap(core).filter((x) => x.label === 'build').map((x) => x.state)).toEqual(['closed']); // no new shell started
});

test('reopen_closed_running_session_returns_same_tab: closing a tab leaves the session running, so reopening shows that same session, not a second one', async ({ app, core }) => {
  const p = core.project('demo');
  const a = core.shell(p, 'one').id;
  const b = core.shell(p, 'two').id;
  await openWindow(app);
  await closeTab(app, a);
  expect(await tabIds(app)).toEqual([b]);
  await reopen(app);
  await expect.poll(() => tabIds(app)).toEqual([a, b]);
  await expect(tab(app, a)).toHaveAttribute('aria-selected', 'true');
  expect(snap(core).filter((x) => x.state === 'running')).toHaveLength(2);
});

const fakeApp = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __calls: [string, Record<string, unknown>][]; __TAURI_INTERNALS__: unknown };
    w.__calls = [];
    w.__TAURI_INTERNALS__ = { invoke: (cmd: string, args: Record<string, unknown>) => (w.__calls.push([cmd, args]), Promise.resolve(null)), transformCallback: () => 1, metadata: {} };
  });
const shows = (page: Page) => page.evaluate(() => (window as unknown as { __calls: [string, Record<string, unknown>][] }).__calls.filter((c) => c[0] === 'browser_show' || c[0] === 'browser_go').map((c) => c[1].url));

test('reopen_closed_browser_same_url: a closed Browser tab reopens at its last URL', async ({ app, core }) => {
  await fakeApp(app);
  const s = core.agent(core.project('alpha'), 'a', 'never-created', false); // the Browser tab belongs to an agent session
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Browser', exact: true }).click(); // ticket 997 L1: ⇧⌘B opens My browser's centre tab
  const pane = app.locator('[data-side-pane]:not([hidden])');
  await pane.getByLabel('Address').fill('http://example.com/docs');
  await pane.getByLabel('Address').press('Enter');
  await expect.poll(() => shows(app)).toContain('http://example.com/docs');
  await pane.getByRole('button', { name: 'More actions' }).click(); // ticket 997 L7: Forget page is in ⋯
  await pane.getByRole('menuitem', { name: /^Forget page/ }).click(); // the Browser tab's close
  await expect(pane.getByLabel('Address')).toHaveValue('');
  await app.locator(`.tab[data-tab="${s.id}"]`).click(); // focus off the pane's field
  await reopen(app);
  await expect(pane.getByLabel('Address')).toHaveValue('http://example.com/docs');
  await expect.poll(async () => (await shows(app)).filter((u) => u === 'http://example.com/docs').length).toBeGreaterThan(1);
});

test('reopen_walks_back_ten: repeating the key walks back through the newest ten closed tabs, newest first; older ones are forgotten', async ({ app, core }) => {
  const p = core.project('demo');
  const ids = Array.from({ length: 12 }, (_, i) => core.shell(p, `t${i}`).id);
  await openWindow(app);
  for (const id of ids) await closeTab(app, id);
  await expect(app.locator('.tab[data-tab]')).toHaveCount(0);
  for (let n = 1; n <= 10; n++) {
    await reopen(app);
    await expect.poll(() => tabIds(app)).toEqual(ids.slice(12 - n)); // t11, then t10 before it, ...
  }
  await reopen(app); // the 11th: t1 and t0 fell off the list
  await app.waitForTimeout(300);
  expect(await tabIds(app)).toEqual(ids.slice(2));
});

test('reopen_restores_position: the tab returns to its old slot while that slot exists, else at the end', async ({ app, core }) => {
  const p = core.project('demo');
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  await closeTab(app, b); // [a c d]
  await reopen(app);
  await expect.poll(() => tabIds(app)).toEqual([a, b, c, d]); // back in the middle
  await closeTab(app, c); // [a b d]
  await closeTab(app, d); // [a b]
  await closeTab(app, a); // [b]
  await closeTab(app, b); // []
  await reopen(app); // b was 2nd of [a b]: slot 1 does not exist in []
  await expect.poll(() => tabIds(app)).toEqual([b]);
  await reopen(app); // a was first
  await expect.poll(() => tabIds(app)).toEqual([a, b]);
  await reopen(app); // d was 3rd of [a b d]: slot 2 is the end
  await expect.poll(() => tabIds(app)).toEqual([a, b, d]);
  await reopen(app); // c was 3rd of [a b c d]
  await expect.poll(() => tabIds(app)).toEqual([a, b, c, d]);
});

test('reopen_disabled_when_nothing_closed: the menu item and the "+" row are disabled and say why; the key does nothing; closing a tab enables them', async ({ app, core }) => {
  const p = core.project('demo');
  const a = core.shell(p, 'one').id;
  const b = core.shell(p, 'two').id;
  await openWindow(app);
  const why = /closed/i;
  await tab(app, a).click({ button: 'right' });
  const item = app.getByRole('menu', { name: 'Actions' }).getByRole('menuitem', { name: REOPEN });
  await expect(item).toHaveAttribute('aria-disabled', 'true');
  await expect(item).toHaveAttribute('title', why);
  await app.keyboard.press('Escape');
  await plus(app).click();
  const row = pop(app).getByRole('option', { name: REOPEN });
  await expect(row).toHaveAttribute('aria-disabled', 'true');
  await expect(row).toHaveAttribute('title', why);
  await app.keyboard.press('Escape');
  await reopen(app);
  await app.waitForTimeout(200);
  expect(await tabIds(app)).toEqual([a, b]);
  expect(snap(core)).toHaveLength(2);
  await closeTab(app, a);
  await plus(app).click();
  await expect(pop(app).getByRole('option', { name: REOPEN })).not.toHaveAttribute('aria-disabled', 'true');
});

test('new_terminal_moved_to_ctrl_shift_backquote: the "+" row shows the chord (⌃⇧`, drawn ⌃~ like every shifted key) for New terminal, the chord starts it, and ⇧⌘T no longer does', async ({ app, core }) => {
  const alpha = core.project('alpha');
  core.shell(alpha, 'build-shell');
  await openWindow(app);
  await plus(app).click();
  await expect(pop(app).getByRole('option', { name: 'New terminal' }).locator('.kbd')).toHaveText('⌃~') // Control+Shift+Backquote: the key chip draws what Shift types, as for ⌘+ and prefix <;
  await expect(pop(app).getByRole('option', { name: REOPEN }).locator('.kbd')).toHaveText('⇧⌘T');
  await app.keyboard.press('Escape');
  await reopen(app); // nothing closed: no new terminal either
  await app.waitForTimeout(300);
  expect(snap(core).filter((x) => x.label !== 'build-shell')).toHaveLength(0);
  await app.keyboard.press('Control+Shift+Backquote');
  await expect.poll(() => snap(core).filter((x) => x.kind === 'shell' && x.label !== 'build-shell').length).toBe(1);
});

test('reopen_tab_menu_basics: the tab menu and the "+" popover items reopen by click and keyboard, Esc closes with focus returned, labelled and within 2 clicks', async ({ app, core }) => {
  const p = core.project('demo');
  const a = core.shell(p, 'one').id;
  const b = core.shell(p, 'two').id;
  await openWindow(app);
  await closeTab(app, a);
  // The tab menu, by the keyboard: Shift+F10 opens it on the focused tab, Esc closes it and the tab keeps focus.
  await tab(app, b).focus();
  await app.keyboard.press('Shift+F10');
  const menu = app.getByRole('menu', { name: 'Actions' });
  const item = menu.getByRole('menuitem', { name: REOPEN });
  await expect(item).not.toHaveAttribute('aria-disabled', 'true');
  await expect(item.locator('.kbd, kbd').first()).toContainText('⇧⌘T'); // its key is shown
  await app.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(tab(app, b)).toBeFocused();
  // 2 clicks: right-click a tab, then the item.
  await tab(app, b).click({ button: 'right' });
  await item.click();
  await expect.poll(() => tabIds(app)).toEqual([a, b]);
  await expect(item).toHaveCount(0);
  // 2 clicks: "+", then the row; the keyboard reaches it through the search field's list (typing filters, Enter runs it).
  await closeTab(app, b);
  await plus(app).click();
  await expect(pop(app)).toBeVisible();
  await app.keyboard.type('reopen');
  await expect(pop(app).getByRole('option', { name: REOPEN })).toBeVisible();
  await app.keyboard.press('Enter');
  await expect(pop(app)).toHaveCount(0);
  await expect.poll(() => tabIds(app)).toEqual([a, b]);
  await closeTab(app, a);
  await plus(app).click();
  await pop(app).getByRole('option', { name: REOPEN }).click();
  await expect(pop(app)).toHaveCount(0);
  await expect.poll(() => tabIds(app)).toEqual([a, b]);
});

test('reopen_after_undo_does_not_double: Undo of a close puts the tab back itself and drops its reopen entry, so the key adds nothing', async ({ app, core }) => {
  const p = core.project('demo');
  const a = core.shell(p, 'one').id;
  const b = core.shell(p, 'two').id;
  await openWindow(app);
  await closeTab(app, a);
  await app.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => tabIds(app)).toEqual([a, b]);
  await plus(app).click();
  await expect(pop(app).getByRole('option', { name: REOPEN })).toHaveAttribute('aria-disabled', 'true'); // nothing left to reopen
  await app.keyboard.press('Escape');
  await reopen(app);
  await app.waitForTimeout(300);
  expect(await tabIds(app)).toEqual([a, b]);
});
