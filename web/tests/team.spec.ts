// Owner 2026-11-16: Settings > Team. A teammate is a saved seat (name, job, agent, its own memory file); opening one starts
// an ordinary session with its name and sends its brief as the first message. A real core and the fake agent that logs
// what it reads (crates/nunchiro-core/tests/fixtures/claude-mode). Ticket 993 rule 7: the quiet page (a row of one job line
// that opens, Open and a menu, a form of five fields with Advanced, levels on one line) and its word budget (rule 8).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, REPO, test } from './fixtures';
import { mateMenu, mates } from './leader-990';
import { openSettings } from './settings-modal';

const fake = (core: Core) => fs.writeFileSync(path.join(core.home, 'bin', 'claude'), fs.readFileSync(path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode')), { mode: 0o700 });
const stored = (core: Core) => JSON.parse(fs.readFileSync(path.join(core.home, 'team', 'team.json'), 'utf8')).teammates as { id: string; name: string; job: string; kind: string; project?: string }[];
const sessions = (core: Core) => core.cli('snapshot', '--json').sessions as { id: string; label: string; project: string; kind: string }[];
const reads = (core: Core, id: string) => (fs.existsSync(path.join(core.home, `stdin-${id}.log`)) ? fs.readFileSync(path.join(core.home, `stdin-${id}.log`), 'utf8') : '');
const landed = (core: Core, id: string, text: string) => reads(core, id).includes(Buffer.from(text).toString('hex'));
async function openTeam(app: Page) {
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="team"]').click();
  await expect(app.locator('.spage h1').first()).toHaveText('Team');
  return app.locator('.sbody');
}
async function add(body: ReturnType<Page['locator']>, name: string, job: string, where: string) {
  await body.getByRole('button', { name: 'Add teammate', exact: true }).click();
  const form = body.getByRole('group', { name: 'Teammate', exact: true });
  await form.getByLabel('Name', { exact: true }).fill(name);
  await form.getByLabel('Job', { exact: true }).fill(job);
  await form.getByRole('combobox', { name: 'Works in', exact: true }).selectOption({ label: where });
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toHaveCount(0);
}

test('team_add_open_and_reopen: a project teammate is saved with its memory file; Open starts its session, sends the brief once, and a second Open shows the same session', async ({ app, core }) => {
  fake(core);
  const project = core.project('demo');
  core.shell(project, 'alpha');
  await openWindow(app);
  const body = await openTeam(app);
  await expect(body).toContainText('No teammates yet');
  await add(body, 'Reviewer', 'Reviews diffs before a merge.', 'demo');
  const [mate] = stored(core);
  expect(mate).toMatchObject({ name: 'Reviewer', job: 'Reviews diffs before a merge.', kind: 'claude', project });
  const memory = path.join(core.home, 'team', mate.id, 'MEMORY.md');
  expect(fs.existsSync(memory)).toBe(true);
  fs.writeFileSync(memory, '# Memory\nThe user wants short answers.\n');
  const row = body.locator(`[data-row="team:${mate.id}"]`);
  await expect(row).toContainText('Reviewer');
  await expect(row).toContainText('demo · Claude');
  await expect(row).toContainText('Reviews diffs before a merge.');

  // Open: an ordinary Claude session named after the teammate, in its project; Settings closes on its tab.
  await row.getByRole('button', { name: 'Open Reviewer', exact: true }).click();
  await expect(app.locator('.settings')).toHaveCount(0);
  await expect.poll(() => sessions(core).filter((s) => s.label === 'Reviewer').length).toBe(1);
  const seat = sessions(core).find((s) => s.label === 'Reviewer')!;
  expect(seat).toMatchObject({ kind: 'claude', project });
  await expect(app.locator(`.tab[data-tab="${seat.id}"]`)).toHaveAttribute('aria-selected', 'true');
  // The brief reaches the agent as its first message: the job and the memory as it was at that moment.
  await expect.poll(() => landed(core, seat.id, 'You are Reviewer, a teammate of this user in Nunchiro.'), { timeout: 20_000 }).toBe(true);
  expect(landed(core, seat.id, 'Reviews diffs before a merge.')).toBe(true);
  expect(landed(core, seat.id, 'The user wants short answers.')).toBe(true);

  // A second Open shows the same seat: no second session, no second brief.
  const again = await openTeam(app);
  await again.getByRole('button', { name: 'Open Reviewer', exact: true }).click();
  await expect(app.locator('.settings')).toHaveCount(0);
  await expect(app.locator(`.tab[data-tab="${seat.id}"]`)).toHaveAttribute('aria-selected', 'true');
  expect(sessions(core).filter((s) => s.label === 'Reviewer')).toHaveLength(1);
});

test('team_home_edit_refusals_and_remove: a Home teammate works in the team folder; a taken name is refused in plain sight; Remove asks and keeps the memory', async ({ app, core }) => {
  fake(core);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const body = await openTeam(app);
  await add(body, 'Inbox', 'Sorts the morning mail.', 'Assistants (no project)');
  const [mate] = stored(core);
  expect(mate.project).toBeUndefined();
  await expect(body.locator(`[data-row="team:${mate.id}"] .team-where`)).toHaveText('Assistants · Claude');

  // The same name again (any case) is refused by the core and the form stays open with the reason.
  await body.getByRole('button', { name: 'Add teammate', exact: true }).click();
  const form = body.getByRole('group', { name: 'Teammate', exact: true });
  await form.getByLabel('Name', { exact: true }).fill('inbox');
  await form.getByLabel('Job', { exact: true }).fill('x');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(app.locator('.sbody [role="alert"]').first()).toContainText('already exists');
  await expect(form).toBeVisible();
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();

  // Edit keeps the id (and so the memory); the row shows the new values.
  await mateMenu(body, 'Inbox', 'Edit');
  await form.getByLabel('Name', { exact: true }).fill('Mail');
  await form.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('codex');
  // The form offers the agent's models and effort levels under Advanced (ticket 993: closed until the teammate has one
  // of its three set); nothing picked is the agent's default.
  await expect(form.locator('details.team-adv')).not.toHaveAttribute('open', '');
  await form.locator('details.team-adv > summary').click();
  await expect(form.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('');
  await form.getByRole('combobox', { name: 'Effort', exact: true }).selectOption('high');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(body.locator(`[data-row="team:${mate.id}"]`)).toContainText('Mail');
  expect(stored(core)).toEqual([expect.objectContaining({ id: mate.id, name: 'Mail', kind: 'codex', effort: 'high' })]);

  // Ticket 1002 (29b8b24ff): a Home seat is Claude in v1, so a Codex one is refused with the reason in plain sight.
  fs.writeFileSync(path.join(core.home, 'bin', 'codex'), fs.readFileSync(path.join(core.home, 'bin', 'claude')), { mode: 0o700 });
  await body.getByRole('button', { name: 'Open Mail', exact: true }).click();
  await expect(app.locator('.sbody [role="alert"]').first()).toContainText('Home seats are Claude in v1');
  expect(sessions(core).find((s) => s.label === 'Mail')).toBeUndefined();

  // Home: as Claude, the session starts in the team's own folder.
  await mateMenu(body, 'Mail', 'Edit');
  await form.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('claude');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(body.locator(`[data-row="team:${mate.id}"] .team-where`)).toHaveText('Assistants · Claude');
  await body.getByRole('button', { name: 'Open Mail', exact: true }).click();
  await expect.poll(() => sessions(core).find((s) => s.label === 'Mail')?.project).toBe(fs.realpathSync(path.join(core.home, 'team', 'home')));

  // Remove (in the row's menu) asks first, in the opened row, with the focus on Cancel; then the row and the entry go;
  // the memory file stays on disk.
  const back = await openTeam(app);
  await mateMenu(back, 'Mail', 'Remove');
  const ask = back.getByRole('group', { name: 'Remove Mail? Its memory file stays on this Mac.', exact: true });
  await expect(ask.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await ask.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(ask).toHaveCount(0);
  expect(stored(core)).toHaveLength(1);
  await mateMenu(back, 'Mail', 'Remove');
  await ask.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(back).toContainText('No teammates yet');
  expect(stored(core)).toEqual([]);
  expect(fs.existsSync(path.join(core.home, 'team', mate.id, 'MEMORY.md'))).toBe(true);
});

// Ticket 991 C16, C20: Team has its own nav icon (not General's gear); Add teammate puts the cursor in Name.
test('team_icon_and_name_focus_C16_C20', async ({ app }) => {
  await openWindow(app);
  const body = await openTeam(app);
  const icon = (page: string) => app.locator(`.settings > nav button[data-page="${page}"] svg`).evaluate((e) => e.innerHTML);
  expect(await icon('team')).not.toBe(await icon('general'));
  await body.getByRole('button', { name: 'Add teammate', exact: true }).click();
  await expect(body.getByRole('group', { name: 'Teammate', exact: true }).getByLabel('Name', { exact: true })).toBeFocused();
});

// Look 1117 (S3): Save stays off until Name and Job are filled, so both say they are required, in words and to a reader.
test('team_form_marks_required_fields', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const body = await openTeam(app);
  await body.getByRole('button', { name: 'Add teammate', exact: true }).click();
  const form = body.getByRole('group', { name: 'Teammate', exact: true });
  for (const name of ['Name', 'Job']) {
    const field = form.getByLabel(name, { exact: true });
    await expect(field).toHaveAttribute('required', '');
    await expect(field.locator('xpath=..')).toContainText(`${name} required`);
  }
});

const JOB = 'Sorts the morning mail and drafts short replies. Anything about money is left for me.\nKeeps a list of what it left.';
const LONG = `Reads every paper on the reading list, ${'checks each one against the notes we keep, '.repeat(4)}and writes a summary.`;

// Ticket 993 rule 7: a row is the name, the level chip, the place and agent in small type and ONE line of the job (its
// first sentence, cut with an ellipsis when long); a press opens the whole job in place. Open is a button; Edit and
// Remove are in the row's menu, whose Esc closes the menu and not Settings.
test('team_row_one_line_and_menu (993 rule 7)', async ({ app, core, browserName }) => {
  const demo = core.project('demo');
  core.shell(demo, 'alpha');
  mates(core, [
    { id: 'mate-inbox', name: 'Inbox', job: JOB, lead: true },
    { id: 'mate-old', name: 'Old', project: core.project('harbor'), lead: true }, // harbor has no session: not in the tree
    { id: 'mate-res', name: 'Researcher', job: LONG, project: demo, kind: 'codex', level: 'deep' } as never,
  ]);
  await openWindow(app);
  const body = await openTeam(app);
  const row = body.locator('[data-row="team:mate-inbox"]');
  const name = row.getByRole('button', { name: 'Inbox', exact: true });
  await expect(row.locator('.sds')).toHaveText('Sorts the morning mail and drafts short replies.');
  await expect(row).not.toContainText('Anything about money');
  await expect(row.locator('.team-where')).toHaveText('Assistants · Claude');
  // Ticket 994: a lead's seat keeps its own level, so its row says the model that is (never "Auto").
  await expect(row.locator('[data-rule]')).toHaveText('Sonnet');
  await expect(row.locator('[data-lead]')).toHaveText('Lead');
  await expect(row.getByRole('button')).toHaveText(['Inbox', 'Open', '⋯']);
  // The other row: the level's bars and what they start on its agent (ticket 994), its project and agent; a long first
  // sentence is one cut line.
  const res = body.locator('[data-row="team:mate-res"]');
  await expect(res.locator('[data-rule]')).toHaveText('Default · high');
  await expect(res.locator('[data-rule] .lvl')).toHaveAttribute('data-level', 'deep');
  await expect(res.locator('.team-where')).toHaveText('demo · Codex');
  // Look 1117 v12 Home S3-8: a lead whose project left the tree says so.
  await expect(body.locator('[data-row="team:mate-old"] .team-where')).toHaveText('harbor (not in the tree) · Claude');
  expect(await res.locator('.sds').evaluate((e) => [e.scrollWidth > e.clientWidth, getComputedStyle(e).textOverflow, Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight))])).toEqual([true, 'ellipsis', 1]);
  // A press opens the row in place: the whole job as written, and the one line gives way to it. Another press folds it.
  await expect(name).toHaveAttribute('aria-expanded', 'false');
  await row.click({ position: { x: 300, y: 8 } }); // anywhere on the row, not only the name
  await expect(name).toHaveAttribute('aria-expanded', 'true');
  const detail = row.getByRole('group', { name: 'Inbox', exact: true });
  await expect(detail.locator('.team-job')).toHaveText(JOB);
  await expect(row.locator('.sds')).toHaveCount(0);
  await name.click();
  await expect(detail).toHaveCount(0);
  // Keyboard: the name, Open, the menu; the menu takes the focus, Esc closes it back to its button, Settings stays.
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab'; // WebKit's Tab skips buttons (ticket 531)
  await name.focus();
  await app.keyboard.press(tab);
  await expect(row.getByRole('button', { name: 'Open Inbox', exact: true })).toBeFocused();
  await app.keyboard.press(tab);
  const more = row.getByRole('button', { name: 'Actions for Inbox', exact: true });
  await expect(more).toBeFocused();
  await app.keyboard.press('Enter');
  const menu = row.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['Edit', 'Remove']);
  await expect(menu.getByRole('menuitem', { name: 'Edit', exact: true })).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(app.locator('.settings')).toBeVisible();
  // The last row's menu is whole (the card does not clip it).
  await res.getByRole('button', { name: 'Actions for Researcher', exact: true }).click();
  const last = res.getByRole('menuitem', { name: 'Remove', exact: true });
  await expect(last).toBeVisible();
  expect(await last.evaluate((e) => { const r = e.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === e; })).toBe(true);
  await last.click();
  await expect(res.getByRole('group', { name: 'Remove Researcher? Its memory file stays on this Mac.', exact: true })).toBeVisible();
  await expect(res.locator('.team-job')).toHaveText(LONG);
});

// Ticket 993 rule 7: the form shows five fields; "Up to", "Custom model" and "Leads this place" are under a folded
// Advanced; what explained mechanics is behind an "i" that the keyboard reaches and a screen reader hears. The Agent's
// "i" says whose permission mode a teammate runs in (the page used to say "the same permissions", wrong in Bypass mode).
test('team_form_five_fields_and_info (993 rule 7)', async ({ app, core, browserName }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const body = await openTeam(app);
  await body.getByRole('button', { name: 'Add teammate', exact: true }).click();
  const form = body.getByRole('group', { name: 'Teammate', exact: true });
  await expect(form.locator('.team-k:visible, label:visible > span:first-child')).toHaveText(['Name required', 'Job required', 'Works in', 'Agent', 'Level']);
  await expect(form.getByRole('radiogroup', { name: 'Level', exact: true }).getByRole('radio')).toHaveCount(4);
  const advanced = form.locator('details.team-adv');
  await expect(advanced).not.toHaveAttribute('open', '');
  await expect(advanced.locator('> summary')).toHaveText('Advanced');
  for (const hidden of [form.getByRole('combobox', { name: 'Up to' }), form.getByRole('combobox', { name: 'Model', exact: true }), form.getByRole('checkbox', { name: 'Leads this place' })]) await expect(hidden).toBeHidden();
  // No explaining paragraph at rest: the form's own text is its captions and buttons.
  await expect(form.locator('p:visible, .sds:visible, .swhy:visible')).toHaveCount(0);
  const info = (label: string) => form.getByRole('button', { name: `About ${label}`, exact: true });
  await expect(info('Works in')).toHaveAccessibleDescription('A project teammate works in that project and joins its room. Assistants share one folder and one room.');
  await expect(info('Agent')).toHaveAccessibleDescription("A teammate runs as a session of this agent and uses the agent's own permission mode.");
  await expect(info('Level')).toHaveAccessibleDescription(/^Auto: the lead or the schedule picks a level for each task/);
  await expect(app.locator('.settings')).not.toContainText(/same permissions/i);
  // The keyboard reaches an "i" and its text shows as the app's tooltip.
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  await form.getByLabel('Job', { exact: true }).focus();
  await app.keyboard.press(tab);
  await expect(info('Works in')).toBeFocused();
  await expect(app.locator('#app-tip')).toHaveText(/^A project teammate works in that project/);
  await app.keyboard.press(tab);
  await expect(form.getByRole('combobox', { name: 'Works in', exact: true })).toBeFocused();
  await expect(app.locator('#app-tip')).toBeHidden();
  // Advanced opens to the three; with Auto, "Up to" is there.
  await advanced.locator('> summary').click();
  await expect(form.getByRole('combobox', { name: 'Up to' })).toBeVisible();
  await expect(info('Custom model')).toHaveAccessibleDescription('A model picked here is used for every task, and levels no longer apply.');
  await expect(info('Leads this place')).toHaveAccessibleDescription(/Each place has one lead/);
});

// Ticket 993 (look at the shots): the form opens in the place of what it edits. An edited teammate's row gives way to
// it (it sat under the whole list, far from its row); a new teammate's form is the card's first line, under Add.
// Cancel and Save put the row back and give the focus to what opened the form: the row's "⋯", or Add teammate.
test('team_form_in_the_rows_place (993): Edit opens the form where the row is, Add at the top; closing returns the focus', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  mates(core, [
    { id: 'm1', name: 'Chief', job: JOB },
    { id: 'm2', name: 'Inbox', job: JOB },
    { id: 'm3', name: 'Reviewer', job: JOB },
  ]);
  await openWindow(app);
  const body = await openTeam(app);
  const card = body.locator('#h-team ~ .scard');
  const form = body.getByRole('group', { name: 'Teammate', exact: true });
  /** The card's lines in order: a row's teammate id, or "form". */
  const lines = () => card.evaluate((c) => [...c.children].map((e) => (e.matches('form') ? 'form' : ((e as HTMLElement).dataset.row ?? e.className))));
  await expect.poll(lines).toEqual(['team:m1', 'team:m2', 'team:m3']); // the list is read from the core
  // Q9 zh-hant-J11-4: another window saved Inbox's job since this page read the list; Edit starts from that save.
  mates(core, [
    { id: 'm1', name: 'Chief', job: JOB },
    { id: 'm2', name: 'Inbox', job: 'Saved elsewhere.' },
    { id: 'm3', name: 'Reviewer', job: JOB },
  ]);
  await mateMenu(body, 'Inbox', 'Edit');
  await expect.poll(lines).toEqual(['team:m1', 'form', 'team:m3']);
  await expect(form.getByLabel('Job', { exact: true })).toHaveValue('Saved elsewhere.');
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Inbox');
  await expect(form.getByLabel('Name', { exact: true })).toBeFocused();
  await expect(form).toBeInViewport({ ratio: 0.95 });
  await expect(body.getByRole('button', { name: 'Add teammate', exact: true })).toHaveCount(0); // one form at a time
  // Cancel: the row is back in its place, the focus on its menu button.
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.poll(lines).toEqual(['team:m1', 'team:m2', 'team:m3']);
  await expect(body.getByRole('button', { name: 'Actions for Inbox', exact: true })).toBeFocused();
  // Save: the same, on the row as saved.
  await mateMenu(body, 'Inbox', 'Edit');
  await form.getByLabel('Name', { exact: true }).fill('Mail');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect.poll(lines).toEqual(['team:m1', 'team:m2', 'team:m3']);
  await expect(body.locator('[data-row="team:m2"] .team-go')).toHaveText('Mail');
  await expect(body.getByRole('button', { name: 'Actions for Mail', exact: true })).toBeFocused();
  // Edit of another teammate while one form is open moves the form to that row.
  await mateMenu(body, 'Chief', 'Edit');
  await mateMenu(body, 'Reviewer', 'Edit');
  await expect.poll(lines).toEqual(['team:m1', 'team:m2', 'form']);
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Reviewer');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(body.getByRole('button', { name: 'Actions for Reviewer', exact: true })).toBeFocused();
  // Add: the form is the card's first line; Cancel and Save give the focus back to Add teammate.
  const addButton = body.getByRole('button', { name: 'Add teammate', exact: true });
  await addButton.click();
  await expect.poll(lines).toEqual(['form', 'team:m1', 'team:m2', 'team:m3']);
  await expect(form.getByLabel('Name', { exact: true })).toBeFocused();
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(addButton).toBeFocused();
  await addButton.click();
  await form.getByLabel('Name', { exact: true }).fill('Planner');
  await form.getByLabel('Job', { exact: true }).fill('Plans the week.');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(body.locator('[data-row^="team:"]')).toHaveCount(4);
  await expect(addButton).toBeFocused();
});

// Ticket 993 rule 8: Settings > Team at rest shows at most 40 words of fixed text (headings, the lead line, buttons,
// labels), not counting what the user wrote (names and jobs) and where a teammate works. A row's own words (its level
// chip, Lead, Open) repeat per teammate: the page with one row is the fixed text, and four whole rows still fit the
// budget. Ticket 994: with no teammate the empty state is one line (the page was 46 words then; 34 now), and a level
// reads as a model's name (25 words with one row, 35 with four).
test('team_words_at_rest (993 rule 8): at most 40 fixed words, in the page head and the page', async ({ app, core }) => {
  const demo = core.project('demo');
  core.shell(demo, 'alpha');
  mates(core, [
    { id: 'm1', name: 'Chief', job: JOB, lead: true },
    { id: 'm2', name: 'Inbox', job: JOB, level: 'light' },
    { id: 'm3', name: 'Researcher', job: LONG, project: demo, kind: 'codex', level_max: 'standard' },
    { id: 'm4', name: 'Reviewer', job: JOB, project: demo, model: 'opus' },
  ] as never);
  await openWindow(app);
  const body = await openTeam(app);
  await expect(body.locator('[data-row^="team:"]')).toHaveCount(4);
  const count = (rows: number) =>
    app.locator('.spage').evaluate((page, rows) => {
      const copy = page.cloneNode(true) as HTMLElement;
      // The user's own words and data: a teammate's name, its job, its project and agent.
      copy.querySelectorAll('.team-go, .team-row .sds, .team-where').forEach((e) => e.remove());
      // Ticket 1099: How this place works (owner-approved mockup cohesion-1099 panel 1, one sentence per row) is not the teammates' words.
      copy.querySelectorAll('.place-sec').forEach((e) => e.remove());
      [...copy.querySelectorAll('.team-row')].slice(rows).forEach((e) => e.remove());
      // A clone is not rendered (no innerText): its text nodes, a space between them.
      const out: string[] = [];
      const walk = (n: Node) => (n.nodeType === 3 ? out.push(n.textContent ?? '') : n.childNodes.forEach(walk));
      walk(copy);
      return out.join(' ').split(/\s+/).filter((w) => /\p{L}/u.test(w));
    }, rows);
  const one = await count(1);
  expect(one.length, one.join(' ')).toBeLessThanOrEqual(30);
  expect(one.length).toBeGreaterThan(15); // the count reads the page
  const four = await count(4);
  expect(four.length, four.join(' ')).toBeLessThanOrEqual(40);
  console.log(`team words at rest: one row ${one.length}, four rows ${four.length}`);
  // With no teammate: the empty state's one line.
  mates(core, []);
  await app.reload();
  await openWindow(app);
  await openTeam(app);
  await expect(app.locator('.spage .team-none')).toBeVisible();
  const none = await count(0);
  expect(none.length, none.join(' ')).toBeLessThanOrEqual(40);
  console.log(`team words at rest: no teammate ${none.length}: ${none.join(' ')}`);
});

// Ticket 993 rule 7: the empty state says what to do in one line, and the page has one Add action.
test('team_empty_state (993 rule 7)', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const body = await openTeam(app);
  await expect(body.getByRole('status')).toHaveText('No teammates yet. Add one for a job you hand over often.');
  await expect(body.getByRole('button', { name: /add/i })).toHaveText(['Add teammate']);
  await expect(app.locator('.spage .phd p')).toHaveText('Saved agents with a name, a job and a memory of their own.');
});
