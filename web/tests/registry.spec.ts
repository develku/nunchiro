// Ticket v1b-28: the widget registry. These pins were recorded on main before the refactor (behavior identical):
// every existing kind keeps its title, minimum size, drawer card and window rendering.
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, test } from './fixtures';
import { isKind, MIN, TITLE, WIDGETS } from '../src/layout/model';
import { parse, tokenize } from '../src/layout/command';

const KINDS = ['tree', 'waiting', 'terminal', 'composer', 'diff', 'files', 'board', 'search', 'preview', 'artifacts', 'decisions', 'room', 'context'];
const USER = 'widget:demo';
const LIST = 'tree, waiting, terminal, composer, diff, files, board, search, preview, artifacts, decisions, room, context';

// Pre-refactor snapshot: kind -> [title, min w, min h].
const PINNED: Record<string, [string, number, number]> = {
  tree: ['Tree', 160, 120],
  waiting: ['Answer strip', 200, 40],
  terminal: ['Terminal', 240, 120],
  composer: ['Composer', 240, 56],
  diff: ['Diff', 240, 120],
  files: ['Files', 160, 120],
  board: ['Board', 240, 160],
  search: ['Search', 160, 120],
  preview: ['Preview', 220, 160],
  artifacts: ['Artifacts', 220, 160],
  decisions: ['Decisions', 240, 120],
  room: ['Room', 280, 160], // ticket 990
  context: ['Context', 200, 80], // ticket 1048
  [USER]: ['demo', 200, 80],
};

// Drawer cards with no sessions: [data-card, aria-label, preview markup].
const CARDS: [string, string, string][] = [
  ['tree', 'Tree widget: waiting slots', '<i class="bar"></i><i class="ln"></i><i class="ln"></i>'],
  ['waiting', 'Answer strip widget: answer here', '<span class="txt">appears when waiting</span>'],
  ['terminal', 'Terminal widget: follows or pinned', '<span class="txt mono">$ _</span>'],
  ['composer', 'Composer widget: hideable', '<span class="box"></span>'],
  ['diff', 'Diff widget: follows or pinned', '<span class="txt mono">±</span>'],
  ['files', 'Files widget: focused folder', '<span class="txt mono">▤ src/</span>'],
  ['board', 'Board widget: work board', '<span class="txt">▦ 0 cards</span>'],
  ['search', 'Search widget: focused folder', '<span class="txt mono">⌕ text</span>'],
  ['preview', 'Preview widget: follows or pinned', '<span class="txt">▶</span>'],
  ['artifacts', 'Artifacts widget: attachments · artifacts', '<span class="txt">◧ this session</span>'],
  ['decisions', 'Decisions widget: pending answers · risky allow', '<span class="txt">Nothing waiting</span>'],
  ['room', 'Room widget: the leader and its team', '<span class="txt">Room</span>'], // ticket 990
  ['context', 'Context widget: context window of the session', '<span class="txt">36% used</span>'], // ticket 1048
];

// The window's first rendered element per kind: tag.class.
const RENDERED: Record<string, string> = {
  tree: 'aside.dock l',
  waiting: 'section.strip',
  terminal: 'div.centre',
  composer: 'div.composer',
  diff: 'aside.dock zone diff',
  files: 'aside.files',
  board: 'section.board',
  search: 'aside.spanel',
  preview: 'div.preview',
  artifacts: 'aside.dock zone aw',
  decisions: 'div.dw',
  room: 'div.roompane',
  context: 'section.ctxw',
  [USER]: 'div.uw',
};

/** Every kind in its own zone: two columns of six. */
function everyWidget(): string {
  const all = [...KINDS.filter((k) => k !== 'tree'), USER]; // D5b: the tree is a sidebar widget, never a zone
  const col = (id: string, ks: string[]) =>
    `[[root.children]]\nid = "${id}"\nsplit = "column"\n\n` + ks.map((k) => `[[root.children.children]]\nid = "${k.replace(':', '-')}"\nwidgets = ["${k}"]\n`).join('\n');
  return `version = 1\nlocked = false\n\n[root]\nid = "main"\nsplit = "row"\n\n${col('a', all.slice(0, 6))}\n${col('b', all.slice(6))}`;
}

test('registry_pins_every_existing_widget', async ({ app, core }) => {
  // Model: kinds, order, titles and minimum sizes.
  expect([...WIDGETS]).toEqual(KINDS);
  for (const [k, [title, w, h]] of Object.entries(PINNED)) {
    expect(isKind(k), k).toBe(true);
    expect((TITLE as Record<string, string>)[k], k).toBe(title);
    expect((MIN as Record<string, unknown>)[k], k).toEqual({ w, h });
  }
  // chat and ask are not registered kinds: still refused with the same message.
  for (const k of ['chat', 'ask']) {
    expect(isKind(k)).toBe(false);
    expect(() => parse(tokenize(`split right ${k}`))).toThrow(`unknown widget "${k}"; widgets: ${LIST}`);
  }

  // Window: each kind renders the same element.
  fs.writeFileSync(path.join(core.home, 'layout.toml'), everyWidget());
  await openWindow(app);
  await expect(app.locator('.wg')).toHaveCount(KINDS.length); // every kind but the tree, plus the user widget
  // The tree renders the same element, in the left sidebar.
  expect(await app.locator('.sbar.l .sbb').evaluate((e) => `${e.firstElementChild!.tagName.toLowerCase()}.${e.firstElementChild!.className}`)).toBe(RENDERED.tree);
  const rendered = await app.$$eval('.wg', (els) =>
    Object.fromEntries(els.map((e) => [(e as HTMLElement).dataset.widget!, e.firstElementChild ? `${e.firstElementChild.tagName.toLowerCase()}.${e.firstElementChild.className}` : '']))
  );
  const { tree: _tree, ...zoned } = RENDERED;
  expect(rendered).toEqual(zoned);

  // Library: one card per kind, in the registry's order (the user widget's card needs its folder, the lane A specs cover it).
  await app.locator('nav[data-bar="right"] .lay').click();
  const cards = await app.$$eval('.lib .lcard', (els) => els.map((e) => (e as HTMLElement).dataset.card!));
  expect(cards).toEqual(CARDS.map(([k]) => k));
});

/** The core's one list (crates/nunchiro-core/src/http/widget_kinds.rs `WIDGET_KINDS`), read from its source. */
function rustKinds(): string[] {
  const src = fs.readFileSync(path.join(REPO, 'crates/nunchiro-core/src/http/widget_kinds.rs'), 'utf8');
  const list = src.match(/pub const WIDGET_KINDS: &\[&str\] = &\[([^\]]*)\]/)![1];
  return [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test('web_registry_and_rust_list_name_the_same_kinds', () => {
  expect([...WIDGETS]).toEqual(rustKinds());
});

test('adding_one_entry_adds_a_widget', async () => {
  // A fresh module graph (Vite SSR): add one test-only entry to the
  // registry before anything reads it, and nothing else changes. Closing the server drops it.
  const { createServer } = await import('vite');
  const vite = await createServer({ root: path.join(REPO, 'web'), configFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false } });
  try {
    const registry = await vite.ssrLoadModule('/src/layout/registry.tsx');
    registry.ENTRIES.push({ kind: 'fake', title: 'Fake', min: { w: 210, h: 90 }, note: 'test only', preview: () => 'F' });
    const model = await vite.ssrLoadModule('/src/layout/model.ts');
    const command = await vite.ssrLoadModule('/src/layout/command.ts');

    expect(model.WIDGETS).toEqual([...KINDS, 'fake']);
    expect(model.isKind('fake')).toBe(true);
    expect([model.TITLE.fake, model.MIN.fake]).toEqual(['Fake', { w: 210, h: 90 }]);
    const l = model.apply(model.defaultLayout(), command.parse(command.tokenize('split right fake --zone terminal')));
    expect(model.leaves(l.root).map((z: { widgets: string[] }) => z.widgets.join())).toContain('fake');
    expect(() => command.parse(command.tokenize('split right chat'))).toThrow(`widgets: ${LIST}, fake`);

    // The library lists every registry entry, so the new one is a card (it reads ENTRIES).
    expect(registry.ENTRIES.map((e: { kind: string }) => e.kind)).toEqual([...KINDS, 'fake']);

    // The drift check sees it: the web side now names a kind the core does not.
    expect(model.WIDGETS).not.toEqual(rustKinds());
  } finally {
    await vite.close();
  }
});
