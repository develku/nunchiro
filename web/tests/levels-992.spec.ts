// Ticket 992 (bot levels): a seat opens at a level the lead or a schedule asks; the window shows it on the tree row, the
// Team view row and the chat header; the level menu picks the bot's next level and offers it as a note for the place.
// Ticket 994: what shows is the model and effort the level starts, after its bars; the level's own word (Light,
// Standard, Deep) is only the bars' tooltip and a column head of the Levels table (levels-994.spec.ts has the rest).
// Settings: the Team form's level rule, the Levels line and its table, the Schedules form's level. No bots: no level
// mark outside Settings > Team > Levels.
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { type Core, expect, openWindow, test } from './fixtures';
import { asSeat, mateMenu, mates, openSeat, openTeam, roster, tokenClaude, tokenOf } from './leader-990';
import { openSettings } from './settings-modal';
import { openWidget } from './schedules-seed';

const team = (core: Core) => roster<{ name: string; level?: string; level_max?: string; next_level?: string; model?: string }>(core); // ticket 1168: the roster as the core keeps it
const notes = (core: Core) => (fs.existsSync(path.join(core.home, 'notes.json')) ? (JSON.parse(fs.readFileSync(path.join(core.home, 'notes.json'), 'utf8')).notes as { text: string; scope: { kind: string; project?: string } }[]) : []);
const features = (core: Core) => (JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features ?? {}) as Record<string, unknown>;
async function page(app: Page, id: string) {
  await openSettings(app);
  await app.locator(`.settings > nav button[data-page="${id}"]`).click();
  return app.locator('.sbody');
}

test('levels_seat: the asked level is on the tree row, the Team view row and the header; the menu keeps the next level and offers a note for the place', async ({ app, core }) => {
  tokenClaude(core);
  core.shell(core.project('alpha'), 'a1');
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-inbox', name: 'Inbox' },
    { id: 'mate-pin', name: 'Pin', level: 'light' } as never,
    { id: 'mate-own', name: 'Own', model: 'opus' } as never,
  ]);
  await openWindow(app, {}, core);
  const chief = await openSeat(app, core, 'Chief');
  const token = await tokenOf(core, chief);
  // The lead asks a level; the reply names the level, and why when it is not the asked one.
  const inbox = asSeat(core, token, 'team', 'open', 'Inbox', '--level', 'light');
  expect(inbox.session.level).toBe('light');
  const pin = asSeat(core, token, 'team', 'open', 'Pin', '--level', 'deep');
  expect(pin.session.level).toBe('light');
  expect(pin.why).toContain('pinned to light');
  const own = asSeat(core, token, 'team', 'open', 'Own', '--level', 'deep');
  expect(own.session.level).toBeUndefined();

  // Tree row: the bars and the model the seat runs, said in the row's label; a custom model shows none.
  const row = (id: string) => app.locator(`.row.wt2[data-hint-session="${id}"]`);
  await app.getByRole('button', { name: '3 resting' }).click();
  await expect(row(inbox.session.id).locator('.lvl')).toHaveAttribute('data-level', 'light');
  await expect(row(inbox.session.id)).toHaveAttribute('aria-label', /Runs on Haiku/);
  await expect(row(inbox.session.id).locator('.lvl')).toHaveAttribute('aria-label', 'Level 1 of 3 · Light');
  await expect(row(inbox.session.id).locator('.lvl-mark')).toHaveText('Haiku');
  await expect(row(own.session.id).locator('.lvl')).toHaveCount(0);

  // Chat header of the seat: bars and model; a pinned bot's chip opens no menu.
  await row(pin.session.id).click();
  await expect(app.locator('.shead .lvl-chip')).toHaveText('Haiku');
  await expect(app.locator('.shead .lvl-chip')).toHaveAttribute('title', 'Fixed in Settings > Team.');
  await expect(app.locator('.shead button.lvl-chip')).toHaveCount(0);
  await row(own.session.id).click();
  await expect(app.locator('.shead .lvl-chip')).toHaveCount(0);
  await row(inbox.session.id).click();
  const chip = app.locator('.shead button.lvl-chip');
  await expect(chip).toHaveAccessibleName('Inbox, Haiku. Change the level for the next task');
  await chip.click();
  const menu = app.getByRole('menu', { name: "Level for Inbox's next task" });
  await expect(menu.getByRole('menuitemradio')).toHaveCount(3);
  await expect(menu.getByRole('menuitemradio', { checked: true })).toContainText('Haiku');
  await expect(menu.locator('.lvl-foot')).toHaveText("Applies from Inbox's next task.");
  // The pick changes nothing in the running seat: it waits for the next task, and the note is offered.
  await menu.getByRole('menuitemradio', { name: /Opus/ }).click();
  await expect.poll(() => team(core).find((m) => m.name === 'Inbox')?.next_level).toBe('deep');
  expect(core.cli('snapshot', '--json').sessions.find((s: { id: string }) => s.id === inbox.session.id).level).toBe('light');
  const offer = app.getByRole('group', { name: /Keep this as a note/ });
  await expect(offer.getByRole('textbox')).toHaveValue('Inbox: Opus (deep) for its tasks'); // the model picked, and the lead's level word
  await offer.getByRole('button', { name: 'Keep note' }).click();
  await expect(offer.getByRole('status')).toHaveText('Note kept. The lead reads it from its next start.');
  const kept = notes(core);
  expect(kept.map((n) => n.text)).toEqual(['Inbox: Opus (deep) for its tasks']);
  expect(kept[0].scope.kind).toBe('project');
  // Look 1117 v12 Home S3-5: the chip still names the running seat, and the level picked for the next task follows it.
  await app.keyboard.press('Escape');
  await expect(chip).toHaveAccessibleName('Inbox, Haiku. Change the level for the next task. Next task: Opus');
  await expect(chip.locator('.lvl-next')).toHaveAttribute('title', 'Next task: Opus');
  await expect(chip.locator('.lvl-next .lvl')).toHaveAttribute('data-level', 'deep');

  // Team view (Home lead): the assistant row shows the level's bars with the model, and the same menu.
  await app.locator(`.tab[data-tab="${chief}"]`).click();
  const view = await openTeam(app);
  await view.getByRole('tab', { name: 'Assistants' }).click();
  const r = view.locator('.lead-row[data-mate="mate-inbox"]');
  await expect(r.locator('.lvl-chip .lvl-pair')).toHaveText('Haiku');
  await expect(r.locator('.lvl-chip .lvl-next')).toHaveAttribute('title', 'Next task: Opus');
  await r.locator('.lvl-chip').click();
  await expect(r.getByRole('menuitemradio', { checked: true })).toContainText('Opus');
  await app.keyboard.press('Escape');
  await expect(r.getByRole('menu')).toHaveCount(0);
});

test('levels_settings: the Team form holds the level rule, with Auto\'s limit and the custom model under a closed Advanced; the Levels line opens to the table, which writes and resets the core table', async ({ app, core }) => {
  core.shell(core.project('alpha'), 'a1');
  mates(core, [{ id: 'mate-inbox', name: 'Inbox' }]);
  await openWindow(app, {}, core);
  const body = await page(app, 'team');
  await mateMenu(body, 'Inbox', 'Edit');
  const form = body.getByRole('group', { name: 'Teammate', exact: true });
  const rule = form.getByRole('radiogroup', { name: 'Level' });
  await expect(rule.getByRole('radio', { name: 'Auto' })).toBeChecked();
  const advanced = form.locator('details.team-adv');
  await expect(advanced).not.toHaveAttribute('open', '');
  await advanced.locator('> summary').click();
  await form.getByRole('combobox', { name: 'Up to' }).selectOption({ label: '▂▄ Sonnet' });
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => team(core)[0].level_max).toBe('standard');
  await expect(body.locator('[data-row="team:mate-inbox"] [data-rule]')).toHaveText('Auto, up to Sonnet');

  await mateMenu(body, 'Inbox', 'Edit');
  await expect(advanced).toHaveAttribute('open', ''); // Auto's limit is set: Advanced starts open
  await expect(form.getByRole('combobox', { name: 'Up to' })).toHaveValue('standard');
  await rule.getByRole('radio', { name: /Haiku/ }).check(); // the segment's radio covers its word (shell.css .sseg input), so a click lands on the radio
  await expect(form.getByRole('combobox', { name: 'Up to' })).toHaveCount(0);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => [team(core)[0].level, team(core)[0].level_max]).toEqual(['light', undefined]);

  // Custom model: the disclosure's model takes the levels off.
  await mateMenu(body, 'Inbox', 'Edit');
  await expect(advanced).not.toHaveAttribute('open', ''); // pinned, nothing of Advanced set
  await advanced.locator('> summary').click();
  await form.getByRole('combobox', { name: 'Model', exact: true }).selectOption('opus');
  await expect(rule.getByRole('radio', { checked: true })).toHaveCount(0);
  // Off, the rule says why on its own line (the kit's Why), not only in a tooltip.
  const off = form.getByRole('group', { name: 'Level', exact: true });
  await expect(off).toHaveAttribute('aria-disabled', 'true');
  await expect(off).toHaveAccessibleDescription('This teammate has a custom model, so levels do not apply. Set the model to Default to use levels.');
  await expect(form.locator('[data-why="why-team-level"]')).toBeVisible();
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => [team(core)[0].model, team(core)[0].level]).toEqual(['opus', undefined]);
  await expect(body.locator('[data-row="team:mate-inbox"] [data-rule]')).toHaveText('Opus');
  await expect(body.locator('[data-row="team:mate-inbox"] [data-rule] [title="Custom model"]')).toHaveCount(1);
  await mateMenu(body, 'Inbox', 'Edit');
  await expect(advanced).toHaveAttribute('open', '');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();

  // Levels (ticket 993): one line of what is stored, and Edit opens the table in place. The defaults until changed; a
  // cell writes the core's table and the line follows; the row's reset and the card's put the defaults back.
  const table = body.getByRole('region', { name: 'Levels', exact: true });
  const line = table.locator('[data-row="levels"] .team-lvsum');
  await expect(line).toHaveText('Haiku Sonnet Opus');
  await expect(table.getByRole('combobox')).toHaveCount(0);
  const edit = table.getByRole('button', { name: 'Edit Levels', exact: true });
  await expect(edit).toHaveAttribute('aria-expanded', 'false');
  await edit.click();
  await expect(table.getByRole('combobox')).toHaveCount(12);
  await expect(table.getByRole('combobox', { name: 'Light, Claude Model' })).toHaveValue('haiku');
  await expect(table.getByRole('combobox', { name: 'Deep, Codex Effort' })).toHaveValue('high');
  await expect(table.getByRole('button', { name: /^Reset / })).toHaveCount(0); // nothing differs: no reset, no disabled button
  await table.getByRole('combobox', { name: 'Light, Claude Model' }).selectOption('sonnet');
  await expect.poll(() => features(core)['team.levels']).toEqual({ claude: { light: { model: 'sonnet' } } });
  await expect(line).toHaveText('Sonnet Sonnet Opus');
  await table.getByRole('button', { name: 'Reset Claude to default', exact: true }).click();
  await expect.poll(() => features(core)['team.levels']).toBeUndefined();
  await expect(table.getByRole('combobox', { name: 'Light, Claude Model' })).toHaveValue('haiku');
  // Another agent's levels join the line, each with its agent's name, once they are changed.
  await table.getByRole('combobox', { name: 'Deep, Codex Effort' }).selectOption('xhigh');
  await table.getByRole('combobox', { name: 'Standard, Claude Effort' }).selectOption('high');
  await expect(line.locator('[data-agent]')).toHaveText(['Claude Haiku Sonnet · high Opus', 'Codex Default · low Default · medium Default · xHigh']);
  await table.getByRole('button', { name: 'Reset Levels to defaults', exact: true }).click();
  await expect.poll(() => features(core)['team.levels']).toBeUndefined();
  await expect(line).toHaveText('Haiku Sonnet Opus');
  await table.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(table.getByRole('combobox')).toHaveCount(0);
});

test('levels_schedule: a schedule that runs a teammate carries a level; a custom model and a plain schedule offer none', async ({ app, core }) => {
  core.shell(core.project('alpha'), 'a1');
  mates(core, [{ id: 'mate-inbox', name: 'Inbox' }, { id: 'mate-own', name: 'Own', model: 'opus' } as never]);
  await openWindow(app, {}, core);
  // Ticket 993: the form is the Schedules widget's (Who, and the level as segments).
  const body = await openWidget(app);
  await body.getByRole('button', { name: 'Add schedule', exact: true }).click();
  const level = body.getByRole('radiogroup', { name: 'Level', exact: true });
  await body.getByRole('combobox', { name: 'Who' }).selectOption({ label: 'New session…' });
  await expect(level).toHaveCount(0);
  await body.getByRole('combobox', { name: 'Who' }).selectOption({ label: 'Own' });
  await expect(level).toHaveCount(0);
  await body.getByRole('combobox', { name: 'Who' }).selectOption({ label: 'Inbox' });
  await level.getByRole('radio', { name: /Haiku/ }).check();
  await body.getByRole('textbox', { name: 'What' }).fill('Sort the morning mail');
  await body.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => fs.existsSync(path.join(core.home, 'schedules.json')) && /"level":\s*"light"/.test(fs.readFileSync(path.join(core.home, 'schedules.json'), 'utf8'))).toBe(true);
  await expect(body.locator('.sched-item .lvl[data-level="light"]')).toHaveCount(1);
});

// Ticket 993: the Levels line shows with no teammate too (a staffed role and a schedule open at a level); outside it
// a user with no teammates sees no level mark (ticket 992 rule 7).
test('levels_none: with no teammates the Team page has the Levels line, folded, and no level mark shows anywhere else', async ({ app, core }) => {
  core.shell(core.project('alpha'), 'a1');
  await openWindow(app, {}, core);
  const body = await page(app, 'team');
  await expect(body).toContainText('No teammates yet');
  const levels = body.getByRole('region', { name: 'Levels', exact: true });
  await expect(levels.locator('.team-lvsum')).toHaveText('Haiku Sonnet Opus');
  await expect(levels.getByRole('combobox')).toHaveCount(0);
  await expect(app.locator('.lvl:not(.settings *)')).toHaveCount(0);
});

// Sixth look, Home S2-1: in the Team side view the chip ends the row at the pane's right edge, and the 280 px menu and
// its note card ran out of the pane's left edge (the foot lost "Applies", "Keep note" read "note").
test('levels_menu_whole: the level menu and its note card stay whole inside the Team side view, and inside a narrow centre from the chat header', async ({ app, core }) => {
  tokenClaude(core);
  core.shell(core.project('alpha'), 'a1');
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-inbox', name: 'Inbox with a long name for a narrow header' },
  ]);
  await openWindow(app, {}, core);
  const chief = await openSeat(app, core, 'Chief');
  const inbox = asSeat(core, await tokenOf(core, chief), 'team', 'open', 'Inbox with a long name for a narrow header', '--level', 'light');
  /** `inner` lies inside `outer`, both on screen. */
  const whole = async (inner: Locator, outer: Locator) => {
    const [a, b] = [(await inner.boundingBox())!, (await outer.boundingBox())!];
    expect(a.x, 'left edge').toBeGreaterThanOrEqual(b.x);
    expect(a.x + a.width, 'right edge').toBeLessThanOrEqual(b.x + b.width);
  };
  const view = await openTeam(app);
  await view.getByRole('tab', { name: 'Assistants' }).click();
  const pane = app.locator('.sbar[data-widget="team"]');
  const r = view.locator('.lead-row[data-mate="mate-inbox"]');
  await r.locator('.lvl-chip').click();
  await whole(r.getByRole('menu'), pane);
  await expect(r.locator('.lvl-foot')).toHaveText(/^Applies from /);
  await r.getByRole('menuitemradio', { name: /Opus/ }).click();
  const offer = r.getByRole('group', { name: /Keep this as a note/ });
  await whole(offer, pane);
  await whole(offer.getByRole('button', { name: 'Keep note' }), pane);
  await whole(offer.getByRole('textbox'), pane);
  await offer.getByRole('button', { name: 'Not now' }).click();

  // The chat header at a narrow centre: the long name pushes the chip to the right, the menu stays in the window's centre.
  await app.getByRole('button', { name: '1 resting' }).click();
  await app.locator(`.row.wt2[data-hint-session="${inbox.session.id}"]`).click();
  await app.setViewportSize({ width: 900, height: 700 });
  const chip = app.locator('.shead button.lvl-chip');
  await chip.click();
  const head = app.locator('.shead');
  await whole(app.locator('.shead').getByRole('menu'), head);
  await app.locator('.shead').getByRole('menuitemradio', { name: /Sonnet/ }).click();
  await whole(app.locator('.shead').getByRole('group', { name: /Keep this as a note/ }), head);
});

// Sixth look, Home S3: an idle seat ended for another level left its open tab on the closed seat ("Inbox is closed:
// read only", Resume) until the row was pressed; the tree row already showed the new seat.
test('levels_tab_follows: a tab of a seat that was replaced for another level moves to the new seat', async ({ app, core }) => {
  tokenClaude(core);
  core.shell(core.project('alpha'), 'a1');
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-inbox', name: 'Inbox' },
  ]);
  await openWindow(app, {}, core);
  const token = await tokenOf(core, await openSeat(app, core, 'Chief'));
  const light = asSeat(core, token, 'team', 'open', 'Inbox', '--level', 'light').session.id as string;
  await app.getByRole('button', { name: '1 resting' }).click();
  await app.locator(`.row.wt2[data-hint-session="${light}"]`).click();
  await expect(app.locator(`.tab[data-tab="${light}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator('.shead .lvl-chip')).toHaveText('Haiku');
  // The seat is idle once a turn ended after its brief (sessions.rs seat_idle); only then is it ended for another level.
  await tokenOf(core, light);
  let standard = light;
  await expect
    .poll(() => {
      core.hook(light, 'UserPromptSubmit');
      core.hook(light, 'Stop');
      return (standard = asSeat(core, token, 'team', 'open', 'Inbox', '--level', 'standard').session.id);
    })
    .not.toBe(light);
  await expect(app.locator(`.tab[data-tab="${standard}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator(`.tab[data-tab="${light}"]`)).toHaveCount(0);
  await expect(app.locator('.tab', { hasText: 'Inbox' })).toHaveCount(1);
  await expect(app.locator('.shead .lvl-chip')).toHaveText('Sonnet');
  await expect(app.getByText('Inbox is closed: read only')).toHaveCount(0);
});

// Sixth look, Home S3: Edit opened the form below a long list, outside the visible part of the page.
test('team_edit_form_in_view: Edit scrolls the teammate form into view and focuses its Name, also from one teammate to another', async ({ app, core }) => {
  core.shell(core.project('alpha'), 'a1');
  mates(core, Array.from({ length: 9 }, (_, i) => ({ id: `mate-${i}`, name: `Mate ${i}`, job: `Mate ${i} sorts the mail of desk ${i}.\nSecond line.` })));
  await openWindow(app, {}, core);
  const body = await page(app, 'team');
  const form = body.getByRole('group', { name: 'Teammate', exact: true });
  const name = form.getByRole('textbox', { name: 'Name' });
  for (const n of ['Mate 0', 'Mate 5']) {
    await mateMenu(body, n, 'Edit');
    await expect(name).toHaveValue(n);
    await expect(name).toBeFocused();
    await expect(form).toBeInViewport({ ratio: 0.95 });
    await body.evaluate((e) => (e.scrollTop = 0)); // back at the list's top, where the next Edit is pressed
  }
});

// Seen in the sixth look's fix (the Team side view is 250 px): a long teammate name wrapped word by word beside the level
// chip, seven lines for one row. One line, cut with an ellipsis; the whole name is in the tooltip and the row's name.
test('assistants_row_one_line: a long teammate name is cut on one line beside the level chip, which keeps its size', async ({ app, core }) => {
  tokenClaude(core);
  core.shell(core.project('alpha'), 'a1');
  const long = 'Inbox with a long name for a narrow header';
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-inbox', name: long },
    { id: 'mate-short', name: 'Pin' },
  ]);
  await openWindow(app, {}, core);
  const token = await tokenOf(core, await openSeat(app, core, 'Chief'));
  for (const name of [long, 'Pin']) asSeat(core, token, 'team', 'open', name, '--level', 'light');
  const view = await openTeam(app);
  await view.getByRole('tab', { name: 'Assistants' }).click();
  const row = (id: string) => view.locator(`.lead-row[data-mate="${id}"]`);
  const name = row('mate-inbox').locator('.lead-go > b');
  await expect(row('mate-inbox').locator('.lvl-chip')).toHaveText('Haiku');
  const [a, b] = [(await row('mate-inbox').boundingBox())!, (await row('mate-short').boundingBox())!];
  expect(a.height, 'the long row is as tall as a short one').toBe(b.height);
  expect(await name.evaluate((e) => e.scrollWidth > e.clientWidth), 'the name is cut').toBe(true);
  expect(await name.evaluate((e) => getComputedStyle(e).textOverflow)).toBe('ellipsis');
  // The chip and the status word keep their size: the same boxes as in the short row.
  for (const part of ['.lvl-chip', '.lead-st']) {
    const [x, y] = [(await row('mate-inbox').locator(part).boundingBox())!, (await row('mate-short').locator(part).boundingBox())!];
    expect([x.width, x.height], part).toEqual([y.width, y.height]);
  }
  // The whole name: in the row's accessible name, and in the tooltip while the name is cut (a short name shows none).
  await expect(row('mate-inbox').locator('.lead-go')).toHaveAccessibleName(new RegExp(`^${long}`));
  await name.hover();
  await expect(app.locator('#app-tip')).toHaveText(long);
  await row('mate-short').locator('.lead-go > b').hover();
  await expect(app.locator('#app-tip')).toBeHidden();
});
