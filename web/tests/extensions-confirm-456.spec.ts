// Ticket 456: turning on a custom item that can run commands asks first in the window, as `nunchiro extensions on` does,
// and the core refuses the change from a page that skips the question. Ticket 584: the page says custom items reach
// Claude sessions only. Real core, the test's own home.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { owner } from './acp-fakes';
import { openSettings } from './settings-modal';

async function open(app: Page, core: Core) {
  await openWindow(app, {}, core);
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Skills & hooks', exact: true }).click();
  await expect(app.getByRole('heading', { level: 1, name: 'Skills & hooks', exact: true })).toBeVisible();
}
const row = (app: Page, id: string) => app.locator(`[data-row="ext:${id}"]`);
const stored = (core: Core) => () => {
  const file = path.join(core.home, 'settings.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).features?.['extensions.enabled'] : undefined;
};
function hookItem(core: Core) {
  const file = path.join(core.home, 'extensions/guard/hooks/hooks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh --strict' }] }] } }));
}

test('ext_on_confirm_456: On shows the commands the item runs, and only Turn on turns it on', async ({ app, core }) => {
  hookItem(core);
  await open(app, core);
  await row(app, 'custom:guard').getByRole('switch').click();
  const ask = app.getByRole('alertdialog', { name: 'Turn on guard?' });
  // The whole command, path and all (the page's own list shortens the program to its name).
  await expect(ask.getByRole('group', { name: 'What guard runs' }).locator('tbody td')).toHaveText(['PreToolUse [Bash]', 'Before the agent uses a tool.', './guard.sh --strict']);
  // The first click changed nothing yet.
  expect(stored(core)()).toBeUndefined();
  await expect(row(app, 'custom:guard').getByRole('switch')).not.toBeChecked();
  await ask.getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(ask).toHaveCount(0);
  await expect.poll(stored(core)).toEqual(['nunchiro', 'custom:guard']);
  await expect(row(app, 'custom:guard').getByRole('switch')).toBeChecked();
});

test('ext_on_cancel_456: Cancel or Escape leaves the item off and nothing stored; a skill-only item asks too', async ({ app, core }) => {
  hookItem(core);
  const skill = path.join(core.home, 'extensions/notes/skills/notes/SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '---\nname: notes\ndescription: Notes.\n---\n');
  await open(app, core);
  await row(app, 'custom:guard').getByRole('switch').click();
  const ask = app.getByRole('alertdialog', { name: 'Turn on guard?' });
  await expect(ask.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await ask.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(ask).toHaveCount(0);
  await expect(row(app, 'custom:guard').getByRole('switch')).not.toBeChecked();
  // A custom item without hooks.json can still run commands (plugin.json hooks, .mcp.json servers): it asks as well.
  await row(app, 'custom:notes').getByRole('switch').click();
  const own = app.getByRole('alertdialog', { name: 'Turn on notes?' });
  await expect(own).toContainText('Its files can run commands (plugin hooks, MCP servers).');
  await app.keyboard.press('Escape');
  await expect(own).toHaveCount(0);
  await expect(row(app, 'custom:notes').getByRole('switch')).not.toBeChecked();
  expect(stored(core)()).toBeUndefined();
});

test('ext_on_unconfirmed_refused_456: the core refuses a change that adds an item without the confirmation', async ({ core }) => {
  hookItem(core);
  const r = owner(core, { op: 'quit_settings', patch: { features: { 'extensions.enabled': ['nunchiro', 'custom:guard'] } } });
  expect(r.Err).toContain('custom:guard was not turned on: it can run commands');
  expect(stored(core)()).toBeUndefined();
  // Confirmed for another id only: still refused.
  const other = owner(core, { op: 'quit_settings', patch: { features: { 'extensions.enabled': ['custom:guard'] }, extensions_confirmed: ['custom:x'] } });
  expect(other.Err).toContain('custom:guard');
  expect(owner(core, { op: 'quit_settings', patch: { features: { 'extensions.enabled': ['custom:guard'] }, extensions_confirmed: ['custom:guard'] } }).Ok).toBeTruthy();
  expect(stored(core)()).toEqual(['custom:guard']);
});

test('ext_on_sheet_width_456: the sheet gives a command its width and wraps it only at spaces, at 1000 and 1440 px, both themes', async ({ app, core }) => {
  const file = path.join(core.home, 'extensions/guard/hooks/hooks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const long = '"${CLAUDE_PLUGIN_ROOT}/hooks/check.sh" --strict --log ~/.cache/x.log';
  const word = '/very/long/' + 'x'.repeat(120) + '/check.sh';
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: long }, { type: 'command', command: word }] }] } }));
  for (const [width, scheme] of [[1440, 'light'], [1000, 'dark']] as const) {
    await app.setViewportSize({ width, height: 900 });
    await app.emulateMedia({ colorScheme: scheme });
    await open(app, core);
    await row(app, 'custom:guard').getByRole('switch').click();
    const ask = app.getByRole('alertdialog', { name: 'Turn on guard?' });
    const codes = ask.locator('code');
    await expect(codes).toHaveText([long, word]);
    const box = (await codes.first().boundingBox())!;
    expect(box.width).toBeGreaterThan(250);
    // Wrapped only at spaces: each line of the rendered text starts a word of the command.
    const lines = await codes.first().evaluate((el) => {
      const r = document.createRange();
      const text = el.firstChild!;
      const out: number[] = [];
      let top = -1;
      for (let i = 0; i < text.textContent!.length; i++) {
        r.setStart(text, i);
        r.setEnd(text, i + 1);
        const y = Math.round(r.getBoundingClientRect().top);
        if (y > top + 2) (out.push(i), (top = y));
      }
      return out;
    });
    for (const i of lines.slice(1)) expect(long[i - 1]).toBe(' ');
    // A word longer than the line scrolls inside its block instead of breaking.
    expect(await codes.last().evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await app.screenshot({ path: path.resolve(import.meta.dirname, `../../.scratch/shots/w103-r2-sheet-${width}-${scheme}-${test.info().project.name}.png`) });
    await app.keyboard.press('Escape');
    await app.keyboard.press('Escape');
  }
});

test('ext_refused_rereads_456: after a refused write the page reads the stored list, so the next switch works', async ({ app, core }) => {
  hookItem(core);
  expect(owner(core, { op: 'quit_settings', patch: { features: { 'extensions.enabled': ['nunchiro', 'custom:guard'] }, extensions_confirmed: ['custom:guard'] } }).Ok).toBeTruthy();
  await open(app, core);
  await expect(row(app, 'custom:guard').getByRole('switch')).toBeChecked();
  // Turned off elsewhere (the CLI, another window): the page still holds the old list.
  expect(owner(core, { op: 'quit_settings', patch: { features: { 'extensions.enabled': ['nunchiro'] } } }).Ok).toBeTruthy();
  const skill = app.getByRole('region', { name: 'Nunchiro defaults' }).getByRole('switch', { name: 'Nunchiro skill' });
  await skill.click();
  await expect(app.getByText('custom:guard was not turned on').first()).toBeVisible();
  await expect.poll(stored(core)).toEqual(['nunchiro']);
  await expect(row(app, 'custom:guard').getByRole('switch')).not.toBeChecked();
  // The next switch starts from the stored list and goes through.
  await skill.click();
  await expect.poll(stored(core)).toEqual([]);
});

test('ext_claude_only_584: the page says custom skills and hooks reach Claude sessions only, and when Codex gets Nunchiro hooks', async ({ app, core }) => {
  await open(app, core);
  await expect(app.locator('section[aria-labelledby="h-ext-skills"] [data-note="claude-only"]')).toHaveText(
    'Skills and hooks you add here reach Claude sessions only. Codex sessions do not load them.',
  );
  await expect(row(app, 'nunchiro-hooks')).toContainText('Codex sessions get them only when your Codex folders hold no hooks or plugins of their own');
});
