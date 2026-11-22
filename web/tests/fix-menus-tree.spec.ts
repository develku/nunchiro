import { expect, test } from './fixtures';
import { riskPatches } from './fixtures/fid-tree';
import { repo, show, trading, worktree } from './visual/compare';
import { openQuiet } from './tree-seed';

// fix-menus-tree-d. Rows 02/14 (decision line), 09/13/14 (sidebar head), 06 (nested Agents).
// The approved mockups, not the brief's prose, are the golden: ko/hiderows-r6.html draws the question on ONE line with
// an ellipsis (`.q .qt{white-space:nowrap;text-overflow:ellipsis}`) and the elapsed time on the session row
// (`.row .tm`), and ko/v2-8a-a-folds.html ③ draws "3 projects" wrapping to two lines at the sidebar's width.

test('waiting_row_shows_elapsed_time_from_the_mockup', async ({ app, core }) => {
  const p = repo(core, 'lumen');
  worktree(core, p, 'build-fix');
  openQuiet(core);
  await riskPatches(app, { 'build-fix': { waiting: 'permission', text: 'npm test 실행 허용?' } });
  await show(app, 'light');
  const row = app.locator('.sess .row.wt2').first();
  await expect(row).toBeVisible();
  // Ticket 1041 (mockup polish-1121): the row shows its word, not its age; the age (observed 2 min ago) is in the tip.
  await expect(row.locator('.tm')).toHaveCount(0);
  await expect(row.locator('.sw')).toHaveText('needs you');
  await expect(row.locator('.tip')).toContainText('2 min');
  // and the word comes before the icon, where the time was.
  const order = await row.evaluate((e) => [...e.children].map((k) => k.className));
  expect(order.indexOf('sw')).toBeLessThan(order.indexOf('ic'));
});

/** How much of the question itself paints inside its own box, chip excluded: 0 means the chip ate the whole line. */
const questionPainted = (el: HTMLElement) => {
  const qt = el.querySelector<HTMLElement>('.qt')!;
  const clip = qt.getBoundingClientRect().right;
  const range = document.createRange();
  const dot = qt.querySelector('.warn'); // V2.5-34: under a project head the dot leads the line, outside the question
  if (dot) range.setStartAfter(dot);
  else range.setStart(qt, 0);
  range.setEnd(qt, qt.childNodes.length);
  return [...range.getClientRects()].reduce((w, r) => w + Math.max(0, Math.min(r.right, clip) - r.left), 0);
};

test('question_stays_one_line_and_the_caution_chip_keeps_it', async ({ app, core }) => {
  const p = repo(core, 'lumen');
  worktree(core, p, 'feature-x');
  worktree(core, p, 'sizing-v2');
  // A shell session's risky line (audit row 02); since RC gap 3 it sits under the session's own row.
  core.shell(p, 'build-fix');
  openQuiet(core);
  await riskPatches(app, { 'build-fix': { waiting: 'permission', text: 'build/ 삭제 실행 허용?', risky: true } });
  await show(app, 'light');
  const line = app.locator('.sess:not(.hl) .q[data-risky]'); // RC gap 3: the line sits under build-fix's own row
  await expect(line).toBeVisible();
  // One line, as the session row above it: the mockup's .q is 29px tall at its 30 px rows, one less than the row (ticket
  // 1041 lane 1 made rows 32 by default, so the line is 31).
  const rowH = (await app.locator('.sess:not(.hl) .row.wt2').first().boundingBox())!.height;
  expect((await line.boundingBox())!.height).toBeLessThanOrEqual(rowH - 1);
  // The chip rides inside the question's span, so it cannot push the question out of the line.
  const [chip, qt] = [await line.locator('.warn').boundingBox(), await line.locator('.qt').boundingBox()];
  expect(chip!.x + chip!.width).toBeLessThanOrEqual(qt!.x + qt!.width);
  // The question paints, not just its box: before this lane the box was 54px, all of it the chip, and no word of the
  // question showed (audit row 02, "주의 칩 뒤 질문이 보이지 않고").
  expect(await line.evaluate(questionPainted)).toBeGreaterThan(40);
  await expect(line.locator('.warn')).toHaveText('Caution');
});

// The narrow-sidebar half of rows 09/13/14: at the 256px the brief names, the head holds "3 projects", the strip and
// "+2" whole, and at the sidebar's own width (243px since ticket 411) it holds at least as much as ko/v2-8a-a-folds.html ③ does at that width.
test('folded_head_at_256_keeps_the_strip_and_plus_whole', async ({ app, core }) => {
  const group = await trading(app, core, 'light');
  const head = group.locator('> .row.ghead');
  await expect(head.locator('.d')).toHaveText('3 projects');
  await expect(head.locator('.cstrip .num')).toHaveText(['3', '4']); // ticket 388: three waiting and four idle, each one bar and its number
  // scrollWidth counts the row's 8px right padding, so the clip is measured against the padding box's inner edge, the
  // place the mockup's own drawing stops (its bar ends at 250px of the same 239px row).
  const measure = (width?: number) =>
    head.evaluate((el, w) => {
      el.style.width = w ? `${w}px` : '';
      const bar = el.querySelector<HTMLElement>(':scope > .cstrip')!;
      const d = el.querySelector<HTMLElement>(':scope > .d')!;
      const edge = el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight);
      return { width: el.clientWidth, barOver: Math.round(bar.getBoundingClientRect().right - edge), dLines: Math.round(d.getBoundingClientRect().height / 16) };
    }, width);
  const wide = await measure(256);
  expect(wide.width).toBe(256);
  // 2px, the same overhang the approved drawing itself has at 256px (measured: mockup barOver 2, app 2): not a clip the
  // mockup avoids.
  expect(wide.barOver, 'the strip and "+2" reach no further past the edge than the mockup at 256px').toBeLessThanOrEqual(2);
  // At its own width the head cuts what the approved drawing cuts at that width and no more (measured: mockup 19, app
  // 19, both against the padding edge; the row was 239 px wide and its content box 231). Ticket 411 gave a group's rows
  // back the 4px right gutter, one strip column with ungrouped projects, so the head is now 243 px and clips no more.
  const own = await measure();
  expect(own.width).toBe(243);
  expect(own.barOver, 'the head clips more than the approved mockup does at 239px').toBeLessThanOrEqual(19);
  // Ticket 388 took the pills out: "3 projects" now fits on the name's line, as the 388 mock draws "Trading 3 projects".
  expect(own.dLines, '"3 projects" stays on one line').toBe(1);
});

// The Agents header and "Clear done" are an approved later addition (V1A-59, needs 122; ROADMAP row 74), so they stay;
// what this lane fixes is the clipping they left in a 256px sidebar.
test('nested_agents_show_whole_names_and_states', async ({ app, core }) => {
  const { defaultBars } = await import('../src/layout/bars');
  const p = core.project('nunchiro');
  core.shell(p, 'backtest-runner');
  core.cli('session', 'close', core.shell(p, 'docs-1028h').id);
  openQuiet(core);
  const bars = { ...defaultBars(), nest: { [p]: ['agents'] }, open: { [`${p}::agents`]: false } };
  await app.addInitScript((b) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ bars: b })), bars);
  await app.mouse.move(900, 600);
  await app.goto('/');
  await app.getByRole('button', { name: 'Agents view', exact: true }).click();
  const agents = app.locator('.view[data-view="agents"] .agents');
  await expect(agents.getByRole('button', { name: 'Clear done', exact: true })).toBeVisible();
  // Both the name and the "project · account · state" line are whole: a word is never cut to "backt…" or "runni…".
  const parts = await agents.locator('.ar .n, .ar .s').evaluateAll((els) => els.map((el) => ({ text: el.textContent, width: el.clientWidth, scroll: el.scrollWidth })));
  expect(parts.length).toBe(4);
  for (const part of parts) expect(part.scroll, part.text ?? '').toBeLessThanOrEqual(part.width);
  // The metadata gets its own line rather than an ellipsis.
  await expect(agents.locator('.ar .s').first()).toHaveCSS('grid-column-start', '2');
});
