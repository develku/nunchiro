// Ticket 1013 F6 (닫힌 세션의 탭이 남음): a session a command closes (`nunchiro session close`, a script, the lead) loses its
// tab at once; one the owner closes in the window keeps its done tab. Shots go to .scratch/shots (SHOT_TAG: before, after).
import path from 'node:path';
import { expect, openWindow, REPO, test } from './fixtures';
import { commandClosed } from '../src/chrome/closedTabs';
import type { Session } from '../src/types';

const SHOTS = path.join(REPO, '.scratch/shots');
const tag = process.env.SHOT_TAG ?? 'after';
const shot = (name: string) => path.join(SHOTS, `1013-${name}-${tag}-${test.info().project.name}.png`);

test('command_closed_tab_goes_1013: session close on the CLI drops the tab; the window Close keeps a done tab', async ({ app, core }) => {
  const dir = core.project('close1013');
  const byCommand = core.shell(dir, 'by-command');
  const byWindow = core.shell(dir, 'by-window');
  await openWindow(app, {}, core);
  const tab = (id: string) => app.locator(`.tab[data-tab="${id}"]`);
  await expect(tab(byCommand.id)).toBeVisible();
  await expect(tab(byWindow.id)).toBeVisible();
  core.cli('session', 'close', byCommand.id);
  core.windowClose(byWindow.id);
  await expect(tab(byWindow.id).locator('.tdot')).toHaveAttribute('data-s', 'done');
  await expect(tab(byCommand.id)).toHaveCount(0);
  await app.locator('.tabs').screenshot({ path: shot('tabs') });
  // Opened again from the tree (a finished session sits in its project's finished popover), the command-closed
  // session keeps its tab (it went once).
  await app.locator('.grp[data-project="close1013"] > .row.head button.dbar').click();
  await app.locator(`[data-done-pop] [data-done-item="${byCommand.id}"]`).click();
  await expect(tab(byCommand.id)).toBeVisible();
  await app.waitForTimeout(500); // a few snapshots
  await expect(tab(byCommand.id)).toBeVisible();
});

test('command_closed_set_prunes_1013: an id a later snapshot no longer lists leaves the set', () => {
  const row = (id: string, closed = true) => ({ id, state: closed ? 'closed' : 'running', closed_by_command: closed }) as Session;
  const dropped = new Set<string>();
  expect([...commandClosed(dropped, [row('a'), row('b'), row('c', false)])]).toEqual(['a', 'b']);
  expect([...commandClosed(dropped, [row('a'), row('b')])]).toEqual([]); // once only
  commandClosed(dropped, []); // a core restarting: kept
  expect([...dropped]).toEqual(['a', 'b']);
  commandClosed(dropped, [row('b'), row('c', false)]);
  expect([...dropped]).toEqual(['b']);
});
