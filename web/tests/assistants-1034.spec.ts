// Tickets 1032 and 1034 (mockup docs/design/bot-statusbar-1121/index.html parts 2 and 3; owner 2026-11-21): the personal
// assistants' group is named "Assistants", it shows before any assistant is set up (one quiet "Chief · Set up" row), the
// onboarding step "Name your assistant" names the main assistant without starting it, and the name is changed later in
// Settings > Assistants; an open seat's tab and header follow a rename.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { mates, roster, sessions } from './leader-990';
import { closeSettings, openSettings } from './settings-modal';

const step = (app: Page, id: string) => app.locator(`.ob-step[data-step="${id}"]`);
const panel = (app: Page) => app.locator('.ob-panel');
const group = (app: Page) => app.locator('.tree .home-grp');
const nameField = (app: Page) => app.locator('.settings input[data-assistant-name]');
type Saved = { name: string; job: string; kind: string; lead?: boolean; project?: string };
const team = (core: Core) => roster<Saved>(core); // ticket 1168: the roster as the core keeps it
const onboarding = async (app: Page) => {
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="onboarding"]').click();
};

test('set_up_row (1032): with no assistant the tree shows the Assistants group with one quiet "Chief · Set up" row; a press opens the name field; folding hides the row', async ({ app, core }) => {
  const project = core.project('nunchiro');
  core.shell(project, 'alpha');
  await openWindow(app, {}, core);
  await expect(group(app).locator('.row.head')).toHaveText('Assistants');
  const row = group(app).locator('.home-setup .row');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.nm')).toHaveText('Chief');
  await expect(row.locator('.tm')).toHaveText('Set up');
  await expect(group(app).locator('.home-mate')).toHaveCount(0);
  // One row high: the tree's row height, as a teammate's row.
  const heights = await row.evaluate((e) => [e.getBoundingClientRect().height, parseFloat(getComputedStyle(e).getPropertyValue('--row'))]);
  expect(heights[0]).toBe(heights[1]);

  // The whole row is the button: it opens the step that names the assistant, with the default name selected.
  await row.click();
  await expect(step(app, 'assistant')).toHaveAttribute('aria-current', 'step');
  await expect(nameField(app)).toBeFocused();
  await expect(nameField(app)).toHaveValue('Chief');
  expect(await nameField(app).evaluate((e: HTMLInputElement) => [e.selectionStart, e.selectionEnd])).toEqual([0, 5]);
  expect(sessions(core).filter((s) => s.teammate)).toEqual([]);

  // Folding the group leaves only its head.
  await closeSettings(app);
  await group(app).locator('.chev').click();
  await expect(row).toHaveCount(0);
  await expect(group(app).locator('.row.head')).toBeVisible();
});

test('name_your_assistant (1034): the optional step before the first session saves the name and starts nothing; the tree, Settings > Assistants and a later rename all show it', async ({ app, core }) => {
  core.project('nunchiro');
  await openWindow(app, {}, core);
  await onboarding(app);
  const ids = await app.locator('.ob-step').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.step));
  expect(ids.slice(-2)).toEqual(['assistant', 'session']);
  await step(app, 'assistant').click();
  await expect(panel(app).locator('h3')).toHaveText('Name your assistant');
  await expect(panel(app)).toContainText('Optional.');
  await expect(panel(app).locator('.ob-pill')).toHaveText('Not done');
  await expect(nameField(app)).toHaveValue('Chief');
  await expect(nameField(app)).toHaveAttribute('maxlength', '40');
  await expect(panel(app)).toContainText("The assistant's seat is a Claude seat.");
  await expect(panel(app)).toContainText('Nothing starts until you open it.');
  await expect(panel(app).getByRole('button', { name: 'Skip', exact: true })).toBeVisible();
  // Mockup 3-1: the field and the "Runs on" value sit beside their labels, not on a line under them.
  const rows = panel(app).locator('.ob-rows .srow');
  await expect(rows).toHaveCount(2);
  for (const r of await rows.all()) {
    const [lab, ctl] = [(await r.locator('.slab').boundingBox())!, (await r.locator('.sctl').boundingBox())!];
    expect(ctl.x).toBeGreaterThanOrEqual(lab.x + lab.width);
    expect(ctl.y).toBeLessThan(lab.y + lab.height);
  }

  const before = sessions(core).length;
  await nameField(app).fill('Jarvis');
  await panel(app).getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(panel(app).locator('.ob-pill')).toHaveText('Done');
  await expect(panel(app)).toContainText('Your assistant is Jarvis. It is in the tree under Assistants.');
  await expect(panel(app).getByRole('button', { name: 'Open Jarvis', exact: true })).toBeVisible();
  await expect(step(app, 'assistant')).toHaveAttribute('data-done', 'true');
  // The existing team_save made Home's lead, a Claude seat with a job; nothing was started.
  const [saved] = team(core);
  expect(saved).toMatchObject({ name: 'Jarvis', kind: 'claude', lead: true });
  expect(saved.project ?? null).toBeNull();
  expect(saved.job).not.toBe('');
  expect(sessions(core).length).toBe(before);

  // Settings > Assistants: the Name row changes it later; the tree row follows.
  await panel(app).getByRole('button', { name: 'Open Assistants', exact: true }).click();
  await expect(nameField(app)).toHaveValue('Jarvis');
  await nameField(app).fill('Friday');
  await nameField(app).press('Enter');
  await expect.poll(() => team(core)[0]?.name).toBe('Friday');
  await closeSettings(app);
  const mate = group(app).locator('.home-mate');
  await expect(mate).toHaveCount(1);
  await expect(mate.locator('.nm')).toHaveText('Friday');
  await expect(mate.locator('.lead-tag')).toHaveText('Chief'); // ticket 1168 (owner 11-26): the office's lead is the Chief; the section keeps its name
  await expect(group(app).locator('.home-setup')).toHaveCount(0);
});

test('name_your_assistant_skip (1034): Skip marks the step skipped and goes on; the set-up row stays in the tree', async ({ app, core }) => {
  core.project('nunchiro');
  await openWindow(app, {}, core);
  await onboarding(app);
  await step(app, 'assistant').click();
  await panel(app).getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(step(app, 'assistant')).toHaveAttribute('data-done', 'true');
  await expect(step(app, 'assistant')).toContainText('Skipped');
  await expect(step(app, 'assistant')).not.toHaveAttribute('aria-current', 'step');
  expect(team(core)).toEqual([]);
  await closeSettings(app);
  await expect(group(app).locator('.home-setup .row')).toHaveCount(1);
});

test('name_your_assistant_needs_claude (1034): with no Claude the step says so and offers only Skip', async ({ app, core }) => {
  fs.rmSync(path.join(core.home, 'bin/claude'));
  core.project('nunchiro');
  await openWindow(app, {}, core);
  await onboarding(app);
  await step(app, 'assistant').click();
  await expect(panel(app)).toContainText('Claude was not found on this Mac', { timeout: 15_000 });
  await expect(nameField(app)).toHaveCount(0);
  await expect(panel(app).getByRole('button', { name: 'Save name', exact: true })).toHaveCount(0);
  await expect(panel(app).getByRole('button', { name: 'Skip', exact: true })).toBeVisible();
});

test('seat_follows_rename (1034): an open seat reads "Assistants · claude" with no count, and its tab and header take a new name', async ({ app, core }) => {
  core.project('nunchiro');
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-inbox', name: 'Inbox' },
  ]);
  await openWindow(app, {}, core);
  await group(app).locator('.home-mate[data-mate="mate-chief"] .row.wt2').first().click();
  await expect.poll(() => sessions(core).find((s) => s.teammate === 'mate-chief' && s.state === 'running')?.id ?? '').not.toBe('');
  const seat = sessions(core).find((s) => s.teammate === 'mate-chief')!;
  const tab = app.locator(`.tab[data-tab="${seat.id}"]`);
  await expect(tab).toContainText('Chief');
  await expect(app.locator('.shead .dim').first()).toContainText('Assistants · claude');
  await expect(app.locator('.shead')).not.toContainText('Assistants:');

  await openSettings(app);
  await app.locator('.settings > nav button[data-page="assistants"]').click();
  await nameField(app).fill('Jarvis');
  await nameField(app).press('Enter');
  await expect.poll(() => sessions(core).find((s) => s.id === seat.id)?.label).toBe('Jarvis');
  await closeSettings(app);
  await expect(tab).toContainText('Jarvis');
  await expect(app.locator('.shead > b')).toHaveText('Jarvis');
  await expect(group(app).locator('.home-mate[data-mate="mate-chief"] .nm')).toHaveText('Jarvis');
});

// Look v35 c S3-4: "Recommended" is a tag beside the Mode row's name, as other rows place a tag; the segment holds only
// the four mode names, so "Ask every time" is not squeezed.
test('mode_recommended_tag (S3-4): the tag sits beside the Mode name, outside the segment', async ({ app }) => {
  await openWindow(app);
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="assistants"]').click();
  const seg = app.locator('.sseg:has(input[name="home-chief-mode"])');
  await expect(seg.locator('label')).toHaveText(['Ask every time', 'Accept edits', 'Full access', 'Full access, shell included']);
  await expect(seg.locator('.chip')).toHaveCount(0);
  const tag = app.locator('.srow:has(input[name="home-chief-mode"]) .snm .chip[data-recommended]');
  await expect(tag).toHaveText('Recommended: Ask every time');
});

// Account connectors off saves `home.connectors_off` (the core then starts the seat with no MCP server); on again clears it.
test('account_connectors_switch: off saves home.connectors_off true, on clears it', async ({ app, core }) => {
  const features = () => (JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features ?? {}) as Record<string, unknown>;
  await openWindow(app);
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="assistants"]').click();
  const sw = app.locator('input[data-setting="homeConnectors"]');
  await expect(sw).toBeChecked();
  await sw.click();
  await expect(sw).not.toBeChecked();
  await expect.poll(() => features()['home.connectors_off']).toBe(true);
  await expect(app.locator('.srow', { hasText: 'Account connectors are off, so the assistant does not reach your mail.' })).toBeVisible();
  await expect(app.getByText('Allowed: files in its folders')).toBeVisible();
  await sw.click();
  await expect(sw).toBeChecked();
  await expect.poll(() => features()['home.connectors_off']).toBeUndefined();
});
