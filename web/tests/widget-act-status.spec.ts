// Ticket 203 (needs 171, 172): the one-line act status of a user widget and of a web widget is truncated, so its whole
// sanitised text is readable: in `title` and reachable by keyboard. Nothing moves (the line keeps its height).
import fs from 'node:fs';
import path from 'node:path';
import { clean } from '../src/widgets/output';
import { expect, openWindow, test, type Core } from './fixtures';
import { installWidgetHost } from './fixtures/web-widgets/host';

const LABEL = `long-target-${'x'.repeat(150)}`;
const HERE = path.join(import.meta.dirname, 'fixtures/web-widgets');
const RECORDING_CLAUDE = `#!/usr/bin/env python3
import os, signal, sys, tty
if '--version' in sys.argv:
    print('2.1.310 (Claude Code)')
    sys.exit()
tty.setraw(0)
signal.signal(signal.SIGWINCH, lambda *_: os.write(1, '\\r\\n\\u276f '.encode()))
os.write(1, '\\u276f '.encode())
out = open('received.bin', 'wb')
while True:
    data = os.read(0, 4096)
    if not data:
        break
    out.write(data)
    out.flush()
`;
function target(core: Core) {
  fs.writeFileSync(path.join(core.home, 'bin/claude'), RECORDING_CLAUDE, { mode: 0o700 });
  core.cli('session', 'start', '--kind', 'claude', '--project', core.project('act'), '--label', LABEL);
}
async function setting(core: Core, key: string) {
  const file = path.join(core.home, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), [key]: true }));
  core.run(['serve', 'stop'], 10_000);
  await core.restart();
}
const place = (core: Core, name: string) => core.cli('layout', ...`split right widget:${name} --zone terminal`.split(' '));
const view = (page: import('@playwright/test').Page, name: string) => page.locator(`[data-user-widget="${name}"]`);

/** The status is truncated (it overflows its line), keeps its height, and carries its whole text in title. */
async function readable(line: import('@playwright/test').Locator, height: number) {
  const text = (await line.textContent())!.trim();
  expect(text.length).toBeGreaterThan(100);
  await expect(line).toHaveAttribute('title', text);
  await expect(line).toHaveAttribute('tabindex', '0');
  expect(await line.evaluate((e) => e.scrollWidth > e.clientWidth), 'the line is truncated').toBe(true);
  expect(Math.round((await line.boundingBox())!.height)).toBe(height);
  await line.focus();
  await expect(line).toBeFocused();
  expect(await line.getAttribute('title')).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
}

test('widget_status_readable: a user widget (script) act status', async ({ app, core }) => {
  await setting(core, 'script_widgets');
  target(core);
  const dir = path.join(core.home, 'widgets', 'pick');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'widget.toml'),
    `version = 1\nkind = "script"\nauthor = "test"\ncommand = ["/bin/sh", "run.sh"]\ninterval = 10\npermissions = ["read", "act"]\n\n[act]\ntemplate = "look at {title}"\nsession = "${LABEL}"\n`,
  );
  fs.writeFileSync(path.join(dir, 'run.sh'), '/bin/cat rows.json\n');
  fs.writeFileSync(path.join(dir, 'rows.json'), JSON.stringify([{ title: 'one' }]));
  core.run(['widget', 'allow', 'pick', '--act']);
  await openWindow(app, core.boot(), core);
  place(core, 'pick');
  await expect(view(app, 'pick').locator('tbody tr')).toHaveCount(1);
  const line = view(app, 'pick').locator('.uw-act');
  await expect(line).toContainText('click a row to send it to');
  await readable(line, 18);
  // After a send the note replaces the hint; it is readable the same way and the line does not move.
  await view(app, 'pick').locator('tbody tr').first().click();
  await expect(line).toContainText('sent to');
  await readable(line, 18);
});

test('widget_status_readable: a web widget act status', async ({ app, core }) => {
  await setting(core, 'web_widgets');
  target(core);
  await installWidgetHost(app, core.home);
  const dir = path.join(core.home, 'widgets', 'w');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'widget.toml'), `version = 1\nkind = "web"\nauthor = "test"\nentry = "index.html"\npermissions = ["read", "act"]\nnetwork = []\n`);
  fs.writeFileSync(path.join(dir, 'index.html'), fs.readFileSync(path.join(HERE, 'bridge.html'), 'utf8'));
  core.run(['widget', 'allow', 'w', '--act']);
  await openWindow(app, core.boot(), core);
  place(core, 'w');
  await expect.poll(() => app.frames().some((f) => f.url().includes('/__widget/w-w-'))).toBe(true);
  const f = app.frames().find((f) => f.url().includes('/__widget/w-w-'))!;
  await expect.poll(() => f.evaluate(() => typeof (window as unknown as { call?: unknown }).call)).toBe('function');
  const bar = view(app, 'w').locator('.ww-confirm');
  const boxBefore = Math.round((await bar.boundingBox())!.height);
  await f.evaluate((label) => (window as unknown as { call: (m: string, p: unknown) => number }).call('act', { text: 'hello', session: label }), LABEL);
  await expect(bar).toHaveAttribute('data-confirm', 'open');
  await app.waitForTimeout(700);
  await bar.getByRole('button', { name: 'Send' }).dblclick();
  const note = bar.locator('[data-act-note]');
  await expect(note).toContainText('sent to session');
  await readable(note, Math.round((await note.boundingBox())!.height)); // the span is one line; the row keeps its own height:
  expect(Math.round((await bar.boundingBox())!.height)).toBe(boxBefore);
});

test('widget_status_stripped: clean() drops escape sequences and controls before the text reaches title', () => {
  expect(clean('ok\u001b[31m red\u001b[0m\u0007 \u009bdone')).toBe('ok red done');
});
