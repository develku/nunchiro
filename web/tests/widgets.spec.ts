// Script widgets in the window (ticket v1b-19): the 사용자 위젯 gallery section, first-use permission sheet, text /
// JSON / table output, placeholders, hidden placements and the "에이전트에게 만들어 달라기" card. A real core with its own
// NUNCHIRO_HOME runs every widget through the real sandbox; widgets are fake shell scripts.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { REPO, expect, openWindow, test, type Core, showComposer } from './fixtures';

const SHOTS = path.join(REPO, '.scratch/shots/v1b-19');
const edit = (page: Page) => page.locator('nav[data-bar="right"] .lay').click();
const done = (page: Page) => page.getByRole('toolbar', { name: 'Layout edit' }).getByRole('button', { name: 'Done' }).click();
/** needs 153: no ':' command line in the window; `nunchiro layout` takes the same words. */
async function layout(_page: Page, core: Core, ...lines: string[]) {
  for (const line of lines) core.cli('layout', ...line.split(' '));
}
const view = (page: Page, name: string) => page.locator(`[data-user-widget="${name}"]`);
const gallery = (page: Page) => page.getByRole('complementary', { name: 'Widget library' });

function widget(core: Core, name: string, script: string, extra = '') {
  const dir = path.join(core.home, 'widgets', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'widget.toml'), `version = 1\nkind = "script"\nauthor = "test"\ncommand = ["/bin/sh", "run.sh"]\n${extra}`);
  fs.writeFileSync(path.join(dir, 'run.sh'), script);
  return dir;
}
function allow(core: Core, name: string) {
  core.run(['widget', 'allow', name, '--read']);
}
/** Script widgets ship off: turn the setting on and restart this test's core. */
async function enable(core: Core) {
  const file = path.join(core.home, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), script_widgets: true }));
  core.run(['serve', 'stop'], 10_000);
  await core.restart();
}
/** The window, booted with the core's current token (a restart issues a new one). */
const open = (app: Page, core: Core) => openWindow(app, core.boot(), core);
const shot = async (page: Page, name: string, target?: ReturnType<Page['locator']>) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await (target ?? page).screenshot({ path: path.join(SHOTS, `${name}-${test.info().project.name}.png`) });
};

test('gallery lists user widgets, hot-reloads a new folder within 1 s and marks the setting off', async ({ app, core }) => {
  widget(core, 'cargo-watch', 'echo hi\n');
  await open(app, core);
  await edit(app);
  await expect(gallery(app)).toBeVisible();
  await expect(gallery(app).locator('.lcard[data-card="widget:cargo-watch"]')).toBeVisible();
  // Default: listed, marked off; ticket 872: the note names the Settings switch.
  await expect(gallery(app)).toContainText('off; turn on in Settings › Layout › Script widgets');
  await expect(gallery(app).locator('.lcard.ask')).toContainText('Ask an agent to make one');
  // The promise is "within 1 s" of the folder appearing; the assertion's own timeout is that second.
  widget(core, 'open-prs', 'echo prs\n');
  const t0 = Date.now();
  await expect(gallery(app).locator('.lcard[data-card="widget:open-prs"]')).toBeVisible({ timeout: 1000 });
  expect(Date.now() - t0).toBeLessThan(1000);
  await shot(app, 'gallery-off', app.locator('.lib'));
  fs.rmSync(path.join(core.home, 'widgets/open-prs'), { recursive: true });
  await expect(gallery(app).locator('.lcard[data-card="widget:open-prs"]')).toHaveCount(0, { timeout: 1000 });
});

test('setting off: a placed widget says so and nothing spawns', async ({ app, core }) => {
  const dir = widget(core, 'demo', 'echo ran > "$NUNCHIRO_CACHE/marker"\n');
  allow(core, 'demo');
  await open(app, core);
  await layout(app, core, 'split right widget:demo --zone terminal');
  await expect(view(app, 'demo')).toContainText('script widgets are off; turn on in Settings › Layout › Script widgets');
  await expect(view(app, 'demo').getByRole('button', { name: 'Open setting' })).toBeVisible(); // ticket 872
  await app.waitForTimeout(1500);
  expect(fs.existsSync(path.join(dir, 'cache/marker'))).toBe(false);
});

test('first use opens the permission sheet; after Allow it runs and shows text as text', async ({ app, core }) => {
  await enable(core);
  const dir = widget(core, 'demo', `echo ran > "$NUNCHIRO_CACHE/marker"\nprintf '\\033[31m빨강 🎉\\033[0m <b>not bold</b>\\n'\n`, 'interval = 30\n');
  await open(app, core);
  await layout(app, core, 'split right widget:demo --zone terminal');
  const sheet = app.getByRole('dialog', { name: 'Allow “demo”?' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-field="command"]')).toHaveText('/bin/sh run.sh');
  await expect(view(app, 'demo')).toContainText('not allowed yet');
  expect(fs.existsSync(path.join(dir, 'cache/marker'))).toBe(false);
  await shot(app, 'permission-sheet');
  await sheet.getByRole('button', { name: 'Allow read only' }).click();
  const out = view(app, 'demo').locator('.uw-text');
  await expect(out).toHaveText('빨강 🎉 <b>not bold</b>\n');
  await expect(view(app, 'demo').locator('b', { hasText: 'not bold' })).toHaveCount(0);
  expect(fs.existsSync(path.join(dir, 'cache/marker'))).toBe(true);
  await shot(app, 'text-output', view(app, 'demo'));
  // A change asks again: nothing runs until it is reviewed.
  fs.writeFileSync(path.join(dir, 'run.sh'), 'echo changed\n');
  await expect(view(app, 'demo')).toContainText('changed since you allowed it');
});

test('a JSON array renders as a table (key union, value column); other JSON pretty-prints', async ({ app, core }) => {
  await enable(core);
  widget(core, 'rows', `printf '[{"name":"리뷰-03","n":1},{"name":"done 🎉","extra":{"x":1}},7]'\n`);
  widget(core, 'obj', `printf '{"ok":true}'\n`);
  allow(core, 'rows');
  allow(core, 'obj');
  await open(app, core);
  await layout(app, core, 'split right widget:rows --zone terminal', 'split down widget:obj --zone widget-rows');
  const table = view(app, 'rows').locator('table');
  await expect(table.locator('th')).toHaveText(['name', 'n', 'extra', 'value']);
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await expect(table.locator('tbody tr').nth(1).locator('td')).toHaveText(['done 🎉', '', '{"x":1}', '']);
  await expect(table.locator('tbody tr').nth(2).locator('td')).toHaveText(['', '', '', '7']);
  await expect(view(app, 'obj').locator('.uw-text')).toHaveText('{\n  "ok": true\n}');
  await shot(app, 'table-output', view(app, 'rows'));
});

test('a long JSON array is capped at 500 rows with a notice', async ({ app, core }) => {
  await enable(core);
  widget(core, 'many', `/usr/bin/perl -e 'print "[", join(",", map { "{\\"i\\":$_}" } 1..600), "]"'\n`);
  allow(core, 'many');
  await open(app, core);
  await layout(app, core, 'split right widget:many --zone terminal');
  await expect(view(app, 'many').locator('tbody tr')).toHaveCount(500);
  await expect(view(app, 'many')).toContainText('showing the first 500 of 600 rows');
});

test('a missing or deleted widget shows a placeholder where it is placed', async ({ app, core }) => {
  await enable(core);
  const dir = widget(core, 'demo', 'echo hi\n');
  allow(core, 'demo');
  await open(app, core);
  await layout(app, core, 'split right widget:ghost --zone terminal', 'split down widget:demo --zone widget-ghost');
  await expect(view(app, 'ghost')).toContainText('widget “ghost” not found');
  await expect(view(app, 'demo').locator('.uw-text')).toHaveText('hi\n');
  fs.rmSync(dir, { recursive: true });
  await expect(view(app, 'demo')).toContainText('widget “demo” not found', { timeout: 1000 });
});

test('a hidden placement (an inactive tab) does not run until shown', async ({ app, core }) => {
  await enable(core);
  const dir = widget(core, 'demo', 'echo ran > "$NUNCHIRO_CACHE/marker"\necho visible\n');
  allow(core, 'demo');
  // The widget is the second tab of the terminal zone; the terminal tab shows.
  fs.writeFileSync(
    path.join(core.home, 'layout.toml'),
    'version = 1\nlocked = false\n\n[root]\nid = "main"\nsplit = "row"\n\n[[root.children]]\nid = "tree"\nsize = 256\nwidgets = ["tree"]\n\n[[root.children]]\nid = "terminal"\nwidgets = ["terminal", "widget:demo"]\n',
  );
  await open(app, core);
  await expect(app.getByRole('tab', { name: 'demo' })).toBeVisible();
  await app.waitForTimeout(2000);
  expect(fs.existsSync(path.join(dir, 'cache/marker'))).toBe(false);
  await app.getByRole('tab', { name: 'demo' }).click();
  await expect(view(app, 'demo').locator('.uw-text')).toHaveText('visible\n');
  expect(fs.existsSync(path.join(dir, 'cache/marker'))).toBe(true);
});

test('the timeout and the posix_spawn limit show on the widget', async ({ app, core }) => {
  await enable(core);
  widget(core, 'slow', '/bin/sleep 30\n');
  widget(core, 'spawn', `/usr/bin/perl -e 'syscall(244,0,0,0,0,0,0) == -1 and die "posix_spawn denied: $!\\n"'\n`);
  allow(core, 'slow');
  allow(core, 'spawn');
  await open(app, core);
  await layout(app, core, 'split right widget:slow --zone terminal', 'split down widget:spawn --zone widget-slow');
  await expect(view(app, 'spawn')).toContainText('posix_spawn denied', { timeout: 10_000 });
  await expect(view(app, 'slow')).toContainText('timed out after 5 s', { timeout: 15_000 });
});

test('dragging a user widget card: an allowed one places, one not allowed yet is refused and its badge opens the sheet', async ({ app, core }) => {
  await enable(core);
  widget(core, 'dragme', 'echo dragged\n');
  widget(core, 'cargo-watch', 'echo ok\n');
  allow(core, 'cargo-watch');
  await open(app, core);
  await edit(app);
  await expect(gallery(app).locator('.lcard[data-card="widget:cargo-watch"]')).toContainText('script · allowed');
  await shot(app, 'gallery-section', app.locator('.lib'));
  // D5b (A22): a widget that is not allowed yet cannot be placed; its badge opens the existing permission sheet.
  const drop = async (kind: string) => {
    const handle = gallery(app).locator(`.lcard[data-card="${kind}"] .tx`);
    await handle.scrollIntoViewIfNeeded();
    await handle.hover();
    await app.mouse.down();
    const b = (await app.locator('[data-zone-id="terminal"]').boundingBox())!;
    await app.mouse.move(b.x + b.width * 0.92, b.y + b.height * 0.5, { steps: 6 });
    await app.mouse.up();
  };
  const file = path.join(core.home, 'layout.toml');
  const layout = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  await drop('widget:dragme');
  await expect(app.locator('.toast')).toContainText('dragme needs approval');
  expect(layout()).not.toContain('widget:dragme');
  await gallery(app).locator('.lcard[data-card="widget:dragme"]').getByRole('button', { name: 'Needs approval' }).click();
  await expect(app.getByRole('dialog', { name: 'Allow “dragme”?' })).toBeVisible();
  await app.keyboard.press('Escape');
  // An allowed one places like any card.
  await drop('widget:cargo-watch');
  await done(app);
  await expect.poll(layout).toContain('widget:cargo-watch');
});

test('"에이전트에게 만들어 달라기" fills the focused composer and sends nothing until Enter', async ({ app, core }) => {
  const project = core.project('ask');
  const s = core.shell(project, 'asker');
  await open(app, core);
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  await edit(app);
  await gallery(app).locator('.lcard.ask').click();
  const composer = app.locator('#composer');
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue(/^Make me a Nunchiro script widget that shows: /);
  await app.waitForTimeout(800);
  expect(core.read(s.id)).not.toContain('Nunchiro script widget');
  await composer.press('Enter');
  await expect.poll(() => core.read(s.id), { timeout: 5000 }).toContain('Make me a Nunchiro script widget');
});

test('"Ask an agent to make one" without a focused session says so', async ({ app }) => {
  await openWindow(app);
  await edit(app);
  await gallery(app).locator('.lcard.ask').click();
  // The library has two status regions: this line and a live region for the keyboard nest hint (empty here). The line is the one that names the reason.
  await expect(gallery(app).getByRole('status').filter({ hasText: 'no focused session' })).toHaveText('no focused session: open a session to ask its agent');
});
