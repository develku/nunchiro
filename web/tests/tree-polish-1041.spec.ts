// Ticket 1041 lane 4 (A+B+C, approved mockup docs/design/polish-1121/index.html; owner answers 2026-11-22): the tree's
// state is light plus one 11 px word, the rail and the working arc are gone, "finished" is a faint filled bar, and the
// tree's floating layers are glass. Nothing the row said before is lost: every glyph but the working arc, the age, the
// tooltip words and the counts stay. Reduced motion holds the lights still and the words still say the state.
import type { Locator, Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { patchSnapshots } from './tree-mock-states';
import { mockup } from './visual/mockups';

const row = (app: Page, name: string) => app.locator('.tree .row.wt2', { hasText: name });
const blockOf = (r: Locator) => r.locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " sess ")][1]');
const pseudo = (l: Locator, which: '::before' | '::after') =>
  l.evaluate((e, w) => {
    const s = getComputedStyle(e, w);
    return { content: s.content, bg: s.backgroundColor, anim: s.animationName, border: s.borderTopWidth };
  }, which);

async function seed(app: Page, core: Core) {
  const dir = core.project('demo');
  for (const l of ['asks', 'works', 'broke', 'limited', 'rests', 'quick']) core.shell(dir, l);
  const set = await patchSnapshots(app);
  const states = { asks: { waiting: true, wt: true, ask: 'permission' as const }, works: { working: true, wt: true }, broke: { failed: true, wt: true }, limited: { limited: true, wt: true }, rests: { wt: true } };
  set(states);
  await openWindow(app);
  await expect(row(app, 'quick')).toBeVisible();
  set({ ...states, quick: { exited: true } });
  await expect(app.locator('.tree .row.wt2.just', { hasText: 'quick' })).toBeVisible();
}

test('state_light_and_word: each state has its light and word, the glyphs stay but the working arc, no rail', async ({ app, core }) => {
  await seed(app, core);
  const want: [string, string | null, string | null, string | null][] = [
    // name, light class, word, glyph
    ['asks', 'light-you', 'needs you', 'hand'],
    ['broke', 'light-bad', 'failed', 'fail'],
    ['limited', 'light-limited', 'Limit', 'limit'],
    ['works', 'light-run', null, null],
    ['rests', null, null, null], // an idle row is bare (owner 11-22); "idle" stays in its tip and label
  ];
  for (const [name, light, word, glyph] of want) {
    const r = row(app, name);
    for (const l of ['light-run', 'light-you', 'light-bad', 'light-limited']) expect(await r.evaluate((e, c) => e.classList.contains(c), l), `${name} ${l}`).toBe(l === light);
    if (word) await expect(r.locator('.sw'), name).toHaveText(word);
    else await expect(r.locator('.sw'), name).toHaveCount(0);
    if (glyph) await expect(r.locator('.ic svg'), name).toHaveAttribute('data-icon', glyph);
    else await expect(r.locator('.ic'), name).toHaveCount(0);
    expect((await pseudo(r, '::before')).content, `${name}: no rail`).toBe('none');
    // The tooltip and the label keep the whole words.
    await expect(r).toHaveAttribute('aria-label', new RegExp(`^${name}, .+`));
  }
  // Your turn shows the word, not the age (mockup polish-1121); the age stays in the tip. A working row's age is its word
  // once the core reports when the turn began.
  await expect(row(app, 'asks').locator('.tm')).toHaveCount(0);
  await expect(row(app, 'asks').locator('.tip')).toContainText(/min/);
  // The working light travels; the your-turn block draws one warm edge for the row and its decision line.
  expect((await pseudo(row(app, 'works'), '::after')).anim).toBe('light-travel');
  const block = blockOf(row(app, 'asks'));
  await expect(block.locator('.q')).toBeVisible();
  expect((await pseudo(block, '::before')).anim).toBe('light-breathe');
  expect((await pseudo(row(app, 'asks'), '::after')).content, 'the block draws the edge, not the row').toBe('none');
});

test('reduced_motion_holds_still: the lights stop, the words and glyphs stay', async ({ app, core }) => {
  await app.emulateMedia({ reducedMotion: 'reduce' });
  await seed(app, core);
  const run = await pseudo(row(app, 'works'), '::after');
  expect(run.anim).toBe('none');
  expect(run.content).not.toBe('none'); // the light still shows, still
  expect((await pseudo(blockOf(row(app, 'asks')), '::before')).anim).toBe('none');
  await expect(row(app, 'asks').locator('.sw')).toHaveText('needs you');
  await expect(row(app, 'broke').locator('.sw')).toHaveText('failed');
});

test('finished_is_a_faint_filled_bar: the head bars and the just-finished edge are filled, not outlined; count and popover stay; glass layers', async ({ app, core }) => {
  const dir = core.project('demo');
  const ids = ['d-1', 'd-2', 'd-3'].map((l) => core.shell(dir, l, '/usr/bin/true').id);
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).filter((s) => ids.includes(s.id) && s.state === 'exited').length).toBe(3);
  await seed(app, core);
  const bars = app.locator('.grp[data-project="demo"] > .row.head .dbar');
  await expect(bars).toHaveAttribute('data-done-bars', '3');
  await expect(bars.locator('.num')).toHaveText('3');
  const bar = await bars.locator('i').evaluate((e) => ({ border: getComputedStyle(e).borderTopWidth, bg: getComputedStyle(e).backgroundColor }));
  expect(bar.border).toBe('0px');
  expect(bar.bg).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  const just = await pseudo(app.locator('.tree .row.wt2.just'), '::before');
  expect(just.border).toBe('0px');
  expect(just.bg).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  await bars.click();
  const pop = app.locator('.dpop');
  await expect(pop).toBeVisible();
  await expect(pop.locator('.dpop-it')).toHaveCount(3);
  const glass = await pop.evaluate((e) => ({ blur: getComputedStyle(e).backdropFilter || getComputedStyle(e).getPropertyValue('-webkit-backdrop-filter'), border: getComputedStyle(e).borderTopWidth }));
  expect(glass.blur).toContain('blur');
  expect(glass.border).toBe('0px');
  // The row tip and the strip tip are glass too.
  await expect(row(app, 'broke').locator('.tip')).toHaveClass(/glass/);
  await expect(app.locator('.grp[data-project="demo"] .cstrip .stip')).toHaveClass(/glass/);
});

// Measured against the approved mockup's A+B+C window (tests/visual/mockups/polish-abc.html, `.win.v-c`): the row height, the word's
// size, the working line's thickness and the your-turn edge's width are the mockup's.
test('rows_measure_as_the_polish_mockup: row 32, word 11 px, working line 1 px, your-turn edge 2 px', async ({ app, core }) => {
  await seed(app, core);
  const m = await app.context().newPage();
  await m.goto(`file://${mockup('polish-abc.html')}`);
  await m.emulateMedia({ reducedMotion: 'reduce' });
  const win = m.locator('.win.v-c:not(.dark)').first();
  const mock = {
    row: await win.locator('.tree .row.run').evaluate((e) => e.getBoundingClientRect().height),
    word: await win.locator('.tree .row.you .m').evaluate((e) => getComputedStyle(e).fontSize),
    line: await win.locator('.tree .row.run').evaluate((e) => getComputedStyle(e, '::after').height),
    edge: await win.locator('.tree .row.you').evaluate((e) => getComputedStyle(e, '::before').width),
  };
  await m.close();
  const got = {
    row: await row(app, 'works').evaluate((e) => e.getBoundingClientRect().height),
    word: await row(app, 'asks').locator('.sw').evaluate((e) => getComputedStyle(e).fontSize),
    line: await row(app, 'works').evaluate((e) => getComputedStyle(e, '::after').height),
    edge: await blockOf(row(app, 'asks')).evaluate((e) => getComputedStyle(e, '::before').width),
  };
  expect(got).toEqual(mock);
});
