// Ticket 1120: Settings > Team > How this place works sets the account the place's seats start on (`task account`).
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test } from './fixtures';
import { mates, openSeat, openTeam, owner, repo, tokenClaude } from './leader-990';
import type { Core } from './fixtures';

const ID = '00000000-0000-4000-8000-000000001120';
const place = (core: Core, project: string) => owner(core, { op: 'task', operation: 'list', project }).Ok.place;

test('place_account_row: the row lists the registered accounts; picking one sets the place account, the own account clears it', async ({ app, core }) => {
  tokenClaude(core);
  fs.mkdirSync(path.join(core.home, 'accounts/claude', ID), { recursive: true });
  fs.writeFileSync(path.join(core.home, 'accounts.toml'), `version = 1\n\n[[accounts]]\nagent = "claude"\nid = "${ID}"\nlabel = "official"\n`);
  const project = repo(core, 'nunchiro');
  mates(core, [{ id: 'lead-main', name: 'Main', project, lead: true }]);
  await openWindow(app, {}, core);
  await openSeat(app, core, 'Main');
  const team = await openTeam(app);
  await team.locator('.teamv-head [data-place-gear]').click();
  const sec = app.locator('.settings .place-sec');
  const row = sec.getByRole('combobox', { name: 'Seats run on' });
  await expect(row).toHaveValue('');
  await expect(row.locator('option')).toHaveText(["The lead's own account", 'official']);
  await row.selectOption('official');
  await expect.poll(() => place(core, project).account).toBe('official');
  await row.selectOption('');
  await expect.poll(() => place(core, project).account).toBeUndefined();
});
