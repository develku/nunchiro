// Ticket v1b-23: the few web-widgets.spec.ts helpers the review spec needs (a spec file cannot import another spec
// without registering its tests twice). Same behavior as there: a real core per test, the app's scheme stood in for by
// ../host.ts, a recording Claude as the act target.
import fs from 'node:fs';
import path from 'node:path';
import type { Frame, Page } from '@playwright/test';
import { expect, openWindow, type Core } from '../../../fixtures';

export const BRIDGE = fs.readFileSync(path.join(import.meta.dirname, '../bridge.html'), 'utf8');

export function webWidget(core: Core, name: string, html: string, network: string[] = []) {
  const dir = path.join(core.home, 'widgets', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'widget.toml'),
    `version = 1\nkind = "web"\nauthor = "test"\nentry = "index.html"\npermissions = ["read", "act"]\nnetwork = ${JSON.stringify(network)}\n`,
  );
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  return dir;
}
export const allow = (core: Core, name: string, level: 'read' | 'act') => core.run(['widget', 'allow', name, `--${level}`]);
export async function enable(core: Core) {
  const file = path.join(core.home, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), web_widgets: true }));
  core.run(['serve', 'stop'], 10_000);
  await core.restart();
}
const RECORDING_CLAUDE = `#!/usr/bin/env python3
import os, signal, sys, tty
if '--version' in sys.argv:
    print('2.1.310 (Claude Code)')
    sys.exit()
name = sys.argv[sys.argv.index('--record') + 1]
tty.setraw(0)
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
export function target(core: Core, label = 'target') {
  const project = core.project('act');
  fs.writeFileSync(path.join(core.home, 'bin/claude'), RECORDING_CLAUDE, { mode: 0o700 });
  const s = core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', label, '--', '--record', 'received.bin').session as { id: string };
  const file = path.join(project, 'received.bin');
  return { s, received: () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') };
}
export const sendLog = (core: Core, id: string) =>
  (core.cli('snapshot', '--json').sessions as { id: string; send_log: { sender: string; content: string }[] }[]).find((s) => s.id === id)!.send_log;

export const view = (page: Page, name: string) => page.locator(`[data-user-widget="${name}"]`);
export const confirmLine = (page: Page, name: string) => view(page, name).locator('.ww-confirm');
export async function open(page: Page, core: Core, ...names: string[]) {
  await openWindow(page, core.boot(), core);
  // needs 153: the window has no ':' command line; `nunchiro layout` takes the same words (as web-widgets.spec.ts places).
  for (const name of names) core.cli('layout', 'split', 'right', `widget:${name}`, '--zone', 'terminal');
}
/** The frame whose URL matches `part`, once its page has defined `call` (the bridge client in bridge.html). */
export async function frameAt(app: Page, part: string): Promise<Frame> {
  await expect.poll(() => app.frames().some((f) => f.url().includes(part))).toBe(true);
  const f = app.frames().find((f) => f.url().includes(part))!;
  await expect.poll(() => f.evaluate(() => typeof (window as unknown as { call?: unknown }).call)).toBe('function');
  return f;
}
export const replies = (f: Frame) => f.evaluate(() => (window as unknown as { replies: () => { id: number; ok?: unknown; error?: string }[] }).replies());
export const call = (f: Frame, method: string, params?: unknown) =>
  f.evaluate(([m, p]) => (window as unknown as { call: (m: string, p: unknown) => number }).call(m as string, p), [method, params] as const);
export const replyTo = async (f: Frame, id: number) => {
  await expect.poll(async () => (await replies(f)).some((r) => r.id === id)).toBe(true);
  return (await replies(f)).find((r) => r.id === id)!;
};
