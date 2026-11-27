// Design book, tree rows and the five states: state is a small light plus a word. Rows are 34 high (compact 24), radius 8,
// padding 0 10 0 24. Working breathes (3.6 s, one shared phase for every dot on screen), needs you glows and holds still,
// failed is a still dot, done and idle are rings. Tabs carry the same dot; the open tab is the reading surface joined to
// the sheet. A face that needs you wears the warm outline and glow. Reduced motion stills every dot.
import type { Locator, Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { patchSnapshots } from './tree-mock-states';

const row = (app: Page, name: string) => app.locator('.tree .row.wt2', { hasText: name });
const css = (l: Locator, ...props: string[]) => l.evaluate((e, p) => Object.fromEntries(p.map((k) => [k, getComputedStyle(e).getPropertyValue(k)])), props);
const token = (app: Page, name: string) =>
  app.evaluate((n) => {
    const probe = document.createElement('i');
    probe.style.color = `var(${n})`;
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);

async function seed(app: Page, core: Core, density?: 'compact') {
  if (density) await app.addInitScript((d) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ density: d, densityPicked: true })), density);
  const dir = core.project('demo');
  for (const l of ['asks', 'works', 'broke', 'limited', 'rests', 'quick']) core.shell(dir, l);
  const set = await patchSnapshots(app);
  const states = { asks: { waiting: true, wt: true }, works: { working: true, wt: true }, broke: { failed: true, wt: true }, limited: { limited: true, wt: true }, rests: { wt: true } };
  set(states);
  await openWindow(app);
  await expect(row(app, 'quick')).toBeVisible();
  set({ ...states, quick: { exited: true } });
  await expect(app.locator('.tree .row.wt2.just', { hasText: 'quick' })).toBeVisible();
}

test('row_size_and_dot_per_state: 34 high, radius 8, padding 0 10 0 24; one dot kind and its word per state', async ({ app, core }) => {
  await seed(app, core);
  for (const name of ['asks', 'works', 'broke', 'rests', 'quick']) {
    const r = row(app, name);
    expect(await css(r, 'height', 'border-top-left-radius', 'padding-left', 'padding-right'), name).toEqual({ height: '34px', 'border-top-left-radius': '8px', 'padding-left': '24px', 'padding-right': '10px' });
  }
  const want: [string, string, string | null][] = [
    ['asks', 'you', 'needs you'],
    ['works', 'run', null],
    ['broke', 'bad', 'failed'],
    ['limited', 'warn', 'Limit'],
    ['rests', 'idle', null],
    ['quick', 'done', null],
  ];
  for (const [name, dot, word] of want) {
    const d = row(app, name).locator('.sdot');
    await expect(d, name).toHaveCount(1);
    await expect(d, name).toHaveAttribute('data-dot', dot);
    expect(await d.evaluate((e) => [e.getBoundingClientRect().width, e.getBoundingClientRect().height]), `${name}: an 8 px light`).toEqual([8, 8]);
    if (word) await expect(row(app, name).locator('.sw'), name).toHaveText(word);
  }
  // The travelling line and the edge lights are gone: no ::after light on any row, no breathing edge on the your-turn block.
  for (const name of ['asks', 'works', 'broke', 'limited'])
    expect(await row(app, name).evaluate((e) => getComputedStyle(e, '::after').content), `${name}: no row light`).toBe('none');
  // Needs you: the glow ring and the wash; its word in --you-text, failed in --bad-text.
  expect((await css(row(app, 'asks').locator('.sdot'), 'box-shadow'))['box-shadow']).toContain('10px 2px');
  expect((await css(row(app, 'asks'), 'background-image'))['background-image']).toContain('linear-gradient');
  expect((await css(row(app, 'asks').locator('.sw'), 'color')).color).toBe(await token(app, '--you-text'));
  expect((await css(row(app, 'broke').locator('.sw'), 'color')).color).toBe(await token(app, '--bad-text'));
  // Failed is still and does not glow; idle and done are rings (no fill).
  expect(await css(row(app, 'broke').locator('.sdot'), 'animation-name', 'box-shadow')).toEqual({ 'animation-name': 'none', 'box-shadow': 'none' });
  for (const name of ['rests', 'quick']) expect((await css(row(app, name).locator('.sdot'), 'background-color'))['background-color'], name).toBe('rgba(0, 0, 0, 0)');
  // Working breathes on opacity and transform only.
  expect((await css(row(app, 'works').locator('.sdot'), 'animation-name'))['animation-name']).toBe('breathe');
  const frames = await app.evaluate(() => {
    for (const sheet of document.styleSheets)
      for (const r of sheet.cssRules) if (r instanceof CSSKeyframesRule && r.name === 'breathe') return [...r.cssRules].flatMap((k) => [...(k as CSSKeyframeRule).style]);
    return null;
  });
  expect(new Set(frames)).toEqual(new Set(['opacity', 'transform']));
});

test('compact_rows_are_24', async ({ app, core }) => {
  await seed(app, core, 'compact');
  for (const name of ['asks', 'works', 'broke']) expect((await css(row(app, name), 'height')).height, name).toBe('24px');
});

test('shared_phase: thirty working dots breathe as one, a late one joins the same phase', async ({ app, core }) => {
  const dir = core.project('many');
  const names = Array.from({ length: 30 }, (_, i) => `w${String(i + 1).padStart(2, '0')}`);
  for (const l of names) core.shell(dir, l);
  const set = await patchSnapshots(app);
  const working = (list: string[]) => Object.fromEntries(list.map((l) => [l, { working: true, wt: true }]));
  set(working(names.slice(0, 29)));
  await openWindow(app);
  await expect(app.locator('.tree .sdot[data-dot="run"]')).toHaveCount(29);
  await app.waitForTimeout(700); // the last one starts a beat later than the rest
  set(working(names));
  await expect(app.locator('.tree .sdot[data-dot="run"]')).toHaveCount(30);
  await app.waitForTimeout(200);
  const phases = await app.locator('.tree .sdot[data-dot="run"]').evaluateAll((dots) =>
    dots.map((d) => {
      const a = d.getAnimations().find((x) => (x as CSSAnimation).animationName === 'breathe')!;
      return Math.round(Number(a.currentTime) % 3600);
    }),
  );
  expect(phases).toHaveLength(30);
  expect(Math.max(...phases) - Math.min(...phases), `phases ${phases.join(' ')}`).toBeLessThanOrEqual(20);
});

test('reduced_motion_stills_the_dots: no animation, the words stay', async ({ app, core }) => {
  await app.emulateMedia({ reducedMotion: 'reduce' });
  await seed(app, core);
  expect((await css(row(app, 'works').locator('.sdot'), 'animation-name', 'opacity'))).toEqual({ 'animation-name': 'none', opacity: '1' });
  await expect(row(app, 'asks').locator('.sw')).toHaveText('needs you');
});

test('tabs_join_the_sheet: 30 high, radius 8 8 0 0, the open tab on the reading surface, the same dots', async ({ app, core }) => {
  await seed(app, core);
  const shown = app.locator('.tabw:has(> .tab[aria-selected="true"])');
  const other = app.locator('.tabw:has(> .tab[aria-selected="false"])').first();
  for (const t of [shown, other]) expect(await css(t, 'height', 'border-top-left-radius', 'border-bottom-left-radius')).toEqual({ height: '30px', 'border-top-left-radius': '8px', 'border-bottom-left-radius': '0px' });
  expect((await css(shown, 'background-color'))['background-color']).toBe(await app.evaluate(() => getComputedStyle(document.querySelector('.centre')!).backgroundColor));
  expect((await css(app.locator('.tabs'), 'background-color'))['background-color']).not.toBe((await css(shown, 'background-color'))['background-color']);
  const dot = (name: string) => app.locator('.tabw', { hasText: name }).locator('.tdot');
  await expect(dot('asks').locator('svg')).toHaveCount(0);
  expect((await css(dot('asks'), 'box-shadow'))['box-shadow']).toContain('10px 2px');
  expect((await css(dot('works'), 'animation-name'))['animation-name']).toBe('breathe');
  expect(await dot('works').evaluate((e) => [e.getBoundingClientRect().width, e.getBoundingClientRect().height])).toEqual([8, 8]);
});

test('face_needs_you_frame: warm outline 1.5 at offset 2 and the glow; no frame otherwise', async ({ app, core }) => {
  await seed(app, core);
  const frame = (you: boolean) =>
    app.evaluate((y) => {
      const f = document.createElement('span');
      f.className = 'face';
      if (y) f.dataset.you = '';
      f.style.setProperty('--s', '16px');
      document.body.append(f);
      const s = getComputedStyle(f);
      const out = { style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset, glow: s.boxShadow };
      f.remove();
      return out;
    }, you);
  const you = await frame(true);
  expect([you.style, you.width, you.offset]).toEqual(['solid', '1.5px', '2px']);
  expect(you.glow).toContain('14px 2px');
  const rest = await frame(false);
  expect([rest.style, rest.glow]).toEqual(['none', 'none']);
});
