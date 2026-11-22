// Script widget act in the window (ticket v1b-20): rows are clickable only with a current act grant, one click sends
// the core-rendered row once, the target's header names the widget, and nothing calls widget_act without a click.
// A real core runs the widget through the real sandbox; the target is a raw, echo-free `/bin/cat` into a file.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { REPO, expect, openWindow, test, type Core } from './fixtures';

const SHOTS = path.join(REPO, '.scratch/shots/v1b-20');
const TEMPLATE = 'look at {title} #{n}';
const ROWS = [
  { title: '리뷰 🎉 PR', n: 12 },
  { title: 'second', n: 2 },
];
const SENT = 'look at 리뷰 🎉 PR #12';

// needs 153: the window has no ':' command line; `nunchiro layout` takes the same words (as web-widgets.spec.ts places).
const place = (core: Core, name: string) => core.cli('layout', 'split', 'right', `widget:${name}`, '--zone', 'terminal');
const view = (page: Page, name: string) => page.locator(`[data-user-widget="${name}"]`);
const shot = async (page: Page, name: string, target?: ReturnType<Page['locator']>) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await (target ?? page).screenshot({ path: path.join(SHOTS, `${name}-${test.info().project.name}.png`) });
};

function widget(core: Core, name: string, rows: unknown) {
  const dir = path.join(core.home, 'widgets', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'widget.toml'),
    `version = 1\nkind = "script"\nauthor = "test"\ncommand = ["/bin/sh", "run.sh"]\ninterval = 10\npermissions = ["read", "act"]\n\n[act]\ntemplate = "${TEMPLATE}"\nsession = "target"\n`,
  );
  fs.writeFileSync(path.join(dir, 'run.sh'), '/bin/cat rows.json\n');
  fs.writeFileSync(path.join(dir, 'rows.json'), JSON.stringify(rows));
  return dir;
}
const allow = (core: Core, name: string, level: 'read' | 'act') =>
  core.run(['widget', 'allow', name, `--${level}`]);
async function enable(core: Core) {
  const file = path.join(core.home, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), script_widgets: true }));
  core.run(['serve', 'stop'], 10_000);
  await core.restart();
}
/** A Claude that records its raw PTY input (Shell sessions are not act targets), behind a ready prompt. */
const RECORDING_CLAUDE = `#!/usr/bin/env python3
import os, signal, sys, tty
if '--version' in sys.argv:
    print('2.1.310 (Claude Code)')
    sys.exit()
name = sys.argv[sys.argv.index('--record') + 1]
tty.setraw(0)
# Like a real agent, redraw the prompt when the window resizes the terminal (the core's screen model starts over).
signal.signal(signal.SIGWINCH, lambda *_: os.write(1, '\\r\\n\\u276f '.encode()))
os.write(1, '\\u276f '.encode())
out = open(name, 'wb')
while True:
    data = os.read(0, 4096)
    if not data:
        break
    out.write(data)
    out.flush()
`;
/** The target session and its file of received PTY bytes. */
function target(core: Core) {
  const project = core.project('act');
  fs.writeFileSync(path.join(core.home, 'bin/claude'), RECORDING_CLAUDE, { mode: 0o700 });
  const s = core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', 'target', '--', '--record', 'received.bin')
    .session as { id: string };
  const file = path.join(project, 'received.bin');
  return { s, received: () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') };
}
const sendLog = (core: Core, id: string) =>
  (core.cli('snapshot', '--json').sessions as { id: string; send_log: { sender: string; content: string }[] }[]).find((s) => s.id === id)!.send_log;
/** Every widget_act frame the window sends. */
function actFrames(app: Page) {
  const sent: string[] = [];
  app.on('websocket', (ws) => ws.on('framesent', (f) => typeof f.payload === 'string' && f.payload.includes('widget_act') && sent.push(f.payload)));
  return sent;
}
async function open(app: Page, core: Core, name: string) {
  await openWindow(app, core.boot(), core);
  place(core, name);
  await expect(view(app, name).locator('tbody tr')).toHaveCount(ROWS.length);
}

test('widget act: one click sends the rendered row once', async ({ app, core }) => {
  await enable(core);
  const t = target(core);
  widget(core, 'pick', ROWS);
  allow(core, 'pick', 'act');
  const frames = actFrames(app);
  await open(app, core, 'pick');
  const row = view(app, 'pick').locator('tbody tr').first();
  await expect(row).toHaveAttribute('tabindex', '0');
  await expect(view(app, 'pick').locator('.uw-act')).toHaveText('click a row to send it to session “target”');
  await shot(app, 'clickable-table', view(app, 'pick'));
  await row.dblclick();
  await expect.poll(t.received).toBe(SENT);
  await expect(view(app, 'pick').locator('.uw-act')).toContainText('sent to “target”');
  await app.waitForTimeout(1500);
  expect(t.received()).toBe(SENT);
  expect(sendLog(core, t.s.id)).toHaveLength(1);
  // The window names the row and the run, never the text.
  for (const f of frames) {
    const { request } = JSON.parse(f) as { request: Record<string, unknown> };
    expect(Object.keys(request).sort()).toEqual(['name', 'op', 'ran_at_ms', 'row', 'session']);
  }
  // Keyboard: Enter on a focused row is a click too.
  await view(app, 'pick').locator('tbody tr').nth(1).press('Enter');
  await expect.poll(t.received).toBe(SENT + 'look at second #2');
});

test('widget act: target shows the widget marker', async ({ app, core }) => {
  await enable(core);
  const t = target(core);
  widget(core, 'pick', ROWS);
  allow(core, 'pick', 'act');
  await open(app, core, 'pick');
  const head = app.locator('.shead').first();
  await expect(head).toContainText('target');
  const boxes = () =>
    app.evaluate(() =>
      ['.shead', '.shead .qlevel-btn', '.pane', '.tabs', '.cbox'].map((sel) => {
        const r = document.querySelector(sel)?.getBoundingClientRect();
        return r ? [r.x, r.y, r.width, r.height].map(Math.round).join(',') : '';
      }),
    );
  const before = await boxes();
  await view(app, 'pick').locator('tbody tr').first().click();
  await expect.poll(t.received).toBe(SENT);
  const marker = head.locator('[data-sent-by="widget:pick"]');
  await expect(marker).toHaveText(/^sent by widget pick · /);
  expect(sendLog(core, t.s.id).map((r) => r.sender)).toEqual(['widget:pick']);
  // One line at the header's right end: nothing else moves.
  expect(await boxes()).toEqual(before);
  await shot(app, 'target-marker');
});

test('widget act: rows are plain without the act grant and a click sends nothing', async ({ app, core }) => {
  await enable(core);
  const t = target(core);
  widget(core, 'pick', ROWS);
  allow(core, 'pick', 'read');
  const frames = actFrames(app);
  await open(app, core, 'pick');
  const row = view(app, 'pick').locator('tbody tr').first();
  await expect(row).not.toHaveAttribute('tabindex');
  await expect(view(app, 'pick').locator('.uw-act')).toHaveCount(0);
  await row.click();
  await app.waitForTimeout(800);
  expect(frames).toEqual([]);
  expect(t.received()).toBe('');
  expect(sendLog(core, t.s.id)).toEqual([]);
});

test('widget act: output changing over runs without a click sends no request', async ({ app, core }) => {
  await enable(core);
  const t = target(core);
  const dir = widget(core, 'pick', ROWS);
  allow(core, 'pick', 'act');
  const frames = actFrames(app);
  await open(app, core, 'pick');
  for (const i of [1, 2]) {
    // A new output is a changed widget: allowed again, the window runs it and renders the new rows.
    fs.writeFileSync(path.join(dir, 'rows.json'), JSON.stringify([{ title: `run ${i}`, n: i }]));
    allow(core, 'pick', 'act');
    await expect(view(app, 'pick').locator('tbody tr').first()).toContainText(`run ${i}`, { timeout: 15_000 });
  }
  await app.waitForTimeout(1500);
  expect(frames).toEqual([]);
  expect(t.received()).toBe('');
  expect(sendLog(core, t.s.id)).toEqual([]);
});

test('widget act: the permission sheet shows the [act] template and target', async ({ app, core }) => {
  await enable(core);
  target(core);
  widget(core, 'pick', ROWS);
  await openWindow(app, core.boot(), core);
  place(core, 'pick');
  const sheet = app.getByRole('dialog', { name: 'Allow “pick”?' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-field="act-template"]')).toHaveText(TEMPLATE);
  await expect(sheet.locator('[data-field="act-target"]')).toHaveText('session “target”');
  await sheet.getByRole('switch', { name: 'Allow act' }).click();
  await shot(app, 'permission-sheet-act');
  await sheet.getByRole('button', { name: 'Allow read and act' }).click();
  await expect(view(app, 'pick').locator('tbody tr').first()).toHaveAttribute('tabindex', '0');
});
