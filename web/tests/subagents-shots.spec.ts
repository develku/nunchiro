// V2-CF4 design conformance page: option A of the approved sub-agents mockup next to the app's own tree, for
// `.scratch/subagents/side-by-side.html` (REPORT). Not part of the gate: run with SG_SHOTS=1.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from '@playwright/test';
import type { ChatCore } from './fixtures/chat/harness';
import { append, expect, rec, test } from './fixtures/chat/harness';
import { REPO } from './fixtures';
import { openQuiet } from './tree-seed';
import { patchSnapshots } from './visual/compare';

test.skip(!process.env.SG_SHOTS, 'screenshots for the side-by-side page: SG_SHOTS=1');
const OUT = path.join(REPO, '.scratch/subagents');
const SHOTS = path.join(OUT, 'shots');
const MOCKUP = path.join(REPO, '.scratch/mockups/subagents-fold.html');
const PANE = '.card:first-of-type .pane';

/** A launch as a real transcript writes it: dated a minute ago, so the running child reads "working 1m" as the mockup. */
const launch = (id: string, name: string, label: string) => ({
  ...rec.use(id, name, { description: label, prompt: 'look' }),
  timestamp: new Date(Date.now() - 90_000).toISOString(),
});
const sideEnd = (id: string) => ({ type: 'assistant', isSidechain: true, parentToolUseID: id, message: { stop_reason: 'end_turn', content: [] }, uuid: `side-${id}` });

/** Alpha: one working child and one finished; beta: one working child (option A's own example rows). */
async function seedChildren(core: ChatCore) {
  const a = core.chat('alpha');
  openQuiet(core);
  const b = core.chat('beta');
  append(a.file, launch('t1', 'Task', 'Explore: find ssh -G callers'), launch('t2', 'Agent', 'Plan: page layout'), sideEnd('t2'));
  append(b.file, launch('t3', 'Task', 'Review: delivery keys'));
  return { a, b };
}

/**
 * The mockup's own frame: one project, "main + 2 worktrees", with the count on a session row under the project. The
 * main folder's session carries two children, each worktree's one (option A's fix-queue and machines-ui rows).
 */
function seedProject(core: ChatCore) {
  const p = core.project('nunchiro');
  const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a]);
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  openQuiet(core);
  const start = (label: string, worktree = false) => {
    const s = core.cli('session', 'start', '--kind', 'claude', '--project', p, '--label', label, ...(worktree ? ['--worktree'] : [])).session as { id: string; cwd: string; agent_session_id: string };
    const file = core.transcriptPath(s);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    return { ...s, file };
  };
  const main = start('nunchiro');
  const fix = start('fix-queue', true);
  const machines = start('machines-ui', true);
  append(main.file, launch('t1', 'Task', 'Explore: find ssh -G callers'), launch('t2', 'Agent', 'Plan: page layout'), sideEnd('t2'));
  append(fix.file, launch('t3', 'Task', 'Review: delivery keys'));
  append(machines.file, launch('t4', 'Task', 'Check the tree rows'));
  return { main, fix, machines };
}

/** The mockup's option A pane, at the app tree's width, in this scheme. */
async function mockShot(app: Page, browser: Browser, scheme: 'light' | 'dark') {
  const mock = await (await browser.newContext({ viewport: app.viewportSize()! })).newPage();
  await mock.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await mock.goto(`file://${MOCKUP}`);
  await mock.addStyleTag({ content: '.wrap>h1,.wrap>p,.card:not(:first-of-type),.tog{display:none!important}body{background:#fff!important}' });
  await mock.locator(PANE).evaluate((e, w) => {
    const el = e as HTMLElement;
    [el.style.width, el.style.maxWidth] = [`${w}px`, 'none'];
  }, (await app.locator('.tree').boundingBox())!.width);
  await mock.locator(PANE).screenshot({ path: path.join(SHOTS, `mock-${scheme}.png`), animations: 'disabled' });
}

/** Opens a session's children and takes the focus and the pointer back off the row, so the shot is the row at rest. */
const openKids = async (app: Page, id: string) => {
  await app.locator(`.kidcount[data-kids~="${id}"]`).click();
  await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await app.mouse.move(900, 600);
};

const shot = async (app: Page, name: string) => app.locator('.tree').screenshot({ path: path.join(SHOTS, `${name}.png`), animations: 'disabled' });

for (const scheme of ['light', 'dark'] as const) {
  test(`shots (${scheme})`, async ({ app, chatCore, browser }) => {
    test.setTimeout(120_000);
    fs.mkdirSync(SHOTS, { recursive: true });
    const { a } = await seedChildren(chatCore);
    await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await app.goto('/');
    await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
    await app.mouse.move(900, 600);
    await shot(app, `collapsed-${scheme}`);
    await openKids(app, a.id);
    await shot(app, `open-${scheme}`);
    await mockShot(app, browser, scheme);
  });

  test(`shots, one project with two worktrees (${scheme})`, async ({ app, chatCore, browser }) => {
    test.setTimeout(120_000);
    fs.mkdirSync(SHOTS, { recursive: true });
    const { main, fix, machines } = seedProject(chatCore);
    await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await app.goto('/');
    await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
    await app.mouse.move(900, 600);
    await shot(app, `project-${scheme}`);
    for (const s of [main, fix, machines]) await openKids(app, s.id);
    await expect(app.locator(`.kids[data-session="${main.id}"] .row.kid`)).toHaveCount(2);
    await expect(app.locator(`.kids[data-session="${fix.id}"] .row.kid`)).toHaveCount(1);
    await shot(app, `project-open-${scheme}`);
    await mockShot(app, browser, scheme);
  });

  test(`shots, parent waiting (${scheme})`, async ({ app, chatCore }) => {
    test.setTimeout(120_000);
    fs.mkdirSync(SHOTS, { recursive: true });
    const { a } = await seedChildren(chatCore);
    await patchSnapshots(app, { alpha: { waiting: 'permission' } });
    await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await app.goto('/');
    await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
    await app.mouse.move(900, 600);
    await shot(app, `waiting-${scheme}`);
    await openKids(app, a.id);
    await expect(app.locator(`.kids[data-session="${a.id}"] .row.kid`)).toHaveCount(2);
    await shot(app, `waiting-open-${scheme}`);
  });
}

test('design_conformance', async () => {
  const cell = (f: string) => `<a href="shots/${f}.png"><img src="shots/${f}.png" loading="lazy"></a>`;
  const row = (s: string, a: string, b: string, note: string) =>
    `<h2>${s}</h2><small>${note}</small><table><tr><th>Mockup (option A)</th><th>App</th></tr><tr><td>${cell(a)}</td><td>${cell(b)}</td></tr></table>`;
  fs.writeFileSync(
    path.join(OUT, 'side-by-side.html'),
    `<!doctype html><meta charset="utf-8"><title>V2-CF4: sub-agents fold, mockup vs app</title><style>body{font:14px system-ui;margin:16px;background:#f6f6f4;color:#1f2328}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d1d9e0;padding:6px;vertical-align:top;width:50%}th{background:#fff}img{width:100%;display:block}h2{margin:18px 0 2px}small{color:#59636e}</style>
<h1>V2-CF4 sub-agents: the approved mockup's option A next to the app (real core, fake Claude)</h1>
<h2>Option A's promises and the test that holds each</h2>
<table><tr><th>Promise (approved mockup)</th><th>Test</th></tr>
<tr><td>Folds under the session row, collapsed; one count on the parent</td><td>subagents_fold_under_session</td></tr>
<tr><td>The count sits on the session row itself; folded adds no row</td><td>count_on_session_row</td></tr>
<tr><td>The words live in the tooltip and label; the number reads once</td><td>count_words_in_tooltip_only</td></tr>
<tr><td>Open: indented quiet rows, finished ones dimmed</td><td>subagent_rows_dimmed</td></tr>
<tr><td>The count is reachable and labelled</td><td>subagents_reachable_within_two_clicks</td></tr>
<tr><td>A sub-agent permission still shows once, on the parent's row</td><td>subagent_permission_once_on_parent</td></tr>
<tr><td>Folding never sends anything</td><td>subagent_fold_never_sends</td></tr>
<tr><td>Nothing about groups, pins or quiet lines changes</td><td>subagent_tree_groups_preserved</td></tr>
<tr><td>A running child reads "working 1m": the state and the age since its own launch record</td><td>child_shows_age</td></tr>
<tr><td>A child nobody reported a state or a time for says nothing, stays grey, and is not counted as working</td><td>unknown_child_not_working</td></tr></table>
${(['light', 'dark'] as const)
  .map(
    (s) =>
      row(
        `one project, main + 2 worktrees, ${s}`,
        `mock-${s}`,
        `project-${s}`,
        "The mockup's own frame: one project over its main folder and worktrees, and the count at the right end of a session row beside its name and kind. The app draws the same tree (the main folder's head row is its session row, each worktree its own), with ↳ 2 on the main session and ↳ 1 on each worktree. The kind word (\"claude\") is not drawn on app rows: TREEROWS keeps words in the tooltip.",
      ) +
      row(`one project, open, ${s}`, `mock-${s}`, `project-open-${s}`, 'All three sessions opened: the children sit one step in with their state and age ("working 1m", "done"), blue rail while working, purple once done, the finished row dimmed.') +
      row(`collapsed, ${s}`, `mock-${s}`, `collapsed-${s}`, 'The mockup draws its own example rows (a worktree row with a count, one waiting row with a pill and a count, two sub rows). The app: alpha has 2 sub-agents, one working and one done.') +
      row(`open, ${s}`, `mock-${s}`, `open-${s}`, "Same option A source; the app's children are one click open, indented one step, dimmed with a 2px rail.") +
      row(`parent waiting, ${s}`, `mock-${s}`, `waiting-${s}`, 'A permission stays one decision on the parent: the pill sits on the parent row, ↳ 2 beside it.') +
      row(`parent waiting, open, ${s}`, `mock-${s}`, `waiting-open-${s}`, 'Opened with the parent still waiting: no answer control of its own under the children.'),
  )
  .join('')}`,
  );
});
