// Ticket 518 (owner pick D), ticket 1040: a Providers row whose value is also set in a project says where, in a
// muted tag after its label. The rows with more than one source are the Claude and Codex new-session model and effort
// (All projects, one project, or the agent's own default). A value set in the scope in view shows no tag.
import type { Page } from '@playwright/test';
import path from 'node:path';
import { expect, openWindow, test } from './fixtures';
import { openRow } from './accounts-rows';

async function openClaude(app: Page) {
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await openRow(app, 'Claude');
}
async function seedDefaults(app: Page, stored: unknown) {
  await app.evaluate((v) => {
    const key = 'nunchiro.settings.v1';
    const s = JSON.parse(localStorage.getItem(key) ?? '{}');
    localStorage.setItem(key, JSON.stringify({ ...s, features: { ...s.features, 'agents.new_session_defaults': v } }));
  }, stored);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
}
// Ticket 534: the tooltip shortens a home folder (/Users/<x>, /home/<x>) to ~ (ticket 518, Row.tsx SourceTag), and the test's
// projects sit under the checkout, which may be in one; the spec was green only for a checkout outside a home.
const shown = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~');
const tag = (app: Page, row: string) => app.locator(`[data-row="${row}"] [data-source]`);
/** Ticket 1040: one project's values are on its page in Settings > Projects; Providers shows All projects only. */
const projectPage = async (app: Page, name: string) => {
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Projects' }).click();
  await app.locator('.pj-row').filter({ hasText: name }).locator('.pj-open').click();
};

test('setting_value_source_tags_follow_the_scope', async ({ app, core }) => {
  const demo = core.project('demo');
  core.shell(demo, 'alpha');
  await openWindow(app);
  // A removed project's leftover override (a folder under the test home that is no registered project) is left out of
  // the tag: its scope cannot be opened to clear it.
  const gone = path.join(core.home, 'gone-project');
  await seedDefaults(app, { all: {}, projects: { [demo]: { claude: { model: 'sonnet' } }, [gone]: { claude: { model: 'opus', effort: 'high' } } } });
  await openClaude(app);

  // All projects: the model is changed in one project, so the row names it; the effort (changed only in the removed
  // project) shows nothing.
  await expect(tag(app, 'newDefaultModel')).toHaveText('Changed in demo');
  await expect(tag(app, 'newDefaultModel')).toHaveAttribute('title', new RegExp(shown(demo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await expect(tag(app, 'newDefaultModel')).not.toHaveAttribute('title', /gone-project/);
  await expect(tag(app, 'newDefaultModel')).not.toHaveRole('button');
  await expect(tag(app, 'newDefaultEffort')).toHaveCount(0);

  // A value set here (All projects) shows no tag.
  await app.getByRole('combobox', { name: 'Effort · Claude', exact: true }).selectOption('high');
  await expect(tag(app, 'newDefaultEffort')).toHaveCount(0);

  // The project's own page: its model is set right there; an unset effort reads "Follow All projects", with no tag.
  await projectPage(app, 'demo');
  const one = app.locator('.pj-one');
  await expect(one.getByRole('combobox', { name: 'Default model and effort · Claude' })).toHaveValue('sonnet');
  await expect(one.getByRole('combobox', { name: 'Effort · Claude', exact: true }).locator('option:checked')).toHaveText('Follow All projects');
  await expect(one.locator('[data-source]')).toHaveCount(0);
});

test('setting_value_source_counts_two_projects', async ({ app, core }) => {
  const demo = core.project('demo');
  const other = core.project('other');
  core.shell(demo, 'alpha');
  core.shell(other, 'beta');
  await openWindow(app);
  await seedDefaults(app, { all: {}, projects: { [demo]: { claude: { model: 'sonnet' } }, [other]: { claude: { model: 'opus' } } } });
  await openClaude(app);
  await expect(tag(app, 'newDefaultModel')).toHaveText('Changed in 2 projects');
  const title = await tag(app, 'newDefaultModel').getAttribute('title');
  expect(title).toContain(shown(demo));
  expect(title).toContain(shown(other));
});
