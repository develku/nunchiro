// V2-14a: the Language picker (General page since 309459ab) next to the Appearance page (no mockup exists for it), saved under .scratch/language/.
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test, agentsZone, REPO } from './fixtures';

test('language_shots: Appearance and Language (on General) pages, side by side', async ({ app, core }) => {
  agentsZone(core);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  const out = path.join(REPO, '.scratch/language');
  fs.mkdirSync(out, { recursive: true });
  const nav = app.getByRole('navigation', { name: 'Settings pages' });
  const region = app.getByRole('region', { name: 'Settings' });
  await nav.getByRole('button', { name: 'Appearance' }).click();
  await region.screenshot({ path: path.join(out, `appearance-${test.info().project.name}.png`) });
  // needs 149/150 (309459ab, finding 22): the Language page folded into General as one Language combobox.
  await nav.getByRole('button', { name: 'General' }).click();
  await expect(region.getByRole('heading', { level: 1 })).toHaveText(/^General/); // needs 192 (ticket 250): the page title is the h1
  await expect(region.getByRole('combobox', { name: 'Language' })).toBeVisible();
  await region.screenshot({ path: path.join(out, `language-${test.info().project.name}.png`) });
  fs.writeFileSync(path.join(out, 'side-by-side.html'), '<!doctype html><meta charset=utf-8><title>Appearance vs Language</title><body style="margin:0;display:flex;gap:8px;background:#888"><img src="appearance-chromium.png" width="50%"><img src="language-chromium.png" width="50%">');
});
