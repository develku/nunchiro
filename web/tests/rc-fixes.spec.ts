// Ticket 181 RC gap 3: a waiting session in a project's main folder (no worktree) gets its own tree row, and its
// decision line sits under that row, not under the project header. Approved design: needs 92 (TREEROWS,
// docs/v2/owner-packets/2026-10-27-tree-rows/v2-8a-d.html mockup A `row you`: orange rail and tint, "2 min", hand or ?)
// and needs 95 (a decision attaches to the session row that asked it; only project-level items sit under the header).
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { fakes, gitRepo, PERMISSION, proxy, QUESTION, show } from './decision-rows-seed';

type Agent = { id: string; cwd: string };
async function setup(app: Page, core: Core) {
  fakes(core);
  const p = gitRepo(core, 'repo');
  const wt = core.agent(p, 'wt-a', 'go-a', true) as Agent;
  const main = core.agent(p, 'main-a', 'go-m') as Agent;
  const px = await proxy(app);
  await openWindow(app);
  // Starts from the visible Tree control on the Left bar.
  const tree = app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Tree' });
  if ((await tree.getAttribute('aria-pressed')) !== 'true') await tree.click();
  await expect(tree).toHaveAttribute('aria-pressed', 'true');
  return { p, wt, main, px };
}
const grp = (app: Page) => app.locator('.grp[data-project="repo"]');
const line = (app: Page, a: Agent) => app.locator(`.q[data-line="${a.id}"]`);
const rowOf = (app: Page, a: Agent) => grp(app).locator(`.row.wt2[data-menu-session="${a.id}"]`);
const tokenColour = (app: Page, v: string) =>
  app.evaluate((c) => {
    const d = document.createElement('i');
    d.style.color = c;
    document.body.append(d);
    const r = getComputedStyle(d).color;
    d.remove();
    return r;
  }, v);

test('main_waiting_row: a waiting main-folder session has its own orange your-turn row with age and hand; a question shows ask', async ({ app, core }) => {
  const { main } = await setup(app, core);
  await app.mouse.move(900, 600); // pointer outside the tree: nothing is frozen
  show(main.cwd, 'go-m', PERMISSION('touch out-m'));
  await expect(line(app, main)).toBeVisible({ timeout: 8000 });
  const row = rowOf(app, main);
  await expect(row).toHaveCount(1);
  await expect(row).toHaveClass(/\byou\b/);
  await expect(row).toHaveAttribute('data-kind', 'hand');
  await expect(row.locator('.tip')).toContainText(/\d+\s*(min|s|h)|now/); // ticket 1041: the age is in the tip; the row shows its word
  // Design book (tree rows): no rail or edge; the row's needs-you dot in --light-you, and its word.
  await expect(row.locator('.sdot')).toHaveAttribute('data-dot', 'you');
  await expect(row.locator('.sw')).toHaveText('needs you');
  expect(await row.locator('.sdot').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(await tokenColour(app, 'var(--light-you)'));
  await expect(row).toContainText('main-a');
});

test('main_waiting_row question: a waiting question from a main-folder session shows the ask icon on its row', async ({ app, core }) => {
  const { main } = await setup(app, core);
  await app.mouse.move(900, 600);
  show(main.cwd, 'go-m', QUESTION);
  await expect(line(app, main)).toBeVisible({ timeout: 8000 });
  await expect(rowOf(app, main)).toHaveAttribute('data-kind', 'ask');
});

test('main_waiting_line_under_row: the line sits right under the row, is not a head line, actions visible at rest; a project-level item stays under the header', async ({ app, core }) => {
  const { main, px } = await setup(app, core);
  await app.mouse.move(900, 600);
  // A project-level item (no session), as the board files one, rides along with the main session's.
  px.patch((d, s) => (s.label === 'main-a' ? [d, { ...d, id: 'proj-1', session_id: '', text: 'Project question?' }] : undefined));
  show(main.cwd, 'go-m', PERMISSION('touch out-m'));
  await expect(line(app, main)).toBeVisible({ timeout: 8000 });
  const [r, q] = [await rowOf(app, main).boundingBox(), await line(app, main).boundingBox()];
  expect(Math.abs(q!.y - (r!.y + r!.height))).toBeLessThanOrEqual(2);
  await expect(app.locator('.sess.hl').filter({ has: line(app, main) })).toHaveCount(0);
  for (const act of ['allow', 'details', 'deny', 'peek']) {
    const b = line(app, main).locator(`[data-act="${act}"]`).first();
    await expect(b, act).toBeVisible();
    expect(await b.evaluate((e) => getComputedStyle(e.closest('.ag') ?? e).opacity), act).toBe('1');
  }
  // needs 95: the project-level item is a head line right under the header, above the session row.
  const proj = grp(app).locator('.sess.hl .q').filter({ hasText: 'Project question?' });
  await expect(proj).toHaveCount(1);
  const head = await grp(app).locator('.row.head').boundingBox();
  const pb = await proj.boundingBox();
  expect(Math.abs(pb!.y - (head!.y + head!.height))).toBeLessThanOrEqual(2);
  expect(pb!.y).toBeLessThan(r!.y);
});

// v25-new-tab (ticket 294 item 4, needs 213) replaces V2-CF4's "an idle main-folder session has no row of its own": an
// expanded project shows its idle sessions (it was main_idle_no_row).
test('main_idle_has_row: an idle main-folder session has a row of its own in an open project (needs 213)', async ({ app, core }) => {
  const { main, wt } = await setup(app, core);
  await app.mouse.move(900, 600);
  // The worktree session waits so the project is open (a quiet project folds away); the main one stays idle.
  show(wt.cwd, 'go-a', PERMISSION('touch out-a'));
  await expect(line(app, wt)).toBeVisible({ timeout: 8000 });
  await expect(rowOf(app, wt)).toHaveCount(1);
  await expect(rowOf(app, main)).toHaveCount(1);
  await expect(rowOf(app, main)).toHaveAttribute('data-kind', 'idle');
});

test('main_waiting_row freeze: a main session that starts waiting while the tree is held gets no line until release (needs 49)', async ({ app, core }) => {
  const { main, wt } = await setup(app, core);
  show(wt.cwd, 'go-a', PERMISSION('touch out-a')); // opens the project (a quiet one folds away)
  await expect(line(app, wt)).toBeVisible({ timeout: 8000 });
  await grp(app).locator('.row.head .n').hover(); // the pointer is in the tree: rows are read at freeze
  show(main.cwd, 'go-m', PERMISSION('touch out-m'));
  await expect(grp(app).locator('.head .chip')).toHaveText('new 1', { timeout: 8000 });
  // Since v25-new-tab (needs 213) the idle main session has had its row all along; what waits for the release is its line.
  await expect(rowOf(app, main)).toHaveCount(1);
  await expect(line(app, main)).toHaveCount(0);
  await app.mouse.move(900, 600);
  await expect(rowOf(app, main)).toHaveCount(1);
  await expect(line(app, main)).toBeVisible();
});
