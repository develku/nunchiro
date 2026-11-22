// Ticket 1036: Claude's limits in the status bar's usage block, from what Claude Code hands its status line in a
// Nunchiro session. The core keeps the last record per account in `claude-limits.json` (crates/nunchiro-core/tests/
// claude_limits.rs drives that part with a fake claude); here the test's core starts with such a record, and the bar
// reads it through the real `account_usage`. Nothing is asked of Anthropic.
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import { type Core, expect, openWindow, REPO, test } from './fixtures';

const now = () => Math.floor(Date.now() / 1000);
const OUT = path.join(REPO, '.scratch/shots/1036');
const block = (app: Page) => app.locator('footer.status button.usg');
const pop = (app: Page) => app.getByRole('dialog', { name: 'Usage' });
const shot = (app: Page, name: string, project: string) => (fs.mkdirSync(OUT, { recursive: true }), app.screenshot({ path: path.join(OUT, `${name}-${project}.png`) }));

/** The record a status line left: 37 % of the 5 h window used, 82 % of the week, made `ago` seconds back. */
function record(core: Core, ago: number) {
  const told = { at: now() - ago, session: { left_pct: 63, resets_at: now() + 3 * 3600 }, weekly: { left_pct: 18, resets_at: now() + 2 * 86_400 } };
  fs.writeFileSync(path.join(core.home, 'claude-limits.json'), JSON.stringify({ own: told }), { mode: 0o600 });
}

test('claude_limits_from_status_line: the bar and the popover show Claude like Codex', async ({ app, core }, info) => {
  record(core, 30);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const claude = block(app).locator('[data-usage="claude"]');
  await expect(claude.locator('.usg-t')).toHaveText(/^37% (2h 5\dm|3h) · 82% (1d 23h|2d)$/);
  await expect(claude.locator('.mini')).toHaveAttribute('data-tone', 'warn');
  await block(app).click();
  const row = pop(app).locator('[data-usage-row="claude:own"]');
  await expect(row.locator('.u-reset')).toHaveText(/^Resets in (2h 5\dm|3h)$/);
  await expect(row.locator('.u-m')).toHaveText([/^5h\s*37%$/, /^wk\s*82%$/]);
  await expect(row).not.toContainText('as of');
  expect((await new AxeBuilder({ page: app }).include('.usg-pop').analyze()).violations).toEqual([]);
  await shot(app, 'fresh', info.project.name);
});

test('claude_limits_old_record_says_as_of: a record older than 10 minutes says when it was made', async ({ app, core }, info) => {
  record(core, 40 * 60);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const at = await app.evaluate((s) => new Date(s * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }), now() - 40 * 60);
  const claude = block(app).locator('[data-usage="claude"]');
  await expect(claude.locator('.usg-t')).toHaveText(new RegExp(`^37% .* · 82% .* · as of ${at}$`));
  await block(app).click();
  await expect(pop(app).locator('[data-usage-row="claude:own"] .u-line')).toHaveText(`as of ${at}`);
  await shot(app, 'as-of', info.project.name);
});

test('claude_limits_no_record_keeps_no_data: before any Claude session ran', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const claude = block(app).locator('[data-usage="claude"]');
  await expect(claude).toContainText('no data');
  await expect(claude.locator('.mini')).toHaveCount(0);
});
