// V2.5-41 rc2b-fb (needs 190 (2)): bugs the owner found on the installed RC2b, one named test per item.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, test } from './fixtures';
import { cardOf, openBoard, seed } from './fixtures/board/coord';

/** Stops the core (agents end) and starts it again, then reloads the window on the new core. */
async function restart(app: Page, core: Core) {
  core.cli('serve', 'stop');
  await core.restart();
  await app.addInitScript((boot) => (window.__NUNCHIRO__ = boot), core.boot());
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
}

// needs 207 (v25-quiet-chat) retires the bar this test dismissed (needs 190 (2)): after a restart, and after a reload, no resume
// bar shows for a resumable session, however many there are; there is nothing left to dismiss. v25-shell-chrome (ticket 282):
// the window comes back with the tab the session had, read-only until it is restarted.
test('resume_bar_dismiss: no resume bar after a core restart or a reload, so nothing to dismiss', async ({ app, core }) => {
  const project = core.project('demo');
  core.agent(project, 'alpha', path.join(project, 'never'));
  await openWindow(app);
  await restart(app, core);
  const offer = app.getByRole('region', { name: 'Sessions to resume' });
  await expect(offer).toHaveCount(0);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(app.locator('.tab[data-tab]')).toHaveCount(1); // the tab alpha had is restored
  await expect(offer).toHaveCount(0);
  expect(core.cli('snapshot', '--json').sessions[0].state).toBe('resumable'); // nothing resumed by itself
  core.agent(project, 'beta', path.join(project, 'never'));
  await restart(app, core);
  await expect(offer).toHaveCount(0);
  await expect(app.locator('.resume')).toHaveCount(0);
});

// Every session.* and tab.* command row on the Keys page names its action with a verb; the three the owner confused differ.
// The ticket 290 New tab rows (session.new.terminal, .claude, .codex, tab.new.browser) are titled "New <thing> ..." on purpose, as the popover rows are.
const VERB_EN = /^(Create|Go|Move|Close|Rename|Stop|Open|Copy|New|Reopen) /;
const SAY_EN: Record<string, string> = {
  'session.new': 'Create a new session…',
  'session.next': 'Go to the next tab',
  'session.prev': 'Go to the previous tab',
  'session.last': 'Go back to the last tab (toggle)',
  'session.jump': 'Go to tab 1-9',
  'tab.rename': 'Rename the session tab',
  'tab.close': 'Close tab',
  'tab.move.left': 'Move the tab left',
  'tab.move.right': 'Move the tab right',
};
const SAY_KO: Record<string, string> = {
  'session.new': '새 세션 만들기',
  'session.next': '다음 탭으로 이동',
  'session.prev': '이전 탭으로 이동',
  'session.last': '바로 전에 보던 탭으로 돌아가기',
  'session.jump': '1~9번 탭으로 바로 가기',
  'tab.rename': '탭 이름 바꾸기',
  'tab.close': '탭 닫기',
  'tab.move.left': '탭을 왼쪽으로 옮기기',
  'tab.move.right': '탭을 오른쪽으로 옮기기',
};

test('keymap_labels_say_the_verb: session and tab rows say create, go to or move, in English and Korean, ids and keys unchanged', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  core.shell(core.project('demo'), 'beta');
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  const rows = app.locator('[data-keys-list] tr[data-command^="session."], [data-keys-list] tr[data-command^="tab."]');
  const titles = async () => Object.fromEntries(await rows.evaluateAll((trs) => trs.map((tr) => [tr.getAttribute('data-command')!, tr.querySelector('td')!.firstChild!.textContent!.trim()])));
  const en = await titles();
  for (const [id, title] of Object.entries(SAY_EN)) expect(en[id], id).toBe(title);
  for (const [id, title] of Object.entries(en)) expect(title, id).toMatch(VERB_EN);
  // Default keys stay: Create a new session is still ⌘T, the next tab still ⌘} (⇧⌘]).
  await expect(app.locator('tr[data-command="session.new"] td').nth(1)).toContainText('⌘T');
  await expect(app.locator('tr[data-command="session.next"] td').nth(1)).toContainText('⌘}');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'General' }).click();
  await app.getByRole('combobox', { name: /Language/ }).selectOption({ label: '한국어' });
  await expect(app.locator('html')).toHaveAttribute('lang', 'ko');
  await app.getByRole('navigation').getByRole('button', { name: '키보드' }).click();
  await expect(rows.first()).toBeVisible();
  const ko = await titles();
  for (const [id, title] of Object.entries(SAY_KO)) expect(ko[id], id).toBe(title);
  // No session or tab row is left in English; ticket 473 translated the per-session "Go to <name> (<project>)" rows too.
  for (const [id, title] of Object.entries(ko)) expect(title, id).toMatch(/[가-힣]/);
});

test('settings_view_scrolls_to_end: with a sized composer zone, Settings fills its modal and its longest page scrolls to its last row', async ({ app, core }) => {
  // The owner's window: the composer zone was dragged to a size (layout.toml `size`), so it keeps its height with nothing in it.
  fs.writeFileSync(
    path.join(core.home, 'layout.toml'),
    'version = 1\nlocked = false\n\n[root]\nid = "centre"\nsplit = "column"\n\n[[root.children]]\nid = "terminal"\nwidgets = ["terminal"]\n\n[[root.children]]\nid = "composer"\nsize = 400\nwidgets = ["composer"]\n',
  );
  const project = core.project('demo');
  core.agent(project, 'alpha', path.join(project, 'never'));
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  const settings = app.getByRole('region', { name: 'Settings', exact: true });
  const bottom = async (l: ReturnType<Page['locator']>) => (await l.boundingBox())!.y + (await l.boundingBox())!.height;
  const status = app.getByRole('dialog', { name: 'Settings' }); // v25f: Settings is a modal; its panel is the frame
  // No blank band: the view ends where the modal panel ends.
  expect(Math.abs((await bottom(settings)) - (await bottom(status)))).toBeLessThan(8);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  const body = settings.locator('.sbody');
  await body.evaluate((e) => (e.scrollTop = e.scrollHeight));
  const last = body.locator('.keys-page > :last-child'); // needs 192 (ticket 250): the hints part ends the Keyboard page
  await expect(last).toBeInViewport();
  expect(await bottom(last)).toBeLessThanOrEqual(await bottom(status));
  // Back on the session, its composer zone keeps the size it was given.
  await app.keyboard.press('Escape');
  await expect.poll(async () => Math.round((await app.locator('[data-zone-id="composer"]').boundingBox())?.height ?? 0)).toBe(400);
});

test('done_card_opens_details: a task card in Done opens its history and receipt in place on click and Enter, no editor', async ({ app, core }) => {
  seed(core, [
    { id: '10', title: 'Five columns', column: 'done', receipt: { sha: '0123456789abcdef', command: 'cargo test', result: 'pass' }, history: [{ actor: 'owner', kind: 'create', from: null, to: 'todo' }, { actor: 'coord-1031', kind: 'move', from: 'review', to: 'done' }] },
    { id: '12', title: 'Still working', column: 'working' },
  ]);
  await openBoard(app, core);
  const done = cardOf(app, 'Five columns');
  await expect(done.locator('.brc')).toHaveText('0123456 · cargo test · pass');
  const history = done.getByRole('group', { name: 'History' });
  await expect(history).toHaveCount(0);
  await done.locator('.bmain').click();
  await expect(history).toBeVisible();
  await expect(history).toContainText('coord-1031');
  await expect(app.getByRole('dialog', { name: 'Edit card' })).toHaveCount(0);
  await done.locator('.bmain').click(); // again closes it
  await expect(history).toHaveCount(0);
  await done.locator('.bmain').press('Enter');
  await expect(history).toBeVisible();
  await expect(app.getByRole('dialog', { name: 'Edit card' })).toHaveCount(0);
  // Other columns keep theirs: a task card in Working opens the editor.
  await cardOf(app, 'Still working').locator('.bmain').click();
  await expect(app.getByRole('dialog', { name: 'Edit card' })).toBeVisible();
});

test('centre_chat_can_be_added_back: the centre chat zone is refused removal with a reason (needs 106), so it never needs adding back', async ({ app, core }) => {
  const project = core.project('demo');
  core.agent(project, 'alpha', path.join(project, 'never'));
  await openWindow(app);
  await app.locator('.ib.r').getByRole('button', { name: 'Layout', exact: true }).click();
  await app.getByRole('button', { name: /^Remove .* from the Chat zone$/ }).click();
  await expect(app.locator('.emsg[data-error="true"]')).toHaveText('The centre chat stays in the window: place other widgets beside it');
  // Still there, and still the chat: its zone and the session's composer.
  await expect(app.locator('[data-zone-id="terminal"]')).toHaveCount(1);
  await app.getByRole('button', { name: 'Done', exact: true }).first().click();
  await expect(app.locator('[data-zone-id="terminal"]')).toBeVisible();
  // Other zones still go: the composer zone is removed as before.
  await app.locator('.ib.r').getByRole('button', { name: 'Layout', exact: true }).click();
  await app.getByRole('button', { name: /^Remove .* from the Composer zone$/ }).click();
  await expect(app.locator('[data-zone-id="composer"]')).toHaveCount(0);
});

const rightIcon = (app: Page, name: string) => app.locator('.ib.r').getByRole('button', { name, exact: true });
const toast = (app: Page) => app.locator('.toast[role="status"] > span').first();

test('browser_widget_opens_or_is_not_clickable: the Browser icon opens the session side pane on Browser, or says why', async ({ app, core }) => {
  const project = core.project('demo');
  core.shell(project, 'sh');
  await openWindow(app);
  // A shell has no agent browser: the click opens the user's own (ticket 288: no refusal).
  await rightIcon(app, 'Browser').click();
  await expect(app.locator('aside.sbar[data-side="right"]').getByLabel('Browser space')).toHaveValue('you');
  // With an agent session open, the side pane shows its Browser tab with the address field.
  core.agent(project, 'alpha', path.join(project, 'never'));
  await expect(app.locator('.tab[data-tab]')).toHaveCount(2);
  await app.locator('.tab[data-tab]', { hasText: 'alpha' }).click();
  await rightIcon(app, 'Browser').click();
  await expect(app.locator('.spane')).toBeVisible();
  await expect(app.locator('.spane input[placeholder="Search or URL"]')).toBeVisible();
});

test('search_icon_focuses_input: clicking the Search icon opens the panel with its field focused, so typing lands there', async ({ app, core }) => {
  core.shell(core.project('demo'), 'sh');
  await openWindow(app);
  await app.locator('.ib.l').getByRole('button', { name: 'Search', exact: true }).click();
  const field = app.locator('.spanel .sscope:not([hidden]) input[type="search"]');
  await expect(field).toBeFocused();
  await app.keyboard.type('needle');
  await expect(field).toHaveValue('needle');
});

test('right_bar_icon_never_silent: the Terminal icon toggles the side pane, or says why when there is no live agent', async ({ app, core }) => {
  const project = core.project('demo');
  const shell = core.shell(project, 'sh');
  await openWindow(app);
  await rightIcon(app, 'Terminal').click();
  await expect(toast(app)).toHaveText('This session shows its terminal in the centre');
  const alpha = core.agent(project, 'alpha', path.join(project, 'never'));
  await expect(app.locator('.tab[data-tab]')).toHaveCount(2);
  await app.locator('.tab[data-tab]', { hasText: 'alpha' }).click();
  await rightIcon(app, 'Terminal').click();
  await expect(app.locator('.spane')).toBeVisible();
  await rightIcon(app, 'Terminal').click();
  await expect(app.locator('.spane')).toHaveCount(0);
  // Ended: no pane to open, and the click says so.
  await expect(app.locator('.tabw', { hasText: 'alpha' }).locator('.tdot')).not.toHaveAttribute('data-s', 'done'); // running: the wait below is not vacuous
  core.windowClose(alpha.id); // ticket 1013 F6: the window's own Close keeps the done tab
  await expect(app.locator('.tab[data-tab]', { hasText: 'alpha' })).toHaveCount(1);
  // The window learns of the close over its stream: the tab's dot reads done once its state is no longer
  // running, which is the state the click reads (useRails iconClick). Waiting for it replaces a race with a signal.
  await expect(app.locator('.tabw', { hasText: 'alpha' }).locator('.tdot')).toHaveAttribute('data-s', 'done');
  // Real-app 11-10 defect M (replaces ticket 288's restart here): the click never restarts it; its tab stays. Ticket 1037: it
  // opens a new shell in the project instead.
  const tabs = await app.locator('.tab[data-tab]').count();
  await rightIcon(app, 'Terminal').click();
  await expect(app.locator('.tab[data-tab]')).toHaveCount(tabs + 1);
  expect((core.cli('snapshot', '--json').sessions as { kind: string; label: string; state: string }[]).filter((x) => x.kind === 'claude' && x.label === 'alpha' && x.state === 'running')).toHaveLength(0);
  await expect(app.locator('.tab[data-tab]', { hasText: 'alpha' })).toHaveCount(1);
  expect(shell.id).toBeTruthy();
});

test('layout_zone_label_matches_content: in Layout edit the centre zone that shows the chat is labelled Chat', async ({ app, core }) => {
  const project = core.project('demo');
  core.agent(project, 'alpha', path.join(project, 'never'));
  await openWindow(app);
  await rightIcon(app, 'Layout').click();
  await expect(app.locator('[data-zone-id="terminal"] .zl b')).toHaveText('Chat');
  // Ticket 511: since lane 508 a built-in zone is named after its widget (TITLE), not its lower-case id.
  await expect(app.locator('[data-zone-id="composer"] .zl b')).toHaveText('Composer');
});

test('settings_keeps_picked_composer_tab: a zone whose picked tab is the composer keeps its size and tab behind the Settings modal (v25f)', async ({ app, core }) => {
  // The lower zone stacks Diff (its default tab) and the Composer; the user picks the Composer tab.
  fs.writeFileSync(
    path.join(core.home, 'layout.toml'),
    'version = 1\nlocked = false\n\n[root]\nid = "centre"\nsplit = "column"\n\n[[root.children]]\nid = "terminal"\nwidgets = ["terminal"]\n\n[[root.children]]\nid = "lower"\nsize = 400\nwidgets = ["diff", "composer"]\n',
  );
  const project = core.project('demo');
  core.agent(project, 'alpha', path.join(project, 'never'));
  await openWindow(app);
  await app.locator('[data-zone-id="lower"] .ztabs').getByRole('tab', { name: 'Composer' }).click();
  await app.keyboard.press('Meta+Comma');
  await expect(app.getByRole('region', { name: 'Settings', exact: true })).toBeVisible();
  // Nothing behind the modal steps aside: the zone keeps its size and its picked tab.
  expect(Math.round((await app.locator('[data-zone-id="lower"]').boundingBox())!.height)).toBe(400);
  await expect(app.locator('[data-zone-id="lower"] .ztabs').getByRole('tab', { name: 'Composer' })).toHaveAttribute('aria-selected', 'true');
  await app.keyboard.press('Escape');
  await expect.poll(async () => Math.round((await app.locator('[data-zone-id="lower"]').boundingBox())?.height ?? 0)).toBe(400);
});

test('centre_chat_cli_refused: `nunchiro layout remove` of the centre chat is refused with the reason and leaves layout.toml as it was', async ({ app, core }) => {
  const project = core.project('demo');
  core.agent(project, 'alpha', path.join(project, 'never'));
  await openWindow(app);
  core.cli('layout', 'resize', 'composer', '120'); // a layout.toml on disk to compare against
  const file = path.join(core.home, 'layout.toml');
  const before = fs.readFileSync(file, 'utf8');
  expect(() => core.cli('layout', 'remove', '--zone', 'terminal')).toThrow(/The centre chat stays in the window/);
  expect(() => core.cli('layout', 'remove', 'terminal')).toThrow(/The centre chat stays in the window/);
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  await expect(app.locator('[data-zone-id="terminal"]')).toBeVisible();
  // The store is whole: the next command runs on it as usual.
  expect(core.cli('layout', 'remove', '--zone', 'composer')).toBeTruthy();
  await expect(app.locator('[data-zone-id="composer"]')).toHaveCount(0);
});
