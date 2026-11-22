import { expect, openWindow, showComposer, test, terminalText, agentsZone } from './fixtures';
import { openQuiet } from './tree-seed';
import { repo } from './visual/compare';

test.beforeEach(({ core }) => agentsZone(core)); // D5b: these specs read the AGENTS rows, which the default window no longer shows

test('shell: icon bars, tree beside AGENTS, tabs, collapsed right sidebar, empty strip, composer', async ({ app, core }) => {
  const p = repo(core, 'nunchiro'); // a repository: "main" names its main checkout (a plain folder shows none: no_main_for_a_plain_folder)
  const a = core.shell(p, 'core-serve');
  core.shell(p, 'v1a-03');
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  await expect(app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Tree' })).toHaveAttribute('aria-pressed', 'true');
  // ICONBAR: Settings is the last slot of the right icon bar and stays visible at this height.
  const gear = await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings', exact: true }).boundingBox();
  expect(gear!.y + gear!.height).toBeLessThan(900);
  // The right sidebar starts collapsed: only its icon bar; Layout (07b) is in the title bar.
  await expect(app.locator('.sbar.r')).toHaveCount(0);
  await expect(app.locator('nav[data-bar="right"] .lay')).toBeEnabled();
  // D5b: the tree is the left sidebar; this layout's own AGENTS zone sits to its right (the default window has none).
  const tree = await app.getByRole('navigation', { name: 'Projects' }).boundingBox();
  const agents = await app.getByRole('region', { name: 'Agents' }).boundingBox();
  expect(tree!.x + tree!.width).toBeLessThanOrEqual(agents!.x + 1); // D5b: the tree is the left sidebar, beside the AGENTS zone
  // ko/ v2-8a-groups.html G2: the name, then the counts, then a muted "main" (STYLE 2026-10-28).
  await expect(app.locator('.grp[data-project="nunchiro"] .head .n')).toHaveText('nunchiro');
  await expect(app.locator('.grp[data-project="nunchiro"] .head > .d')).toHaveText('main');
  await expect(app.getByRole('tab')).toHaveCount(3); // the project's two sessions and its Room tab (ticket 571)
  await expect(app.locator(`[data-agent="${a.id}"]`)).toContainText('core-serve');
  // The strip takes no space before anything waits (needs 77).
  await expect(app.locator('#waiting-strip')).toHaveCSS('height', '0px');
  await expect(app.locator('.composer')).toHaveCount(0); // V2.5-34: a session that shows its terminal has no composer until asked
  await showComposer(app);
  await expect(app.getByLabel('Message core-serve')).toBeVisible();
  // Scoped to the composer: since V1A-26 r2 each sidebar project head keeps an empty `.chip` live region.
  await expect(app.locator('.chips .chip').first()).toContainText('nunchiro / main'); // needs 130
});

test('terminal: output streams, keystrokes reach only that PTY, composer sends on Enter', async ({ app, core }) => {
  const p = core.project('demo');
  const a = core.shell(p, 'alpha');
  const b = core.shell(p, 'beta');
  await openWindow(app);
  await app.locator(`[data-agent="${a.id}"]`).click();
  await app.locator(`.term[data-session="${a.id}"]`).click();
  await app.keyboard.type('hello-alpha');
  await app.keyboard.press('Enter');
  await expect.poll(() => terminalText(app, a.id)).toContain('hello-alpha');
  expect(core.read(b.id)).not.toContain('hello-alpha');
  await showComposer(app);
  const composer = app.getByLabel('Message alpha');
  await composer.fill('from-composer');
  await expect.poll(() => core.read(a.id)).not.toContain('from-composer');
  await composer.press('Enter');
  await expect.poll(() => core.read(a.id)).toContain('from-composer');
  await expect(composer).toHaveValue('');
});

test('composer hides for a terminal-only view', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await expect(app.locator('.composer')).toHaveCount(0); // V2.5-34: a shell shows its terminal alone until the composer is asked for
  await showComposer(app);
  await expect(app.locator('.composer')).toBeVisible();
  await app.getByRole('button', { name: 'Open command palette' }).click();
  await app.getByRole('dialog').getByRole('combobox').fill('terminal-only');
  await app.keyboard.press('Enter');
  await expect(app.locator('.composer')).toHaveCount(0);
});

test('closing and reopening the window keeps the agent running and its scrollback', async ({ app, core }) => {
  const a = core.shell(core.project('demo'), 'alpha');
  for (let cycle = 0; cycle < 3; cycle++) {
    await openWindow(app);
    await app.locator(`.term[data-session="${a.id}"]`).click();
    await app.keyboard.type(`cycle-${cycle}`);
    await app.keyboard.press('Enter');
    await expect.poll(() => terminalText(app, a.id)).toContain(`cycle-${cycle}`);
    // A new page is a new window process from the core's view: the old socket closes.
    await app.goto('about:blank');
    expect(core.cli('snapshot', '--json').sessions[0].state).toBe('running');
  }
  await openWindow(app);
  for (let cycle = 0; cycle < 3; cycle++) await expect.poll(() => terminalText(app, a.id)).toContain(`cycle-${cycle}`);
});
