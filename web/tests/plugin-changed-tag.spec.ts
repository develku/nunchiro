// A room message a plugin's check changed says "Changed by <plugin>" under it (docs/plugins.md, Checks); the person's
// own message, never checked, has no tag. A real core and a real check: an agent (a shell session acting through the
// CLI with its own token) sends to the person, and the check replaces the words.
import fs from 'node:fs';
import path from 'node:path';
import { expect, nunchiro, openWindow, test, type Core } from './fixtures';

function guard(core: Core) {
  const dir = path.join(core.home, 'plugins/guard');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.toml'), 'id = "guard"\nname = "Guard"\nversion = "1.0.0"\n\n[[gate]]\nname = "g"\non = "prompt.send.before"\ncommand = ["/bin/sh", "gate.sh"]\n');
  fs.writeFileSync(path.join(dir, 'gate.sh'), `#!/bin/sh\nprintf '{"allow": true, "text": "Words a plugin chose."}\\n'\n`);
  core.run(['plugin', 'allow', 'guard']);
  core.run(['plugin', 'on', 'guard']);
}
async function enable(core: Core) {
  const file = path.join(core.home, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), script_widgets: true }));
  core.run(['serve', 'stop'], 10_000);
  await core.restart();
}
async function agentSaysToPerson(core: Core, project: string) {
  const args = ['session', 'start', '--kind', 'shell', '--project', project, '--label', 'worker', '--', '/bin/sh', '-c', 'printf "TOKEN:%s\\n" "$NUNCHIRO_TOKEN"; exec cat'];
  const id = (JSON.parse(nunchiro(core.env, args)).session as { id: string }).id;
  let token = '';
  await expect.poll(() => (token = /TOKEN:(\S+)/.exec(core.read(id))?.[1] ?? '')).not.toBe('');
  nunchiro({ ...core.env, NUNCHIRO_TOKEN: token }, ['agent', 'send', '--to', 'person', 'raw agent words']);
  return id;
}

for (const scheme of ['light', 'dark'] as const) {
  test(`plugin_changed_tag_in_the_room (${scheme})`, async ({ app, core }) => {
    guard(core);
    await enable(core);
    const project = core.project('room');
    const worker = await agentSaysToPerson(core, project);
    // The person's own words (the owner's CLI, outside every session): never checked, no tag.
    nunchiro(core.env, ['agent', 'send', '--to', worker, '--project', project, 'my own words']);
    await app.emulateMedia({ colorScheme: scheme });
    await openWindow(app, core.boot(), core);
    await app.locator('[data-room-tab]').click();
    const changed = app.locator('.room-msg', { hasText: 'Words a plugin chose.' });
    await expect(changed.locator('.changed-tag')).toHaveText('Changed by Guard');
    // The seats column's last-message line says it too.
    await expect(app.locator('.room-last', { hasText: 'Words a plugin chose.' })).toContainText('changed by Guard');
    await expect(app.locator('.room-msg', { hasText: 'raw agent words' })).toHaveCount(0);
    const mine = app.locator('.room-msg[data-created-by="person"]', { hasText: 'my own words' });
    await expect(mine).toBeVisible();
    await expect(mine.locator('.changed-tag')).toHaveCount(0);
    fs.mkdirSync('../.scratch/shots', { recursive: true });
    await app.screenshot({ path: `../.scratch/shots/plugin-changed-tag-${scheme}.png` });
  });
}
