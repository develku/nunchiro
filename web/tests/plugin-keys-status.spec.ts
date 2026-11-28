// A plugin's shortcut and status item (docs/plugins.md): its review sheet lists them; once approved and on, the
// shortcut runs its command and the status item shows its text and runs its command when pressed. A real core and a
// real command run in the sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test, type Core } from './fixtures';
import { closeSettings, openSettings } from './settings-modal';

function keyed(core: Core) {
  const dir = path.join(core.home, 'plugins/keys');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plugin.toml'),
    'id = "keys"\nname = "Keys"\nversion = "1.0.0"\n\n[[command]]\nname = "hi"\ntitle = "Say hi"\ncommand = ["/bin/sh", "hi.sh"]\nshow = "note"\n\n[[keybinding]]\ncommand = "hi"\nkey = "Meta+Shift+KeyH"\n\n[[status]]\nname = "greet"\ntext = "Hi there"\ncommand = "hi"\n',
  );
  fs.writeFileSync(path.join(dir, 'hi.sh'), '#!/bin/sh\necho "hello $(od -An -N4 -tu4 /dev/urandom | tr -d \' \')"\n');
}
async function enableScripts(core: Core) {
  const file = path.join(core.home, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), script_widgets: true }));
  core.run(['serve', 'stop'], 10_000);
  await core.restart();
}

for (const scheme of ['light', 'dark'] as const) {
  test(`plugin_shortcut_and_status_item (${scheme})`, async ({ app, core }) => {
    keyed(core);
    await enableScripts(core);
    await app.emulateMedia({ colorScheme: scheme });
    await openWindow(app, core.boot(), core);
    // The review sheet lists what it adds beyond its parts.
    await openSettings(app);
    await app.locator('.settings > nav button[data-page="plugins"]').click();
    await app.locator('.plg[data-plugin="keys"]').getByRole('button', { name: 'Review Keys' }).click();
    const extras = app.locator('.ps [data-field="extras"] li');
    await expect(extras).toHaveText(['command hi on key Meta+Shift+KeyH', 'status item greet', 'status item greet runs command hi']);
    await app.keyboard.press('Escape');
    core.run(['plugin', 'allow', 'keys']);
    core.run(['plugin', 'on', 'keys']);
    await closeSettings(app);
    // The window reads the plugins again when it comes back into focus.
    await app.evaluate(() => window.dispatchEvent(new Event('focus')));
    const note = app.locator('.pane-status');
    // The shortcut runs its command (the output is a fresh number each run).
    await app.keyboard.press('Meta+Shift+KeyH');
    await expect(note).toHaveText(/^Keys: hello \d+$/);
    const first = await note.textContent();
    // The status item shows its text, and a press runs the command again.
    const item = app.locator('footer.status [data-plugin-status="keys.greet"]');
    await expect(item).toHaveText('Hi there');
    await item.click();
    await expect(note).not.toHaveText(first!);
    await expect(note).toHaveText(/^Keys: hello \d+$/);
    fs.mkdirSync('../.scratch/shots', { recursive: true });
    await app.screenshot({ path: `../.scratch/shots/plugin-keys-status-${scheme}.png` });
  });
}
