// Theme ops answered by the test (V1A-47, V1A-62): `theme_index` and `theme_file` frames never reach the real core, so
// no test touches GitHub; every other frame goes to the real core. `hold` keeps file answers back until `release`, so a
// test can count what the window has in flight.
import type { Page } from '@playwright/test';
import { expect } from './fixtures';

export const PIN = 'https://raw.githubusercontent.com/mbadolato/iTerm2-Color-Schemes/04a98db045eb5d71c2247ca6c050ab97290d081c/';
export const PALETTE = ['#2e3436', '#ff5577', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf', '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'];
export const colors = (background: string, foreground: string) => ({ background, foreground, cursor: foreground, cursorText: background, selectionBackground: foreground, selectionForeground: background, palette: PALETTE });
export type Colors = ReturnType<typeof colors>;
export type Entry = { name: string; license: string; source: string };
export type Op = { op: 'theme_index' } | { op: 'theme_file'; name: string };

export async function harness(app: Page, index: Entry[], files: (name: string) => Colors) {
  const h = {
    ops: [] as Op[],
    files: () => h.ops.filter((o): o is Extract<Op, { op: 'theme_file' }> => o.op === 'theme_file').map((o) => o.name),
    down: false,
    hold: false,
    held: [] as (() => void)[],
    open: 0,
    maxOpen: 0,
    release() {
      for (const answer of h.held.splice(0)) answer();
    },
  };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const frame = typeof m === 'string' ? JSON.parse(m) : null;
      const op = frame?.request?.op;
      if (op !== 'theme_index' && op !== 'theme_file') return server.send(m);
      h.ops.push(frame.request);
      const r = frame.request as Op;
      if (r.op === 'theme_index') {
        const response = h.down ? { Err: 'the request failed (curl exit 7)' } : { Ok: { type: 'theme_index', themes: index } };
        return ws.send(JSON.stringify({ id: frame.id, response }));
      }
      h.open++;
      h.maxOpen = Math.max(h.maxOpen, h.open);
      const answer = () => {
        h.open--;
        const e = index.find((x) => x.name === r.name)!;
        const response = h.down ? { Err: 'the request failed (curl exit 7)' } : { Ok: { type: 'theme', theme: { name: r.name, license: e.license, source: `${PIN}ghostty/${encodeURIComponent(r.name)}`, colors: files(r.name) } } };
        ws.send(JSON.stringify({ id: frame.id, response }));
      };
      if (h.hold) h.held.push(answer);
      else answer();
    });
  });
  return h;
}

export const token = (app: Page, name: string) => app.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
export const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
export const stored = (app: Page) => app.evaluate(() => localStorage.getItem('nunchiro.settings.v1'));

/** Ticket 162: the page shows two light and two dark themes first; `all` (the default here) opens Show all. */
export async function openTheme(app: Page, all = true) {
  // The visible control, not the chord: a chord pressed right after a reload can be dropped (ticket 106).
  const gear = app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }); // v25 placement: bottom-left
  await expect(gear).toBeVisible();
  // v25f: Settings is a modal that a reload keeps open; the gear behind it opens it only when it is closed.
  if (!(await app.getByRole('dialog', { name: 'Settings' }).isVisible())) await gear.click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click();
  await expect(card(app, 'Catppuccin Latte')).toBeVisible();
  if (all) await app.getByRole('button', { name: 'Show all', exact: true }).click();
}
export const grid = (app: Page) => app.getByRole('list', { name: 'Themes' });
export const cards = (app: Page) => grid(app).getByRole('listitem');
export const card = (app: Page, name: string) => grid(app).getByRole('listitem', { name, exact: true });
/** A card's menu item: opens the card's Options menu first. */
export async function menu(app: Page, name: string, item: string) {
  await card(app, name).getByRole('button', { name: 'Options' }).click();
  await card(app, name).getByRole('button', { name: item, exact: true }).click();
}
export const search = (app: Page, q: string) => app.getByRole('searchbox', { name: 'Search themes' }).fill(q);
