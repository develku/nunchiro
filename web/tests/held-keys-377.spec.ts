// Ticket 377 item 2 (F4, decision f4-chip-look-a): the keys shown where they act. Holding ⌘ for 200 ms shows ⌘1-⌘9 on the visible
// project's tabs and on the tree rows of the sessions in those tabs; holding ⌃ shows ⌃1-⌃9 on the project rows. The chips follow
// the real binding, and the tab strip's +, close and stop buttons name their key in the tooltip.
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';

const seed = (core: Core) => {
  const [a, b] = [core.project('alpha'), core.project('beta')];
  const [a1, a2] = ['a-one', 'a-two'].map((l) => core.shell(a, l).id);
  const [b1, b2] = ['b-one', 'b-two'].map((l) => core.shell(b, l).id);
  return { a, b, a1, a2, b1, b2 };
};
const rebind = (app: Page, bindings: Record<string, string[]>) =>
  app.addInitScript((b) => localStorage.getItem('nunchiro.settings.v1') === null && localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ bindings: b })), bindings);
const digits = (base: string, mods: string[]) => Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`${base}.${n}`, mods.length ? [`${mods.join('+')}+Digit${n}`] : []]));
/** The texts of the chips that are drawn (a hidden chip is in the page, display none). */
const shown = (app: Page, sel: string) => app.locator(`${sel}:visible`).allTextContents();
const tabChips = (app: Page) => shown(app, '.tabw > .tkey');
const rowChips = (app: Page, id: string) => shown(app, `.tree .row.wt2[data-menu-session="${id}"] .tkey`);
const projChips = (app: Page) => shown(app, '.tree .pjkey');
/** A chip check that waits for it (the 200 ms timer fires 205-305 ms after the press on a busy machine). */
const chips = (read: () => Promise<string[]>, want: string[]) => expect.poll(read, { timeout: 5000 }).toEqual(want);
/** Times in the page: when a modifier went down and up and when a held-key mark was set, so the delay is read from the page's own clock, not the test's. */
const clock = (app: Page) =>
  app.addInitScript(() => {
    const log = { down: [] as number[], up: [] as number[], set: [] as number[] };
    (window as unknown as { __held: typeof log }).__held = log;
    const mod = (e: KeyboardEvent) => ['Meta', 'Control', 'Alt'].includes(e.key) && !e.repeat;
    window.addEventListener('keydown', (e) => mod(e) && log.down.push(performance.now()), true);
    window.addEventListener('keyup', (e) => mod(e) && log.up.push(performance.now()), true);
    new MutationObserver((rs) => rs.forEach((r) => (r.target as Element).hasAttribute(r.attributeName!) && log.set.push(performance.now()))).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-held-tab', 'data-ctl'] });
  });
const heldLog = (app: Page) => app.evaluate(() => (window as unknown as { __held: { down: number[]; up: number[]; set: number[] } }).__held);

test('hold ⌘ 300 ms: chips on the visible project\'s tabs and on the rows of those sessions only; release hides', async ({ app, core }) => {
  const { a1, a2, b1, b2 } = seed(core);
  await openWindow(app, {}, core);
  expect(await tabChips(app)).toEqual([]);
  await app.keyboard.down('Meta');
  await chips(() => tabChips(app), ['⌘1', '⌘2']); // alpha's two tabs; beta has none in this strip
  expect(await rowChips(app, a1)).toEqual(['⌘1']);
  expect(await rowChips(app, a2)).toEqual(['⌘2']);
  expect(await rowChips(app, b1)).toEqual([]); // open in a tab of another project: ⌘N does not reach it
  expect(await rowChips(app, b2)).toEqual([]);
  expect(await projChips(app)).toEqual([]); // ⌃ is not held
  await app.keyboard.up('Meta');
  expect(await tabChips(app)).toEqual([]);
  expect(await rowChips(app, a1)).toEqual([]);
});

test('the tab chip takes the close button\'s place and moves nothing; the name keeps its letters', async ({ app, core }) => {
  const { a1 } = seed(core);
  await openWindow(app, {}, core);
  const tab = app.locator(`.tabw:has(> .tab[data-tab="${a1}"])`);
  const before = await tab.boundingBox();
  await app.keyboard.down('Meta');
  await expect(tab.locator('> .tkey')).toBeVisible();
  const after = await tab.boundingBox();
  expect(after?.width).toBe(before?.width);
  // Design book (tabs): the chip takes the close button's place, after the dot and the name; the close button hides.
  const [chip, close, dot, name] = await Promise.all(['> .tkey', '> .x', '.tdot', '.tname'].map((s) => tab.locator(s).boundingBox()));
  expect(Math.abs(chip!.x + chip!.width / 2 - (close!.x + close!.width / 2))).toBeLessThan(6);
  expect(chip!.x).toBeGreaterThanOrEqual(dot!.x + dot!.width);
  expect(chip!.x + 1).toBeGreaterThanOrEqual(name!.x);
  await expect(tab.locator('> .x svg')).toBeHidden();
  await app.keyboard.up('Meta');
  await app.mouse.move(0, 0);
});

test('a short hold and a quick ⌘C show no chips, the delay is 200 ms; losing the window\'s focus hides them', async ({ app, core }) => {
  seed(core);
  await clock(app);
  await openWindow(app, {}, core);
  // A hold of about 100 ms: when a busy machine stretches it past 200 ms the chips are rightly shown, so it is tried again.
  for (let i = 0; i < 5; i++) {
    await app.keyboard.down('Meta');
    await app.waitForTimeout(100);
    await app.keyboard.up('Meta');
    const l = await heldLog(app);
    if (l.up.at(-1)! - l.down.at(-1)! < 190) break;
    expect(i).toBeLessThan(4); // five stretched holds in a row: the machine is too busy to say anything
  }
  await app.waitForTimeout(400);
  expect((await heldLog(app)).set).toEqual([]); // the timer died with the release
  expect(await tabChips(app)).toEqual([]);
  await app.keyboard.down('Meta');
  await app.keyboard.press('KeyC');
  await app.waitForTimeout(500);
  expect((await heldLog(app)).set).toEqual([]); // ⌘C ended the wait
  expect(await tabChips(app)).toEqual([]);
  await app.keyboard.up('Meta');
  await app.keyboard.down('Meta');
  await chips(() => tabChips(app), ['⌘1', '⌘2']);
  const l = await heldLog(app);
  expect(l.set.length).toBe(1);
  expect(l.set[0] - l.down.at(-1)!).toBeGreaterThanOrEqual(195); // the 200 ms wait, on the page's clock
  await app.evaluate(() => window.dispatchEvent(new Event('blur')));
  expect(await tabChips(app)).toEqual([]);
  await app.keyboard.up('Meta');
});

test('hold ⌃: ⌃1-⌃9 on the project rows, after 200 ms', async ({ app, core }) => {
  seed(core);
  await clock(app);
  await openWindow(app, {}, core);
  await app.keyboard.down('Control');
  await chips(() => projChips(app), ['⌃1', '⌃2']);
  const l = await heldLog(app);
  expect(l.set[0] - l.down.at(-1)!).toBeGreaterThanOrEqual(195); // not before the 200 ms
  expect(await tabChips(app)).toEqual([]); // ⌘ is not held
  await app.keyboard.up('Control');
  expect(await projChips(app)).toEqual([]);
});

test('rebinding the tab key to ⌥1-9 moves the chip to ⌥; unbound or after the prefix, there is none', async ({ app, core }) => {
  seed(core);
  await rebind(app, digits('session.jump', ['Alt']));
  await openWindow(app, {}, core);
  await app.keyboard.down('Alt');
  await chips(() => tabChips(app), ['⌥1', '⌥2']);
  await app.keyboard.up('Alt');
  await app.keyboard.down('Meta'); // the chips came after the ⌥ hold, so a ⌘ hold that shows none is a rule, not a slow timer
  await app.waitForTimeout(500);
  expect(await tabChips(app)).toEqual([]);
  await app.keyboard.up('Meta');
});

test('unbound tab key: no chip on a ⌘ hold', async ({ app, core }) => {
  seed(core);
  await rebind(app, digits('session.jump', []));
  await openWindow(app, {}, core);
  await app.keyboard.down('Meta');
  await app.waitForTimeout(600);
  expect(await tabChips(app)).toEqual([]);
  await app.keyboard.up('Meta');
});

test('tab key bound after the prefix: no chip (nothing to hold)', async ({ app, core }) => {
  seed(core);
  await rebind(app, Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`session.jump.${n}`, [`prefix Digit${n}`]])));
  await openWindow(app, {}, core);
  await app.keyboard.down('Meta');
  await app.waitForTimeout(600);
  expect(await tabChips(app)).toEqual([]);
  await app.keyboard.up('Meta');
});

test('project key rebound to ⌥1-9: ⌥ shows the chips and ⌃ does not', async ({ app, core }) => {
  seed(core);
  await rebind(app, digits('project.jump', ['Alt']));
  await openWindow(app, {}, core);
  await app.keyboard.down('Alt');
  await chips(() => projChips(app), ['⌥1', '⌥2']);
  await app.keyboard.up('Alt');
  await app.keyboard.down('Control');
  await app.waitForTimeout(500);
  expect(await projChips(app)).toEqual([]);
  await app.keyboard.up('Control');
});

test('tooltips: + names ⌘T, close names ⌘W', async ({ app, core }) => {
  const { a1 } = seed(core);
  await openWindow(app, {}, core);
  const tip = app.locator('#app-tip');
  await app.locator('.tadd').hover();
  await expect(tip).toHaveText('New session (⌘T)');
  const tab = app.locator(`.tabw:has(> .tab[data-tab="${a1}"])`);
  await tab.hover();
  await tab.locator('> .x').hover();
  await expect(tip).toHaveText('Close tab (⌘W)');
});

for (const scheme of ['light', 'dark'] as const)
  test(`shots: held ⌘ and ⌃ chips, ${scheme}`, async ({ app, core }) => {
    const { a1 } = seed(core);
    await app.emulateMedia({ colorScheme: scheme });
    await openWindow(app, {}, core);
    await app.mouse.move(700, 600);
    await app.keyboard.down('Meta');
    await app.keyboard.down('Control');
    await expect(app.locator(`.tabw:has(> .tab[data-tab="${a1}"]) > .tkey`)).toBeVisible();
    await expect(app.locator('.tree .pjkey:visible').first()).toBeVisible();
    await app.screenshot({ path: `../.scratch/shots/f4-held-${scheme}-${test.info().project.name}.png` });
    await app.keyboard.up('Control');
    await app.keyboard.up('Meta');
  });
