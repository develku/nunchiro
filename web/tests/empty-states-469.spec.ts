// Ticket 469 (scorecard D4, F2): every empty list or screen a new user reaches says what is missing in one line and
// offers the one action that fills it; the action opens the same next screen as the menu or palette command.
// Fresh fixture home: no project, no session, no machine, no schedule, nothing waiting.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { icon, sidebar } from './d5b';
import { seed } from './tree-seed';

test.use({ colorScheme: 'dark' }); // the report's shots are dark; nothing asserted depends on the theme

const centre = (app: Page) => app.locator('.pane .empty');
const settingsPage = async (app: Page, name: string) => {
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name, exact: true }).click();
  return app.getByRole('region', { name: 'Settings' });
};
// Dark shots for the lane report; SHOT_TAG=before on the old code.
const shot = async (app: Page, name: string) => {
  if (test.info().project.name !== 'chromium') return;
  await app.screenshot({ path: `../.scratch/shots/empty-469-${process.env.SHOT_TAG ?? 'after'}-${name}.png` });
};

test('no_project: centre and tree say to add a project; the action opens the Add project chooser', async ({ app }) => {
  await openWindow(app);
  await expect(centre(app).getByText('Add a project to get started', { exact: true })).toBeVisible();
  await expect(app.locator('.tree .empty')).toContainText('Add a project to get started.');
  await shot(app, 'no-project');
  await centre(app).getByRole('button', { name: 'Add project', exact: true }).click();
  await expect(app.getByRole('dialog', { name: 'Add project', exact: true })).toBeVisible();
});

test('no_session: a known project with no session offers Start a session, which opens the new-session popover', async ({ app, core }) => {
  seed(core, { op: 'add', project: core.project('beta'), added: true });
  await openWindow(app);
  await expect(centre(app).locator('.landing')).toBeVisible();
  await shot(app, 'no-session');
  await expect(centre(app).locator('p').first()).toHaveText('No sessions yet.');
  await expect(centre(app).getByRole('button', { name: 'Add project', exact: true })).toHaveCount(0);
  await centre(app).getByRole('button', { name: 'Start a session', exact: true }).click();
  // The tree's one project is the folder: no second pick (round 2, NewSession knows sessions' projects only).
  await expect(app.getByRole('dialog', { name: 'New tab', exact: true }).locator('.nt-in')).toHaveAttribute('title', core.project('beta'));
});

test('no_machine: the empty Machines list offers its first machine, which opens the add form', async ({ app }) => {
  await openWindow(app);
  const page = await settingsPage(app, 'SSH machines');
  const empty = page.locator('.machines-page .empty');
  await expect(empty).toContainText('No machines listed.');
  await shot(app, 'no-machine');
  await empty.getByRole('button', { name: 'Add your first machine', exact: true }).click();
  await expect(page.locator('form.machine-add')).toBeVisible();
  await expect(empty).toHaveCount(0); // one way in at a time: the form replaces the line
});

// Ticket 993: Schedules is a widget. Its empty state is two lines; the action that fills it is the "+" in its header,
// right above them (the old page's "Add your first schedule" button is gone with the page).
test('no_schedule: the empty Schedules widget says what is missing; its Add schedule opens the add form', async ({ app }) => {
  await openWindow(app);
  await app.locator('#icon-schedules').click();
  const widget = app.locator('.sbar[data-widget="schedules"] .schedv');
  const empty = widget.locator('.schedv-empty');
  await expect(empty).toContainText('No schedules yet.');
  await expect(empty).toContainText('Add one, or ask your lead to set one up.');
  await shot(app, 'no-schedule');
  await widget.getByRole('button', { name: 'Add schedule', exact: true }).click();
  await expect(widget.getByRole('combobox', { name: 'Agent' })).toBeVisible();
  await expect(empty).toHaveCount(0); // one way in at a time: the form replaces the lines
});

test('nothing_waiting: the empty Decisions widget says so and has no button (ticket 1076)', async ({ app, core }) => {
  seed(core, { op: 'add', project: core.project('beta'), added: true });
  await openWindow(app);
  await icon(app, 'right', 'Decisions').click();
  const empty = sidebar(app, 'right').locator('.dw-empty');
  await expect(empty).toContainText('Nothing waiting');
  await shot(app, 'nothing-waiting');
  await expect(empty.getByRole('button')).toHaveCount(0);
});

// Round 2: the default bars' Files, Diff and Artifacts widgets with no session open. Round 3: with the tree's one
// project, the popover starts in it, as from the Landing.
for (const [name, side, where, line] of [
  ['Files', 'left', 'aside.files .empty', 'Open a session to see its files.'],
  ['Diff', 'right', '.dstate', 'Open a session to see its changes.'],
  ['Artifacts', 'right', 'aside.aw .awempty', 'Open a session to see its attachments and artifacts.'],
] as const) {
  test(`no_session_${name.toLowerCase()}: the ${name} widget says to open a session and offers Start a session`, async ({ app, core }) => {
    seed(core, { op: 'add', project: core.project('beta'), added: true });
    await openWindow(app);
    await icon(app, side, name).click();
    const empty = sidebar(app, side).locator(where);
    await expect(empty).toContainText(line);
    await shot(app, `no-session-${name.toLowerCase()}`);
    await empty.getByRole('button', { name: 'Start a session', exact: true }).click();
    await expect(app.getByRole('dialog', { name: 'New tab', exact: true }).locator('.nt-in')).toHaveAttribute('title', core.project('beta'));
  });
}
