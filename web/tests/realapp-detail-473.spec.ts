// Ticket 473 (실제 앱에서 본 디테일 정리): detail faults the coordinator saw in the real RC app on 11-12. A tab of an unlabeled
// session does not repeat its agent; two unlabeled sessions of one agent in one project read apart in the approval strip;
// the Diff sidebar has one "Diff" title. Shots go to .scratch/shots (SHOT_TAG names before or after).
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, stripOnTop, test, type Core } from './fixtures';

const SHOTS = path.join(REPO, '.scratch/shots');
const tag = process.env.SHOT_TAG ?? 'after';
const shot = (name: string) => path.join(SHOTS, `473-${name}-${tag}-${test.info().project.name}.png`);

// The fake agent waits for its trigger file (the --model value), then draws the file's text as its screen.
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

test('tab_title_names_agent_once: an unlabeled session tab shows its name alone; a labelled one keeps "<kind> · <label>"', async ({ app, core }) => {
  const dir = core.project('tabs473');
  core.shell(dir, 'build');
  const bare = unlabeled(core, dir, 'never');
  await openWindow(app, {}, core);
  const tab = app.locator(`.tab[data-tab="${bare.id}"]`);
  await expect(tab).toContainText('New Claude session');
  fs.mkdirSync(SHOTS, { recursive: true });
  await app.locator('.tabs').screenshot({ path: shot('tabs') });
  await expect(tab).not.toContainText('claude ·');
  await expect(app.locator('.tabs')).toContainText('shell · build');
});

test('strip_tells_colliding_sessions_apart: two unlabeled Claude sessions in one project asking at once get a number each', async ({ app, core }) => {
  stripOnTop(core);
  fs.writeFileSync(path.join(core.home, 'bin/claude'), FAKE, { mode: 0o700 });
  const dir = core.project('strip473');
  unlabeled(core, dir, 'go-a');
  unlabeled(core, dir, 'go-b');
  await openWindow(app, {}, core);
  for (const t of ['go-a', 'go-b']) fs.writeFileSync(path.join(dir, t), QUESTION);
  await expect(app.locator('#waiting-strip .qmore')).toHaveText('+1', { timeout: 10_000 });
  await app.locator('#waiting-strip').screenshot({ path: shot('strip') });
  await expect(app.locator('#waiting-strip .qcard .who')).toHaveText(/^New Claude session( 2)?$/);
  // 485: both askers read apart, not just the front card: each tree line is brought into the strip in turn.
  const items = await app.locator('.tree .q[data-item]').evaluateAll((qs) => qs.map((q) => q.getAttribute('data-item')!));
  expect(items).toHaveLength(2);
  const whos = new Set<string>();
  for (const id of items) {
    await app.evaluate((i) => window.dispatchEvent(new CustomEvent('nunchiro:queue.focus', { detail: { id: i } })), id);
    await expect(app.locator(`#waiting-strip .qcard[data-item="${id}"]`)).toBeVisible();
    whos.add(await app.locator(`#waiting-strip .qcard[data-item="${id}"] .who`).innerText());
  }
  expect([...whos].sort()).toEqual(['New Claude session', 'New Claude session 2']); // ticket 991 A21: the first keeps the plain name
});

// 485: the fake agent takes an answer (one line, as queue.spec.ts's fake) and clears its screen.
const ANSWERS = FAKE.replace('draw\nsleep 600', "draw\nuntil read x; do :; done\nprintf '\\033[2J\\033[Hanswered\\r\\n'\nsleep 600");

test('strip_gone_card_keeps_name: with three colliding askers, the answered one\'s line never reads "New Claude session 0"', async ({ app, core }) => {
  expect(ANSWERS).not.toBe(FAKE);
  stripOnTop(core);
  fs.writeFileSync(path.join(core.home, 'bin/claude'), ANSWERS, { mode: 0o700 });
  const dir = core.project('gone485');
  for (const t of ['go-a', 'go-b', 'go-c']) unlabeled(core, dir, t);
  await openWindow(app, {}, core);
  for (const t of ['go-a', 'go-b', 'go-c']) fs.writeFileSync(path.join(dir, t), QUESTION);
  const strip = app.locator('#waiting-strip');
  await expect(strip.locator('.qmore')).toHaveText('+2', { timeout: 10_000 });
  // The pointer stays on the strip, so the answered card keeps its line (as "gone").
  const card = strip.locator('.qcard').first();
  await card.locator('.what').click();
  await card.getByRole('button', { name: /1 red/ }).click();
  const gone = strip.locator('.qcard.gone .who');
  await expect(gone).toHaveCount(1, { timeout: 10_000 });
  fs.mkdirSync(SHOTS, { recursive: true });
  await strip.screenshot({ path: shot('gone') });
  await expect(gone).toHaveText(/^New Claude session( [123])?$/);
});

test('strip_numbers_only_askers: a lone asker with a closed unlabeled sibling in its project has no number', async ({ app, core }) => {
  stripOnTop(core);
  fs.writeFileSync(path.join(core.home, 'bin/claude'), FAKE, { mode: 0o700 });
  const dir = core.project('lone473');
  core.cli('session', 'close', unlabeled(core, dir, 'never').id);
  unlabeled(core, dir, 'go-a');
  await openWindow(app, {}, core);
  fs.writeFileSync(path.join(dir, 'go-a'), QUESTION);
  await expect(app.locator('#waiting-strip .qcard')).toHaveCount(1, { timeout: 10_000 });
  await expect(app.locator('#waiting-strip .qcard .who')).toHaveText('New Claude session');
});

test('sidebar_title_once: Diff, Files and Artifacts in a sidebar show their title once, in the sidebar head', async ({ app, core }) => {
  const dir = core.project('diff473');
  core.shell(dir, 'build');
  await openWindow(app, {}, core);
  for (const name of ['Files', 'Diff', 'Artifacts']) {
    const b = app.getByRole('button', { name, exact: true }).first();
    await b.click();
    const bar = app.locator(`.sbar[data-widget="${name.toLowerCase()}"]`);
    await expect(bar.locator('.sbh')).toContainText(name);
    await bar.screenshot({ path: shot(`sidebar-${name.toLowerCase()}`) });
    // The sidebar head names the widget; the widget's own head below it does not say it again.
    expect(await bar.locator('.sbb .ph').first().innerText()).not.toMatch(new RegExp(`\\b${name}\\b`));
    await b.click();
  }
});

test('palette_go_to_translated: a session row of the palette is in the window language and still ranks by its name', async ({ app, core }) => {
  const dir = core.project('pal473');
  const s = core.shell(dir, 'build');
  await openWindow(app, {}, core);
  await app.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: 'ko' })));
  await app.reload();
  await expect(app.locator('html')).toHaveAttribute('lang', 'ko');
  await app.keyboard.press('Meta+k');
  await app.getByRole('combobox').first().fill('build');
  const row = app.locator(`#palette-list [data-command="session.open.${s.id}"]`);
  await expect(row).toBeVisible();
  await app.locator('.palette').screenshot({ path: shot('palette-ko') });
  await expect(row).toContainText('build(pal473) 세션으로 이동');
  await expect(app.locator('#palette-list [data-command]').first()).toHaveAttribute('data-command', `session.open.${s.id}`);
});

test('fold_note_in_user_words: a sidebar folded for room says so without a column count', async ({ app, core }) => {
  core.shell(core.project('fold473'), 'build');
  await app.setViewportSize({ width: 900, height: 700 });
  await openWindow(app, {}, core);
  await app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Diff' }).click();
  const note = app.locator('.foldnote');
  await expect(note).toContainText('folded', { timeout: 5000 });
  await app.locator('.status, footer').first().screenshot({ path: shot('foldnote') }).catch(() => app.screenshot({ path: shot('foldnote') }));
  await expect(note).toHaveText(/ folded to make room$/);
});
