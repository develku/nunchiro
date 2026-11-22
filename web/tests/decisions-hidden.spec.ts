// V2.5-82 (review SHOULD 5 of v25-quiet-chat): a permission prompt's text reaches the eye through `plain()` (the one
// shared hidden-character set, V2.5-49) in the Decisions card and the tree row's decision line. Display only: the answer,
// the risky rule and the item it acts on stay the raw item's. The window's snapshot is patched (decision-rows-seed.ts)
// so the item text carries the characters whatever the core's own screen reader keeps.
import type { Page } from '@playwright/test';
import path from 'node:path';
import { expect, openWindow, test, type Core } from './fixtures';
import { behind, fakes, gitRepo, pending, PERMISSION, proxy, QUESTION, show } from './decision-rows-seed';
import { icon, sidebar } from './d5b';

// U+202E right-to-left override, U+200B zero-width space, U+E0041 tag letter A.
const HIDDEN = /[\u202e\u200b\u{e0041}]/u;
const dirty = (s: string) => s.replace('out', 'o\u202eu\u200bt\u{e0041}');

type Item = Parameters<Parameters<Awaited<ReturnType<typeof proxy>>['patch']>[0]>[0];
async function setup(app: Page, core: Core, cmd: string, edit: (text: string) => string, risky = false) {
  return setupItem(app, core, PERMISSION(cmd), (d) => void (d.text = edit(d.text)), risky);
}
/** A prompt drawn by the fake agent, its item patched in the window's snapshot by `edit`. */
async function setupItem(app: Page, core: Core, screen: string, edit: (d: Item) => void, risky = false) {
  fakes(core);
  const p = gitRepo(core, 'repo');
  const a = core.agent(p, 'wt-a', 'go-a', true);
  const px = await proxy(app);
  if (risky) px.risky.add('wt-a');
  px.patch((d) => void edit(d));
  await openWindow(app);
  await behind(app, a.id);
  show(a.cwd, 'go-a', screen);
  const line = app.locator(`.q[data-line="${a.id}"]`);
  await expect(line).toBeVisible({ timeout: 8000 });
  return { a, px, line };
}
const side = (app: Page) => sidebar(app, 'right');
async function card(app: Page, core: Core) {
  await icon(app, 'right', 'Decisions').click();
  await expect(side(app)).toHaveAttribute('data-widget', 'decisions');
  const item = side(app).locator('.dc-item').first();
  // The shown item is one the core holds now (a sidebar refit may re-file the prompt under a new id).
  await expect
    .poll(async () => {
      const shown = await item.getAttribute('data-item');
      return pending(core).some((d) => d.id === shown);
    })
    .toBe(true);
  return item;
}

test('decision_card_hides_hidden_characters: the card shows the prompt text without U+202E, U+200B and U+E0041', async ({ app, core }) => {
  await setup(app, core, 'touch out-a', dirty);
  const item = await card(app, core);
  if (process.env.DH_SHOTS) await item.screenshot({ path: path.join(process.env.DH_SHOTS, 'decision-card-hidden.png') });
  await expect(item.locator('.dc-what')).toContainText('touch out-a');
  await expect(item.locator('.dc-code')).toContainText('touch out-a');
  for (const sel of ['.dc-what', '.dc-why', '.dc-code']) expect(await item.locator(sel).textContent()).not.toMatch(HIDDEN);
});

test('decision_line_hides_hidden_characters: the tree row decision line and its title show the item without them', async ({ app, core }) => {
  const { line } = await setup(app, core, 'touch out-a', dirty);
  const qt = line.locator('.qt');
  await expect(qt).toContainText('touch out-a');
  expect(await qt.textContent()).not.toMatch(HIDDEN);
  const title = (await qt.getAttribute('title')) ?? '';
  expect(title).toContain('touch out-a');
  expect(title).not.toMatch(HIDDEN);
  await line.locator('[data-act="peek"]').click();
  const peek = app.locator('.peek code');
  await expect(peek).toContainText('touch out-a');
  expect(await peek.textContent()).not.toMatch(HIDDEN);
  expect(await peek.getAttribute('title')).not.toMatch(HIDDEN);
});

test('hidden_text_item_answer_frame_unchanged: answering an item with hidden characters sends the plain-text frame for that item', async ({ app, core }) => {
  const { a, px } = await setup(app, core, 'touch out-a', dirty);
  const item = await card(app, core);
  const id = await item.getAttribute('data-item');
  await item.locator('[data-act="allow"]').focus();
  await app.keyboard.press('Digit1');
  await expect.poll(() => px.sent.length).toBe(1);
  // The frame is the pin; delivery to the PTY is decision-rows' and V2.5-67's (quarantined under load), not this lane's.
  expect(px.sent).toEqual([{ item: id, session: a.id, answer: { type: 'allow_once' } }]);
});

test('hidden_text_risky_allow_enter_only: a risky item with hidden characters still allows only by focus plus Enter', async ({ app, core }) => {
  const { a, px } = await setup(app, core, 'rm -rf build', (t) => t.replace('rm -rf', 'r\u200bm\u202e -rf\u{e0041}'), true);
  const item = await card(app, core);
  await expect(item).toHaveClass(/risky/);
  await expect(item.locator('.warn')).toHaveText('Caution');
  await expect(item.locator('.dc-what')).toContainText('rm -rf build');
  const allow = item.locator('[data-act="allow"]');
  await item.locator('[data-act="deny"]').focus();
  await app.keyboard.press('Digit1');
  await allow.click();
  await app.keyboard.press('Space');
  await app.waitForTimeout(300);
  expect(px.sent).toHaveLength(0);
  await allow.focus();
  await app.keyboard.press('Enter');
  await expect.poll(() => px.sent.length).toBe(1);
  expect(px.sent.map((s) => [s.session, s.answer])).toEqual([[a.id, { type: 'allow_once' }]]);
});

test('decision_text_keeps_visible_text: Korean and an emoji with ZWJ keep every visible character', async ({ app, core }) => {
  // needs 186 (4): the shared set strips ZWJ/ZWNJ (the owner confirmed), so the joined emoji shows as its two visible emoji in
  // order; Korean, a plain emoji and a variation selector are untouched.
  const sent = 'touch 파일-👩\u200d💻-❤\ufe0f-🎉';
  const shown = 'touch 파일-👩💻-❤\ufe0f-🎉';
  const { line } = await setup(app, core, 'touch out-a', (t) => t.replace('touch out-a', sent));
  await expect(line.locator('.qt')).toHaveText(`Run ${shown}`); // B20 (ticket 991): the line names the ask
  expect(await line.locator('.qt').getAttribute('title')).toContain(shown);
  const item = await card(app, core);
  await expect(item.locator('.dc-what')).toContainText(shown);
  await expect(item.locator('.dc-code')).toContainText(shown);
});

// Round 2 (security review MUST-1): a choice label decides the answer sent, and the core does not filter `choices`. An RLO
// label reads as another option ("\u202eeulb" looks like "blue"); shown plainly it reads as what it is, and a click
// still sends that option's own index.
const labels = (d: Item) => {
  const c = d.choices as { label: string }[];
  if (c?.length >= 3) [c[0].label, c[1].label, c[2].label] = ['\u202eeulb', 'bl\u200bue', 'Always pick r\u200bed from now on'];
};
const PLAIN_LABELS = ['1 eulb', '2 blue', '3 Always pick red from now on'];

test('decision_card_choice_labels_plain: card option labels show without U+202E or U+200B; a click sends its own choose index', async ({ app, core }) => {
  const { px } = await setupItem(app, core, QUESTION, labels);
  const item = await card(app, core);
  const options = item.locator('.dc-btns [data-act="choose"], .dc-btns [data-act="option"]');
  await expect(options).toHaveText(PLAIN_LABELS);
  for (const t of await options.allTextContents()) expect(t).not.toMatch(HIDDEN);
  await options.nth(0).click();
  await expect.poll(() => px.sent.map((s) => s.answer)).toEqual([{ type: 'choose', index: 0 }]);
});

test('decision_line_choice_labels_plain: the row choose menu shows labels without them; picking one sends its own index', async ({ app, core }) => {
  const { line, px } = await setupItem(app, core, QUESTION, labels);
  await line.locator('[data-act="choose"]').click();
  const menu = line.getByRole('menuitem');
  await expect(menu).toHaveText(PLAIN_LABELS.slice(0, 2));
  for (const t of await menu.allTextContents()) expect(t).not.toMatch(HIDDEN);
  await menu.nth(1).click();
  await expect.poll(() => px.sent.map((s) => s.answer)).toEqual([{ type: 'choose', index: 1 }]);
});

test('decision_card_allow_always_tip_plain: the "don\'t ask again" tip names the option without hidden characters; a click sends allow_always', async ({ app, core }) => {
  const { px } = await setupItem(app, core, PERMISSION('touch out-a'), (d) => void (d.kind === 'permission' && (d.allow_always = 'Yes, allow \u202eall\u200b edits')));
  const item = await card(app, core);
  const always = item.locator('[data-act="allow-always"]');
  const tip = (await always.getAttribute('title')) ?? '';
  expect(tip).toContain('Yes, allow all edits');
  expect(tip).not.toMatch(HIDDEN);
  await always.click();
  await expect.poll(() => px.sent.map((s) => s.answer)).toEqual([{ type: 'allow_always' }]);
});
