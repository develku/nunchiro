// needs 171 (tree rows 2-3): the counts open what they count. "+N" is a button that shows its rows in place; the
// head's colours open what they count (ticket 388 moved this from the pills to the colour strip). Neither answers, allows or denies anything.
import fs from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { seed } from './tree-seed';

const arrive = (dir: string, trigger: string) => fs.writeFileSync(path.join(dir, trigger), '');
const grpOf = (app: Page, name: string) => app.locator(`.grp[data-project="${name}"]`);

/** Five main-folder agents of one project, all asking: two rows and a "+3" under the head. */
async function five(app: Page, core: Core) {
  const p = core.project('nunchiro');
  const tags = ['a', 'b', 'c', 'd', 'e'];
  const ids = tags.map((t) => core.agent(p, `agent-${t}`, `go-${t}`).id);
  await openWindow(app);
  for (const t of tags) arrive(p, `go-${t}`);
  const grp = grpOf(app, 'nunchiro');
  await expect(grp.locator('.q')).toHaveCount(2, { timeout: 10_000 });
  // All five ask before a test goes on: two rows show as soon as two ask, and a pointer that freezes the tree earlier
  // holds the rows as they were (webkit: the fifth arrived after the freeze, so "+3" opened four).
  await expect(grp.locator('.more')).toHaveText('+3', { timeout: 10_000 });
  return { p, ids, grp };
}
/** A row's markup with ids and text removed: two rows drawn by the same code have the same shape. */
const shape = (l: Locator) =>
  l.evaluate((e) => {
    const walk = (n: Element): string => `<${n.tagName.toLowerCase()}.${[...n.classList].sort().join('.')}${[...n.children].map(walk).join('')}>`;
    return walk(e);
  });

test('more_button_expands_in_place: "+3" is a button; click, Enter and Space show the other rows below the first two, nothing above moves', async ({ app, core }) => {
  const { grp } = await five(app, core);
  const more = grp.locator('.more');
  await expect(more).toHaveText('+3');
  await expect(more).toHaveJSProperty('tagName', 'BUTTON');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await app.mouse.move(900, 600);
  const rows = grp.locator('.sess');
  const top = async () => Promise.all([0, 1].map(async (i) => JSON.stringify(await rows.nth(i).boundingBox())));
  const before = await top();
  const shapes = await Promise.all([0, 1].map((i) => shape(rows.nth(i))));

  await more.click();
  await expect(grp.locator('.q')).toHaveCount(5);
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(more).toHaveText('Show fewer');
  expect(await top()).toEqual(before);
  // The three new rows are drawn by the same code as the first two.
  for (let i = 2; i < 5; i++) expect(await shape(rows.nth(i))).toBe(shapes[i % 2]);
  // The button sits below the rows it opened.
  const last = (await rows.nth(4).boundingBox())!;
  expect((await more.boundingBox())!.y).toBeGreaterThanOrEqual(last.y + last.height - 1);

  await more.click();
  await expect(grp.locator('.q')).toHaveCount(2);
  await expect(more).toHaveText('+3');
  await expect(more).toHaveAttribute('aria-expanded', 'false');

  await more.focus();
  await app.keyboard.press('Enter');
  await expect(grp.locator('.q')).toHaveCount(5);
  await app.keyboard.press('Enter');
  await expect(grp.locator('.q')).toHaveCount(2);
  await app.keyboard.press('Space');
  await expect(grp.locator('.q')).toHaveCount(5);
  await expect(more).toBeFocused();
});

test('more_button_works_while_the_tree_is_frozen: the pointer over the sidebar freezes the rows; the button still opens, in the frozen order', async ({ app, core }) => {
  const { grp, ids } = await five(app, core);
  const more = grp.locator('.more');
  const aside = app.locator('aside.dock.l');
  await grp.locator('.head .n').hover();
  await expect(aside).toHaveAttribute('data-held', 'true');
  const order = () => grp.locator('.q').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.line));
  const two = await order();
  const rows = grp.locator('.sess');
  const top = async () => Promise.all([0, 1].map(async (i) => JSON.stringify(await rows.nth(i).boundingBox())));
  const before = await top();
  await more.hover();
  await app.mouse.down();
  await app.mouse.up();
  await expect(grp.locator('.q')).toHaveCount(5);
  await expect(aside).toHaveAttribute('data-held', 'true');
  const all = await order();
  expect(all.slice(0, 2)).toEqual(two);
  expect(new Set(all)).toEqual(new Set(ids));
  expect(await top()).toEqual(before); // nothing above the button moved
});

test('more_button_under_a_folded_group_expands_too: "+N waiting" is the same control', async ({ app, core }) => {
  const p = core.project('nunchiro');
  const tags = ['a', 'b', 'c', 'd', 'e'];
  tags.forEach((t) => core.agent(p, `agent-${t}`, `go-${t}`));
  seed(core, { op: 'group_create', name: 'Web', project: p }, { op: 'fold', key: 'group:Web', folded: true });
  await openWindow(app);
  for (const t of tags) arrive(p, `go-${t}`);
  const body = app.locator('.pgrp[data-group="Web"] .gbody');
  await expect(body.locator('.q')).toHaveCount(2, { timeout: 10_000 });
  await app.mouse.move(900, 600);
  const more = body.locator('.more');
  await expect(more).toHaveText('+3 waiting');
  await expect(more).toHaveJSProperty('tagName', 'BUTTON');
  await more.click();
  await expect(body.locator('.q')).toHaveCount(5);
  await expect(more).toHaveText('Show fewer');
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await more.click();
  await expect(body.locator('.q')).toHaveCount(2);
});

// ---- the strip colours. A failed session is patched in on the window's socket (the core cannot fail a shell on demand).
async function failShell(app: Page, label: string) {
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m !== 'string' || JSON.parse(m).event !== 'snapshot') return ws.send(m);
      const msg = JSON.parse(m);
      for (const s of msg.sessions ?? []) if (s.label === label) Object.assign(s.attention, { failed: true, working: false });
      ws.send(JSON.stringify(msg));
    });
  });
}

test('strip_colours_open_longest_waiting: the orange colour opens the longest-waiting session, the red one the failed one; neither folds the head', async ({ app, core }) => {
  const p = core.project('nunchiro');
  const ask = ['a', 'b'].map((t) => core.agent(p, `agent-${t}`, `go-${t}`).id);
  const broken = core.shell(p, 'broken').id;
  await failShell(app, 'broken');
  await openWindow(app);
  arrive(p, 'go-a');
  const grp = grpOf(app, 'nunchiro');
  await expect(grp.locator('.q')).toHaveCount(1, { timeout: 10_000 });
  await new Promise((r) => setTimeout(r, 400));
  arrive(p, 'go-b');
  const you = grp.locator('.head .cstrip > .sg[data-tone="o"]');
  const bad = grp.locator('.head .cstrip > .sg[data-tone="r"]');
  await expect(you).toHaveAttribute('data-n', '2');
  await expect(you).toHaveAccessibleName('2 your turn · open the longest waiting');
  await expect(bad).toHaveAccessibleName('1 failed · open the longest waiting');
  const chev = grp.getByRole('button', { name: 'Collapse nunchiro', exact: true });
  await expect(chev).toHaveAttribute('aria-expanded', 'true');

  await you.click();
  await expect(app.locator(`.tab[data-tab="${ask[0]}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(chev).toHaveAttribute('aria-expanded', 'true');

  await bad.click();
  await expect(app.locator(`.tab[data-tab="${broken}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(chev).toHaveAttribute('aria-expanded', 'true');

  // Keyboard: Enter on a colour does the same as a click (a new colour starts from its longest waiting again).
  await you.focus();
  await app.keyboard.press('Enter');
  await expect(app.locator(`.tab[data-tab="${ask[0]}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(grp.locator('.head .r')).toHaveAttribute('role', 'group');

  // No button inside a button on the head.
  const axe = await new AxeBuilder({ page: app }).include('.grp[data-project="nunchiro"] .head').analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  expect(await grp.locator('.head button button').count()).toBe(0);
});

test('strip_colour_answers_nothing: opening a session from the strip sends no answer', async ({ app, core }) => {
  const p = core.project('nunchiro');
  core.agent(p, 'agent-a', 'go-a');
  const sent: string[] = [];
  app.on('websocket', (ws) => ws.on('framesent', (f) => typeof f.payload === 'string' && /"op":"answer"/.test(f.payload) && sent.push(f.payload)));
  await openWindow(app);
  arrive(p, 'go-a');
  const grp = grpOf(app, 'nunchiro');
  await expect(grp.locator('.q')).toHaveCount(1, { timeout: 10_000 });
  await grp.locator('.head .cstrip > .sg[data-tone="o"]').click();
  await new Promise((r) => setTimeout(r, 300));
  expect(sent).toEqual([]);
});
