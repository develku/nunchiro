// Ticket 774: before ticket 720 a login tab's saved project was its account folder, which no strip shows. A window state
// saved like that must still show the login tab with the selected project after a restart.
import fs from 'node:fs';
import path from 'node:path';
import { REPO, expect, openWindow, test } from './fixtures';
import { openAdd, openRow } from './accounts-rows';

test('a login tab saved under its account folder shows in the selected project after a restart', async ({ app, core }) => {
  const bin = path.join(core.home, 'bin');
  fs.copyFileSync(path.join(REPO, 'crates/nunchiro-core/tests/fixtures/accounts/signin-fake-codex.sh'), path.join(bin, 'codex'));
  fs.writeFileSync(path.join(bin, 'open'), '#!/bin/sh\n');
  for (const name of ['codex', 'open']) fs.chmodSync(path.join(bin, name), 0o700);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await openRow(app, 'Codex');
  await openAdd(app, 'codex');
  await app.getByRole('textbox', { name: 'Name' }).fill('term');
  await app.locator('[data-agent="codex"]').getByRole('button', { name: 'Sign in using a terminal instead' }).click();
  const find = () => (core.cli('snapshot', '--json').sessions as { id: string; project: string; account_tab?: boolean }[]).find((s) => s.account_tab);
  await expect.poll(find).toBeTruthy();
  const login = find();
  await expect(app.locator(`.tab[data-tab="${login!.id}"]`)).toBeVisible();
  // The state as a window from before ticket 720 saved it: the login tab filed under the account folder.
  await app.addInitScript(([id, folder]) => {
    if (sessionStorage.getItem('seeded774')) return;
    sessionStorage.setItem('seeded774', '1');
    const key = `nunchiro.window.v1:${sessionStorage.getItem('nunchiro.window.id')}`;
    const s = JSON.parse(localStorage.getItem(key) ?? 'null');
    s.tabProj = { ...s.tabProj, [id]: folder };
    for (const k of [key, 'nunchiro.window.v1']) localStorage.setItem(k, JSON.stringify(s));
  }, [login!.id, login!.project] as const);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(app.locator(`.tab[data-tab="${login!.id}"]`)).toBeVisible();
});
