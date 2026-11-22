// Ticket 1017 (첫 메시지가 새 세션 이름을 바꿈): two sessions the first message named alike ("ASK") read "ASK 1" and
// "ASK 2" in the approval strip, the tabs, the tree and the palette; a different name stays plain and a name the user set
// is never numbered. Shots go to .scratch/shots (SHOT_TAG names before or after).
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, stripOnTop, test, type Core } from './fixtures';

const SHOTS = path.join(REPO, '.scratch/shots');
const tag = process.env.SHOT_TAG ?? 'after';
const shot = (name: string) => path.join(SHOTS, `1017-${name}-${tag}-${test.info().project.name}.png`);

// As same-name-491.spec.ts: the fake waits for its trigger file (the --model value), then draws its text as its screen.
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
const start = (core: Core, dir: string, trigger: string) =>
  core.cli('session', 'start', '--kind', 'claude', '--project', dir, '--model', path.join(dir, trigger)).session as { id: string };
/** The first message names the session, as Claude's prompt hook does. */
const firstMessage = (core: Core, id: string, prompt: string) => core.hook(id, 'UserPromptSubmit', { prompt });

test('same_first_message_names_are_numbered_1017: two "ASK" sessions asking at once read ASK 1 and ASK 2', async ({ app, core }) => {
  stripOnTop(core);
  fs.writeFileSync(path.join(core.home, 'bin/claude'), FAKE, { mode: 0o700 });
  const dir = core.project('ask1017');
  const a = start(core, dir, 'go-a');
  const b = start(core, dir, 'go-b');
  const c = start(core, dir, 'never-c');
  firstMessage(core, a.id, 'ASK');
  firstMessage(core, b.id, 'ASK');
  firstMessage(core, c.id, 'Other work');
  await openWindow(app, {}, core);
  const tab = (id: string) => app.locator(`.tab[data-tab="${id}"] .tname`);
  await expect(tab(a.id)).toHaveText('ASK 1');
  await expect(tab(b.id)).toHaveText('ASK 2');
  await expect(tab(c.id)).toHaveText('Other work'); // a different name stays plain
  for (const t of ['go-a', 'go-b']) fs.writeFileSync(path.join(dir, t), QUESTION);
  await expect(app.locator('#waiting-strip .qmore')).toHaveText('+1', { timeout: 10_000 });
  await app.locator('#waiting-strip').screenshot({ path: shot('strip') });
  // Both askers read apart in the strip: each tree line is brought into the strip in turn (as 473's spec does).
  const items = await app.locator('.tree .q[data-item]').evaluateAll((qs) => qs.map((q) => q.getAttribute('data-item')!));
  expect(items).toHaveLength(2);
  const whos = new Set<string>();
  for (const id of items) {
    await app.evaluate((i) => window.dispatchEvent(new CustomEvent('nunchiro:queue.focus', { detail: { id: i } })), id);
    await expect(app.locator(`#waiting-strip .qcard[data-item="${id}"]`)).toBeVisible();
    whos.add(await app.locator(`#waiting-strip .qcard[data-item="${id}"] .who`).innerText());
  }
  expect([...whos].sort()).toEqual(['ASK 1', 'ASK 2']);
  await app.locator('.tabs').screenshot({ path: shot('tabs') });
  await expect(app.getByRole('button', { name: /^ASK 1, / })).toHaveCount(1);
  await expect(app.getByRole('button', { name: /^ASK 2, / })).toHaveCount(1);
  await app.keyboard.press('Meta+k');
  await app.getByRole('combobox').first().fill('ASK');
  await expect(app.locator(`#palette-list [data-command="session.open.${a.id}"]`)).toContainText('ASK 1');
  await expect(app.locator(`#palette-list [data-command="session.open.${b.id}"]`)).toContainText('ASK 2');
});

test('hand_set_name_is_never_numbered_1017: the user names a session "ASK" beside a first-message "ASK"', async ({ app, core }) => {
  fs.writeFileSync(path.join(core.home, 'bin/claude'), FAKE, { mode: 0o700 });
  const dir = core.project('hand1017');
  const auto = start(core, dir, 'never-a');
  const hand = core.cli('session', 'start', '--kind', 'claude', '--project', dir, '--label', 'ASK', '--model', path.join(dir, 'never-b')).session as { id: string };
  firstMessage(core, auto.id, 'ASK');
  await openWindow(app, {}, core);
  const tab = (id: string) => app.locator(`.tab[data-tab="${id}"] .tname`);
  await expect(tab(auto.id)).toHaveText('ASK 1');
  await expect(tab(hand.id)).toHaveText('ASK');
});

test('twin_number_follows_the_names_1017: a twin renamed by hand leaves the other unique and plain; renamed back, it is numbered again', async ({ app, core }) => {
  fs.writeFileSync(path.join(core.home, 'bin/claude'), FAKE, { mode: 0o700 });
  const dir = core.project('rename1017');
  const a = start(core, dir, 'never-a');
  const b = start(core, dir, 'never-b');
  firstMessage(core, a.id, 'ASK');
  firstMessage(core, b.id, 'ASK');
  await openWindow(app, {}, core);
  const tab = (id: string) => app.locator(`.tab[data-tab="${id}"] .tname`);
  await expect(tab(a.id)).toHaveText('ASK 1');
  await expect(tab(b.id)).toHaveText('ASK 2');
  core.cli('session', 'label', a.id, 'my-hand-name');
  await expect(tab(a.id)).toHaveText('my-hand-name');
  await expect(tab(b.id)).toHaveText('ASK'); // unique now: no number (look v34 S3-2)
  core.cli('session', 'label', a.id, 'ASK');
  await expect(tab(b.id)).toHaveText('ASK 1'); // twins again; the hand-set name is never numbered
  await expect(tab(a.id)).toHaveText('ASK');
});
