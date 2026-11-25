// Ticket 1070: the Agents widget is retired. Pure functions, no page: the library no longer offers it, and a stored
// arrangement, nest, split or preset that still names it loads without it and keeps every other widget in place.
import fs from 'node:fs';
import path from 'node:path';
import { expect, legacyLayout, openWindow, test } from './fixtures';
import { cardOf, openBoard } from './fixtures/board/coord';
import { cleanBars, DEFAULT_BARS } from '../src/layout/bars';
import { cleanPresets } from '../src/layout/presets';
import { isKind, withoutRetired, WIDGETS, type Leaf, type Node, type Split } from '../src/layout/model';

const stored = (extra: Record<string, unknown>) => ({ ...JSON.parse(JSON.stringify(DEFAULT_BARS)), ...extra });

test('the library offers no Agents widget', () => {
  expect(WIDGETS).not.toContain('agents');
  expect(isKind('agents')).toBe(false);
});

test('a bar that names agents loads with the other icons in place', () => {
  const left = [...DEFAULT_BARS.left];
  left[3] = 'agents';
  const bars = cleanBars(stored({ left, active: { left: 'agents', right: null } }))!;
  expect(bars).not.toBeNull();
  expect(bars.left).not.toContain('agents');
  expect(bars.left.filter((w) => w === 'tree' || w === 'files' || w === 'search' || w === 'settings')).toHaveLength(4);
  expect(bars.active.left).toBeNull();
});

test('a nest that names agents keeps the other sub-views and drops an emptied project', () => {
  const nest = { '/a': ['agents', 'board'], '/b': ['agents'], '/c': ['files'] };
  const bars = cleanBars(stored({ nest, open: { '/a::agents': true, '/a::board': true, '/b::agents': true } }))!;
  expect(bars.nest).toEqual({ '/a': ['board'], '/c': ['files'] });
  expect(bars.open).toEqual({ '/a::board': true });
});

const leaf = (id: string, ...widgets: string[]): Leaf => ({ id, widgets });
const split = (id: string, ...children: Node[]): Split => ({ id, split: 'row', children });

test('a split that names agents loses the zone, and a split left with one child becomes it', () => {
  const root = split('main', leaf('left', 'agents'), split('centre', leaf('a', 'terminal'), leaf('b', 'agents', 'waiting')));
  expect(withoutRetired(root)).toEqual(split('centre', leaf('a', 'terminal'), { id: 'b', widgets: ['waiting'] }));
  expect(withoutRetired(leaf('only', 'agents'))).toBeNull();
  const kept = split('main', leaf('a', 'terminal'), leaf('b', 'files'));
  expect(withoutRetired(kept)).toBe(kept);
});

test('a saved preset that names agents loads without it', () => {
  const root = split('main', leaf('left', 'agents'), leaf('centre', 'terminal'));
  const got = cleanPresets([{ name: 'mine', root, bars: stored({}) }], cleanBars)!;
  expect(got).toHaveLength(1);
  expect(got[0].root).toEqual(leaf('centre', 'terminal'));
});

// The same file the core keeps: layout.toml of before ticket 1070 names the widget; the window drops that zone and keeps the rest.
test('a layout.toml that names the Agents widget loads without an error and keeps the other zones', async ({ app, core }) => {
  legacyLayout(core, { retired: true });
  core.shell(core.project('demo'), 'one');
  await openWindow(app);
  await expect(app.locator('.status .lerr')).toHaveCount(0);
  await expect(app.locator('[data-zone-id="agents"]')).toHaveCount(0);
  for (const id of ['tree', 'terminal', 'waiting', 'composer']) await expect(app.locator(`[data-zone-id="${id}"]`)).toHaveCount(1);
});

// Ticket 1070: the account was the one fact only the widget showed; the Board's session card shows it now.
test('the Board session card shows the account of its session', async ({ app, core }) => {
  const ID = 'aaaaaaaa-0000-4000-8000-000000001070';
  const fake = '#!/bin/sh\ncase "$1" in --version) echo "2.1.312 (Claude Code)"; exit 0;; esac\n[ "$1 $2" = "auth status" ] && { echo \'{"loggedIn": true}\'; exit 0; }\nexec /bin/cat\n';
  fs.writeFileSync(path.join(core.home, 'bin', 'claude'), fake, { mode: 0o700 });
  fs.mkdirSync(path.join(core.home, 'accounts/claude', ID), { recursive: true });
  fs.writeFileSync(path.join(core.home, 'accounts.toml'), `version = 1\n\n[[accounts]]\nagent = "claude"\nid = "${ID}"\nlabel = "Work"\n`);
  core.cli('session', 'start', '--kind', 'claude', '--project', core.project('demo'), '--label', 'with-account', '--account', 'Work');
  await openBoard(app, core);
  await expect(cardOf(app, 'with-account').locator('[data-account]')).toHaveText('Work');
});
