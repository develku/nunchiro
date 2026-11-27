// Ticket 1041 lane 4, moved to the design book (tree rows): the tree's state is a dot plus one word, the rail and the
// working arc are gone, "finished" is the done ring, and the
// tree's floating layers are glass. Nothing the row said before is lost: every glyph but the working arc, the age, the
// tooltip words and the counts stay. Reduced motion holds the lights still and the words still say the state.
import type { Locator, Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { patchSnapshots } from './tree-mock-states';

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
  const want: [string, string, string | null, string | null][] = [
    // name, state dot (design book; the light classes retired), word, glyph
    ['asks', 'you', 'needs you', 'hand'],
    ['broke', 'bad', 'failed', 'fail'],
    ['limited', 'warn', 'Limit', 'limit'],
    ['works', 'run', null, null],
    ['rests', 'idle', null, null], // an idle row has no glyph (owner 11-22); "idle" stays in its tip and label
  ];
  for (const [name, dot, word, glyph] of want) {
    const r = row(app, name);
    await expect(r.locator('.sdot'), name).toHaveAttribute('data-dot', dot);
    expect(await r.evaluate((e) => [...e.classList].some((c) => c.startsWith('light-'))), `${name}: no light class`).toBe(false);
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
  // Design book: the working dot breathes; the your-turn block has the wash and no edge (the dot glows, still).
  expect((await row(app, 'works').locator('.sdot').evaluate((e) => getComputedStyle(e).animationName))).toBe('breathe');
  const block = blockOf(row(app, 'asks'));
  await expect(block.locator('.q')).toBeVisible();
  expect((await pseudo(block, '::before')).content, 'no edge on the block').toBe('none');
  expect((await pseudo(row(app, 'asks'), '::after')).content, 'no edge on the row').toBe('none');
  expect(await row(app, 'asks').locator('.sdot').evaluate((e) => getComputedStyle(e).animationName)).toBe('none');
});

test('reduced_motion_holds_still: the lights stop, the words and glyphs stay', async ({ app, core }) => {
  await app.emulateMedia({ reducedMotion: 'reduce' });
  await seed(app, core);
  const run = await row(app, 'works').locator('.sdot').evaluate((e) => ({ anim: getComputedStyle(e).animationName, opacity: getComputedStyle(e).opacity }));
  expect(run).toEqual({ anim: 'none', opacity: '1' }); // the dot still shows, still, at full strength
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
  // Design book: finished is the done ring (--light-done), on the head and on the just-finished row.
  const ring = (l: Locator) => l.evaluate((e) => getComputedStyle(e).boxShadow);
  expect(await ring(bars.locator('i'))).toContain('1.5px');
  expect(await ring(app.locator('.tree .row.wt2.just .sdot'))).toBe(await ring(bars.locator('i')));
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

// The design book (tree rows) replaces the polish mockup's measures: row 34, meta word 11.5, an 8 px dot, no line, no edge.
test('rows_measure_as_the_design_book: row 34, word 11.5 px, dot 8 px, no working line or your-turn edge', async ({ app, core }) => {
  await seed(app, core);
  const got = {
    row: await row(app, 'works').evaluate((e) => e.getBoundingClientRect().height),
    word: await row(app, 'asks').locator('.sw').evaluate((e) => getComputedStyle(e).fontSize),
    dot: await row(app, 'works').locator('.sdot').evaluate((e) => (e as HTMLElement).offsetWidth),
    line: await row(app, 'works').evaluate((e) => getComputedStyle(e, '::after').content),
    edge: await blockOf(row(app, 'asks')).evaluate((e) => getComputedStyle(e, '::before').content),
  };
  expect(got).toEqual({ row: 34, word: '11.5px', dot: 8, line: 'none', edge: 'none' });
});
