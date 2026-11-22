// TREEHEAD (c), owner 2026-11-02 (tree4 r2): while a project head is hovered or has focus inside, its tools sit LEFT of the count
// pills and overlap nothing; the name truncates further to make room. Tools and every pill stay clickable at every sidebar width.
// Ticket 388: the pills are gone; the colour strip in the head's right column takes their place in every check here.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { openQuiet } from './tree-seed';
import { ownerOk } from './acp-fakes';

const WIDTHS = [0, 320, 240]; // 0 = the default width
/** The head's orange (your turn) strip colour; `data-n` is its session count. */
const you = (head: import('@playwright/test').Locator) => head.locator(':scope > .cstrip > .sg[data-tone="o"]');
const TOOLS = ':scope > :is(.ptool, .padd)';

async function seeded(app: Page, core: Core, name = 'nunchiro') {
  const p = core.project(name);
  core.agent(p, 'agent-a', 'go-a');
  core.agent(p, 'agent-b', 'go-b');
  await openWindow(app);
  fs.writeFileSync(path.join(p, 'go-a'), '');
  fs.writeFileSync(path.join(p, 'go-b'), '');
  const head = app.locator(`.grp[data-project="${name}"] .row.head`);
  await expect(you(head)).toHaveAttribute('data-n', '2', { timeout: 10_000 });
  return head;
}

/** The sidebar's own width (208 px minimum); 0 leaves the default. */
const width = (app: Page, w: number) =>
  w ? app.evaluate((n) => document.querySelectorAll<HTMLElement>('aside.sbar.l').forEach((e) => (e.style.width = `${n}px`)), w) : Promise.resolve();

const boxes = (head: import('@playwright/test').Locator, sel: string) =>
  head.locator(sel).evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((b) => ({ l: b.left, r: b.right, t: b.top, b: b.bottom })));

test('tools_left_of_counts: hovered head at 240 px, 320 px and the default width: every tool ends at or before the first pill and no two boxes overlap', async ({ app, core }) => {
  const head = await seeded(app, core);
  for (const w of WIDTHS) {
    await width(app, w);
    await app.mouse.move(900, 600);
    await head.hover({ position: { x: 30, y: 8 } });
    const tools = await boxes(head, TOOLS);
    const pills = await boxes(head, ':scope > .cstrip > .sg');
    expect(tools.length, `${w}px tools`).toBeGreaterThanOrEqual(4);
    expect(pills.length).toBeGreaterThanOrEqual(1);
    const firstPill = Math.min(...pills.map((b) => b.l));
    for (const t of tools) expect(t.r, `${w}px tool right edge <= first pill left`).toBeLessThanOrEqual(firstPill + 0.5);
    const all = [...tools, ...pills].sort((a, b) => a.l - b.l);
    for (let i = 1; i < all.length; i++) expect(all[i].l, `${w}px boxes ${i - 1}/${i} overlap`).toBeGreaterThanOrEqual(all[i - 1].r - 0.5);
  }
});

test('tools_clickable_on_hover: Open in editor and Set icon (and the pill beside them) take the pointer at 240 px', async ({ app, core }) => {
  const head = await seeded(app, core);
  await width(app, 240);
  await app.mouse.move(900, 600);
  await head.hover({ position: { x: 30, y: 8 } });
  // trial: the full actionability check, including "nothing else receives the click", without opening an editor or a file chooser.
  for (const sel of ['.ped', '.pic', '.padd:not(.wtadd)', '.wtadd', '.cstrip > .sg[data-tone="o"]']) {
    await head.locator(`:scope > ${sel}, :scope > .r ${sel}`).first().click({ trial: true, timeout: 5000 });
  }
  // the "+" really answers: it opens the New session dialog.
  await head.locator(':scope > .padd:not(.wtadd)').click();
  await expect(app.getByRole('dialog')).toBeVisible();
});

test('name_truncates_not_overflows: a long name ellipsizes while the tools show, the head keeps its height and nothing scrolls sideways', async ({ app, core }) => {
  const name = 'a-very-long-project-name-that-cannot-possibly-fit-in-the-sidebar';
  const head = await seeded(app, core, name);
  for (const w of WIDTHS) {
    await width(app, w);
    await app.mouse.move(900, 600);
    const rest = (await head.boundingBox())!;
    const overflow = () => app.evaluate(() => [...document.querySelectorAll<HTMLElement>('aside.sbar.l, aside.dock.l, .tree')].map((e) => e.scrollWidth - e.clientWidth));
    const restOver = await overflow();
    await head.hover({ position: { x: 30, y: 8 } });
    expect((await head.boundingBox())!.height, `${w}px head height`).toBe(rest.height);
    const n = head.locator(':scope > .n');
    expect(await n.evaluate((e) => e.scrollWidth > e.clientWidth || getComputedStyle(e.querySelector('b') ?? e).textOverflow === 'ellipsis'), `${w}px name cut`).toBe(true);
    // Showing the tools adds no sideways scroll to what the sidebar already had at rest.
    const over = await overflow();
    over.forEach((d, i) => expect(d, `${w}px sidebar scroll width #${i}`).toBeLessThanOrEqual(Math.max(0, restOver[i])));
    const h = (await head.boundingBox())!;
    for (const b of await boxes(head, ':scope > *:not(.chip)')) if (b.r - b.l > 0) expect(b.r, `${w}px child inside the head`).toBeLessThanOrEqual(h.x + h.width + 0.5);
  }
});

test('strip_click_still_opens_session: the orange strip colour on a hovered head opens a waiting session, at 240 px too', async ({ app, core }) => {
  const head = await seeded(app, core);
  await width(app, 240);
  await app.mouse.move(900, 600);
  const ids = (await you(head).getAttribute('data-ids'))!.split(' ');
  await you(head).click();
  await expect.poll(() => app.locator('.tab[aria-selected="true"]').getAttribute('data-tab')).toBe(ids[0]); // the longest waiting
});

// ---- TREEHEAD-FREEZE (owner 2026-11-02, r3): a hovered or focused head does not reflow on arrivals; the live region still announces them.
async function idle(app: Page, core: Core, name = 'nunchiro') {
  const p = core.project(name);
  for (const t of ['a', 'b', 'c']) core.agent(p, `agent-${t}`, `go-${t}`);
  openQuiet(core);
  await openWindow(app);
  const head = app.locator(`.grp[data-project="${name}"] .row.head`);
  await expect(head).toBeVisible();
  return { p, head };
}
const arrive = (p: string, ...tags: string[]) => tags.forEach((t) => fs.writeFileSync(path.join(p, `go-${t}`), ''));
/** Everything that could move: the head's box, each drawn child's box (a zero-width one paints nothing) and the name's width. */
const geometry = (head: import('@playwright/test').Locator) =>
  head.evaluate((h) => ({ head: JSON.stringify(h.getBoundingClientRect()), kids: [...h.children].filter((e) => e.getBoundingClientRect().width > 0).map((e) => `${e.className}:${JSON.stringify(e.getBoundingClientRect())}`), name: h.querySelector('.n')!.getBoundingClientRect().width }));

test('head_hover_freezes_counts_until_leave: an arrival under the pointer moves nothing on the head; the new count shows when the pointer leaves', async ({ app, core }) => {
  const { p, head } = await idle(app, core);
  await app.mouse.move(900, 600);
  await head.hover({ position: { x: 30, y: 8 } });
  const before = await geometry(head);
  const counts = await head.locator('.r').getAttribute('aria-label');
  arrive(p, 'a');
  await expect(head.locator('.r')).not.toHaveAttribute('aria-label', counts!, { timeout: 10_000 }); // the live count has changed
  await expect(you(head)).toHaveCount(0); // ...but the head still draws what it drew
  expect(await geometry(head)).toEqual(before);
  await app.mouse.move(900, 600);
  await expect(you(head)).toHaveAttribute('data-n', '1');
});

test('head_focus_freezes_counts_until_blur: the same with keyboard focus inside the head and the pointer elsewhere', async ({ app, core }) => {
  const { p, head } = await idle(app, core);
  // A project that first gets a waiting agent changes section and its head is drawn anew (focus would go with it), so start from one that already has a pill.
  arrive(p, 'a');
  await expect(you(head)).toHaveAttribute('data-n', '1', { timeout: 10_000 });
  await app.mouse.move(900, 600);
  await head.locator('.chev').focus();
  const before = await geometry(head);
  const counts = await head.locator('.r').getAttribute('aria-label');
  arrive(p, 'b');
  await expect(head.locator('.r')).not.toHaveAttribute('aria-label', counts!, { timeout: 10_000 }); // the live count has changed
  await expect(you(head)).toHaveAttribute('data-n', '1'); // ...the head still draws the 1 it drew when focus arrived
  expect(await geometry(head)).toEqual(before);
  await head.locator('.chev').blur();
  await expect(you(head)).toHaveAttribute('data-n', '2');
});

test('live_region_announces_arrival_while_frozen: the same live region element carries the new text at once, though it paints nothing', async ({ app, core }) => {
  const { p, head } = await idle(app, core);
  await app.mouse.move(900, 600);
  await head.hover({ position: { x: 30, y: 8 } });
  const chip = head.locator('.chip');
  await expect(chip).toHaveAttribute('role', 'status');
  await expect(chip).toHaveAttribute('aria-live', 'polite');
  await chip.evaluate((e) => (e.dataset.mark = 'same'));
  arrive(p, 'a');
  await expect(chip).toHaveText('new 1', { timeout: 10_000 });
  await expect(chip).toHaveAttribute('aria-label', /1/);
  await expect(chip).toHaveAttribute('data-mark', 'same'); // not re-created: a re-created live region is not announced
  expect(await chip.evaluate((e) => getComputedStyle(e).fontSize)).toBe('0px'); // text present, nothing painted
  await app.mouse.move(900, 600);
  await expect(chip).not.toHaveAttribute('data-shown', /.*/); // released: drawn as itself
});

test('worktree_tool_icon_has_label_and_tooltip: an icon button, named and titled, reachable by keyboard, that opens New worktree', async ({ app, core }) => {
  const { head } = await idle(app, core);
  await head.hover({ position: { x: 30, y: 8 } });
  const add = head.locator(':scope > .wtadd');
  await expect(add).toBeVisible();
  expect(await add.locator('svg').count()).toBe(1);
  await expect(add).toHaveAccessibleName('New worktree in nunchiro');
  await expect(add).toHaveAttribute('title', /^New worktree in /);
  expect((await add.boundingBox())!.width).toBeLessThanOrEqual(24);
  await add.focus();
  await app.keyboard.press('Enter');
  await expect(app.getByRole('dialog', { name: 'New worktree' })).toBeVisible();
});

test('head_name_keeps_room_at_default_width: with the tools and one pill a long name keeps at least 40 px', async ({ app, core }) => {
  const { p, head } = await idle(app, core, 'nunchiro-long-project-name');
  arrive(p, 'a');
  await expect(you(head)).toHaveAttribute('data-n', '1', { timeout: 10_000 });
  await app.mouse.move(900, 600);
  await head.hover({ position: { x: 30, y: 8 } });
  const side = (await app.locator('aside.sbar.l').boundingBox())!;
  expect(Math.round(side.width), 'default sidebar width').toBeLessThanOrEqual(250);
  expect((await head.locator(':scope > .n').boundingBox())!.width).toBeGreaterThanOrEqual(40);
});

test('head_hold_released_when_head_remounts: a held head that is drawn anew (its project is filed into a group) does not keep its old counts', async ({ app, core }) => {
  // The pointer hold ends after 5 s without a move (Sidebar IDLE_MS); the held edit then applies, the project moves into a group and its head
  // is a new element. The pointer never left the old one, so no pointerleave ever reaches the hold. Ticket 370 (f6568f12) took the old cause
  // (a first arrival moving the project out of the folded quiet line), so the group filing stands in for it.
  await app.clock.install();
  const { p, head } = await idle(app, core);
  await app.mouse.move(900, 600);
  await head.hover({ position: { x: 30, y: 8 } });
  await head.evaluate((h) => (h.dataset.mark = 'first-head'));
  arrive(p, 'a');
  await expect(head.locator('.chip')).toHaveText('new 1', { timeout: 10_000 }); // arrived, held: the head still draws nothing
  await expect(you(head)).toHaveCount(0);
  // Filed from elsewhere in the window (as the New tab popover hands its own edit over): the core's tree, then TREE_SET.
  const { tree } = ownerOk(core, { op: 'tree_edit', edit: { op: 'group_create', name: 'Web', project: p } }) as { tree: unknown };
  await app.evaluate((t) => window.dispatchEvent(new CustomEvent('nunchiro:tree.set', { detail: t })), tree);
  await app.clock.fastForward(6000);
  await expect(app.locator('.pgrp[data-group="Web"] .grp[data-project="nunchiro"] .row.head:not([data-mark])')).toHaveCount(1, { timeout: 10_000 }); // a new element, in the group
  // The pointer goes elsewhere: the new head draws the live count, not the snapshot (no pill, no chip) the old one was held at.
  await app.mouse.move(900, 600);
  await app.clock.fastForward(1000);
  const fresh = app.locator('.grp[data-project="nunchiro"] .row.head');
  await expect(you(fresh)).toHaveAttribute('data-n', '1', { timeout: 5000 });
  await expect(fresh.locator('.chip')).not.toHaveAttribute('data-shown', /.*/);
});
