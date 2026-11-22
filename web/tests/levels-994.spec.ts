// Ticket 994 (levels show the real model): every place that shows or offers a level shows the model and effort of that
// seat's agent after the level's bars; the words Light, Standard and Deep are drawn only as the Levels table's column
// heads (and said by the bars' tooltip). A seat shows what its session runs, also after the table changed; a choice
// shows what each level would start now. The Levels table has a row per agent the user has (Claude, Codex, each ACP
// agent), and a teammate may run an ACP agent. Against a real core, a fake Claude and Codex, and the core's fake ACP
// agent (models Fast and Smart, thinking levels Low and High).
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { type Core, expect, nunchiro, openWindow, test } from './fixtures';
import { asSeat, mateMenu, mates, openSeat, openTeam, tokenClaude, tokenOf } from './leader-990';
import { acpAgent, acpSets, fakeCodex, setLevels } from './levels-seed';
import { add, openWidget } from './schedules-seed';
import { closeSettings, openSettings } from './settings-modal';

const team = (core: Core) => (fs.existsSync(path.join(core.home, 'team', 'team.json')) ? (JSON.parse(fs.readFileSync(path.join(core.home, 'team', 'team.json'), 'utf8')).teammates as { name: string; kind: string; agent?: string; level?: string }[]) : []);
const features = (core: Core) => (JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features ?? {}) as Record<string, unknown>;
const schedules = (core: Core) => (JSON.parse(fs.readFileSync(path.join(core.home, 'schedules.json'), 'utf8')).schedules as { run: { label: string; level?: string } }[]).map((s) => s.run);
async function teamPage(app: Page) {
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="team"]').click();
  return app.locator('.sbody');
}
/** The level's own words are drawn nowhere in `where` (they may be said by a tooltip or an accessible name). */
const noLevelWords = async (where: Locator) => expect(await where.evaluateAll((all) => all.map((e) => (e as HTMLElement).innerText).join('\n'))).not.toMatch(/\b(Light|Standard|Deep)\b/);

// The pair's words, as the agents name them (rule 4): an unset model reads "Default", with what its session reported
// once it has; an effort in the agent's own word; a model the catalogue does not know by the name it came with.
test('levels994_pair_words', async () => {
  const { pairText } = await import('../src/lead/level');
  const t = ((key: string) => (key === 'providers.default' ? 'Default' : key)) as never;
  expect(pairText(t, 'claude', { model: 'haiku' })).toBe('Haiku');
  expect(pairText(t, 'claude', { model: 'opus', effort: 'high' })).toBe('Opus · high');
  expect(pairText(t, 'claude', {})).toBe('Default');
  expect(pairText(t, 'claude', {}, { reported: 'claude-opus-5-5' })).toBe('Default · Opus 5.5');
  expect(pairText(t, 'codex', { effort: 'low' })).toBe('Default · low');
  expect(pairText(t, 'codex', { effort: 'low' }, { reported: 'gpt-6.1-sol' })).toBe('Default · GPT-6.1 Sol · low');
  expect(pairText(t, 'codex', { model: 'gpt-6.1-sol', effort: 'xhigh' })).toBe('GPT-6.1 Sol · xHigh');
  expect(pairText(t, 'codex', { model: 'gpt-9-new' })).toBe('gpt-9-new');
  expect(pairText(t, 'codex', {}, { reported: 'gpt-9-new' })).toBe('Default · gpt-9-new');
  expect(pairText(t, 'acp', { model: 'vendor/some-model', effort: 'max' }, { agent: 'unlisted' })).toBe('vendor/some-model · max');
});

test('levels994_seats: a seat shows the model it runs on the tree row, the header and the Home row; its menu shows what each level starts; the seat keeps its own model after the table changed', async ({ app, core }) => {
  tokenClaude(core);
  fakeCodex(core);
  const alpha = core.project('alpha');
  core.shell(alpha, 'a1');
  // Ticket 1002 (Fable review R6): a Home seat is Claude in v1, so the Codex teammate works in a project.
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-inbox', name: 'Inbox' },
    { id: 'mate-plan', name: 'Planner' },
    { id: 'mate-res', name: 'Researcher' },
    { id: 'mate-code', name: 'Builder', kind: 'codex', project: alpha },
    { id: 'mate-pin', name: 'Pin', level: 'deep' } as never,
    { id: 'mate-main', name: 'Main', lead: true, project: alpha }, // opens Builder: only a place's lead opens its teammates
  ]);
  await openWindow(app, {}, core);
  const chief = await openSeat(app, core, 'Chief');
  const token = await tokenOf(core, chief);
  const open = (name: string, ...level: string[]) => asSeat(core, token, 'team', 'open', name, ...level).session as { id: string; level: string; model: string | null; effort: string | null };
  const inbox = open('Inbox', '--level', 'light');
  const plan = open('Planner', '--level', 'standard');
  const res = open('Researcher', '--level', 'deep');
  const mainToken = await tokenOf(core, await openSeat(app, core, 'Main'));
  const code = asSeat(core, mainToken, 'team', 'open', 'Builder', '--level', 'light').session as typeof inbox;
  const pin = open('Pin');
  // The CLI keeps its words and prints the pair they resolved to.
  expect([inbox.level, inbox.model, code.level, code.model ?? null, code.effort]).toEqual(['light', 'haiku', 'light', null, 'low']);

  // Tree rows: bars, then the model (and the effort, where the level sets one); the bars' tooltip names the level.
  const row = (id: string) => app.locator(`.row.wt2[data-hint-session="${id}"]`);
  const resting = app.getByRole('button', { name: /resting$/ });
  if (await resting.count()) await resting.first().click();
  // (A tree row is a narrow place: Codex's "Default · low" is drawn as the effort alone there; levels994_narrow.)
  for (const [seat, level, text, drawn] of [
    [inbox, 'light', 'Haiku', 'Haiku'],
    [plan, 'standard', 'Sonnet', 'Sonnet'],
    [res, 'deep', 'Opus', 'Opus'],
    [code, 'light', 'Default · low', 'low'],
    [pin, 'deep', 'Opus', 'Opus'],
  ] as const) {
    await expect(row(seat.id).locator('.lvl-mark')).toHaveText(drawn);
    await expect(row(seat.id).locator('.lvl-pair')).toHaveAttribute('title', text);
    await expect(row(seat.id).locator('.lvl')).toHaveAttribute('data-level', level);
    await expect(row(seat.id)).toHaveAttribute('aria-label', new RegExp(`Runs on ${text}`));
  }
  await expect(row(inbox.id).locator('.lvl')).toHaveAttribute('title', 'Level 1 of 3 · Light');
  await expect(row(chief).locator('.lvl-mark')).toHaveText('Sonnet'); // the lead's own level
  await noLevelWords(app.getByRole('navigation', { name: 'Projects' }));

  // The chat header: the same pair on the chip. A Codex seat on its default model says so with its effort.
  await row(code.id).click();
  await expect(app.locator('.shead .lvl-chip')).toHaveText('Default · low');
  await row(pin.id).click();
  await expect(app.locator('.shead .lvl-chip')).toHaveText('Opus');
  await expect(app.locator('.shead button.lvl-chip')).toHaveCount(0); // fixed: nothing to pick
  await row(inbox.id).click();
  const chip = app.locator('.shead button.lvl-chip');
  await expect(chip).toHaveText('Haiku');
  await expect(chip).toHaveAccessibleName('Inbox, Haiku. Change the level for the next task');
  await noLevelWords(app.locator('.shead'));
  // Its menu: each level as its bars and what it starts for this teammate's agent.
  await chip.click();
  const menu = app.getByRole('menu', { name: "Level for Inbox's next task" });
  await expect(menu.locator('.lvl-words b')).toHaveText(['Haiku', 'Sonnet', 'Opus']);
  await expect(menu.locator('.lvl')).toHaveCount(3);
  await expect(menu.getByRole('menuitemradio', { checked: true })).toContainText('Haiku');
  // Look 1117 v9 Home S3-2: an item's accessible name is its pair and hint, as shown; the level word stays the bars' tooltip.
  await expect(menu.getByRole('menuitemradio').first()).toHaveAccessibleName('Haiku Quick, routine work: sorting, short replies, lookups.');
  await noLevelWords(menu);
  await app.keyboard.press('Escape');
  // A Codex teammate's menu reads in Codex's own words.
  await row(code.id).click();
  await app.locator('.shead button.lvl-chip').click();
  await expect(app.locator('.shead').getByRole('menu').locator('.lvl-words b')).toHaveText(['Default · low', 'Default · medium', 'Default · high']);
  await app.keyboard.press('Escape');

  // Home's assistants rows (the Home lead's Team view): the same chips.
  await row(chief).click(); // its tree row: the strip shows one project's tabs (ticket 570) and Builder's is alpha
  const view = await openTeam(app);
  await view.getByRole('tab', { name: 'Assistants' }).click();
  await expect(view.locator('.lead-row[data-mate="mate-inbox"] .lvl-chip')).toHaveText('Haiku');
  await expect(view.locator('.lead-row[data-mate="mate-code"]')).toHaveCount(0); // a project's teammate is not one of Home's assistants
  await noLevelWords(view);

  // The table changes (in Settings, as a user changes it): the open seat still shows what it opened with; its menu
  // shows what the level starts now.
  const levels = (await teamPage(app)).getByRole('region', { name: 'Levels', exact: true });
  await levels.getByRole('button', { name: 'Edit Levels', exact: true }).click();
  await levels.getByRole('combobox', { name: 'Light, Claude Model' }).selectOption('sonnet');
  await levels.getByRole('combobox', { name: 'Light, Claude Effort' }).selectOption('high');
  await levels.getByRole('combobox', { name: 'Light, Codex Model' }).selectOption('gpt-6.1-terra');
  await expect.poll(() => features(core)['team.levels']).toEqual({ claude: { light: { model: 'sonnet', effort: 'high' } }, codex: { light: { model: 'gpt-6.1-terra', effort: 'low' } } });
  await closeSettings(app);
  await expect(row(inbox.id).locator('.lvl-mark')).toHaveText('Haiku');
  await row(inbox.id).click();
  await expect(app.locator('.shead button.lvl-chip')).toHaveText('Haiku');
  await app.locator('.shead button.lvl-chip').click();
  await expect(app.locator('.shead').getByRole('menu').locator('.lvl-words b')).toHaveText(['Sonnet · high', 'Sonnet', 'Opus']);
  await app.keyboard.press('Escape');
  // A model the catalogue took from Codex's own list reads by its name.
  await row(code.id).click();
  await app.locator('.shead button.lvl-chip').click();
  await expect(app.locator('.shead').getByRole('menu').locator('.lvl-words b').first()).toHaveText('GPT-6.1 Terra · low');
});

test('levels994_table: the Levels table has a row per agent (Claude, Codex, an ACP agent), three levels each; an unfilled row says so; the tooltip of its "i" leaves Edit free', async ({ app, core, browserName }) => {
  fakeCodex(core);
  await acpAgent(core, 'acme');
  core.shell(core.project('alpha'), 'a1');
  mates(core, [{ id: 'mate-scout', name: 'Scout', kind: 'acp', agent: 'acme' } as never]);
  await openWindow(app, {}, core);
  const body = await teamPage(app);
  const table = body.getByRole('region', { name: 'Levels', exact: true });
  const line = table.locator('[data-row="levels"] .team-lvsum');
  await expect(line).toHaveText('Haiku Sonnet Opus');
  await expect(line.locator('.lvl')).toHaveCount(3);
  await noLevelWords(table);
  // Look C S3: the "i" starts the line, and its tooltip does not cover the Edit button.
  const edit = table.getByRole('button', { name: 'Edit Levels', exact: true });
  await edit.focus();
  await app.keyboard.press(browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab'); // WebKit's Tab skips buttons (ticket 531)
  await expect(table.getByRole('button', { name: 'About Levels', exact: true })).toBeFocused();
  const tip = app.locator('#app-tip');
  await expect(tip).toHaveText(/^The model and effort each level starts with/);
  const [a, b] = [(await tip.boundingBox())!, (await edit.boundingBox())!];
  expect(a.x + a.width <= b.x || a.x >= b.x + b.width || a.y + a.height <= b.y || a.y >= b.y + b.height, 'the tooltip leaves Edit free').toBe(true);
  await edit.click();

  // Open: the level's words are the column heads, here only; a row per agent with its own models and efforts.
  await expect(table.locator('.team-lvhead .team-lvcap')).toHaveText(['Light', 'Standard', 'Deep']);
  const rows = table.locator('.team-lvrow:not(.team-lvhead)');
  await expect(rows.locator('.snm > span:first-child')).toHaveText(['Claude', 'Codex', 'acme']);
  await expect(rows.nth(0).locator('.team-lvk')).toHaveText(['Model', 'Effort']);
  await expect(table.getByRole('combobox')).toHaveCount(18);
  await expect(table.getByRole('combobox', { name: 'Light, Claude Model' })).toHaveValue('haiku');
  await expect(table.getByRole('combobox', { name: 'Deep, Codex Effort' })).toHaveValue('high');
  // Fable is offered, in no default; Codex's list has the id its own cache reports.
  await expect(table.getByRole('combobox', { name: 'Deep, Claude Model' }).locator('option')).toHaveText(['Default', 'Fable', 'Opus', 'Sonnet', 'Haiku']);
  await expect(table.getByRole('combobox', { name: 'Light, Codex Model' }).locator('option').nth(1)).toHaveText('GPT-6.1 Terra');
  // The ACP agent: the models and thinking levels it reported; not filled, every level is the same and the row says so.
  const acme = rows.nth(2);
  await expect(acme.locator('.sds')).toHaveText('Same model at every level');
  await expect(rows.nth(0).locator('.sds')).toHaveCount(0);
  await expect(table.getByRole('combobox', { name: 'Light, acme Model' }).locator('option')).toHaveText(['Default', 'Fast', 'Smart']);
  await expect(table.getByRole('combobox', { name: 'Light, acme Effort' }).locator('option')).toHaveText(['Default', 'Low', 'High']);
  await expect(table.getByRole('button', { name: /^Reset / })).toHaveCount(0);
  // A teammate on it has no level to pick: its row reads the one pair.
  await expect(body.locator('[data-row="team:mate-scout"] [data-rule]')).toHaveText('Default');
  await expect(body.locator('[data-row="team:mate-scout"] .team-where')).toHaveText('Assistants · acme');

  // Filling a slot writes the core's table under the agent's name; the line gains the agent, the row loses its note.
  await table.getByRole('combobox', { name: 'Light, acme Model' }).selectOption('smart');
  await expect.poll(() => features(core)['team.levels']).toEqual({ 'acp:acme': { light: { model: 'smart' } } });
  await table.getByRole('combobox', { name: 'Deep, acme Effort' }).selectOption('high');
  await expect.poll(() => features(core)['team.levels']).toEqual({ 'acp:acme': { light: { model: 'smart' }, deep: { effort: 'high' } } });
  await expect(acme.locator('.sds')).toHaveCount(0);
  await expect(line.locator('[data-agent]')).toHaveText(['Claude Haiku Sonnet Opus', 'acme Smart Default Default · High']);
  await expect(body.locator('[data-row="team:mate-scout"] [data-rule]')).toHaveText('Auto');
  // A cell put back to the default is not stored; the row's reset and the card's remove what is left.
  await table.getByRole('combobox', { name: 'Light, acme Model' }).selectOption('');
  await expect.poll(() => features(core)['team.levels']).toEqual({ 'acp:acme': { deep: { effort: 'high' } } });
  await table.getByRole('combobox', { name: 'Standard, Claude Effort' }).selectOption('high');
  await table.getByRole('button', { name: 'Reset acme to default', exact: true }).click();
  await expect.poll(() => features(core)['team.levels']).toEqual({ claude: { standard: { model: 'sonnet', effort: 'high' } } });
  await expect(line).toHaveText('Haiku Sonnet · high Opus');
  await table.getByRole('button', { name: 'Reset Levels to defaults', exact: true }).click();
  await expect.poll(() => features(core)['team.levels']).toBeUndefined();
  await expect(acme.locator('.sds')).toHaveText('Same model at every level');
});

test('levels994_acp_teammate: a teammate may run an ACP agent; its seat opens at its level\'s model and thinking level, set through the agent\'s own options, and shows them', async ({ app, core }) => {
  await acpAgent(core, 'acme');
  core.shell(core.project('alpha'), 'a1');
  setLevels(core, { 'acp:acme': { standard: { model: 'smart', effort: 'low' } } });
  await openWindow(app, {}, core);
  const body = await teamPage(app);
  await body.getByRole('button', { name: 'Add teammate', exact: true }).click();
  const form = body.getByRole('group', { name: 'Teammate', exact: true });
  await form.getByLabel('Name', { exact: true }).fill('Scout');
  await form.getByLabel('Job', { exact: true }).fill('Looks things up.');
  await form.getByRole('combobox', { name: 'Works in', exact: true }).selectOption({ label: 'alpha' }); // ticket 1002 R6: a Home seat is Claude in v1
  await expect(form.getByRole('combobox', { name: 'Agent', exact: true }).locator('option')).toHaveText(['Claude', 'Codex', 'acme']);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).selectOption({ label: 'acme' });
  // The level rule offers each level as what it starts on this agent.
  const rule = form.getByRole('radiogroup', { name: 'Level', exact: true });
  await expect(rule.locator('label')).toHaveText(['Auto', 'Default', 'Smart · Low', 'Default']);
  await noLevelWords(form);
  // Its custom model is one of the agent's own.
  await form.locator('details.team-adv > summary').click();
  await expect(form.getByRole('combobox', { name: 'Model', exact: true }).locator('option')).toHaveText(['Default', 'Fast', 'Smart']);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => team(core).map((m) => [m.name, m.kind, m.agent])).toEqual([['Scout', 'acp', 'acme']]);
  await expect(body.locator('[data-row^="team:"] .team-where')).toHaveText('alpha · acme');
  const before = acpSets(core, 'acme').length;

  // Open: the seat starts on the agent, and its model and thinking level are set before its brief goes in.
  await body.getByRole('button', { name: 'Open Scout', exact: true }).click();
  await expect(app.locator('.settings')).toHaveCount(0);
  await expect(app.locator('.shead .lvl-chip')).toHaveText('Smart · Low');
  await expect(app.locator('.shead .lvl-chip')).toHaveAccessibleName(/Scout, Smart · Low/);
  expect(acpSets(core, 'acme').slice(before)).toEqual(['model=smart', 'think=low']);
  const log = fs.readFileSync(path.join(core.home, 'acme.log'), 'utf8');
  expect(log.lastIndexOf('You are Scout')).toBeGreaterThan(log.lastIndexOf('session/set_config_option'));
  const seat = (core.cli('snapshot', '--json').sessions as { label: string; state: string; id: string; level?: string; model?: string; effort?: string; kind: string }[]).find((s) => s.label === 'Scout' && s.state === 'running')!;
  expect([seat.kind, seat.level, seat.model, seat.effort]).toEqual(['acp', 'standard', 'smart', 'low']);
  await expect(app.locator(`.row.wt2[data-hint-session="${seat.id}"] .lvl-mark`)).toHaveText('Smart · Low');
});

test('levels994_schedules: a schedule row, the form and a proposal card show the model the level starts; a lead gets no level to pick', async ({ app, core }) => {
  tokenClaude(core);
  fakeCodex(core);
  core.shell(core.project('alpha'), 'a1');
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-inbox', name: 'Inbox' },
    { id: 'mate-code', name: 'Builder', kind: 'codex' },
  ]);
  add(core, { teammate: 'mate-inbox', task: 'Sort the mail.', level: 'light' }, '21:00');
  add(core, { teammate: 'mate-code', task: 'Run the tests.', level: 'deep' }, '07:00');
  add(core, { teammate: 'mate-chief', task: 'Write the morning report.', level: 'deep' }, '08:00'); // an old entry: a lead with a level
  await openWindow(app, {}, core);
  const widget = await openWidget(app);
  const item = (name: string) => widget.locator('.sched-item', { has: app.locator('.sched-go', { hasText: name }) });
  await expect(item('Inbox').locator('.lvl-mark')).toHaveText('Haiku');
  await expect(item('Builder').locator('.lvl-mark')).toHaveText('high'); // the narrow side widget: the effort alone
  await expect(item('Builder').locator('.lvl-pair')).toHaveAttribute('title', 'Default · high');
  // A lead's seat keeps its own level: the row shows that, not the entry's.
  await expect(item('Chief').locator('.lvl-mark')).toHaveText('Sonnet');
  await expect(item('Chief').locator('.lvl')).toHaveAttribute('data-level', 'standard');
  await noLevelWords(widget);

  // The form: each level as what it starts for the teammate picked; a lead has no level to pick, only what it runs.
  await widget.getByRole('button', { name: 'Add schedule', exact: true }).click();
  const level = widget.getByRole('radiogroup', { name: 'Level', exact: true });
  const who = widget.getByRole('combobox', { name: 'Who' });
  await who.selectOption({ label: 'Inbox' });
  await expect(level.locator('label')).toHaveText(['Haiku', 'Sonnet', 'Opus']);
  await expect(level.getByRole('radio', { checked: true })).toHaveAccessibleName(/Haiku/);
  await who.selectOption({ label: 'Builder' });
  await expect(level.locator('label')).toHaveText(['Default · low', 'Default · medium', 'Default · high']);
  await who.selectOption({ label: 'Chief' });
  await expect(level).toHaveCount(0);
  await expect(widget.locator('.sched-form [data-rule]')).toHaveText('Sonnet');
  await expect(widget.locator('.sched-form [data-rule]')).toHaveAttribute('title', 'A lead keeps this for every task.');
  await noLevelWords(widget.locator('.sched-form'));
  await widget.getByRole('textbox', { name: 'What' }).fill('Plan the day');
  await widget.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => schedules(core).filter((r) => r.label === 'Chief').map((r) => r.level ?? null)).toEqual([null, null]); // a lead's schedule stores no level (the core drops one that is given)

  // A lead's proposal: the card's line and the CLI's reply name the model, not the level's word.
  const chief = await openSeat(app, core, 'Chief');
  const token = await tokenOf(core, chief);
  const said = nunchiro({ ...core.env, NUNCHIRO_TOKEN: token }, ['schedule', 'propose', '--who', 'Inbox', '--when', 'daily 21:00', '--level', 'deep', '--task', 'Sort the mail.']);
  expect(said).toContain('Inbox · Every day 9:00 PM · Opus: Sort the mail.');
  nunchiro({ ...core.env, NUNCHIRO_TOKEN: token }, ['schedule', 'propose', '--who', 'Builder', '--when', 'daily 07:00', '--task', 'Run the tests.']);
  await app.locator('#icon-decisions').click();
  const cards = app.locator('.dw [data-schedule-card]');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).locator('.sched-line')).toHaveText('Inbox · Every day 9:00 PM · Opus');
  await expect(cards.nth(1).locator('.sched-line')).toHaveText('Builder · Every day 7:00 AM · Default · low');
  await noLevelWords(cards);
});

// Owner 11-18 (look at the shots): a pair is never cut inside its only informative word ("Default · mediu…", "Default…").
// In a narrow place (a row of the Schedules side widget, an Assistants row of the Team side view, a tree row under
// 260 px) an unset model with an effort is drawn as the effort alone; the tooltip and the wide places keep the whole
// pair. A pair that still does not fit ends after a whole word. A job of which fewer than about 8 characters fit beside
// a name is not drawn.
test('levels994_narrow: narrow places draw the effort alone for an unset model, cut a long pair after a whole word, and drop a job with no room', async ({ app, core }) => {
  tokenClaude(core);
  fakeCodex(core);
  const alpha = core.project('alpha');
  core.shell(alpha, 'a1');
  // Ticket 1002 (Fable review R6): a Home seat is Claude in v1, so the Codex teammates work in a project.
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-code', name: 'Builder', kind: 'codex', job: 'Builds small tools for the team.', project: alpha },
    { id: 'mate-long', name: 'Report writer', kind: 'codex', project: alpha },
    { id: 'mate-main', name: 'Main', lead: true, project: alpha }, // opens Builder: only a place's lead opens its teammates
    { id: 'mate-inbox', name: 'Inbox', job: 'Sorts the morning mail and drafts short replies.' },
    { id: 'mate-ann', name: 'Ann', job: 'Looks things up on the web.' },
  ]);
  setLevels(core, { codex: { deep: { model: 'gpt-6.1-terra', effort: 'xhigh' } } });
  add(core, { teammate: 'mate-code', task: 'Run the tests.', level: 'standard' }, '07:00');
  add(core, { teammate: 'mate-long', task: 'Write the report.', level: 'deep' }, '08:00');
  await openWindow(app, {}, core);
  const widget = await openWidget(app);
  const item = (where: Locator, name: string) => where.locator('.sched-item', { has: app.locator('.sched-go', { hasText: name }) });
  // The side widget: the effort alone; the whole pair is the tooltip.
  const short = item(widget, 'Builder').locator('.lvl-pair');
  await expect(short).toHaveText('medium');
  await expect(short).toHaveAttribute('title', 'Default · medium');
  // A named model beside a long name: cut after a whole word, with an ellipsis; never inside a word.
  const FULL = 'GPT-6.1 Terra · xHigh';
  const long = item(widget, 'Report writer').locator('.lvl-pair');
  await expect(long).toHaveAttribute('title', FULL);
  await expect(long).toHaveText(/…$/);
  const drawn = (await long.innerText()).trim();
  expect(['GPT-6.1 Terra…', 'GPT-6.1…'], drawn).toContain(drawn);
  expect(await long.evaluate((e) => e.firstElementChild!.scrollWidth <= e.clientWidth), 'what is drawn fits its box').toBe(true);
  // The wide tab: the whole pairs.
  await widget.locator('.teamv-move[data-move="tab"]').click();
  const tab = app.locator('.schedv[data-where="tab"]');
  await expect(item(tab, 'Builder').locator('.lvl-pair')).toHaveText('Default · medium');
  await expect(item(tab, 'Report writer').locator('.lvl-pair')).toHaveText(FULL);
  await tab.locator('.teamv-move[data-move="side"]').click();

  // A seat: the tree row (250 px sidebar) draws the effort alone, the chat header the whole pair.
  const chief = await openSeat(app, core, 'Chief');
  const token = await tokenOf(core, chief);
  const code = asSeat(core, await tokenOf(core, await openSeat(app, core, 'Main')), 'team', 'open', 'Builder', '--level', 'light').session.id as string;
  asSeat(core, token, 'team', 'open', 'Inbox', '--level', 'light');
  const resting = app.getByRole('button', { name: /resting$/ });
  if (await resting.count()) await resting.first().click();
  const row = app.locator(`.row.wt2[data-hint-session="${code}"]`);
  await expect(row.locator('.lvl-mark')).toHaveText('low');
  await expect(row).toHaveAttribute('aria-label', /Runs on Default · low/);
  await row.click();
  await expect(app.locator('.shead .lvl-chip')).toHaveText('Default · low');

  // Home's Assistants rows in the side view (Claude seats only since ticket 1002): a job with no room beside the name is not drawn.
  await app.locator(`.row.wt2[data-hint-session="${chief}"]`).click(); // the strip shows alpha's tabs now (ticket 570)
  const view = await openTeam(app);
  await view.getByRole('tab', { name: 'Assistants' }).click();
  const mate = (where: Locator, id: string) => where.locator(`.lead-row[data-mate="${id}"]`);
  await expect(mate(view, 'mate-inbox').locator('.lvl-chip')).toHaveText('Haiku');
  for (const id of ['mate-inbox']) {
    await expect(mate(view, id).locator('.lead-go > b')).toBeVisible();
    await expect(mate(view, id).locator('.lead-who > span')).toBeHidden();
  }
  expect(await mate(view, 'mate-inbox').locator('.lead-go > b').evaluate((e) => e.scrollWidth <= e.clientWidth), 'the name is whole').toBe(true);
  // A row with the room (a short name, no seat) still says its job.
  await expect(mate(view, 'mate-ann').locator('.lead-who > span')).toBeVisible();
  await expect(mate(view, 'mate-ann').locator('.lead-who')).toContainText('Looks things up');
  // The Team view as a tab: its Assistants column is as narrow, so the chip reads the same.
  await view.locator('.teamv-move[data-move="tab"]').click();
  const wide = app.locator('.teamv[data-where="tab"]');
  await expect(wide).toHaveAttribute('data-wide', 'true');
  if (await wide.getByRole('tab', { name: 'Assistants' }).count()) await wide.getByRole('tab', { name: 'Assistants' }).click(); // side by side when there is room: no tabs
  await expect(mate(wide, 'mate-inbox').locator('.lvl-chip')).toHaveText('Haiku');
});

test('levels994_team_page: a row reads its rule as models; a lead and its form show what it runs and offer no level; Edit then Cancel, and Remove then Cancel, leave a row as it was', async ({ app, core }) => {
  fakeCodex(core);
  core.shell(core.project('alpha'), 'a1');
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-inbox', name: 'Inbox' },
    { id: 'mate-cap', name: 'Capped', level_max: 'standard' } as never,
    { id: 'mate-pin', name: 'Pin', kind: 'codex', level: 'light' } as never,
    { id: 'mate-own', name: 'Own', model: 'fable', effort: 'high' } as never,
  ]);
  await openWindow(app, {}, core);
  const body = await teamPage(app);
  const rule = (id: string) => body.locator(`[data-row="team:${id}"] [data-rule]`);
  await expect(rule('mate-chief')).toHaveText('Sonnet');
  await expect(rule('mate-inbox')).toHaveText('Auto');
  await expect(rule('mate-cap')).toHaveText('Auto, up to Sonnet');
  await expect(rule('mate-pin')).toHaveText('Default · low');
  await expect(rule('mate-pin').locator('.lvl')).toHaveAttribute('data-level', 'light');
  await expect(rule('mate-own')).toHaveText('Fable · high');
  await expect(rule('mate-own').locator('.lvl')).toHaveCount(0);
  await noLevelWords(body.locator('.team-sec'));

  // The form of a teammate: Auto, then each level as what it starts on its agent; "Up to" likewise.
  const form = body.getByRole('group', { name: 'Teammate', exact: true });
  await mateMenu(body, 'Capped', 'Edit');
  await expect(form.getByRole('radiogroup', { name: 'Level', exact: true }).locator('label')).toHaveText(['Auto', 'Haiku', 'Sonnet', 'Opus']);
  await expect(form.getByRole('combobox', { name: 'Up to' }).locator('option')).toHaveText(['No limit', '▂ Haiku', '▂▄ Sonnet', '▂▄▆ Opus']);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('codex');
  await expect(form.getByRole('radiogroup', { name: 'Level', exact: true }).locator('label')).toHaveText(['Auto', 'Default · low', 'Default · medium', 'Default · high']);
  await noLevelWords(form);
  // Owner 11-18: as the Schedules form's, the choices are one line while they fit and a column when they do not (a narrow
  // Settings window here; an ACP agent's long model names likewise). The picked one's bars take its text colour.
  const choices = form.getByRole('group', { name: 'Level', exact: true });
  const tops = () => choices.locator('.sseg label').evaluateAll((all) => all.map((e) => Math.round(e.getBoundingClientRect().top)));
  await expect(choices).not.toHaveAttribute('data-col', '');
  expect(new Set(await tops()).size, 'one line at 1440 px').toBe(1);
  await choices.getByRole('radio', { name: /Default · medium/ }).check();
  const picked = choices.locator('.sseg label:has(input:checked)');
  expect(await picked.evaluate((e) => getComputedStyle(e.querySelector('.lvl')!).color === getComputedStyle(e).color), "the picked segment's bars are its text colour").toBe(true);
  await app.setViewportSize({ width: 700, height: 800 });
  await expect(choices).toHaveAttribute('data-col', '');
  expect(new Set(await tops()).size, 'a column when the line does not fit').toBe(4);
  expect(await choices.locator('.sseg').evaluate((e) => e.scrollWidth <= e.clientWidth && e.getBoundingClientRect().right <= e.parentElement!.getBoundingClientRect().right + 1), 'nothing runs out of the form').toBe(true);
  await app.setViewportSize({ width: 1440, height: 900 });
  await expect(choices).not.toHaveAttribute('data-col', '');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  // A lead: no level to pick (its seat keeps its own), only what it runs and why; making a teammate the lead does the same.
  await mateMenu(body, 'Chief', 'Edit');
  await expect(form.getByRole('radiogroup', { name: 'Level', exact: true })).toHaveCount(0);
  await expect(form.getByRole('group', { name: 'Level', exact: true }).locator('[data-rule]')).toHaveText('Sonnet');
  await expect(form.getByRole('group', { name: 'Level', exact: true })).toContainText('A lead keeps this for every task.');
  await expect(form.getByRole('combobox', { name: 'Up to' })).toHaveCount(0);
  await form.getByRole('checkbox', { name: 'Leads this place' }).uncheck();
  await expect(form.getByRole('radiogroup', { name: 'Level', exact: true }).getByRole('radio')).toHaveCount(4);
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();

  // Look C S3: a row is as it was after Edit then Cancel (folded stays folded, open stays open), and after the menu's
  // Remove then Cancel (which opened it to ask).
  const name = body.locator('[data-row="team:mate-inbox"] .team-go');
  await expect(name).toHaveAttribute('aria-expanded', 'false');
  await mateMenu(body, 'Inbox', 'Edit');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(name).toHaveAttribute('aria-expanded', 'false');
  await mateMenu(body, 'Inbox', 'Remove');
  await expect(name).toHaveAttribute('aria-expanded', 'true');
  await body.locator('[data-row="team:mate-inbox"]').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(name).toHaveAttribute('aria-expanded', 'false');
  await name.click();
  await expect(name).toHaveAttribute('aria-expanded', 'true');
  await mateMenu(body, 'Inbox', 'Edit');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(name).toHaveAttribute('aria-expanded', 'true');
  await mateMenu(body, 'Inbox', 'Remove');
  await body.locator('[data-row="team:mate-inbox"]').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(name).toHaveAttribute('aria-expanded', 'true'); // it was open before Remove: it stays
});
