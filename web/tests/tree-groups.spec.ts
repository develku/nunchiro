// V2-9a project groups in the one tree: folded groups, expand all, group actions, Hangul in the name field, axe.
// Chromium drives a real IME composition over CDP; Playwright WebKit has no IME driver and is not WKWebView.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { MENU_ONLY, SURFACES } from '../src/menu/surfaces';
import { boxes, expect, HANGUL, openWindow, showComposer, test, unmoved, type Core, agentsZone, stripBeside } from './fixtures';
import { seed } from './tree-seed';

// tree/commands registers the project and group surfaces; it reaches NewSession's CSS import, which Node cannot load.
registerHooks({ load: (url, context, next) => (url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context)) });
await import('../src/tree/commands');

test.beforeEach(({ core }) => agentsZone(core)); // D5b: these specs read the AGENTS rows, which the default window no longer shows

const arrive = (dir: string, trigger: string) => fs.writeFileSync(path.join(dir, trigger), '');
const clearing = (core: Core) => {
  const file = path.join(core.home, 'bin/claude');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("printf 'answered %s", "printf '\\033[2J\\033[Hanswered %s"), { mode: 0o700 });
};
const answerAgent = (core: Core, id: string) => core.cli('session', 'send-keys', id, '1', 'enter') // lane w102: send-text waits out a start question;

const tomlFolded = (core: Core) => fs.readFileSync(path.join(core.home, 'tree.toml'), 'utf8');

const grpOf = (app: Page, name: string) => app.locator(`.grp[data-project="${name}"]`);
/** Leaves the tree the way a user does: pointer away and focus into the composer. */
const leave = async (app: Page) => (await showComposer(app), await app.mouse.move(900, 400), await app.locator('.cbox textarea').focus()); // V2.5-34: a shell's composer is asked for
const group = (app: Page, name: string) => app.locator(`.pgrp[data-group="${name}"]`);
const menu = (p: Page) => p.getByRole('menu', { name: 'Actions' });
/** Runs a palette command by its title. */
async function palette(app: Page, query: string) {
  // A name or picker dialog wears the class "palette" too and stays up until the core answers its edit: wait for it to go, or
  // `.palette input` matches two inputs (strict-mode violation) and Meta+K opens the palette over it.
  await expect(app.locator('.palette')).toHaveCount(0);
  await app.keyboard.press('Meta+KeyK');
  const box = app.getByRole('dialog', { name: 'Command palette' });
  await box.getByRole('combobox').fill(query);
  await app.keyboard.press('Enter');
  await expect(box).toHaveCount(0); // the command ran; a dialog it opens is a different element
}
/** Composes text through its jamo stages over CDP, as hangul.spec does. */
async function compose(app: Page, text: string, leaveLast = false) {
  const cdp = await app.context().newCDPSession(app);
  const gap = () => new Promise((r) => setTimeout(r, 15));
  for (const [i, ch] of [...text].entries()) {
    await gap();
    const code = ch.charCodeAt(0) - 0xac00;
    if (code < 0 || code > 11171) {
      await cdp.send('Input.insertText', { text: ch });
      continue;
    }
    const lead = String.fromCharCode(0x1100 + Math.floor(code / 588)).normalize('NFC');
    const stages = [lead, String.fromCharCode(0xac00 + code - (code % 28))];
    if (code % 28) stages.push(ch);
    for (const s of stages) {
      await cdp.send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length });
      await gap();
    }
    if (!(leaveLast && i === text.length - 1)) await cdp.send('Input.insertText', { text: ch });
  }
}

// needs 81, 128 (and the folded group's shared waiting-row budget, needs 130): a folded group shows at most two waiting rows
// in all, then "+N waiting" for the rest. Before the budget was shared, the rule was per project (2 rows plus "+1 waiting" for alpha).
test('folded_group_shows_waiting_row_answerable: 5 waiting items in a folded group show 2 rows plus "+3 waiting", answerable without unfolding', async ({ app, core }) => {
  clearing(core);
  const p = ['alpha', 'beta', 'gamma'].map((n) => core.project(n));
  const agents = [0, 1, 2].map((i) => core.agent(p[0], `a${i}`, `go-${i}`)).concat([core.agent(p[1], 'b0', 'go-b'), core.agent(p[2], 'c0', 'go-c')]);
  seed(core, { op: 'group_create', name: 'Web', project: p[0] }, { op: 'project_move', project: p[1], group: 'Web' }, { op: 'project_move', project: p[2], group: 'Web' }, { op: 'fold', key: 'group:Web', folded: true });
  await openWindow(app);
  await app.mouse.move(900, 400);
  const web = group(app, 'Web');
  await expect(web.locator('.ghead')).toBeVisible();
  await expect(web.locator('.grp')).toHaveCount(0);
  [0, 1, 2].forEach((i) => arrive(p[0], `go-${i}`));
  arrive(p[1], 'go-b');
  arrive(p[2], 'go-c');
  // The two oldest are alpha's own; the group's overflow line counts the other three (alpha's third, beta's, gamma's).
  await expect(web.locator('.q')).toHaveCount(2, { timeout: 5000 });
  await expect(web.locator('.grp[data-project="alpha"] .q')).toHaveCount(2);
  await expect(web.locator('.more')).toHaveText('+3 waiting');
  await expect(web.locator(':scope > .sess, :scope > .more')).toHaveCount(0);
  // Answerable from the row: V2-8e (HIDEROWS), it opens that session's panel card instead of the strip card.
  await app.evaluate(() => {
    (window as unknown as { focused: unknown[] }).focused = [];
    window.addEventListener('nunchiro:queue.focus', (e) => (window as unknown as { focused: unknown[] }).focused.push((e as CustomEvent).detail));
  });
  const session = (await web.locator('.q').first().getAttribute('data-line'))!;
  await web.locator('.q').first().click();
  const focused = await app.evaluate(() => (window as unknown as { focused: { id: string; session: string }[] }).focused);
  expect(focused).toHaveLength(0);
  expect(agents.map((a) => a.id)).toContain(session);
  await expect(app.locator(`aside.sbar[data-side="right"] .deccard[data-session="${session}"]`)).toBeVisible(); // DECISIONW
  // The right sidebar narrows the main zone below the minimum columns, so V1A-60 folds the tree: close the widget to bring it back.
  await app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Decisions' }).click();
  answerAgent(core, session);
  await app.mouse.move(900, 400); // the click parked the pointer in the tree: the answered row stays until it leaves
  await expect(web.locator('.more')).toHaveText('+2 waiting', { timeout: 5000 }); // four items are left: the third took the answered row's place
  await expect(web.locator('.q')).toHaveCount(2);
  await expect(web.locator('.row.wt2')).toHaveCount(2); // only the waiting rows: a folded group draws no project or worktree row
  await expect(web.locator('.ghead').getByRole('button', { name: /Expand group Web/ })).toHaveAttribute('aria-expanded', 'false');
});

test('pointer_in_tree_shows_new_chip_not_row: a folded group shows "N new" while the pointer is in the tree, then the row animates in', async ({ app, core }) => {
  stripBeside(core); // needs 107 (ticket 180): the strip in its own zone beside the terminal, so an arrival moves nothing but the strip
  const a = core.project('alpha');
  const b = core.project('beta');
  core.agent(a, 'a1', 'go-1');
  core.shell(b, 'b1');
  seed(core, { op: 'group_create', name: 'Web', project: a }, { op: 'fold', key: 'group:Web', folded: true });
  await openWindow(app);
  await grpOf(app, 'beta').locator('.head .n').hover();
  const before = await boxes(app);
  arrive(a, 'go-1');
  const web = group(app, 'Web');
  await expect(web).toHaveAttribute('data-urgency', 'waiting', { timeout: 5000 });
  await expect(web.locator('.ghead .chip')).toHaveText('1 new');
  await expect(web.locator('.q')).toHaveCount(0);
  // The arrival draws its strip and changes the composer by it; no tree row, tab or other box moves.
  const moved = unmoved(before, await boxes(app));
  expect(moved).toContain('strip');
  expect(moved.filter((k) => k !== 'strip' && k !== 'cbox')).toEqual([]);
  await app.mouse.move(900, 400);
  await expect(web.locator('.q')).toHaveCount(1);
  await expect(web.locator('.ghead .chip')).toHaveText('');
});

// needs 130 (FIDELITY BAR, mockup ③): a folded group's body is only its waiting rows, so the session you go to adds no row of its own
// (before, its one row showed until the user left the tree).
test('notification_click_does_not_unfold: going to a session leaves its group folded and adds no row', async ({ app, core }) => {
  const a = core.project('alpha');
  const b = core.project('beta');
  const s = core.shell(a, 'a1');
  const other = core.shell(b, 'b1');
  seed(core, { op: 'group_create', name: 'Web', project: a }, { op: 'fold', key: 'group:Web', folded: true });
  await openWindow(app);
  await app.mouse.move(900, 400);
  const web = group(app, 'Web');
  await app.locator(`.ar[data-agent="${other.id}"]`).click();
  await expect(web.locator('.row.sess')).toHaveCount(0);
  // The path a notification click or an AGENTS row takes: the palette's go-to opens the same session.
  await app.locator(`.ar[data-agent="${s.id}"]`).click();
  await expect(app.locator(`.tab[data-tab="${s.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(web.locator('.row.sess, .row.wt2')).toHaveCount(0);
  await expect(web.locator('.grp')).toHaveCount(0);
  await expect(web.locator('.ghead button.chev')).toHaveAttribute('aria-expanded', 'false');
  await app.locator(`.ar[data-agent="${other.id}"]`).click();
  await expect(web.locator('.row.sess, .row.wt2')).toHaveCount(0);
  await expect(web.locator('.ghead button.chev')).toHaveAttribute('aria-expanded', 'false');
});

test('expand_all_one_level_then_restores: one press shows every project header, a second restores the exact folding; Alt opens the same level plus clean-up folds', async ({ app, core }) => {
  const [a, b, c] = ['alpha', 'beta', 'gamma'].map((n) => core.project(n));
  [a, b, c].forEach((d, i) => core.shell(d, `s${i}`));
  const repo = core.project('repo');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args]);
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  core.shell(repo, 'main-shell');
  core.agent(repo, 'wt-agent', 'go', true);
  seed(core, { op: 'group_create', name: 'Web', project: a }, { op: 'project_move', project: b, group: 'Web' }, { op: 'project_move', project: repo, group: 'Web' }, { op: 'fold', key: 'group:Web', folded: true });
  await openWindow(app);
  await app.mouse.move(900, 400);
  const btn = app.getByRole('button', { name: 'Expand all' });
  // The core's tree (groups, folds) has loaded: a press before its first tree_get reply takes the empty tree's folding as
  // the one to restore. Only the loaded tree has the Web group's header.
  await expect(group(app, 'Web')).toHaveCount(1);
  // Folded to begin with: the group hides its projects' headers; the one outside it stays.
  await expect(app.locator('.grp[data-project]')).toHaveCount(1);
  const prior = tomlFolded(core);
  await btn.click();
  await expect(app.locator('.grp[data-project]')).toHaveCount(4);
  // The press's fold_set has reached tree.toml: until then the file still reads `prior`, so the check after Restore below
  // could pass before either write lands, and the reload would then show the expanded folding.
  await expect.poll(() => tomlFolded(core)).not.toBe(prior);
  await expect(app.getByRole('button', { name: 'Restore' })).toBeVisible();
  await expect(app.locator('.grp[data-project] .row.wt2:not([data-menu="treerow"])')).toHaveCount(1); // TREEROWS: worktree rows show whenever their project is open, no fold row first
  await app.getByRole('button', { name: 'Restore' }).click();
  await expect(app.locator('.grp[data-project] .row.wt2:not([data-menu="treerow"])')).toHaveCount(0);
  await expect(app.locator('.grp[data-project]')).toHaveCount(1);
  await expect.poll(() => tomlFolded(core)).toBe(prior);
  await app.reload();
  await expect(group(app, 'Web')).toHaveCount(1); // loaded again, as above
  await expect(app.locator('.grp[data-project]')).toHaveCount(1);
  // Alt-click opens the same level (and the clean-up folds, none without worktree facts): the worktree rows show too.
  await app.getByRole('button', { name: 'Expand all' }).click({ modifiers: ['Alt'] });
  await expect(app.locator('.grp[data-project] .row.wt2:not([data-menu="treerow"])')).toHaveCount(1);
  await app.getByRole('button', { name: 'Restore' }).click();
  await expect(app.locator('.grp[data-project] .row.wt2:not([data-menu="treerow"])')).toHaveCount(0);
  // Changing the folding while expanded makes the next press expand again.
  await app.getByRole('button', { name: 'Expand all' }).click();
  await expect(app.locator('.grp[data-project]')).toHaveCount(4);
  await app.getByRole('button', { name: 'Collapse group Web' }).click();
  await expect(app.getByRole('button', { name: 'Expand all' })).toBeVisible();
});

test('group_changes_move_nothing_under_pointer: create, rename, pin, dissolve and move leave every box alone while the pointer rests in the tree', async ({ app, core }) => {
  const [a, b, c] = ['alpha', 'beta', 'gamma'].map((n) => core.project(n));
  [a, b, c].forEach((d, i) => core.shell(d, `s${i}`));
  seed(core, { op: 'group_create', name: 'Docs', project: a });
  await openWindow(app);
  await app.mouse.move(900, 400);
  const gamma = grpOf(app, 'gamma');
  const steady = async (step: () => Promise<void>) => {
    await gamma.locator('.head .n').click(); // makes gamma the active project and parks the pointer on its row
    const before = await boxes(app);
    await step();
    await expect(app.locator('.palette')).toHaveCount(0); // the name dialog closes once the core answered; its change lands before the settle below, not in the next step
    await app.waitForTimeout(300);
    expect(unmoved(before, await boxes(app)), 'rows under the pointer moved').toEqual([]);
  };
  await steady(async () => {
    await palette(app, 'New group');
    await app.locator('.gname input').fill('Web');
    await app.keyboard.press('Enter');
  });
  await steady(async () => {
    await palette(app, 'project.pin'); // by id: the words "Pin" rank "Settings: Artifact libraries (… fixed versions …)" first
  });
  await leave(app);
  await expect(group(app, 'Web').locator('.grp[data-project="gamma"]')).toHaveCount(1);
  await expect(group(app, 'Web').locator('.pin-mark')).toHaveCount(1);
  await steady(async () => {
    await palette(app, 'Rename group');
    await app.locator('.gname input').fill('Site');
    await app.keyboard.press('Enter');
  });
  await leave(app);
  await expect(group(app, 'Site')).toHaveCount(1);
  await steady(async () => {
    await palette(app, 'Move to group');
    await app.locator('.tpick input').fill('Docs');
    await app.keyboard.press('Enter');
  });
  await leave(app);
  await expect(group(app, 'Docs').locator('.grp[data-project="gamma"]')).toHaveCount(1);
  await steady(async () => {
    await palette(app, 'Dissolve group');
  });
  await leave(app);
  await expect(group(app, 'Docs')).toHaveCount(0);
  await expect(gamma).toHaveCount(1);
});

test('group_name_field_composes_hangul: composing text stays, Enter commits only after composition, Esc cancels', async ({ app, core, browserName }) => {
  const a = core.project('alpha');
  const b = core.project('beta');
  core.shell(a, 's1');
  core.shell(b, 's2');
  await openWindow(app);
  await app.locator('.grp[data-project="alpha"] .head .n').click();
  await palette(app, 'New group');
  const field = app.locator('.gname input');
  await expect(field).toBeFocused();
  if (browserName === 'chromium') {
    await compose(app, HANGUL, true);
    const cdp = await app.context().newCDPSession(app);
    await cdp.send('Input.imeSetComposition', { text: '요', selectionStart: 1, selectionEnd: 1 });
    // The Enter that ends a syllable carries isComposing (Safari: keyCode 229): it must not commit.
    await field.evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true, cancelable: true } as KeyboardEventInit));
    });
    await expect(field).toBeVisible();
    await cdp.send('Input.insertText', { text: '요' });
  } else await app.keyboard.insertText(HANGUL);
  await expect(field).toHaveValue(HANGUL);
  await field.press('Enter');
  await expect(app.locator('.gname')).toHaveCount(0);
  await leave(app);
  await expect(group(app, HANGUL)).toHaveCount(1);
  // Esc cancels: nothing is created and the project stays where it was.
  await app.locator('.grp[data-project="beta"] .head .n').click();
  await palette(app, 'New group');
  await app.locator('.gname input').fill('Cancelled');
  await app.keyboard.press('Escape');
  await expect(app.locator('.gname')).toHaveCount(0);
  await leave(app);
  await expect(group(app, 'Cancelled')).toHaveCount(0);
  await expect(app.locator('.grp[data-project="beta"]')).toHaveCount(1);
});

test('group_commands_map_to_palette_ids: every menu item and button of the tree maps to a registered palette command', async ({ app, core }) => {
  const a = core.project('alpha');
  core.shell(a, 's1');
  await openWindow(app);
  await app.keyboard.press('Meta+KeyK');
  const ids = await app.locator('.palette [data-command]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.command));
  for (const surface of ['project', 'project-loose', 'group'] as const) {
    expect(SURFACES[surface].length, surface).toBeGreaterThan(0);
    for (const id of SURFACES[surface]) if (!MENU_ONLY.has(id)) expect(ids, `${surface}: ${id}`).toContain(id); // ticket 991 A10: row-only items are not in the palette
  }
  for (const id of ['group.create', 'group.rename', 'group.dissolve', 'group.move', 'group.remove', 'project.pin', 'tree.expand-all', 'projects.pick']) expect(ids, id).toContain(id);
  // The head button is the command: running the command presses it.
  await app.keyboard.press('Escape');
  await expect(app.getByRole('button', { name: 'Expand all' })).toBeVisible();
  await palette(app, 'tree.expand-all');
  await expect(app.getByRole('button', { name: 'Restore' })).toBeVisible();
});

test('never_fold: a project whose sessions have all ended keeps its own row and no Other projects line appears', async ({ app, core }) => {
  const [w, ended, pin] = ['waiting', 'ended', 'pinned'].map((n) => core.project(n));
  seed(core, { op: 'add', project: ended, added: true });
  core.agent(w, 'w1', 'go');
  core.shell(ended, 'once', '/bin/sh', '-c', 'exit 0');
  core.shell(pin, 's3');
  seed(core, { op: 'pin', project: pin, pinned: true });
  await openWindow(app);
  await app.mouse.move(900, 400);
  await expect(app.locator('.grp[data-project="ended"]')).toHaveAttribute('data-urgency', 'idle');
  await expect(app.getByRole('button', { name: /Other projects/ })).toHaveCount(0);
  await expect(app.locator('button.row.quiet:not(.done)')).toHaveCount(0); // a project's own "N done" fold keeps the class
  arrive(w, 'go');
  await expect(app.locator('.grp[data-project="waiting"]')).toHaveAttribute('data-urgency', 'waiting', { timeout: 5000 });
  // Pinned first, then first-seen order, each drawn once.
  const order = await app.locator('.tree .grp[data-project]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.project));
  expect(order).toEqual(['pinned', 'waiting', 'ended']);
});

const axeBad = async (p: Page, include: string) =>
  (await new AxeBuilder({ page: p }).include(include).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);

test('tree_axe_clean: the tree with a group, the open menu and the picker have no serious or critical violation', async ({ app, core }) => {
  const a = core.project('alpha');
  const b = core.project('beta');
  core.shell(a, 's1');
  core.shell(b, 's2');
  seed(core, { op: 'group_create', name: 'Web', project: a });
  await openWindow(app);
  expect(await axeBad(app, '.tree')).toEqual([]);
  await app.locator('.pgrp[data-group="Web"] .ghead').click({ button: 'right' });
  await expect(menu(app)).toBeVisible();
  expect(await axeBad(app, '.cmenu')).toEqual([]);
  await app.keyboard.press('Escape');
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyJ');
  await expect(app.getByRole('dialog', { name: 'Projects by status' })).toBeVisible();
  expect(await axeBad(app, '.palette')).toEqual([]);
});

const TREE_BOXES = '.tree .row, .tree .q, .tree .more, .ar, .cbox, #waiting-strip'; // the default set without `.tab`
test('current_row_under_folded_group_waits_for_the_pointer: going to a session while the pointer rests in the tree adds no row', async ({ app, core }) => {
  const a = core.project('alpha');
  const b = core.project('beta');
  const s = core.shell(a, 'a1');
  const other = core.shell(b, 'b1');
  seed(core, { op: 'group_create', name: 'Web', project: a }, { op: 'fold', key: 'group:Web', folded: true });
  await openWindow(app);
  await app.locator(`.ar[data-agent="${other.id}"]`).click();
  await grpOf(app, 'beta').locator('.head .n').hover();
  const before = await boxes(app, TREE_BOXES); // the tabs change with the project, so they are left out
  await app.locator(`.ar[data-agent="${s.id}"]`).evaluate((el) => (el as HTMLElement).click()); // ticket 570: its tab is in another project's strip
  await app.waitForTimeout(300);
  expect(unmoved(before, await boxes(app, TREE_BOXES))).toEqual([]);
  await expect(group(app, 'Web').locator('.row.sess')).toHaveCount(0);
  await leave(app);
  // needs 130: nothing arrives after the pointer leaves either: the folded group draws only waiting rows.
  await expect(group(app, 'Web').locator('.row.sess, .row.wt2')).toHaveCount(0);
  await expect(group(app, 'Web').locator('.ghead button.chev')).toHaveAttribute('aria-expanded', 'false');
});

test('stale_quiet_keys_tolerated: a tree.toml holding quiet: keys from an older version loads and the tree draws every project', async ({ app, core }) => {
  const [a, b] = ['alpha', 'beta'].map((n) => core.project(n));
  [a, b].forEach((d, i) => core.shell(d, `s${i}`));
  core.run(['serve', 'stop', '--yes']);
  await expect.poll(() => core.proc.exitCode !== null, { timeout: 10_000 }).toBe(true); // it writes tree.toml no more
  fs.writeFileSync(path.join(core.home, 'tree.toml'), `version = 1\nfolded = ["quiet:", "quiet:Web"]\n[[groups]]\nname = "Web"\nprojects = ["${a}"]\n`);
  await core.restart();
  await app.addInitScript((boot) => void (window.__NUNCHIRO__ = boot), core.boot()); // the new core has a new port and token
  await openWindow(app);
  await expect(group(app, 'Web').locator('.grp[data-project="alpha"]')).toHaveCount(1);
  await expect(app.locator('.grp[data-project="beta"]')).toHaveCount(1);
  await expect(app.locator('button.row.quiet:not(.done)')).toHaveCount(0);
  expect(tomlFolded(core)).toContain('quiet:'); // no migration
});

test('menu_labels_follow_clicked_row: Pin/Unpin and Remove from group describe the right-clicked row, not the active session', async ({ app, core }) => {
  const [a, b] = ['alpha', 'beta'].map((n) => core.project(n));
  const sa = core.shell(a, 's1');
  core.shell(b, 's2');
  seed(core, { op: 'pin', project: a, pinned: true }, { op: 'group_create', name: 'Web', project: a });
  await openWindow(app, {});
  await app.locator(`.ar[data-agent="${sa.id}"]`).click(); // alpha (pinned, grouped) is the active project
  await app.mouse.move(900, 400);
  await grpOf(app, 'beta').locator('.head .n').click({ button: 'right' });
  await expect(menu(app)).toBeVisible();
  const names = await menu(app).getByRole('menuitem').evaluateAll((els) => els.map((e) => ({ t: e.querySelector('.mt')?.textContent, off: e.getAttribute('aria-disabled') })));
  expect(names.find((n) => n.t === 'Pin')).toBeTruthy();
  expect(names.find((n) => n.t === 'Unpin')).toBeUndefined();
  expect(names.find((n) => n.t === 'Remove from group')).toBeUndefined();
  await app.keyboard.press('Escape');
  await grpOf(app, 'alpha').locator('.head .n').click({ button: 'right' });
  const alpha = await menu(app).getByRole('menuitem').evaluateAll((els) => els.map((e) => ({ t: e.querySelector('.mt')?.textContent, off: e.getAttribute('aria-disabled') })));
  expect(alpha.find((n) => n.t === 'Unpin')).toBeTruthy();
  expect(alpha.find((n) => n.t === 'Remove from group')).toBeTruthy();
});

test('group_dialog_single_submit: a second Enter while the edit is in flight sends nothing more', async ({ app, core }) => {
  const a = core.project('alpha');
  core.shell(a, 's1');
  await openWindow(app);
  const edits: string[] = [];
  app.on('websocket', (ws) => ws.on('framesent', (f) => typeof f.payload === 'string' && f.payload.includes('group_create') && edits.push(f.payload)));
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await app.locator('.grp[data-project="alpha"] .head .n').click();
  await palette(app, 'New group');
  await app.locator('.gname input').fill('Web');
  await app.locator('.gname input').evaluate((el) => {
    for (let i = 0; i < 2; i++) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  });
  await expect(app.locator('.gname')).toHaveCount(0);
  await leave(app);
  await expect(group(app, 'Web')).toHaveCount(1);
  expect(edits).toHaveLength(1);
});

/** A core that answers the first `failLoads` tree_get and every tree_edit while `refusing` with an Err, and passes everything else on. */
async function flaky(app: Page, gate: { refusing: boolean; failLoads: number }) {
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const op = typeof m === 'string' ? (JSON.parse(m).request?.op as string | undefined) : undefined;
      const no = (text: string) => ws.send(JSON.stringify({ id: JSON.parse(m as string).id, response: { Err: text } }));
      if (op === 'tree_edit' && gate.refusing) return no(`refused ${JSON.parse(m as string).request.edit.op}`);
      if (op === 'tree_get' && gate.failLoads-- > 0) return no('tree.toml unreadable');
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
}
const note = (app: Page, text: string) => app.getByRole('alert').filter({ hasText: text });

test('refused_tree_edit_shows_error: a refused fold, pin and move-to-group each show the core\'s message and the tree returns to the core\'s state', async ({ app, core }) => {
  const [a, b, c] = ['alpha', 'beta', 'gamma'].map((n) => core.project(n));
  [a, b, c].forEach((d, i) => core.shell(d, `s${i}`));
  seed(core, { op: 'group_create', name: 'Web', project: a }, { op: 'group_create', name: 'Docs', project: b });
  const gate = { refusing: false, failLoads: 0 };
  await flaky(app, gate);
  await openWindow(app);
  await app.mouse.move(900, 400);
  const before = tomlFolded(core);
  await grpOf(app, 'gamma').locator('.head .n').click(); // gamma is the active project
  gate.refusing = true;
  // Fold: the group's chevron flips at once and flips back.
  const chev = app.getByRole('button', { name: 'Collapse group Web' });
  await chev.click();
  await expect(note(app, 'refused fold')).toBeVisible();
  await expect(chev).toHaveAttribute('aria-expanded', 'true');
  await note(app, 'refused fold').getByRole('button', { name: 'Dismiss' }).click();
  await expect(note(app, 'refused fold')).toHaveCount(0);
  // Pin, from the palette.
  await palette(app, 'project.pin'); // by id: the words "Pin" rank "Settings: Artifact libraries (… fixed versions …)" first
  await expect(note(app, 'refused pin')).toBeVisible();
  expect(tomlFolded(core)).toBe(before);
  // Move to a group, from the picker.
  await palette(app, 'Move to group');
  await app.locator('.tpick input').fill('Docs');
  await app.keyboard.press('Enter');
  await expect(note(app, 'refused project_move')).toBeVisible();
  await expect(group(app, 'Docs').locator('.grp[data-project="gamma"]')).toHaveCount(0);
  expect(tomlFolded(core)).toBe(before);
  // The next edit that goes through clears the message.
  gate.refusing = false;
  await palette(app, 'project.pin'); // by id: the words "Pin" rank "Settings: Artifact libraries (… fixed versions …)" first
  await leave(app);
  await expect.poll(() => tomlFolded(core)).toContain('pins = ["');
  await expect(app.getByRole('alert')).toHaveCount(0);
});

test('tree_load_failure_shows_retry: a failed tree load says so in one line; Retry loads the tree', async ({ app, core }) => {
  const [a, b] = ['alpha', 'beta'].map((n) => core.project(n));
  [a, b].forEach((d, i) => core.shell(d, `s${i}`));
  seed(core, { op: 'group_create', name: 'Web', project: a }, { op: 'project_move', project: b, group: 'Web' });
  await flaky(app, { refusing: false, failLoads: 1 });
  await openWindow(app);
  const line = note(app, 'could not load the project tree');
  await expect(line).toBeVisible();
  await expect(group(app, 'Web')).toHaveCount(0);
  await line.getByRole('button', { name: 'Retry' }).click();
  await leave(app);
  await expect(line).toHaveCount(0);
  await expect(group(app, 'Web')).toHaveCount(1);
});
