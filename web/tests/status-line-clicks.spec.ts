// system5 (ticket 196, needs 171, 172 "Count or badge: click opens the list it counts"): the status line's stale count answers a
// click, and a truncated session name gives its full text on hover.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';

const tab = (page: Page, id: string) => page.locator(`.tab[data-tab="${id}"]`);

/** The snapshot as the core sends it, with the sessions labelled in `labels` stale (running, quiet for ten minutes). */
const stale = (page: Page, labels: string[]) =>
  page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((raw) => {
      if (typeof raw !== 'string' || JSON.parse(raw).event !== 'snapshot') return ws.send(raw);
      const msg = JSON.parse(raw);
      for (const s of msg.sessions ?? []) if (labels.includes(s.label)) Object.assign(s.attention, { working: false, stale: true, failed: false, waiting: false, last_activity: Date.now() - 600_000 });
      ws.send(JSON.stringify(msg));
    });
  });

test('stale_count_click_opens_the_list: "stale N" is a button; a click jumps to the first stale session, the next click to the next one', async ({ app, core }) => {
  const p = core.project('demo');
  const [one, two, three] = [core.shell(p, 'one'), core.shell(p, 'two'), core.shell(p, 'three')];
  await stale(app, ['two', 'three']);
  await openWindow(app, {}, core);
  await tab(app, one.id).click();
  await expect(tab(app, one.id)).toHaveAttribute('aria-selected', 'true');
  const count = app.locator('footer.status').getByRole('button', { name: /stale 2/ });
  await expect(count).toBeVisible();
  const selected = () => app.locator('.tab[aria-selected="true"]').getAttribute('data-tab');
  await count.click();
  const first = await selected();
  expect([two.id, three.id]).toContain(first); // never the quiet session that is not stale
  await count.click(); // the other stale one
  const second = await selected();
  expect([two.id, three.id].filter((id) => id !== first)).toEqual([second]);
  await count.click(); // wraps to the first
  expect(await selected()).toBe(first);
  // A keyboard path: it is a button.
  await tab(app, one.id).click();
  await count.focus();
  await app.keyboard.press('Enter');
  expect(await selected()).toBe(first);
});

const repo = (core: Core, name: string) => {
  const p = core.project(name);
  const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(p, 'a.txt'), 'one\nold\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'init');
  return p;
};

// Ticket 1031 (mockup bot-statusbar-1121, row "+128 −24"): the status line's +a −b button left the bar; the number is in
// the session header and the screen's one Diff control (the right bar's icon in the default window) opens Diff.
test('status_diff_counts_open_diff: the +a −b is in the session header, not the status line, and the Diff control opens Diff, by click and by key', async ({ app, core }) => {
  const p = repo(core, 'changing');
  const s = core.shell(p, 'changing');
  fs.writeFileSync(path.join(p, 'a.txt'), 'one\ntwo\nthree\n');
  await openWindow(app, {}, core);
  await tab(app, s.id).click();
  const counts = app.locator('.shead .hstat');
  await expect(counts).toHaveText(/\+2\s*−1/);
  await expect(app.locator('footer.status')).not.toContainText('+2');
  const diff = app.getByRole('complementary', { name: 'Diff' });
  await expect(diff).toHaveCount(0);
  const open = app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Diff', exact: true });
  await open.click();
  await expect(diff).toBeVisible();
  await open.click();
  await expect(diff).toHaveCount(0);
  // The keyboard path.
  await open.focus();
  await app.keyboard.press('Enter');
  await expect(diff).toBeVisible();
});

test('session_header_name_full_on_hover: a session name cut off in the header shows in full through the app tooltip', async ({ app, core }) => {
  const name = 'nightly-backtest-runner-for-the-lumen-research-cluster-with-a-very-long-name';
  const s = core.shell(core.project('demo'), name);
  await app.setViewportSize({ width: 700, height: 800 });
  await openWindow(app, {}, core);
  await tab(app, s.id).click();
  const head = app.locator('.shead > b');
  await expect(head).toHaveText(name);
  expect(await head.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true); // it really is cut off here
  await head.hover();
  await expect(app.getByRole('tooltip')).toHaveText(name);
});
