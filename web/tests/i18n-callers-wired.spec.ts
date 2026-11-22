// UI language, V2-14h (needs 93; coordinator): the slices moved window text into the catalogue and gave each surface a
// `t` prop, but a mount that never passes the window's `t` stays English after a language switch, and nothing fails
// because a missing `t` falls back to English. This spec is that check: every mount of a `t`-taking component carries
// `t=`, each surface shows an injected table's text at its narrowest seam, and a translation never drops a placeholder.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { Rollup } from 'vite';
import { buildQuiet } from './vite-build';
import fs from 'node:fs';
import path from 'node:path';
import { type Key } from '../src/i18n';
import { EN, makeT } from './i18n-tables';

const WEB = path.resolve(import.meta.dirname, '..');
const src = path.join(WEB, 'src');
const read = (f: string) => fs.readFileSync(path.join(src, f), 'utf8');
const files = (dir = src): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.tsx') ? [path.join(dir, e.name)] : []));

/** Every component whose props accept `t`, from the brief's grep (`\bt\??: *T\b`), hand-checked after 118/120/122. */
const TAKES_T = [
  'AccountsPage', 'AgentsPage', 'AlertsPage', 'AppearancePage', 'Board', 'CardEditor', 'CardView', 'ChatPanes', 'CleanupLine',
  'CloseNotice', 'ColumnEditor', 'ColumnView', 'ComposerMenu', 'DecisionCard', 'DecisionsWidget', 'HandoffChip',
  'HintPreview', 'HintsSection', 'ImportTheme', 'KeysPage', 'LanguagePage', 'LayoutPage', 'LibsPage', 'LibsPanel',
  'LifetimeSection', 'LivePrStatus', 'LivePrStatusView', 'Palette', 'PermChip', 'PermissionSheet', 'PrChip', 'PrChipView',
  'ProblemCard', 'ProjectDialogs', 'QuitDialog', 'RenameField', 'ResumeOffer', 'SessionFacts', 'SubViews', 'ThemeCard',
  'ThemeLicences', 'ThemePage', 'Tree', 'WorktreeLayer',
];

/** Mounts that legitimately carry no `t`, each with the reason (REPORT says who owns them). */
const EXEMPT: Record<string, string> = {
  // Ticket 121's lanes (Strict layer): their call sites are that lane's, not this one's.
  'src/queue/Strip.tsx:PermissionSheet': 'web/src/queue/ is the Strict layer',
  'src/widgets/UserWidget.tsx:PermissionSheet': 'web/src/widgets/ is the Strict layer',
  'src/layout/Library.tsx:PermissionSheet': 'web/src/widgets/ and approval/ are the Strict layer',
  // ArtifactFrame's callers name their artifact Target `t`; wiring them is a rename pass, listed in REPORT (gap for 121).
  'src/artifacts/Card.tsx:ArtifactFrame': "the caller's `t` is the artifact Target",
  'src/artifacts/Preview.tsx:ArtifactFrame': "the caller's `t` is the artifact Target",
  'src/files/FileView.tsx:ArtifactFrame': 'FileView builds no `t` (gap, REPORT)',
  // App.tsx has its own local `RenameField` (the tab's inline name field), which takes no `t`: a name collision, not a mount.
  'src/chrome/CentreView.tsx:RenameField': "App.tsx's local tab-name field, not tree/worktrees.tsx RenameField",
};

/** The opening tag of `<name …>`: JSX attributes nest braces, so depth-count to the `>` that closes the tag. */
function tags(text: string, name: string): { tag: string; line: number }[] {
  const out: { tag: string; line: number }[] = [];
  for (const m of text.matchAll(new RegExp(`<${name}\\b`, 'g'))) {
    let i = m.index! + m[0].length;
    let depth = 0;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    out.push({ tag: text.slice(m.index!, i + 1), line: text.slice(0, m.index!).split('\n').length });
  }
  return out;
}

test('callers_inventory: no mount of a `t`-taking component omits `t=`, but for the listed exemptions', () => {
  const missing: string[] = [];
  for (const file of files()) {
    const rel = path.relative(WEB, file);
    const text = fs.readFileSync(file, 'utf8');
    for (const name of TAKES_T) {
      for (const { tag, line } of tags(text, name)) {
        if (/\bt=\{/.test(tag)) continue;
        const key = `${rel}:${name}`;
        if (!EXEMPT[key]) missing.push(`${rel}:${line} <${name}>`);
      }
    }
  }
  expect(missing).toEqual([]);
  // The scan has teeth: a mount without `t=` is found, one with it is not.
  expect(tags('<Board core={c.core} />', 'Board')[0].tag).not.toMatch(/\bt=\{/);
  expect(tags('<Board core={c.core} t={c.t} />', 'Board')[0].tag).toMatch(/\bt=\{/);
});

test('windowctx_carries_t: the window context hands every widget the window\'s `t`', () => {
  // Source check on the one seam a page test cannot reach: App builds `t` from settings.language and offers no injection.
  const ctx = read('App.tsx').split('const windowCtx = (): WindowCtx => ({')[1]?.split('});')[0] ?? '';
  expect(ctx).toMatch(/^\s*t,\s*$/m);
  const windows = read('layout/windows.tsx');
  expect(windows, 'WindowCtx.t').toMatch(/interface WindowCtx \{[\s\S]*?\n  t: T;/);
  // Board is the one registry widget that takes `t`.
  expect(tags(windows, 'Board')[0].tag).toMatch(/\bt=\{c\.t\}/);
});

// ---- every surface that was missing `t`, mounted through its real caller with an injected table ---------------------

const HARNESS = '/__callers-f/';
test.beforeAll(async () => {
  // The surfaces import their CSS, which the spec runner cannot parse: build the harness and serve it under a path.
  const out = await buildQuiet({
    configFile: path.join(WEB, 'vite.config.ts'),
    root: WEB,
    base: HARNESS,
    logLevel: 'silent',
    build: { write: false, rollupOptions: { input: path.join(WEB, 'tests/i18n-callers-harness.html') } },
  });
  for (const o of (Array.isArray(out) ? out : [out as Rollup.RollupOutput]).flatMap((r) => ('output' in r ? r.output : []))) {
    const dest = path.join(WEB, 'dist', HARNESS, o.fileName);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(`${dest}.${process.pid}`, o.type === 'chunk' ? o.code : o.source);
    fs.renameSync(`${dest}.${process.pid}`, dest);
  }
});

/** The surface renders the table's text: as its text, or as an accessible name / tip / placeholder. */
const shown = async (app: Page, surface: string, marker: Key) => {
  await app.goto(`${HARNESS}tests/i18n-callers-harness.html?surface=${surface}`);
  await expect(app.locator('#root')).toBeVisible();
  await expect
    .poll(() => app.locator('#root').evaluate((el, want) => el.outerHTML.includes(want), `XX-${marker}`))
    .toBe(true);
};

test('surface_follows_language_tree: the Tree reads the window\'s `t` (its root name and empty state)', async ({ app }) => {
  await shown(app, 'tree', 'tree.root');
  await shown(app, 'tree', 'tree.empty');
});

test('surface_follows_language_board: the Board placed by the window registry reads `c.t`', async ({ app }) => {
  await shown(app, 'board', 'board.region');
  // V2.5-69 (ticket 289): the default watch view drops the Columns button; View options is its toolbar's own key.
  await shown(app, 'board_ctx', 'board.watch.options');
});

test('surface_follows_language_rename: the tab strip\'s inline rename follows the window\'s `t`', async ({ app }) => {
  await shown(app, 'rename', 'dialog.worktree.labelField');
});

test('surface_follows_language_groupdialog: the group dialog follows the window\'s `t`', async ({ app }) => {
  await shown(app, 'dialog', 'tree.group.newTitle');
});

test('surface_follows_language_worktree_dialog: the New worktree dialog follows the window\'s `t`', async ({ app }) => {
  await shown(app, 'worktree', 'dialog.worktree.title');
});

// V2-14c (tree) named its pairs `.one`/`.many`; every other slice names them `.one`/`.other`, and one catalogue speaks
// one dialect: the tree and dialog pairs are renamed, English text unchanged. (chat.decisions.many predates the
// convention and is chat's own key, left alone.)
test('tree_plurals_use_other: no `.many` key remains under tree. or dialog., and the helper picks `.one`/`.other`', async () => {
  expect(Object.keys(EN).filter((k) => /^(tree|dialog)\./.test(k) && k.endsWith('.many'))).toEqual([]);
  const { plural } = await import('../src/tree/state');
  const t = makeT('en', 'en');
  expect(plural(t, 'tree.projects', 1)).toBe('1 project');
  expect(plural(t, 'tree.projects', 2)).toBe('2 projects');
});

/** `{name}` placeholders a string carries. */
const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
/** What a translation breaks: a placeholder the English text has and the translation drops (or one it invents). */
const dropped = (key: Key, text: string) => {
  const want = holes(EN[key]);
  const got = holes(text);
  return want.length === got.length && want.every((h, i) => h === got[i]) ? null : `${key}: en ${JSON.stringify(want)} vs translation ${JSON.stringify(got)}`;
};

// A translation that drops `{name}` or `{hash}` would hide what the owner approves: these approval keys carry data.
const DATA_KEYS = ['approval.title', 'approval.hash', 'approval.logged', 'approval.askedBy', 'approval.libOpenWith', 'approval.libAllowedOther', 'approval.libNoLongerPinned', 'approval.commandEvery', 'decisions.more', 'decisions.lineLabel', 'decisions.alwaysTip'] as Key[];

test('translated_keys_keep_placeholders: every table keeps the English placeholders, and a dropped one is caught', () => {
  // The shipped tables hold English only, so the law is checked over every key against a table that keeps them.
  const keys = Object.keys(EN) as Key[];
  const keeping = Object.fromEntries(keys.map((k) => [k, `XX ${EN[k]}`])) as Record<Key, string>;
  expect(keys.map((k) => dropped(k, keeping[k])).filter(Boolean)).toEqual([]);

  // Teeth: a translation that drops a placeholder is reported, per key, with both sets.
  expect(dropped('tree.row.label', 'v1a-62, Merged. Branch kept')).toBe('tree.row.label: en ["name","tips"] vs translation []');
  for (const k of DATA_KEYS) expect(holes(EN[k]).length, `${k} carries data`).toBeGreaterThan(0);
  // The sheet's hash line is exactly the kind of key this guards: a translation that drops {hash} hides what is approved.
  expect(dropped('approval.hash', 'Hash')).toBe('approval.hash: en ["hash"] vs translation []');
});
