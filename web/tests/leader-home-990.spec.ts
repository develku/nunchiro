// Ticket 990 slice d (mockup docs/design/leader-room/index.html H2 ③): Home in the tree, and "no leader, no change": with no
// lead and no Home teammate, nothing of the leader is drawn and the rail and the default layout are as before.
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test } from './fixtures';
import { mates, openTeam, sessions } from './leader-990';

test('home_group (990 d8): Home teammates sit in a Home group above the projects, the lead first with its tag; not running is quiet; a press opens the seat; the Home folder is no project and no "main"', async ({ app, core }) => {
  const project = core.project('nunchiro');
  core.shell(project, 'alpha');
  mates(core, [
    { id: 'mate-inbox', name: 'Inbox' },
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-res', name: 'Researcher' },
  ]);
  const home = path.join(core.home, 'team', 'home');
  fs.mkdirSync(home, { recursive: true });
  const notes = core.shell(fs.realpathSync(home), 'notes'); // a Home folder session that is no seat
  await openWindow(app, {}, core);
  const group = app.locator('.tree .home-grp');
  await expect(group).toBeVisible();
  // Above every project, under This Mac.
  const order = await app.locator('.tree .home-grp, .tree .grp[data-project]').evaluateAll((els) => els.map((e) => (e.matches('.home-grp') ? 'Home' : (e as HTMLElement).dataset.project)));
  expect(order[0]).toBe('Home');
  await expect(group.locator('.row.head')).toContainText('Assistants'); // ticket 1034: the group's name
  // Home view change 3: with a Home lead, resting assistants fold into one line; a press shows them.
  await expect(group.locator('.home-mate')).toHaveCount(1);
  await group.locator('.home-rest .row').click();
  await expect(group.locator('.home-mate')).toHaveCount(3);
  await expect(group.locator('.home-mate').first()).toHaveAttribute('data-mate', 'mate-chief');
  await expect(group.locator('.home-mate[data-mate="mate-chief"] .lead-tag')).toHaveText('Chief'); // ticket 1168 (owner 11-26): the office's lead is the Chief
  await expect(group.locator('.home-mate[data-mate="mate-inbox"] .lead-tag')).toHaveCount(0);
  await expect(group.locator('.home-mate[data-mate="mate-inbox"] .tm')).toHaveText('not running');
  // The Home folder's own session sits in the group (under the lead's row), not as a project named "home" with a "main" row.
  await expect(group.locator('.home-mate[data-mate="mate-chief"] .home-kid')).toContainText('notes');
  await expect(app.locator('.tree .grp[data-project="home"]')).toHaveCount(0);
  await expect(app.locator('.tree .row.head', { hasText: /^home/ })).toHaveCount(0);

  // A press opens the seat through team_open; the row then shows its state, and the header names Home, not "main".
  await group.locator('.home-mate[data-mate="mate-inbox"] .row.wt2').first().click();
  await expect.poll(() => sessions(core).find((s) => s.teammate === 'mate-inbox' && s.state === 'running')?.id ?? '').not.toBe('');
  const seat = sessions(core).find((s) => s.teammate === 'mate-inbox')!;
  await expect(app.locator(`.tab[data-tab="${seat.id}"]`)).toHaveAttribute('aria-selected', 'true');
  // Since #67 the design book gives an idle row its word and age ("idle · <1m"), where "not running" stood.
  await expect(group.locator('.home-mate[data-mate="mate-inbox"] .tm')).toHaveText(/^idle · /);
  await expect(group.locator('.home-mate[data-mate="mate-inbox"] .row.wt2')).toHaveAttribute('data-kind', 'idle');
  await expect(app.locator('.shead .dim').first()).toContainText('Assistants · claude');
  await expect(app.locator('.shead .dim').first()).not.toContainText('main');
  // Look 1117 v12 Home S3-3: Home is no project in the tree, so the palette's Remove is greyed and says why.
  await app.keyboard.press('Meta+KeyK');
  await app.locator('.palette input').fill('Remove from Nunchiro');
  await expect(app.locator('#palette-list [data-command="project.remove"] .why')).toHaveText('Assistants is not a project in the tree');
  await app.keyboard.press('Escape');
  // The Home lead's Team view lists the other Home teammates (no worktrees at Home); a press opens one.
  await group.locator('.home-mate[data-mate="mate-chief"] .row.wt2').first().click();
  await expect(app.locator('.shead .lead-tag')).toHaveText('Lead');
  await expect(app.locator('.shead')).not.toContainText('Assistants:'); // ticket 1034: the place already says Assistants; no count after it
  // Home view: the Home lead's view is Projects | Assistants | Room; the assistants are in their own part.
  const view = await openTeam(app);
  await view.getByRole('tab', { name: 'Assistants' }).click();
  const band = view.locator('[data-part="assistants"]');
  await expect(band.locator('.lead-row[data-mate]')).toHaveCount(2);
  await expect(band.locator('.lead-row[data-mate="mate-res"] .lead-st')).toHaveText('not running');
  await band.locator('.lead-row[data-mate="mate-res"] .lead-go').click();
  await expect.poll(() => sessions(core).find((s) => s.teammate === 'mate-res' && s.state === 'running')?.id ?? '').not.toBe('');
  // Folds as a project row does.
  await group.locator('.chev').click();
  await expect(group.locator('.home-mate')).toHaveCount(0);
  void notes;
});

test('no_leader_no_change (990): sessions and worktrees with no teammate show no Lead tag, no band, no Home teammate row (ticket 1032: the group shows only its set-up row), no Team chip or view, no team line; the rail and the default layout have no room and no Team', async ({ app, core }) => {
  const project = core.project('demo');
  const a = core.shell(project, 'alpha');
  const b = core.agent(project, 'beta', 'none');
  await openWindow(app, {}, core);
  for (const id of [a.id, b.id]) {
    await app.locator(`.tab[data-tab="${id}"]`).click();
    await expect(app.locator(`.tab[data-tab="${id}"]`)).toHaveAttribute('aria-selected', 'true');
    await expect(app.locator('.shead')).toBeVisible();
    await expect(app.locator('.lead-tag, .lead-band, .lead-av, .lead-crumb, .home-mate, .roompane, .teamv, [data-team-chip], [data-team-tab]')).toHaveCount(0);
  }
  await expect(app.locator('.shead')).not.toContainText('Delegated');
  const icons = await app.locator('nav[data-bar] [data-icon]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.icon));
  expect(icons).not.toContain('room');
  expect(icons).not.toContain('team');
  const zones = await app.locator('.wg[data-widget]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.widget));
  expect(zones).not.toContain('room');
  const toml = path.join(core.home, 'layout.toml');
  if (fs.existsSync(toml)) expect(fs.readFileSync(toml, 'utf8')).not.toMatch(/"room"/);
  // The palette still offers a leader (the one way in), and the Room tab is as before.
  await app.keyboard.press('Meta+KeyK');
  await app.locator('.palette input').fill('Add a leader');
  await expect(app.locator('#palette-list [data-command="lead.add"]')).toHaveCount(1);
  await app.keyboard.press('Escape');
  await expect(app.locator('[data-room-tab]')).toBeVisible();
});
