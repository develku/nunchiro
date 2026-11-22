// Ticket 491 (같은 이름의 세션 두 개를 구별할 수 없음): two unlabeled Claude sessions in one project read apart, by one
// rule, in the tabs, the tree, the palette and the approval strip and card; "claude c026a0" (kind and id prefix) never shows.
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test, type Core } from './fixtures';
import { enable, freePort, pair, phone } from './web-access-shared';

// As realapp-detail-473.spec.ts: the fake waits for its trigger file (the --model value), then draws its text as its screen.
const FAKE = `#!/bin/sh
if [ "$1" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi
go=""; prev=""
for a in "$@"; do [ "$prev" = --model ] && go="$a"; prev="$a"; done
printf 'fake agent ready\\r\\n'
while [ ! -s "$go" ]; do sleep 0.02; done
draw() { printf '\\033[2J\\033[H'; cat "$go"; }
trap draw WINCH
draw
sleep 600
`;
const QUESTION = 'Red or blue?\r\n> 1. red\r\n  2. blue\r\nEnter to select · Esc to cancel\r\n';
const unlabeled = (core: Core, dir: string, trigger: string) =>
  core.cli('session', 'start', '--kind', 'claude', '--project', dir, '--model', path.join(dir, trigger)).session as { id: string };
/** As fixtures.ts stripOnTop, with the Decisions widget (the approval cards) in its own zone too. */
const stripAndCards = (core: Core) => {
  const zone = (id: string) => `\n[[root.children]]\nid = "${id}"\nwidgets = ["${id}"]\n`;
  fs.writeFileSync(path.join(core.home, 'layout.toml'), `version = 1\nlocked = false\n\n[root]\nid = "centre"\nsplit = "column"\n${zone('waiting') + zone('decisions') + zone('terminal') + zone('composer')}`);
};
const ID_NAME = /\bclaude [0-9a-f]{6}\b/;

test('same_name_sessions_read_apart: tabs, tree and palette number two unlabeled Claude sessions of one project', async ({ app, core }) => {
  fs.writeFileSync(path.join(core.home, 'bin/claude'), FAKE, { mode: 0o700 });
  const dir = core.project('same491');
  const a = unlabeled(core, dir, 'never-a');
  const b = unlabeled(core, dir, 'never-b');
  const other = core.project('other491');
  const lone = unlabeled(core, other, 'never-c');
  await openWindow(app, {}, core);
  const tabText = async (id: string) => (await app.locator(`.tab[data-tab="${id}"]`).innerText()).trim();
  await expect(app.locator(`.tab[data-tab="${a.id}"]`)).toContainText(/New Claude session( 2)?$/);
  const tabs = [await tabText(a.id), await tabText(b.id)];
  expect(new Set(tabs).size).toBe(2);
  // A lone unlabeled session in another project keeps the plain name (ticket 570: that project's strip shows it).
  await app.locator(`.row.head[data-project-path="${other}"] b`).click();
  await expect(app.locator(`.tab[data-tab="${lone.id}"]`)).toContainText(/New Claude session$/);
  await app.locator(`.row.head[data-project-path="${dir}"] b`).click();
  // The tree's rows (a button named "<name>, <state>").
  // Ticket 991 A21 (491 kept): the first is plain, the second "2". The other project's lone session is plain too.
  await expect(app.getByRole('button', { name: /^New Claude session, / })).toHaveCount(2);
  await expect(app.getByRole('button', { name: /^New Claude session 2, / })).toHaveCount(1);
  await app.keyboard.press('Meta+k');
  await app.getByRole('combobox').first().fill('New Claude');
  const pal = (id: string) => app.locator(`#palette-list [data-command="session.open.${id}"]`).innerText();
  await expect(app.locator(`#palette-list [data-command="session.open.${a.id}"]`)).toBeVisible();
  expect(await pal(a.id)).not.toBe(await pal(b.id));
  expect(await pal(a.id)).toContain('New Claude session ');
});

test('same_name_card_and_strip: an asking unlabeled session is named as its tab, never by kind and id prefix', async ({ app, core }) => {
  stripAndCards(core);
  fs.writeFileSync(path.join(core.home, 'bin/claude'), FAKE, { mode: 0o700 });
  const dir = core.project('card491');
  unlabeled(core, dir, 'never');
  const asker = unlabeled(core, dir, 'go');
  await openWindow(app, {}, core);
  fs.writeFileSync(path.join(dir, 'go'), QUESTION);
  await expect(app.locator('#waiting-strip .qcard')).toHaveCount(1, { timeout: 10_000 });
  const tab = (await app.locator(`.tab[data-tab="${asker.id}"]`).innerText()).trim();
  expect(tab).toMatch(/New Claude session( 2)?$/);
  const shown = tab.match(/New Claude session( 2)?$/)![0];
  // The strip: the same number as the tab (one rule), even though only one of the two asks.
  await expect(app.locator('#waiting-strip .qcard .who')).toHaveText(shown);
  // The tree's decision line and the chat's approval card.
  await expect(app.locator('.tree')).not.toContainText(ID_NAME);
  await expect(app.locator('body')).not.toContainText(ID_NAME);
  const card = app.locator(`.deccard[data-session="${asker.id}"]`);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('aria-label', new RegExp(shown));
});

test('same_name_paired_browser: two unlabeled askers read apart on the paired browser page too', async ({ app, core, browser }) => {
  test.setTimeout(60_000);
  fs.writeFileSync(path.join(core.home, 'bin/claude'), FAKE, { mode: 0o700 });
  const dir = core.project('pair491');
  unlabeled(core, dir, 'go-a');
  unlabeled(core, dir, 'go-b');
  const port = await freePort();
  await enable(app, port);
  const { page } = await phone(browser, `http://127.0.0.1:${port}/`);
  await pair(app, page);
  for (const t of ['go-a', 'go-b']) fs.writeFileSync(path.join(dir, t), QUESTION);
  const cards = page.getByRole('article', { name: /is waiting$/ });
  await expect(cards).toHaveCount(2, { timeout: 10_000 });
  const names = (await cards.evaluateAll((as) => as.map((a) => a.getAttribute('aria-label')!))).sort();
  expect(names).toEqual(['New Claude session 2 is waiting', 'New Claude session is waiting']);
  await expect(page.locator('body')).not.toContainText(ID_NAME);
});

test('same_name_shells: two unlabeled terminals of one project are numbered too', async ({ app, core }) => {
  const dir = core.project('shell491');
  const a = core.cli('session', 'start', '--kind', 'shell', '--project', dir, '--', '/bin/cat').session as { id: string };
  const b = core.cli('session', 'start', '--kind', 'shell', '--project', dir, '--', '/bin/cat').session as { id: string };
  await openWindow(app, {}, core);
  const tab = (id: string) => app.locator(`.tab[data-tab="${id}"]`);
  await expect(tab(a.id)).toContainText(/New terminal( 2)?$/);
  expect((await tab(a.id).innerText()).trim()).not.toBe((await tab(b.id).innerText()).trim());
});

// Ticket 991 A21 (ticket 491 kept): a name never changes by itself. The first terminal is plain and stays plain when a
// second ("2") and a third ("3") arrive; when the second closes, its own tab stays "2", the third stays "3" and a fourth is
// "4", not "2"; a reload keeps every name.
test('same_name_number_is_stable_A21', async ({ app, core }) => {
  const dir = core.project('stable991');
  const start = () => core.cli('session', 'start', '--kind', 'shell', '--project', dir, '--', '/bin/cat').session as { id: string };
  const a = start();
  await openWindow(app, {}, core);
  const tab = (id: string) => app.locator(`.tab[data-tab="${id}"] .tname`);
  await expect(tab(a.id)).toHaveText('New terminal');
  const b = start();
  await expect(tab(b.id)).toHaveText('New terminal 2');
  const c = start();
  await expect(tab(c.id)).toHaveText('New terminal 3');
  await expect(tab(a.id)).toHaveText('New terminal');
  core.windowClose(b.id); // ticket 1013 F6: the window's own Close keeps the done tab
  await expect(app.locator(`.tab[data-tab="${b.id}"] .tdot`)).toHaveAttribute('data-s', 'done'); // look 1117 v14 O1: the closed tab keeps its own name
  await expect(tab(b.id)).toHaveText('New terminal 2');
  const d = start();
  await expect(tab(d.id)).toHaveText('New terminal 4');
  await expect(tab(c.id)).toHaveText('New terminal 3');
  await app.reload();
  await expect(tab(a.id)).toHaveText('New terminal');
  await expect(tab(c.id)).toHaveText('New terminal 3');
  await expect(tab(d.id)).toHaveText('New terminal 4');
});
