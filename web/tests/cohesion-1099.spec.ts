// Ticket 1099 (feature cohesion; owner-approved mockup docs/design/cohesion-1099, 2026-11-24): one test per mockup panel.
import type { Page } from '@playwright/test';
import { expect, nunchiro, openWindow, test } from './fixtures';
import { mates, openSeat, openTeam, owner, repo, tokenClaude, tokenOf } from './leader-990';
import type { Core } from './fixtures';

async function leadScene(app: Page, core: Core) {
  tokenClaude(core);
  const project = repo(core, 'nunchiro');
  mates(core, [{ id: 'lead-main', name: 'Main', project, lead: true }]);
  await openWindow(app, {}, core);
  await openSeat(app, core, 'Main');
  return { project, team: await openTeam(app) };
}
const place = (core: Core, project: string) => owner(core, { op: 'task', operation: 'list', project }).Ok.place;
async function palette(app: Page, q: string) {
  await app.keyboard.press('Meta+KeyK');
  const box = app.locator('.palette input').first();
  await box.fill(q);
  return app.locator('.palette [data-command]');
}

test('panel_1_2_place_section: the Team view head has a gear, no pill; it opens Settings > Team on this project, whose first section sets the way, the seats, auto-advance and live seats', async ({ app, core }) => {
  const { project, team } = await leadScene(app, core);
  await expect(team.locator('.teamv-head .way-pill, .teamv-head [data-way-head]')).toHaveCount(0);
  const gear = team.locator('.teamv-head [data-place-gear]');
  await expect(gear).toHaveAccessibleName('How this place works');
  await gear.click();
  const sec = app.locator('.settings .place-sec');
  await expect(app.locator('.settings .sbody section.ssec').first()).toHaveClass(/place-sec/); // first on the page
  await expect(sec.getByRole('combobox', { name: 'Project' })).toHaveValue(project);
  await expect(sec.getByRole('radiogroup', { name: 'Way of working' }).getByRole('radio', { name: 'Build + review' })).toBeChecked();
  await expect(sec).toContainText('A Builder builds each task; a fresh Reviewer checks it before the merge.');
  await expect(sec).toContainText('At most 4 seats work at once here. Extra reviews wait for a free seat.');
  await expect(sec).toContainText('A stalled seat gets one nudge; if it stays stalled, you get asked.');
  await expect(sec).toContainText('Seats ask you before each edit and command.');
  await expect(app.locator('.settings')).toContainText('Teammates 1 · nunchiro Build + review · Live seats 4'); // the page summary
  await sec.getByRole('radio', { name: 'Strict' }).click();
  await expect.poll(() => place(core, project).way).toBe('strict');
  await sec.getByRole('radiogroup', { name: 'What seats may do' }).getByRole('radio', { name: 'Edit files' }).click();
  await expect.poll(() => place(core, project).seats).toBe('edits');
  await sec.getByRole('radiogroup', { name: 'Live seats' }).getByRole('radio', { name: '6' }).click();
  await expect.poll(() => place(core, project).cap).toBe(6);
  await expect(sec.getByRole('radiogroup', { name: 'Live seats' }).getByRole('radio', { name: '6' })).toBeChecked();
  await sec.getByRole('switch', { name: 'Auto-advance' }).click();
  await expect.poll(() => place(core, project).auto).toBe(false);
  await expect(sec).toContainText('Only you change these.');
});

test('panel_3_day_one_line: the day-one card says the way in one sentence; Change opens the section, and the sentence follows the stored way', async ({ app, core }) => {
  const { project, team } = await leadScene(app, core);
  const line = team.locator('[data-way-card] [data-way-line]');
  await expect(line).toHaveText('Reviewers check each task automatically · Change');
  await line.getByRole('button', { name: 'Change' }).click();
  await app.locator('.settings .place-sec').getByRole('radio', { name: 'Build only' }).click();
  await expect.poll(() => place(core, project).way).toBe('solo');
  await app.keyboard.press('Escape');
  await expect(line).toHaveText('Nothing reviews a task before the merge · Change');
});

test('panel_4_cap_card: a lead asks for 6 live seats; Decisions shows the card as panel 4; Change to 6 sets the cap the Settings row shows, Not now drops the card', async ({ app, core }) => {
  tokenClaude(core);
  const project = repo(core, 'nunchiro');
  mates(core, [{ id: 'lead-main', name: 'Main', project, lead: true }]);
  await openWindow(app, {}, core);
  const lead = await openSeat(app, core, 'Main');
  const token = await tokenOf(core, lead);
  const asLead = (...args: string[]) => nunchiro({ ...core.env, NUNCHIRO_TOKEN: token }, args);
  const why = '3 reviews have waited 20 minutes for a free seat. With 6 seats they start now.';
  asLead('task', 'ask-cap', '6', '--why', why);
  await app.locator('#icon-decisions').click();
  const card = app.locator('.dw [data-cap-card]');
  await expect(card).toBeVisible();
  await expect(card.locator('.mc-head')).toHaveText('Change live seats');
  await expect(card.locator('.sched-line')).toHaveText('nunchiro · 4 → 6 seats at once');
  await expect(card.locator('.sched-ctask')).toHaveText(why);
  await expect(card.locator('.sched-by')).toHaveText('asked by Main');
  await expect(card.locator('.dc-btns button')).toHaveText(['Change to 6', 'Not now']);
  expect(place(core, project).cap ?? 4).toBe(4); // nothing changes before the yes
  await card.getByRole('button', { name: 'Change to 6' }).click();
  await expect.poll(() => place(core, project).cap).toBe(6);
  await expect(card).toHaveCount(0);
  // The Settings row shows the new cap, and the room says the answer in words (never its key).
  const team = await openTeam(app);
  const notes = team.locator('.room-tnote');
  await expect(notes.filter({ hasText: 'You changed the live seats to 6' })).not.toHaveCount(0); // the room's chat and log both hold it
  await team.locator('.teamv-head [data-place-gear]').click();
  await expect(app.locator('.settings .place-sec').getByRole('radiogroup', { name: 'Live seats' }).getByRole('radio', { name: '6' })).toBeChecked();
  await app.keyboard.press('Escape');
  // Not now drops the card; the cap stays.
  asLead('task', 'ask-cap', '8', '--why', 'more');
  await app.locator('#icon-decisions').click();
  await expect(card).toHaveAttribute('data-cap-card', '8');
  await card.getByRole('button', { name: 'Not now' }).click();
  await expect(card).toHaveCount(0);
  expect(place(core, project).cap).toBe(6);
  const again = (await openTeam(app)).locator('.room-tnote');
  await expect(again.filter({ hasText: 'You said not now to 8 live seats' })).not.toHaveCount(0);
  await expect(again.filter({ hasText: 'lead.note.' })).toHaveCount(0);
});

test('panel_5_keys_sheet: ⌘/ lists every binding grouped by area with its ⌘ chord, else its ◆ key; ◆ ? and the armed wait stay the prefix keys', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const help = app.locator('.prefix-help');
  await app.keyboard.press('Meta+Slash');
  await expect(help).toHaveAttribute('data-all', 'true');
  const key = (id: string) => help.locator(`[data-command="${id}"] .kbd`);
  await expect(key('palette.open')).toHaveText('⌘K');
  await expect(key('session.new')).toHaveText('⌘T');
  await expect(key('worktree.create')).toHaveText('⌘N');
  await expect(key('session.jump.1')).toHaveText('⌘1-9');
  await expect(help.locator('[data-command="session.jump.2"]')).toHaveCount(0);
  await expect(key('board.toggle')).toHaveText('◆ k');
  await expect(key('tab.rename')).toHaveText('F2'); // its direct key, not ◆ , (mockup panel 5)
  // A command that cannot run now stays on the sheet, dimmed (no tab was closed, so Reopen is off).
  await expect(key('tab.reopen')).toHaveText('⇧⌘T');
  await expect(help.locator('[data-command="tab.reopen"]')).toHaveAttribute('data-off', 'true');
  await expect(help.locator('[data-command="settings.search"]')).toHaveCount(0); // ⌘F there is Settings' own
  await expect(help.locator('.ph-area b')).toContainText(['Palette and window', 'Sessions and tabs']);
  await expect(help.locator('.ph-foot')).toContainText('◆ = the prefix (⌃. ⌃␣), then the key');
  await expect(help.locator('.ph-foot')).toContainText('Change keys in Settings > Keyboard');
  await app.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  await app.keyboard.press('Control+Space');
  await expect(help).toBeVisible();
  await expect(help).not.toHaveAttribute('data-all', /.*/);
  await expect(help.locator('[data-command="palette.open"]')).toHaveCount(0);
  await app.keyboard.press('Shift+Slash');
  await expect(help).not.toHaveAttribute('data-all', /.*/);
  await expect(help.locator('[data-command="board.toggle"] .kbd')).toHaveText('k');
  await app.keyboard.press('Escape');
});

test('panel_6_small_gaps: Agent settings has no ⌘, chip and says where it goes; Schedules is in the palette; "history" opens History first', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Meta+KeyT');
  const row = app.getByRole('dialog', { name: 'New tab' }).locator('.nt-row', { hasText: 'Agent settings…' });
  await expect(row.locator('.kbd')).toHaveCount(0);
  await expect(row.locator('.nt-detail')).toHaveText('Settings > Providers');
  await app.keyboard.press('Escape');
  let rows = await palette(app, 'schedule');
  await expect(rows.first()).toHaveAttribute('data-command', 'schedules.open');
  await expect(app.locator('.palette [data-command="schedules.new"]')).toHaveCount(1);
  await app.keyboard.press('Escape');
  rows = await palette(app, 'history');
  await expect(rows.first()).toHaveAttribute('data-command', 'history.open');
  await app.keyboard.press('Escape');
  rows = await palette(app, 'usage');
  await expect(rows.first()).toHaveAttribute('data-command', 'usage.page');
  await app.keyboard.press('Escape');
});

test('cohesion_gaps: every place has a palette row, the bar icons name their command, the session alert level is a command, help lines read the live key', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Meta+KeyK');
  const ids = await app.locator('.palette [data-command]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.command));
  for (const id of ['usage.page', 'team.page', 'assistants.page', 'keys.sheet', 'decisions.open', 'schedules.open', 'schedules.new', 'context.open', 'history.open', 'notify.session.all', 'notify.session.waiting', 'notify.session.off']) expect(ids, id).toContain(id);
  await app.keyboard.press('Escape');
  // The Context widget opens from the palette (it was only in the Layout library).
  await (await palette(app, 'context')).filter({ hasText: 'Open Context' }).first().click();
  await expect(app.locator('.sbar[data-widget="context"]')).toBeVisible();
  // New schedule… opens the widget with its form.
  await (await palette(app, 'new schedule')).first().click();
  await expect(app.locator('.schedv form, .schedv .sched-form').first()).toBeVisible();
  // Bar icons carry their command, so the tooltip shows its key once bound.
  await expect(app.locator('#icon-history')).toHaveAttribute('data-tip-cmd', 'history.open');
  await expect(app.locator('#icon-decisions')).toHaveAttribute('data-tip-cmd', 'decisions.open');
  // The session's alert level from the palette: the header chip follows.
  await (await palette(app, 'alerts for this session: off')).first().click();
  await expect(app.locator('.qlevel-btn').first()).toHaveAttribute('data-level', 'muted');
  // A help line says the bound key, not a fixed one: Settings > Providers names New session's key.
  await app.keyboard.press('Meta+Comma');
  await app.locator('.settings > nav button[data-page="providers"]').click();
  await expect(app.locator('.settings')).toContainText('New session (⌘T) starts this agent.');
});
