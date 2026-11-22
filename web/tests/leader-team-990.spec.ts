// Ticket 990 (leader and room, slices c and d; mockup docs/design/leader-room/index.html H2): a teammate leads its place.
// Settings > Team saves the lead and opens a seat through the core's `team_open`; the tree's project menu and the palette add
// a leader. A real core with the fake Claude that logs what it reads (crates/nunchiro-core/tests/fixtures/claude-mode).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, REPO, test } from './fixtures';
import { mateMenu } from './leader-990';
import { openSettings } from './settings-modal';

const fake = (core: Core) => fs.writeFileSync(path.join(core.home, 'bin', 'claude'), fs.readFileSync(path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode')), { mode: 0o700 });
const stored = (core: Core) => (fs.existsSync(path.join(core.home, 'team', 'team.json')) ? JSON.parse(fs.readFileSync(path.join(core.home, 'team', 'team.json'), 'utf8')).teammates : []) as { id: string; name: string; job: string; kind: string; project?: string; lead?: boolean; model?: string }[];
const sessions = (core: Core) => core.cli('snapshot', '--json').sessions as { id: string; label: string; project: string; kind: string; teammate?: string }[];
async function openTeam(app: Page) {
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="team"]').click();
  await expect(app.locator('.spage h1').first()).toHaveText('Team');
  return app.locator('.sbody');
}

test('lead_in_team_page (990 c1): "Leads this place" saves a lead, its row wears a Lead tag, Open goes through team_open and finds the same seat again', async ({ app, core }) => {
  fake(core);
  const project = core.project('demo');
  core.shell(project, 'alpha');
  await openWindow(app);
  const body = await openTeam(app);
  await body.getByRole('button', { name: 'Add teammate', exact: true }).click();
  const form = body.getByRole('group', { name: 'Teammate', exact: true });
  await form.getByLabel('Name', { exact: true }).fill('Main');
  await form.getByLabel('Job', { exact: true }).fill('Runs this project.');
  await form.getByRole('combobox', { name: 'Works in', exact: true }).selectOption({ label: 'demo' });
  // Ticket 993: the box is under Advanced, and what a lead is sits behind its "i".
  await expect(form.getByRole('checkbox', { name: 'Leads this place', exact: true })).toBeHidden();
  await form.locator('details.team-adv > summary').click();
  await expect(form.getByRole('button', { name: 'About Leads this place', exact: true })).toHaveAccessibleDescription(/Each place has one lead/);
  await form.getByRole('checkbox', { name: 'Leads this place', exact: true }).check();
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toHaveCount(0);
  const [mate] = stored(core);
  expect(mate).toMatchObject({ name: 'Main', project, lead: true });
  const row = body.locator(`[data-row="team:${mate.id}"]`);
  await expect(row.locator('[data-lead]')).toHaveText('Lead');

  // Edit shows the box checked; unchecking saves a teammate that leads nothing, and the tag goes.
  await mateMenu(body, 'Main', 'Edit');
  await expect(form.locator('details.team-adv')).toHaveAttribute('open', ''); // a lead: Advanced starts open
  await expect(form.getByRole('checkbox', { name: 'Leads this place', exact: true })).toBeChecked();
  await form.getByRole('checkbox', { name: 'Leads this place', exact: true }).uncheck();
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toHaveCount(0); // the form stands in the row's place (7cede629c): the row is back once the core saved
  await expect(row.locator('[data-lead]')).toHaveCount(0);
  expect(stored(core)[0].lead).toBeUndefined();
  await mateMenu(body, 'Main', 'Edit');
  await form.locator('details.team-adv > summary').click();
  await form.getByRole('checkbox', { name: 'Leads this place', exact: true }).check();
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row.locator('[data-lead]')).toHaveText('Lead');

  // Open: the core starts the seat, marked with the teammate; Settings closes on its tab. A second Open shows the same seat.
  await row.getByRole('button', { name: 'Open Main', exact: true }).click();
  await expect(app.locator('.settings')).toHaveCount(0);
  await expect.poll(() => sessions(core).filter((s) => s.teammate === mate.id).length).toBe(1);
  const seat = sessions(core).find((s) => s.teammate === mate.id)!;
  expect(seat).toMatchObject({ label: 'Main', kind: 'claude', project });
  await expect(app.locator(`.tab[data-tab="${seat.id}"]`)).toHaveAttribute('aria-selected', 'true');
  const again = await openTeam(app);
  await again.getByRole('button', { name: 'Open Main', exact: true }).click();
  await expect(app.locator('.settings')).toHaveCount(0);
  await expect(app.locator(`.tab[data-tab="${seat.id}"]`)).toHaveAttribute('aria-selected', 'true');
  expect(sessions(core).filter((s) => s.teammate === mate.id)).toHaveLength(1);
});

test('add_leader_menu_and_palette (990 c3): the project head menu adds a leader (name, agent), opens its seat and shows its tab; then neither the menu nor the palette offers it', async ({ app, core }) => {
  fake(core);
  const project = core.project('demo');
  core.shell(project, 'alpha');
  await openWindow(app);
  // The palette offers it for the shown project.
  await app.keyboard.press('Meta+KeyK');
  await app.locator('.palette input').fill('Add a leader');
  await expect(app.locator('#palette-list [data-command="lead.add"]')).toHaveText(/Add a leader to this project…/);
  await app.keyboard.press('Escape');

  await app.locator('.tree .grp[data-project] .row.head .n').first().click({ button: 'right' });
  await app.getByRole('menuitem', { name: 'Add a leader to this project…' }).click();
  const dialog = app.getByRole('dialog', { name: 'Add a leader to demo' });
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Lead');
  await expect(dialog.getByRole('combobox', { name: 'Agent', exact: true })).toHaveValue('claude');
  await expect(dialog.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('');
  await expect(dialog.getByRole('combobox', { name: 'Effort', exact: true })).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill('Main');
  await dialog.getByRole('button', { name: 'Add and open', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const [mate] = stored(core);
  expect(mate).toMatchObject({ name: 'Main', project, lead: true, kind: 'claude' });
  await expect.poll(() => sessions(core).find((s) => s.teammate === mate.id)?.id ?? '').not.toBe('');
  const seat = sessions(core).find((s) => s.teammate === mate.id)!;
  await expect(app.locator(`.tab[data-tab="${seat.id}"]`)).toHaveAttribute('aria-selected', 'true');
  // Owner 11-17: the lead's row is the project's first row, above the shell that was there before it.
  await app.locator(`.tab[data-tab="${seat.id}"]`).click(); // the tree holds its rows while the pointer or the focus is in it
  await expect(app.locator('.tree .grp[data-project] .row.wt2')).toHaveCount(2);
  await expect(app.locator('.tree .grp[data-project] .row.wt2').first()).toHaveAttribute('data-menu-session', seat.id);

  // The project has its lead: the menu and the palette no longer offer one.
  await app.locator('.tree .grp[data-project] .row.head .n').first().click({ button: 'right' });
  await expect(app.getByRole('menu')).toBeVisible();
  await expect(app.getByRole('menuitem', { name: 'Add a leader to this project…' })).toHaveCount(0);
  await app.keyboard.press('Escape');
  await app.keyboard.press('Meta+KeyK');
  await app.locator('.palette input').fill('Add a leader');
  await expect(app.locator('#palette-list [data-command="lead.add"]')).toHaveCount(0);
  // Look 1117 v11-A-S3-1: with a lead the place's Room lives in its Team view; "room" in the palette brings it back as a tab.
  await expect(app.locator('[data-room-tab]')).toHaveCount(0);
  await app.locator('.palette input').fill('room');
  await app.locator('#palette-list [data-command="room.open"]').click();
  await expect(app.locator('[data-room-tab][data-team-tab]')).toHaveAttribute('aria-selected', 'true');
});

// Look 1117 v5 (es): the Leader row's sentence was cut ("reparte el trabajo y lo lle…"); it wraps, a path row still cuts.
test('leader_row_sentence_wraps_whole_in_spanish', async ({ app, core }) => {
  fake(core);
  core.agent(core.project('demo'), 'one', 'never-1');
  await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: 'es' })));
  await app.goto('/');
  await expect(app.locator('.tab[data-tab]')).toHaveCount(1);
  await app.keyboard.press('Meta+KeyT');
  // 96ef9d6aa (look v12 C V13): the greyed Reopen row's reason wraps too; the Leader row is the one that is never greyed.
  const detail = app.locator('.newtab .nt-row[data-wrap]:not([aria-disabled]) .nt-detail');
  await expect(detail).toHaveText('Dile el objetivo una sola vez; reparte el trabajo y lo lleva a cabo'); // fc7323993: the es native read (Q5)
  expect(await detail.evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)).toBe(true);
});

// Owner 11-17: the palette and the project menu were the only ways to a leader. Two places say it now: a Leader row in the
// New session list, and one line in the tree when two or more agents run in a project with no leader.
test('leader_is_findable (owner 11-17): the New session list has a Leader row, the tree suggests one with two agents at work; both open Add a leader; closed once, the line stays away', async ({ app, core }) => {
  fake(core);
  const project = core.project('demo');
  core.agent(project, 'one', 'never-1');
  await openWindow(app);
  // One agent: no line in the tree. The New session list offers the leader.
  await expect(app.locator('[data-lead-suggest]')).toHaveCount(0);
  await app.keyboard.press('Meta+KeyT');
  const row = app.locator('.newtab [data-row="lead"], .newtab [data-entry="lead"], .newtab li:has-text("Leader"), .newtab [role="option"]:has-text("Leader")').first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('say the goal once');
  await row.click();
  const dialog = app.getByRole('dialog', { name: 'Add a leader to demo' });
  await expect(dialog).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // A second agent at work: the line shows, with the count.
  core.agent(project, 'two', 'never-2');
  await app.mouse.move(900, 500);
  const line = app.locator('[data-lead-suggest]');
  await expect(line).toContainText('2 sessions here. A leader can run them for you.');
  // Look v34 S3-3 (rule A): a tint field with no dashed outline, and a quiet button with no outline.
  const box = await line.evaluate((el) => { const s = getComputedStyle(el); return [s.borderTopStyle, s.backgroundColor]; });
  expect(box[0]).toBe('none');
  expect(box[1]).not.toBe('rgba(0, 0, 0, 0)');
  expect(await line.locator('.btn').evaluate((el) => getComputedStyle(el).borderTopColor)).toBe('rgba(0, 0, 0, 0)');
  await line.getByRole('button', { name: 'Add a leader', exact: true }).click();
  await expect(dialog).toBeVisible();
  await app.keyboard.press('Escape');
  // Closed once: gone, also after a reload.
  await line.getByRole('button', { name: "Don't suggest a leader" }).click();
  await expect(line).toHaveCount(0);
  await app.reload();
  await expect(app.locator('.tree .grp[data-project] .row.wt2').first()).toBeVisible();
  await expect(app.locator('[data-lead-suggest]')).toHaveCount(0);
});

// Home N-A (look 1117 v4f): a name the core refuses read "A value you gave is not allowed here"; the dialog says the
// reason in plain words, next to the name field.
test('add_leader_name_taken_says_so_by_the_name', async ({ app, core }) => {
  fake(core);
  const project = core.project('demo');
  core.shell(project, 'alpha');
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      if (f?.request?.op === 'team_save') return ws.send(JSON.stringify({ id: f.id, response: { Err: 'a teammate named Lead already exists' } }));
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await openWindow(app);
  await app.locator('.tree .grp[data-project] .row.head .n').first().click({ button: 'right' });
  await app.getByRole('menuitem', { name: 'Add a leader to this project…' }).click();
  const dialog = app.getByRole('dialog', { name: 'Add a leader to demo' });
  await dialog.getByRole('button', { name: 'Add and open', exact: true }).click();
  const name = dialog.getByLabel('Name', { exact: true });
  await expect(dialog).toContainText('There is already a teammate named Lead here. Pick another name.');
  await expect(dialog).not.toContainText('A value you gave is not allowed here');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
});
