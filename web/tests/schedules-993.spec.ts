// Ticket 993 (Schedules as a widget) against a real core: the right-bar widget and its wide tab (a row's three lines
// and its columns, when and next run in words), the switch, Run now and the last-run dot, the form (Once, Every day,
// Weekdays, Weekly; a teammate's level), Remove, the empty state, a lead's proposal card in Decisions, a failed run on
// Home, the narrow widget in four languages, and Settings without its Schedules page. The V2.5-11 page's specs
// (schedule-page.spec.ts) live on here, against the widget's form.
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, nunchiro, openWindow, REPO, test } from './fixtures';
import { mates, openSeat, openTeam, owner, tokenClaude, tokenOf } from './leader-990';
import { closeSettings, openSettings } from './settings-modal';
import { add, listed, openWidget, row, stored } from './schedules-seed';

const box = async (l: Locator) => (await l.boundingBox())!;
const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
const order = (app: Page) => app.locator('.schedv .sched-item').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.schedule));
/** The form the widget's "+" opens. */
async function addForm(app: Page) {
  const widget = await openWidget(app);
  await widget.getByRole('button', { name: 'Add schedule', exact: true }).click();
  const form = widget.getByRole('form', { name: 'Add schedule' });
  await expect(form).toBeVisible();
  await expect(form.getByRole('combobox', { name: 'Who' })).toBeFocused(); // its first field takes the focus
  return form;
}
const WAITING_CLAUDE = `#!/bin/sh
if [ "$1" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi
if [ "$1 $2" = "auth status" ]; then exit 2; fi
printf 'fake agent ready\\r\\n'
while [ ! -f go ]; do sleep 0.05; done
printf '\\033[2J\\033[HDo you want to proceed?\\r\\n1. Yes\\r\\n2. No\\r\\n'
exec cat
`;
const submit = (form: Locator) => form.getByRole('button', { name: 'Add', exact: true });

test('schedule_rows: a row is three lines in the side and one line of columns in the tab; when and next run read in words; soonest first', async ({ app, core }) => {
  const demo = core.project('demo');
  core.shell(demo, 'main');
  mates(core, [{ id: 'mate-inbox', name: 'Inbox' }]);
  const inbox = add(core, { teammate: 'mate-inbox', task: 'Sort the new mail.\nThen list what is left.', level: 'light' }, '21:00');
  const week = add(core, { project: demo, label: 'tests', task: 'Run the tests.' }, '03:30', true, [1, 2, 3, 4, 5]);
  const monday = add(core, { project: demo, label: 'plan' }, '09:00', true, [1]);
  const some = add(core, { project: demo, label: 'digest' }, '09:00', true, [1, 3, 5]);
  const once = add(core, { project: demo, label: 'party' }, `${new Date().getFullYear()}-12-31 23:59`, false);
  const far = add(core, { project: demo, label: 'far' }, '2099-11-05 18:00', false);
  await openWindow(app);
  // Rule 1: a clock icon on the right bar; the widget opens in the right sidebar with its title and "+".
  const icon = app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Schedules', exact: true });
  await expect(icon.locator('svg[data-icon="clock"]')).toBeVisible();
  await expect(icon).toHaveAttribute('aria-pressed', 'false');
  const widget = await openWidget(app);
  await expect(icon).toHaveAttribute('aria-pressed', 'true');
  await expect(app.locator('.sbar[data-widget="schedules"] .sbh b')).toHaveText('Schedules');
  await expect(widget.getByRole('button', { name: 'Add schedule', exact: true })).toBeVisible();
  await expect(widget.locator('p')).toHaveCount(0); // no describing paragraph
  await expect(widget.locator('.sched-item')).toHaveCount(6);

  // When in words, from at / daily / days.
  const when = (id: string) => row(app, id).locator('.sched-when');
  await expect(when(inbox.id)).toHaveText('Every day 9:00 PM');
  await expect(when(week.id)).toHaveText('Weekdays 3:30 AM');
  await expect(when(monday.id)).toHaveText('Mondays 9:00 AM');
  await expect(when(some.id)).toHaveText('Mon, Wed, Fri 9:00 AM');
  await expect(when(once.id)).toHaveText('Once, Dec 31 11:59 PM'); // this year: no year
  await expect(when(far.id)).toHaveText('Once, Nov 5, 2099 6:00 PM');
  expect(await when(inbox.id).textContent()).toContain('9:00 PM'); // look 1117 C3: the time never wraps ("9:00 / PM")
  // The next run, short and never a second time of day: under a day a duration, under a week days, later the date
  // alone. The exact day and time are the row's tooltip and read with the row.
  await expect(row(app, inbox.id).locator('.sched-next')).toHaveText(/^in \d+ (min|hours?)$/);
  await expect(row(app, monday.id).locator('.sched-next')).toHaveText(/^in \d+ (min|hours?|days?)$/);
  await expect(row(app, far.id).locator('.sched-next')).toHaveText('Nov 5, 2099');
  await expect(row(app, inbox.id).locator('.sched-go')).toHaveAttribute('data-tip', /^Next run · (today|tomorrow) 9:00\sPM$/);
  await expect(row(app, far.id).locator('.sched-go')).toHaveAttribute('data-tip', /^Next run · Nov 5, 2099 6:00\sPM$/);
  await expect(row(app, far.id).locator('.sched-go')).toHaveAccessibleDescription(/Next run · Nov 5, 2099 6:00\sPM$/);
  // Eighth look (Home): the name's tooltip goes below the name, not over the text beside it.
  await row(app, inbox.id).locator('.sched-go').hover();
  await expect(app.getByRole('tooltip')).toHaveText(/^Next run · /);
  const go = await box(row(app, inbox.id).locator('.sched-go'));
  expect((await box(app.getByRole('tooltip'))).y).toBeGreaterThanOrEqual(go.y + go.height);
  await app.mouse.move(700, 500);
  // Sorted by the next run, soonest first.
  expect(await order(app)).toEqual([...listed(core)].sort((a, b) => a.next_ms - b.next_ms).map((s) => s.id));

  // Rule 2, narrow: (1) switch, name with the level's bars, the dot's place at the right end; (2) when · next; (3) the task.
  const r = row(app, inbox.id);
  await expect(r.getByRole('switch')).toHaveAccessibleName('Inbox, Every day 9:00 PM: on');
  await expect(r.getByRole('switch')).toBeChecked();
  await expect(r.locator('.sched-go')).toHaveText('Inbox');
  await expect(r.locator('.sched-name .lvl')).toHaveAttribute('data-level', 'light');
  await expect(r.locator('.sched-name .lvl')).toHaveAccessibleName('Level 1 of 3 · Light');
  await expect(r.locator('.sched-name .lvl-mark')).toHaveText('Haiku'); // ticket 994: the model the level starts
  await expect(row(app, week.id).locator('.lvl')).toHaveCount(0); // no teammate, no level
  await expect(r.locator('.sched-task')).toHaveText('Sort the new mail.');
  await expect(r).toHaveAttribute('data-last', 'none'); // never ran: no dot
  await expect(r.locator('.sched-dot .tdot')).toHaveCount(0);
  const [sw, name, l2, task, dot, line] = await Promise.all(['.stog', '.sched-name', '.sched-l2', '.sched-task', '.sched-dot', '.sched-row'].map((s) => box(r.locator(s))));
  expect([sw.width, sw.height]).toEqual([28, 16]); // the small switch: the name is what the eye lands on
  expect(name.height).toBeGreaterThanOrEqual(sw.height);
  expect(Math.abs(mid(sw) - mid(name))).toBeLessThan(4);
  expect(Math.abs(mid(sw) - mid(dot))).toBeLessThan(4);
  expect(sw.x).toBeLessThan(name.x);
  expect(dot.x).toBeGreaterThan(name.x + name.width - 1);
  expect(line.x + line.width - (dot.x + dot.width)).toBeLessThan(12); // the right end
  expect(l2.y).toBeGreaterThanOrEqual(sw.y + sw.height - 1);
  expect(task.y).toBeGreaterThanOrEqual(l2.y + l2.height - 1);
  // Rows are apart by a hairline in the app's line colour.
  expect(await app.locator('.schedv .sched-item').nth(1).evaluate((e) => getComputedStyle(e).borderTopWidth)).toBe('1px');
  expect(await r.locator('.sched-task').evaluate((e) => getComputedStyle(e).textOverflow)).toBe('ellipsis');

  // Wide: the same widget as a centre tab; one line in columns, under their heads.
  await widget.getByRole('button', { name: 'Open as a tab', exact: true }).click();
  const tab = app.locator('.schedv[data-where="tab"]');
  await expect(tab).toBeVisible();
  await expect(app.locator('.sbar[data-widget="schedules"]')).toHaveCount(0);
  await expect(app.getByRole('tab', { name: 'Schedules', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(tab.locator('.sched-heads span:not(.sched-l2)')).toHaveText(['', 'Name', 'Task', 'When', 'Next run']);
  const cells = await Promise.all(['.stog', '.sched-name', '.sched-task', '.sched-when', '.sched-next', '.sched-dot', '.lead-more'].map((s) => box(row(app, inbox.id).locator(s))));
  for (const c of cells) expect(Math.abs(mid(c) - mid(cells[0]))).toBeLessThan(4);
  expect(cells.map((c) => c.x)).toEqual([...cells.map((c) => c.x)].sort((a, b) => a - b));
  expect(cells[2].width).toBeGreaterThan(cells[3].width); // the task takes the free width
  // The columns line up: every row's When starts where the head's does.
  const head = await box(tab.locator('.sched-heads .sched-l2 > span').first());
  for (const id of [inbox.id, week.id, far.id]) expect(Math.abs((await box(when(id))).x - head.x)).toBeLessThan(1);
  // The "more" menu: Run now, Edit, Remove.
  await row(app, week.id).getByRole('button', { name: 'Actions for tests', exact: true }).click();
  await expect(tab.getByRole('menu').getByRole('menuitem')).toHaveText(['Run now', 'Edit', 'Remove']);
  await app.keyboard.press('Escape');
  await expect(tab.getByRole('menu')).toHaveCount(0);
  // Rule 8: the fixed text at rest (title, column heads, button names) is at most 15 English words.
  const fixed = [...(await tab.locator('.schedv-title, .sched-heads span:not(.sched-l2)').allTextContents()), ...(await tab.locator('.schedv-head button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? '')))];
  const words = fixed.join(' ').split(/\s+/).filter(Boolean);
  expect(words.length).toBeGreaterThan(5);
  expect(words.length).toBeLessThanOrEqual(15);
  // ⌘W on the Schedules tab closes it; the icon then opens the widget in the side again.
  await app.keyboard.press('Meta+w');
  await expect(tab).toHaveCount(0);
  await expect(app.getByRole('tab', { name: 'Schedules', exact: true })).toHaveCount(0);
  await openWidget(app);
  await app.locator('.sbar[data-widget="schedules"] .schedv').getByRole('button', { name: 'Open as a tab', exact: true }).click();
  await tab.getByRole('button', { name: 'Back to the side', exact: true }).click();
  await expect(app.locator('.sbar[data-widget="schedules"] .schedv')).toBeVisible();
  await expect(app.getByRole('tab', { name: 'Schedules', exact: true })).toHaveCount(0);
});

test('schedule_switch: the switch pauses and resumes; a paused row reads "paused" and moves last', async ({ app, core }) => {
  const demo = core.project('demo');
  core.shell(demo, 'main');
  add(core, { project: demo, label: 'one' }, '03:30');
  add(core, { project: demo, label: 'two' }, '04:30');
  const [first, second] = [...listed(core)].sort((a, b) => a.next_ms - b.next_ms);
  await openWindow(app);
  await openWidget(app);
  expect(await order(app)).toEqual([first.id, second.id]);
  const sw = row(app, first.id).getByRole('switch');
  await sw.click();
  await expect.poll(() => listed(core).find((s) => s.id === first.id)?.paused).toBe(true);
  await expect(sw).not.toBeChecked();
  await expect(sw).toHaveAccessibleName(`${first.run.label}, Every day ${first.at === '03:30' ? '3:30' : '4:30'} AM: off`);
  await expect(row(app, first.id).locator('.sched-next')).toHaveText('paused');
  await expect(row(app, first.id)).toHaveAttribute('data-paused', 'true');
  await expect.poll(() => order(app)).toEqual([second.id, first.id]);
  // By the keyboard: Space on the switch resumes it, and it is first again with its next run.
  await sw.focus();
  await app.keyboard.press('Space');
  await expect.poll(() => listed(core).find((s) => s.id === first.id)?.paused ?? false).toBe(false);
  await expect(sw).toBeChecked();
  await expect(row(app, first.id).locator('.sched-next')).not.toHaveText('paused');
  await expect.poll(() => order(app)).toEqual([first.id, second.id]);
});

test('schedule_run_now: Run now starts the run; the dot is running, then finished, then needs you, and opens the session; Tab reaches switch, row and dot', async ({ app, core, browserName }) => {
  const demo = core.project('demo');
  core.shell(demo, 'main');
  // A fake Claude that waits for the file `go` in its folder before it shows a permission dialog.
  fs.writeFileSync(path.join(core.home, 'bin/claude'), WAITING_CLAUDE, { mode: 0o700 });
  const s = add(core, { project: demo, label: 'nightly' }, '03:30');
  await openWindow(app);
  await openWidget(app);
  const r = row(app, s.id);
  await r.locator('.sched-go').click();
  await expect(r.locator('.sched-go')).toHaveAttribute('aria-expanded', 'true');
  const detail = r.getByRole('group', { name: 'nightly' });
  await expect(detail.locator('.sched-last')).toHaveText('Last run not run yet');
  await expect(detail.getByRole('button', { name: 'Open last run' })).toHaveCount(0);
  await detail.getByRole('button', { name: 'Run now', exact: true }).click();
  let session = '';
  await expect.poll(() => (session = listed(core)[0].last?.session ?? '')).not.toBe('');
  expect(listed(core)[0].last?.result).toBeUndefined();
  // Running: the tab strip's turning arc, "running now" where the next run was.
  await expect(r).toHaveAttribute('data-last', 'working');
  await expect(r.locator('.sched-dot .tdot')).toHaveAttribute('data-s', 'working');
  await expect(r.locator('button.sched-dot')).toHaveAccessibleName('Last run: running now');
  await expect(r.locator('.sched-next')).toHaveText('running now');
  // The turn ends: finished, in the done fill, with when it ran.
  core.hook(session, 'UserPromptSubmit');
  core.hook(session, 'Stop');
  await expect(r).toHaveAttribute('data-last', 'done', { timeout: 15_000 });
  await expect(r.locator('button.sched-dot')).toHaveAccessibleName(/^Last run finished · today \d+:\d\d\s[AP]M$/);
  await expect(r.locator('button.sched-dot')).toHaveAttribute('data-tip', /^Last run finished · today/);
  await expect(detail.locator('.sched-last')).toHaveText(/^Last run today \d+:\d\d\s[AP]M · finished$/);
  await expect(r.locator('.sched-next')).not.toHaveText('running now');
  // Keyboard: Tab goes switch, row, dot.
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab'; // WebKit's Tab skips buttons, as Safari's does ("Tab to links" off; ticket 531)
  await r.getByRole('switch').focus();
  await app.keyboard.press(tab);
  await expect(r.locator('.sched-go')).toBeFocused();
  await app.keyboard.press(tab);
  await expect(r.locator('button.sched-dot')).toBeFocused();
  // Its prompt comes up: the run needs the user (the "your turn" hand).
  fs.writeFileSync(path.join(demo, 'go'), '');
  await expect(r).toHaveAttribute('data-last', 'waiting', { timeout: 15_000 });
  await expect(r.locator('button.sched-dot')).toHaveAccessibleName(/^Last run needs you · today/);
  await expect(r.locator('.sched-dot .sdot')).toHaveAttribute('data-dot', 'you'); // design book: the tab's dot, no glyph
  // The dot (Enter on it) and "Open last run" open the run's session.
  await app.keyboard.press('Enter');
  await expect(app.locator(`.tab[data-tab="${session}"]`)).toHaveAttribute('aria-selected', 'true');
  await app.locator('.tab[data-tab]').first().click();
  await detail.getByRole('button', { name: 'Open last run', exact: true }).click();
  await expect(app.locator(`.tab[data-tab="${session}"]`)).toHaveAttribute('aria-selected', 'true');
});

test('schedule_dots: a failed run is the broken red with its reason; the bar icon gets a dot', async ({ app, core }) => {
  core.shell(core.project('demo'), 'main');
  mates(core, [{ id: 'mate-lister', name: 'Lister' }]);
  const s = add(core, { teammate: 'mate-lister', task: 'List the files.' }, '21:00');
  await openWindow(app);
  await openWidget(app);
  const icon = app.locator('#icon-schedules');
  await expect(icon.locator('.wdot')).toHaveCount(0);
  // The teammate leaves the team; its run cannot start. That is a failed run with its reason, not silence.
  mates(core, []);
  await row(app, s.id).locator('.sched-go').click();
  await row(app, s.id).getByRole('button', { name: 'Run now', exact: true }).click();
  const r = row(app, s.id);
  await expect(r).toHaveAttribute('data-last', 'failed');
  // Eighth look (Home): the refusal is said once, on the row (its detail has the reason); no banner above the list says it again.
  await expect(r.locator('.sched-last')).toContainText('failed: Lister is no longer a teammate');
  await expect(app.locator('.schedv').getByRole('alert')).toHaveCount(0);
  const dot = r.locator('.sched-dot');
  await expect(dot).toHaveAccessibleName('Last run failed: Lister is no longer a teammate');
  await expect(dot).toHaveAttribute('data-tip', 'Last run failed: Lister is no longer a teammate');
  await expect(dot.locator('.sdot')).toHaveAttribute('data-dot', 'bad'); // design book: the tab's dot, no glyph
  expect(await dot.evaluate((e) => e.tagName)).toBe('SPAN'); // it reached no session: nothing to open
  await expect(r.locator('.sched-last')).toHaveText(/^Last run today \d+:\d\d\s[AP]M · failed: Lister is no longer a teammate$/);
  await expect(icon.locator('.wdot[data-failed]')).toHaveAccessibleName('A scheduled run failed');
  await expect(icon).toHaveAccessibleDescription('A scheduled run failed');
});

test('schedule_form_when: the form adds Once, Every day, Weekdays and Weekly schedules with the right fields; a past date is refused in plain words', async ({ app, core }) => {
  const project = core.project('demo');
  core.shell(project, 'main'); // the core knows a project from a session in it
  await openWindow(app);
  let form = await addForm(app);
  // No teammate: Who offers only a new session, with its agent, folder and name as the old form had them.
  await expect(form.getByRole('combobox', { name: 'Who' }).locator('option')).toHaveText(['New session…']);
  await form.getByRole('combobox', { name: 'Agent' }).selectOption('claude');
  await expect(form.getByRole('combobox', { name: 'Project folder' })).toHaveValue(project); // C4: the tree's project, picked
  await expect(form.getByRole('radiogroup', { name: 'When' }).getByRole('radio')).toHaveCount(4);
  await expect(form.getByRole('radio', { name: 'Every day' })).toBeChecked();
  await expect(form.getByRole('radiogroup', { name: 'Level' })).toHaveCount(0); // a level is a teammate's
  await expect(form.getByLabel('Date')).toHaveCount(0); // a repeating schedule has no date
  // Every day.
  await form.getByRole('textbox', { name: 'Name' }).fill('nightly-run');
  await form.getByLabel('Time').fill('03:30');
  await submit(form).click();
  await expect(form).toHaveCount(0); // the form closes once the schedule is added
  await expect(app.locator('.schedv .sched-item')).toHaveCount(1);
  const daily = listed(core)[0];
  expect([daily.at, daily.daily, daily.days, daily.run.label, daily.run.project]).toEqual(['03:30', true, undefined, 'nightly-run', project]);
  await expect(row(app, daily.id).locator('.sched-go')).toHaveText('nightly-run');
  await expect(row(app, daily.id).locator('.sched-when')).toHaveText('Every day 3:30 AM');
  // The row is the only place the name shows: no sidebar row before it starts.
  await expect(app.getByText('nightly-run', { exact: true })).toHaveCount(1);

  // Once: a date field; a past date is refused by the field, in plain words with no Details.
  form = await addForm(app);
  await form.getByRole('textbox', { name: 'Name' }).fill('once-run');
  await form.getByRole('radio', { name: 'Once' }).check();
  await form.getByLabel('Date').fill('2020-01-02');
  await form.getByLabel('Time').fill('18:00');
  await submit(form).click();
  await expect(form.getByRole('alert')).toHaveText('That date and time has already passed. Pick a later one.');
  await form.getByLabel('Date').fill('2099-11-05');
  await submit(form).click();
  await expect(form).toHaveCount(0);
  const once = listed(core).find((s) => s.run.label === 'once-run')!;
  expect([once.at, once.daily, once.days]).toEqual(['2099-11-05 18:00', false, undefined]);
  await expect(row(app, once.id).locator('.sched-when')).toHaveText('Once, Nov 5, 2099 6:00 PM');
  await expect(row(app, once.id).locator('.sched-next')).toHaveText('Nov 5, 2099');

  // Weekdays: Monday to Friday.
  form = await addForm(app);
  await form.getByRole('textbox', { name: 'Name' }).fill('workdays');
  await form.getByRole('radio', { name: 'Weekdays' }).check();
  await form.getByLabel('Time').fill('09:00');
  await submit(form).click();
  await expect(form).toHaveCount(0);
  const week = listed(core).find((s) => s.run.label === 'workdays')!;
  expect([week.at, week.daily, week.days]).toEqual(['09:00', true, [1, 2, 3, 4, 5]]);
  await expect(row(app, week.id).locator('.sched-when')).toHaveText('Weekdays 9:00 AM');

  // Weekly: one day, picked from a select that shows only then.
  form = await addForm(app);
  await expect(form.getByRole('combobox', { name: 'Day' })).toHaveCount(0);
  await form.getByRole('textbox', { name: 'Name' }).fill('review');
  await form.getByRole('radio', { name: 'Weekly' }).check();
  await expect(form.getByRole('combobox', { name: 'Day' }).locator('option')).toHaveText(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  await form.getByRole('combobox', { name: 'Day' }).selectOption({ label: 'Wednesday' });
  await form.getByLabel('Time').fill('16:00');
  await submit(form).click();
  await expect(form).toHaveCount(0);
  const weekly = listed(core).find((s) => s.run.label === 'review')!;
  expect([weekly.at, weekly.daily, weekly.days]).toEqual(['16:00', true, [3]]);
  await expect(row(app, weekly.id).locator('.sched-when')).toHaveText('Wednesdays 4:00 PM');

  // Cancel and Escape close the form and add nothing.
  form = await addForm(app);
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(form).toHaveCount(0);
  form = await addForm(app);
  await form.getByRole('textbox', { name: 'Name' }).press('Escape');
  await expect(form).toHaveCount(0);
  await expect(app.locator('.schedv').getByRole('button', { name: 'Add schedule', exact: true })).toBeFocused();
  expect(listed(core)).toHaveLength(4);
});

// Ticket 981: a schedule carries a task, and can be a teammate's. The teammate has its own folder and name, so those
// boxes leave the form; the task is then required. Ticket 993: a new one starts at the first level (Haiku on Claude;
// ticket 994 shows the model, not the level's word); an edited one keeps its level.
test('schedule_form_teammate: teammates are offered by place; a teammate needs a task and starts at the first level; Edit fills the form, keeps the level and replaces the schedule', async ({ app, core }) => {
  const project = core.project('demo');
  core.shell(project, 'main');
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-inbox', name: 'Inbox' },
    { id: 'mate-build', name: 'Builder', project },
    { id: 'mate-own', name: 'Writer', model: 'opus' } as never,
  ]);
  const deep = add(core, { teammate: 'mate-inbox', task: 'Read the contracts.', level: 'deep' }, '21:00');
  await openWindow(app);
  let form = await addForm(app);
  const who = form.getByRole('combobox', { name: 'Who' });
  // Grouped by place, Home first, then "New session…"; the form starts on the first teammate that leads no place.
  expect(await who.locator('optgroup').evaluateAll((gs) => gs.map((g) => [(g as HTMLOptGroupElement).label, ...[...g.querySelectorAll('option')].map((o) => o.textContent)]))).toEqual([
    ['Assistants (no project)', 'Chief', 'Inbox', 'Writer'],
    ['demo', 'Builder'],
  ]);
  await expect(who.locator(':scope > option')).toHaveText(['New session…']);
  await expect(who).toHaveValue('team:mate-inbox');
  await expect(form.getByRole('combobox', { name: 'Agent' })).toHaveCount(0);
  await expect(form.getByRole('combobox', { name: 'Project folder' })).toHaveCount(0);
  await expect(form.getByRole('textbox', { name: 'Name' })).toHaveCount(0);
  const level = form.getByRole('radiogroup', { name: 'Level' });
  await expect(level.getByRole('radio')).toHaveCount(3);
  await expect(level.getByRole('radio', { name: /Haiku/ })).toBeChecked();
  await expect(submit(form)).toBeDisabled(); // a teammate with nothing to do is not a schedule
  // A custom model has no levels.
  await who.selectOption({ label: 'Writer' });
  await expect(level).toHaveCount(0);
  await who.selectOption({ label: 'Builder' });
  await form.getByRole('textbox', { name: 'What' }).fill('Build the nightly.\nReport what failed.');
  await form.getByLabel('Time').fill('08:00');
  await submit(form).click();
  await expect(form).toHaveCount(0);
  const built = listed(core).find((s) => s.run.label === 'Builder')!;
  expect([built.run.teammate, built.run.level, built.run.task, built.run.project, built.at]).toEqual(['mate-build', 'light', 'Build the nightly.\nReport what failed.', project, '08:00']);
  await expect(row(app, built.id).locator('.sched-task')).toHaveText('Build the nightly.');
  await expect(row(app, built.id).locator('.lvl')).toHaveAttribute('data-level', 'light');

  // A plain agent: New session…, where the task is optional.
  form = await addForm(app);
  await form.getByRole('combobox', { name: 'Who' }).selectOption({ label: 'New session…' });
  await form.getByRole('textbox', { name: 'Name' }).fill('tests');
  await expect(submit(form)).toBeEnabled();
  await form.getByRole('textbox', { name: 'What' }).fill('Run the tests.');
  await submit(form).click();
  await expect(form).toHaveCount(0);

  // Edit: the same form, filled; the level it has stays; Save replaces it (one write, a new id).
  await row(app, deep.id).locator('.sched-go').click();
  await row(app, deep.id).getByRole('button', { name: 'Edit', exact: true }).click();
  form = app.locator('.schedv').getByRole('form', { name: 'Edit' });
  // Eighth look (Home): Edit opens in the row's place (it opened at the top of the list with the row's detail left open below).
  await expect(row(app, deep.id).getByRole('form', { name: 'Edit' })).toBeVisible();
  await expect(row(app, deep.id).locator('.sched-row, .sched-detail')).toHaveCount(0);
  await expect(form.getByRole('combobox', { name: 'Who' })).toHaveValue('team:mate-inbox');
  await expect(form.getByRole('combobox', { name: 'Who' })).toBeFocused(); // Edit: the form's first field takes the focus, in view
  await expect(form).toBeInViewport();
  await expect(form.getByRole('textbox', { name: 'What' })).toHaveValue('Read the contracts.');
  await expect(form.getByLabel('Time')).toHaveValue('21:00');
  await expect(form.getByRole('radio', { name: 'Every day' })).toBeChecked();
  await expect(form.getByRole('radio', { name: /Opus/ })).toBeChecked();
  await form.getByLabel('Time').fill('22:15');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toHaveCount(0);
  const all = listed(core);
  expect(all).toHaveLength(3);
  const edited = all.find((s) => s.run.label === 'Inbox')!;
  expect([edited.at, edited.run.level, edited.run.task, edited.id === deep.id]).toEqual(['22:15', 'deep', 'Read the contracts.', false]);
  await expect(row(app, edited.id).locator('.sched-when')).toHaveText('Every day 10:15 PM');
  await expect(row(app, edited.id).locator('.lvl')).toHaveAttribute('data-level', 'deep');
  expect(JSON.parse(fs.readFileSync(path.join(core.home, 'schedules.json'), 'utf8')).schedules.map((s: { run: { label: string; task?: string; teammate?: string } }) => [s.run.label, s.run.task, !!s.run.teammate])).toEqual([
    ['Builder', 'Build the nightly.\nReport what failed.', true],
    ['tests', 'Run the tests.', false],
    ['Inbox', 'Read the contracts.', true],
  ]);
});

test('schedule_default_date: after the default 21:00 the form starts on tomorrow, before it on today', async ({ app, core }) => {
  core.shell(core.project('demo'), 'main');
  await openWindow(app);
  const widget = await openWidget(app);
  const addButton = widget.getByRole('button', { name: 'Add schedule', exact: true });
  await app.clock.setFixedTime(new Date('2099-03-10T22:00:00'));
  await addButton.click();
  await widget.getByRole('radio', { name: 'Once' }).check();
  await expect(widget.getByLabel('Date')).toHaveValue('2099-03-11');
  await addButton.click(); // closes
  await expect(widget.getByRole('form')).toHaveCount(0);
  await app.clock.setFixedTime(new Date('2099-03-10T20:00:00'));
  await addButton.click();
  await widget.getByRole('radio', { name: 'Once' }).check();
  await expect(widget.getByLabel('Date')).toHaveValue('2099-03-10');
});

// Ticket 991 C2: a time the box shows but never reported (WebKit's segment typing) is kept when the When segment changes.
test('schedule_time_kept_C2: picking Once keeps the shown time', async ({ app, core }) => {
  core.shell(core.project('demo'), 'main');
  await openWindow(app);
  const form = await addForm(app);
  const time = form.getByLabel('Time');
  await time.focus();
  await time.evaluate((el: HTMLInputElement) => (el.value = '16:03')); // no input event, as the survey's typing
  await form.getByRole('radio', { name: 'Once' }).check();
  await expect(time).toHaveValue('16:03');
});

// Ticket 991 C3, C4 and C13: a typed folder through a link (/var -> /private/var on macOS) is saved resolved, not
// refused; the Home folder reads "Home (no project)" in the project picker, never its folder name.
test('schedule_folders_C3_C4_C13: a linked typed folder is taken; the Home folder reads Home in the picker', async ({ app, core }) => {
  const project = core.project('demo');
  core.shell(project, 'main');
  const home = path.join(core.home, 'team', 'home');
  fs.mkdirSync(home, { recursive: true });
  core.shell(fs.realpathSync(home), 'notes');
  const link = path.join(core.home, 'demo-link');
  fs.symlinkSync(project, link);
  await openWindow(app);
  let form = await addForm(app);
  const picker = form.getByRole('combobox', { name: 'Project folder' });
  await expect(picker.locator('option')).toContainText(['demo', 'Assistants (no project)', 'Other folder…']);
  await picker.selectOption({ label: 'Other folder…' });
  await form.getByRole('textbox', { name: 'Folder path' }).fill(link);
  await form.getByRole('textbox', { name: 'Name' }).fill('nightly');
  await form.getByLabel('Time').fill('03:30');
  await submit(form).click();
  await expect(form).toHaveCount(0);
  await expect(app.locator('.schedv').getByRole('alert')).toHaveCount(0);
  expect(listed(core).map((s) => [s.run.label, s.run.project])).toEqual([['nightly', project]]);
  form = await addForm(app);
  await form.getByRole('combobox', { name: 'Project folder' }).selectOption({ label: 'Assistants (no project)' });
  await form.getByRole('textbox', { name: 'Name' }).fill('tidy');
  await submit(form).click();
  await expect(form).toHaveCount(0);
  expect(listed(core).find((s) => s.run.label === 'tidy')?.run.project).toBe(fs.realpathSync(home));
});

test('schedule_remove_empty: Remove asks first; with none left the widget says what it is for; a first schedule is added from there', async ({ app, core }) => {
  const demo = core.project('demo');
  core.shell(demo, 'main');
  const s = add(core, { project: demo, label: 'nightly-run', task: 'Run the tests.\nReport what failed.' }, '03:30');
  await openWindow(app);
  const widget = await openWidget(app);
  await expect(widget.locator('.schedv-empty')).toHaveCount(0);
  const go = row(app, s.id).locator('.sched-go');
  // The row is a button that opens its detail in place: the whole task and the buttons.
  await expect(go).toHaveAttribute('aria-expanded', 'false');
  await go.focus();
  await app.keyboard.press('Enter');
  await expect(go).toHaveAttribute('aria-expanded', 'true');
  const detail = row(app, s.id).getByRole('group', { name: 'nightly-run' });
  await expect(detail.locator('.sched-whole')).toHaveText('Run the tests.\nReport what failed.');
  await expect(row(app, s.id).locator('.sched-task')).toBeHidden(); // the whole task is right under: not there twice
  await expect(detail.getByRole('button')).toHaveText(['Run now', 'Edit', 'Remove']);
  // Look 1117 v5 (C S3-8): Remove asks in place; Cancel keeps the schedule.
  await detail.getByRole('button', { name: 'Remove', exact: true }).click();
  const ask = detail.getByRole('group', { name: 'Remove this schedule?' });
  await expect(ask).toBeVisible();
  await expect(ask.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await ask.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(widget.locator('.sched-item')).toHaveCount(1);
  expect(listed(core)).toHaveLength(1);
  await detail.getByRole('button', { name: 'Remove', exact: true }).click();
  await ask.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(widget.locator('.sched-item')).toHaveCount(0);
  expect(listed(core)).toHaveLength(0);
  // The empty state: the clock and two short lines.
  const empty = widget.getByRole('status');
  await expect(empty.locator('svg[data-icon="clock"]')).toBeVisible();
  await expect(empty.locator('p')).toHaveText(['No schedules yet.', 'Add one, or ask your lead to set one up.']);
  // Rule 8: besides those two lines the widget's fixed text is its title and its two button names.
  const buttons = await widget.locator('.schedv-head button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  expect(buttons).toEqual(['Add schedule', 'Open as a tab']);
  expect(await widget.locator('.schedv-body').evaluate((e) => (e as HTMLElement).innerText.split(/\s+/).filter(Boolean).join(' '))).toBe('No schedules yet. Add one, or ask your lead to set one up. New schedule'); // ticket 1099: the empty state's Add is a button
  await widget.getByRole('button', { name: 'Add schedule', exact: true }).click();
  await expect(empty).toHaveCount(0);
  await expect(widget.getByRole('form', { name: 'Add schedule' })).toBeVisible();
});

test('schedule_proposal_card: a lead proposes; the card says who, when and the level on a line, the task under it (three lines until Show all) and who asked; Not now stores nothing, Add stores it; a change is a card too', async ({ app, core }) => {
  tokenClaude(core);
  core.shell(core.project('demo'), 'main');
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-inbox', name: 'Inbox' },
  ]);
  await openWindow(app, {}, core);
  const chief = await openSeat(app, core, 'Chief');
  const token = await tokenOf(core, chief);
  const lead = (...args: string[]) => nunchiro({ ...core.env, NUNCHIRO_TOKEN: token }, ['schedule', ...args]);
  const task = `Sort the mail that came in since yesterday. ${'Draft a short reply to each one that needs it. '.repeat(6)}\nList what you left for me.`;
  lead('propose', '--who', 'Inbox', '--when', 'daily 21:00', '--task', task);
  expect(listed(core)).toHaveLength(0); // nothing is stored before the answer
  // The Decisions icon gets its dot; the card is there, built from the proposal's own fields.
  const icon = app.locator('#icon-decisions');
  await expect(icon.locator('.wdot')).toBeVisible();
  await icon.click();
  const card = app.locator('.dw').getByRole('group', { name: /^New schedule: / });
  // The core's one sentence (no level asked: the first level, as a schedule made by hand, said as the model it starts;
  // the task cut at 160 characters) is the card's accessible summary.
  await expect(card).toHaveAccessibleName(/^New schedule: Inbox · Every day 9:00 PM · Haiku: Sort the mail that came in since yesterday\. .*…$/);
  await expect(card.locator('.mc-head b')).toHaveText('New schedule');
  await expect(card.locator('.sched-line')).toHaveText('Inbox · Every day 9:00 PM · Haiku');
  await expect(card.locator('.sched-line .lvl')).toHaveAccessibleName('Level 1 of 3 · Light');
  await expect(card.locator('.sched-by')).toHaveText(/^asked by .*Chief$/);
  await expect(card.getByRole('button')).toHaveText(['Show all', 'Add', 'Not now']);
  // The task is there once: three lines, and the whole of it in place after Show all.
  const words = card.locator('.sched-ctask');
  await expect(words).toHaveText(task);
  expect(await card.evaluate((e, t) => e.textContent!.split(t.slice(0, 40)).length - 1, task)).toBe(1);
  const lines = () => words.evaluate((e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)));
  expect(await lines()).toBe(3);
  expect(await words.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
  await card.getByRole('button', { name: 'Show all', exact: true }).click();
  expect(await lines()).toBeGreaterThan(3);
  expect(await words.evaluate((e) => e.scrollHeight <= e.clientHeight + 1)).toBe(true);
  await card.getByRole('button', { name: 'Show less', exact: true }).click();
  expect(await lines()).toBe(3);
  await card.getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(card).toHaveCount(0);
  expect(listed(core)).toHaveLength(0);

  // Again, and Add: the schedule is stored as proposed, and the widget shows it without a reload.
  lead('propose', '--who', 'Inbox', '--when', 'weekly mon 09:00', '--level', 'deep', '--task', 'Plan the week.');
  await expect(card.locator('.sched-line')).toHaveText('Inbox · Mondays 9:00 AM · Opus');
  await expect(card.locator('.sched-ctask')).toHaveText('Plan the week.');
  await expect(card.getByRole('button')).toHaveText(['Add', 'Not now']); // a task that fits has no toggle
  await card.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => listed(core).length).toBe(1);
  const s = listed(core)[0];
  expect([s.run.teammate, s.run.level, s.run.task, s.at, s.daily, s.days]).toEqual(['mate-inbox', 'deep', 'Plan the week.', '09:00', true, [1]]);
  await openWidget(app);
  await expect(row(app, s.id).locator('.sched-when')).toHaveText('Mondays 9:00 AM');
  await expect(row(app, s.id).getByRole('switch')).toBeChecked();

  // A change is asked the same way: the title and the positive button name it, and the card shows which schedule it is.
  lead('change', s.id, 'pause');
  expect(listed(core)[0].paused).toBeUndefined();
  await app.locator('#icon-decisions').click();
  const pause = app.locator('.dw').getByRole('group', { name: /^Pause schedule: / });
  await expect(pause.locator('.mc-head b')).toHaveText('Pause schedule');
  await expect(pause.locator('.sched-line')).toHaveText('Inbox · Mondays 9:00 AM · Opus');
  await expect(pause.locator('.sched-ctask')).toHaveText('Plan the week.');
  await expect(pause.getByRole('button')).toHaveText(['Inbox', 'Pause', 'Not now']); // eighth look (Home): the name opens the widget on that row
  await pause.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => listed(core)[0].paused).toBe(true);
  await openWidget(app);
  await expect(row(app, s.id).getByRole('switch')).not.toBeChecked();
  await expect(row(app, s.id).locator('.sched-next')).toHaveText('paused');
});

test('schedule_home_failed: a failed scheduled run is under "Needs you" on Home with its reason, and the chip counts its card; a press opens the widget on its row', async ({ app, core }) => {
  tokenClaude(core);
  core.shell(core.project('demo'), 'main');
  const team = [{ id: 'mate-chief', name: 'Chief', lead: true }];
  mates(core, [...team, { id: 'mate-lister', name: 'Lister' }]);
  const s = add(core, { teammate: 'mate-lister', task: 'List the files.', level: 'light' }, '21:00');
  mates(core, team);
  expect(owner(core, { op: 'schedule_run_now', id: s.id }).Err).toContain('Lister is no longer a teammate');
  await openWindow(app, {}, core);
  await openSeat(app, core, 'Chief');
  const chip = app.locator('.shead [data-team-chip]');
  // Eighth look (Home S2-B): the failed run is an owner card, so the chip counts it (it said "1 project" with the
  // failure only on the Schedules icon and in the list); Home lists it once.
  await expect(chip).toHaveAccessibleName('1 project · 1 needs you');
  await expect(chip).toHaveAttribute('data-needs', 'true');
  await expect(app.locator('#icon-schedules .wdot[data-failed]')).toBeVisible();
  const view = await openTeam(app);
  const needs = view.locator('[data-part="projects"] .lead-grp[data-group="needs"]');
  await expect(needs).toHaveAccessibleName('Needs you · 1');
  const failed = needs.locator(`[data-failed-run="${s.id}"]`);
  await expect(failed.locator('b')).toHaveText('Lister');
  await expect(failed.locator('.lead-who')).toHaveText('Scheduled run failed: Lister is no longer a teammate');
  // The press opens the Schedules widget on that row, its detail open (Answer, beside it, opens the card).
  await failed.locator('.lead-go').click();
  const widget = app.locator('.sbar[data-widget="schedules"] .schedv');
  await expect(widget).toBeVisible();
  await expect(app.locator('.sbar[data-widget="team"]')).toHaveCount(0); // one sidebar widget at a time
  await expect(row(app, s.id).locator('.sched-go')).toHaveAttribute('aria-expanded', 'true');
  await expect(row(app, s.id).locator('.sched-last')).toContainText('failed: Lister is no longer a teammate');
  // Look v14 Home S3: its teammate was removed, and its row says so, as Edit does.
  await expect(row(app, s.id).locator('.sched-go b')).toHaveText('Lister (removed)');
  // Removed (the user's act on the failure), it is no longer a failed run: the icon's dot goes.
  await row(app, s.id).getByRole('button', { name: 'Remove', exact: true }).click();
  await row(app, s.id).getByRole('group', { name: 'Remove this schedule?' }).getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(app.locator('#icon-schedules .wdot[data-failed]')).toHaveCount(0);
  await expect(chip).toHaveAccessibleName('1 project');
});

// Nothing overflows at the default sidebar width (250 px): no row wider than the pane, no text cut without an ellipsis,
// in the list, an open detail and the form; in every language of the window.
for (const lang of ['en', 'ko', 'ja', 'es', 'fr', 'pt', 'zh-Hans', 'zh-Hant'])
  test(`schedule_narrow_${lang}: the widget fits 250 px`, async ({ app, core }) => {
    const demo = core.project('demo');
    const main = core.shell(demo, 'main');
    mates(core, [
      { id: 'mate-inbox', name: 'Inbox' },
      { id: 'mate-long', name: 'Quarterly-report-writer-and-checker' },
    ]);
    const a = add(core, { teammate: 'mate-inbox', task: 'Sort the morning mail, draft short replies to anything that needs one, and list what you left for me.', level: 'light' }, '21:00');
    const b = add(core, { teammate: 'mate-long', task: 'Write the quarterly report.', level: 'deep' }, '09:00', true, [1, 3, 5]);
    const c = add(core, { project: demo, label: 'nightly tests' }, `${new Date().getFullYear() + 1}-12-31 23:59`, false);
    await stored(app, core, {
      [a.id]: { last: { session: main.id, at: Date.now() - 3600_000, result: 'finished' } },
      [b.id]: { last: { at: Date.now() - 26 * 3600_000, result: 'failed', reason: 'Quarterly-report-writer-and-checker is no longer a teammate' } },
      [c.id]: { paused: true },
    });
    await openWindow(app);
    if (lang !== 'en') {
      await openSettings(app);
      await app.locator('.settings > nav button[data-page="general"]').click();
      await app.locator('[data-setting="language"]').selectOption(lang);
      await app.locator('.ovl .ovl-x').click();
      await expect(app.locator('.ovl')).toHaveCount(0);
    }
    const widget = await openWidget(app);
    await expect(widget.locator('.sched-item')).toHaveCount(3);
    expect((await box(widget)).width).toBeLessThanOrEqual(250);
    /** Every element of the widget that runs past the pane, or whose text is cut where no ellipsis says so. */
    const spills = () =>
      widget.evaluate((pane) => {
        const out: string[] = [];
        for (const el of pane.querySelectorAll<HTMLElement>('*')) {
          const r = el.getBoundingClientRect();
          if (!r.width || el.closest('svg, .sr') || /^(OPTION|OPTGROUP|TEXTAREA|INPUT|SELECT)$/.test(el.tagName)) continue; // .sr: text for a screen reader, not drawn
          const say = `${el.tagName.toLowerCase()}.${el.className}: ${(el.textContent ?? '').slice(0, 40)}`;
          // The box that clips it: itself, or the nearest ancestor that hides what runs over.
          let clip = el;
          while (clip !== pane && getComputedStyle(clip).overflowX === 'visible') clip = clip.parentElement!;
          const over = clip === el ? el.scrollWidth > el.clientWidth + 1 : r.right > clip.getBoundingClientRect().right + 0.5;
          if (!over) continue;
          const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
          if (clip === pane) out.push(`past the pane ${say}`);
          else if (clip.classList.contains('schedv-body')) out.push(`the body scrolls sideways for ${say}`);
          else if (own && getComputedStyle(clip).textOverflow !== 'ellipsis') out.push(`cut ${say}`);
        }
        return out;
      });
    expect(await spills()).toEqual([]);
    // Line 2 (when · next run) stays on one line in every row.
    for (const id of [a.id, b.id, c.id]) {
      const [when, next, l2] = await Promise.all(['.sched-when', '.sched-next', '.sched-l2'].map((sel) => box(row(app, id).locator(sel))));
      expect(Math.abs(when.y - next.y), `${lang}: line 2 of ${id}`).toBeLessThan(2);
      expect(l2.height).toBeLessThan(when.height * 1.5);
      expect(await row(app, id).locator('.sched-next').evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true); // the next run is never the part cut
    }
    // A long name is cut with an ellipsis on its row; the detail has the whole task and the reason on as many lines as they take.
    expect(await row(app, b.id).locator('.sched-go b').evaluate((e) => [e.scrollWidth > e.clientWidth, getComputedStyle(e).textOverflow])).toEqual([true, 'ellipsis']);
    await row(app, b.id).locator('.sched-go').click();
    await expect(row(app, b.id).locator('.sched-detail')).toBeVisible();
    expect(await spills()).toEqual([]);
    await row(app, a.id).locator('.sched-go').click();
    expect(await spills()).toEqual([]);
    // The form, for a teammate and for a new session, and with each When segment.
    await widget.locator('.schedv-add').click();
    const form = widget.locator('.sched-form');
    await expect(form).toBeVisible();
    expect(await spills()).toEqual([]);
    for (const mode of ['once', 'weekly']) {
      await form.locator(`input[name="sched-mode"][value="${mode}"]`).check();
      expect(await spills(), mode).toEqual([]);
    }
    await form.locator('select').first().selectOption('new');
    expect(await spills()).toEqual([]);
  });

test('schedule_settings_gone: Settings has no Schedules page; its search for "schedule" offers one result that opens the widget; the old page id opens the widget', async ({ app, core }) => {
  core.shell(core.project('demo'), 'main');
  await openWindow(app);
  await openSettings(app);
  const nav = app.getByRole('navigation', { name: 'Settings pages' });
  await expect(nav.getByRole('button', { name: 'Team', exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Schedules', exact: true })).toHaveCount(0);
  await expect(app.locator('.settings > nav button[data-page="schedule"]')).toHaveCount(0);
  // The search: one result, which closes Settings and opens the widget.
  const search = nav.getByRole('searchbox', { name: 'Search settings' });
  await search.fill('schedule');
  const results = nav.getByRole('list', { name: 'Matching settings' });
  await expect(results.getByRole('button')).toHaveCount(1);
  await expect(results.getByRole('button')).toHaveText('Schedules · Open the widget');
  await expect(app.locator('.settings').getByRole('status')).toHaveCount(0); // not "no setting matches"
  await results.getByRole('button').click();
  await expect(app.getByRole('dialog', { name: 'Settings' })).toBeHidden();
  const widget = app.locator('.sbar[data-widget="schedules"] .schedv');
  await expect(widget).toBeVisible();
  // Enter in the search box opens it too.
  await app.locator('#icon-schedules').click();
  await expect(widget).toHaveCount(0);
  await openSettings(app);
  await search.fill('Schedules');
  await search.press('Enter');
  await expect(app.getByRole('dialog', { name: 'Settings' })).toBeHidden();
  await expect(widget).toBeVisible();
  // A link to the old page by its id (the window's own settings event) opens the widget, never Settings.
  await app.locator('#icon-schedules').click();
  await expect(widget).toHaveCount(0);
  await app.evaluate(() => window.dispatchEvent(new CustomEvent('nunchiro:settings.field', { detail: { page: 'schedule', key: 'schedule' } })));
  await expect(widget).toBeVisible();
  await expect(app.getByRole('dialog', { name: 'Settings' })).toBeHidden();
  // A window whose stored last Settings page is the old one opens Settings on General.
  await app.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      try {
        const v = JSON.parse(localStorage.getItem(k)!);
        if (v && typeof v === 'object' && 'settingsPage' in v) localStorage.setItem(k, JSON.stringify({ ...v, settingsPage: 'schedule' }));
      } catch {
        // not a JSON value
      }
    }
  });
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await openSettings(app);
  await expect(app.locator('.settings > nav button[data-page="general"]')).toHaveAttribute('aria-current', 'page');
  await closeSettings(app);
});

// Look v9 Home S3-7b: the "New session…" form started on a project whose folder was removed (its ended session says
// so, the core's `folder_gone`); that project is not offered, the next one is picked.
test('schedule_form_skips_gone_folder: a project whose folder is gone is not offered as the new session\'s folder', async ({ app, core }) => {
  const alpha = core.project('alpha'); // first by name: the default before the fix
  const beta = core.project('beta');
  const old = core.shell(alpha, 'old');
  core.shell(beta, 'main');
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      if (typeof m !== 'string' || JSON.parse(m).event !== 'snapshot') return ws.send(m);
      const msg = JSON.parse(m);
      msg.sessions = msg.sessions.map((s: { id: string }) => (s.id === old.id ? { ...s, folder_gone: true } : s));
      ws.send(JSON.stringify(msg));
    });
  });
  await openWindow(app);
  const form = await addForm(app);
  await form.getByRole('combobox', { name: 'Agent' }).selectOption('claude');
  const folder = form.getByRole('combobox', { name: 'Project folder' });
  await expect(folder).toHaveValue(beta);
  await expect(folder.locator(`option[value="${alpha}"]`)).toHaveCount(0);
});

test('schedule_form_when_segment_has_no_hairlines: the When segment is the kit\'s segmented control (tint track, no rules between parts; look v35 b S3-4)', async ({ app, core }) => {
  const project = core.project('demo');
  core.shell(project, 'main');
  await openWindow(app);
  const form = await addForm(app);
  await form.getByRole('combobox', { name: 'Agent' }).selectOption('claude');
  const seg = form.getByRole('radiogroup', { name: 'When' });
  await expect(seg.getByRole('radio')).toHaveCount(4);
  const rules = await seg.locator('label').evaluateAll((els) => els.map((e) => ['Top', 'Left', 'Right', 'Bottom'].map((s) => getComputedStyle(e).getPropertyValue(`border-${s.toLowerCase()}-width`)).join(' ')));
  expect(rules).toEqual(Array(4).fill('0px 0px 0px 0px'));
  expect(await seg.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)'); // the tint track
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    await app.waitForTimeout(200);
    await seg.screenshot({ path: path.join(REPO, `.scratch/shots/w108-s3-4-when-${scheme}-${test.info().project.name}.png`) });
  }
});
