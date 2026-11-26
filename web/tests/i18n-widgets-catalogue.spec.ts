// V2-14f (needs 93, ticket 121): the widget frame, the approval prompts (permission sheet, library cards) and the Decisions
// widget take their window text from the catalogue. A key must never change what the owner is asked to approve, so the
// old text is pinned three ways: the table below (old literal -> key, checked against the base commit's source), the
// rendered text of every approval state, and the placeholders (library, version, host, hash come from data).
import fs from 'node:fs';
import path from 'node:path';
import type { Rollup } from 'vite';
import { buildQuiet } from './vite-build';
import type { Page } from '@playwright/test';
import { REPO, expect, test, type Core } from './fixtures';
import { EN, makeT } from './i18n-tables';
import { harnessServer } from './sandbox-server';
import { libServer } from './fixtures/libs/server';

const WEB = path.resolve(import.meta.dirname, '..');
// The source this slice started from (commit 193ac455, which a fresh public clone does not hold), kept verbatim per file.
const BASE: Record<string, string> = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/i18n-widgets-base.json'), 'utf8'));
const PREFIXES = ['widget.', 'approval.', 'decisions.'];
const FILE = {
  P: 'src/approval/PermissionSheet.tsx',
  A: 'src/sandbox/ArtifactFrame.tsx',
  L: 'src/sandbox/LibCards.tsx',
  W: 'src/decisions/DecisionsWidget.tsx',
  D: 'src/tree/DecisionLine.tsx',
  C: 'src/chat/DecisionCard.tsx',
} as const;
type F = keyof typeof FILE;

/** key, English text, file, and a piece of the base source that held it (the whole text when it was one literal). */
const ROWS: [string, string, F, string?][] = [
  // PermissionSheet
  ['approval.title', 'Allow “{name}”?', 'P', 'Allow “{name}”?'],
  ['approval.kindSource', 'Integration source', 'P', "'Integration source'"],
  ['approval.kindWidget', 'Custom widget', 'P', "'Custom widget'"],
  ['approval.madeBy', 'made by', 'P', "' · made by '"],
  ['approval.hash', 'hash {hash}', 'P', 'hash {view.hash.slice(0, 12)}'],
  ['approval.asked', 'asked once, and again after any change', 'P'],
  ['approval.changed', 'Changed since you allowed it. Review it again.', 'P'],
  ['approval.pageToShow', 'Page to show', 'P', "'Page to show'"],
  ['approval.commandEvery', 'Command to run (exactly this, every {secs} s)', 'P', 'Command to run (exactly this${'],
  ['approval.commandNoRepeat', 'Command to run (exactly this, no repeat)', 'P', "', no repeat'"],
  ['approval.spawnBefore', 'Commands whose runtime spawns children with', 'P'],
  ['approval.spawnAfter', 'fail closed.', 'P'],
  ['approval.runLimits', 'A run stops after 5 seconds. A run can start at most 64 processes. Memory has no limit of its own; these two limits are the only ones.', 'P', 'Each run stops after 5 s and may start at most 64 processes'],
  ['approval.read', 'Read', 'P', '">Read</span>'],
  ['approval.act', 'Act', 'P', '">Act</span>'],
  ['approval.never', 'Never', 'P', '">Never</span>'],
  ['approval.network', 'Network', 'P', '">Network</span>'],
  ['approval.files', 'Files', 'P', 'Files\n                  </span>'],
  ['approval.showPage', 'Show its page', 'P', "'Show its page'"],
  ['approval.showOutput', 'Show the command’s output (text or JSON) as a table', 'P'],
  ['approval.readProjects', 'Project names and the session list with states', 'P'],
  ['approval.tagDefaultOn', 'default · on', 'P'],
  ['approval.actSend', 'Send text you set to a session, or start a session', 'P'],
  ['approval.actNotRequested', 'Not requested by this widget', 'P'],
  ['approval.actClick', 'When you click a row, sends to', 'P'],
  ['approval.logged', 'Logged as “widget {name}”', 'P', 'Logged as “widget {name}”'],
  ['approval.allowAct', 'Allow act', 'P', 'aria-label="Allow act"'],
  ['approval.on', 'on', 'P', "{act ? 'on' : 'off'}"],
  ['approval.off', 'off', 'P', "{act ? 'on' : 'off'}"],
  ['approval.neverAnswer', 'Answer pending decisions', 'P'],
  ['approval.neverChange', 'Change settings · touch agent config', 'P'],
  ['approval.tagAlways', 'always', 'P', '">always</span>'],
  ['approval.netHosts', 'Hosts it may reach:', 'P'],
  ['approval.netBlocked', 'all other hosts blocked', 'P'],
  ['approval.netNone', 'No network · all hosts blocked', 'P', "'No network · all hosts blocked'"],
  ['approval.tagAllowed', 'allowed', 'P', "'allowed'"],
  ['approval.tagNone', 'none', 'P', "'none'"],
  ['approval.filesDefault', 'Its project folder, its cache, system tools, ~/.cargo/bin and ~/.local/bin', 'P'],
  ['approval.andAlso', 'and also:', 'P', "', and also:'"],
  ['approval.nothingElse', 'nothing else in your home', 'P', "' · nothing else in your home'"],
  ['approval.homeWide', 'Reads your whole home folder: documents, other projects and app data. Agent config and keys stay blocked.', 'P'],
  ['approval.tagDeclared', 'declared', 'P', "'declared'"],
  ['approval.tagDefault', 'default', 'P', "'default'"],
  ['approval.manifestFile', 'widget.toml', 'P', 'aria-label="widget.toml"'],
  ['approval.hideToml', 'Hide widget.toml', 'P', "'Hide widget.toml'"],
  ['approval.viewToml', 'View widget.toml', 'P', "'View widget.toml'"],
  ['approval.cancel', 'Cancel', 'P', 'Cancel\n          </button>'],
  ['approval.allowRead', 'Allow read only', 'P', "'Allow read only'"],
  ['approval.allowReadAct', 'Allow read and act', 'P', "'Allow read and act'"],
  // ArtifactFrame
  ['widget.libsToAllowOne', '{n} library to allow', 'A', "'library' : 'libraries'} to allow"],
  ['widget.libsToAllowMany', '{n} libraries to allow', 'A', "'library' : 'libraries'} to allow"],
  ['widget.libs', 'Libraries', 'A', ": 'Libraries'}"],
  ['widget.alwaysAllow', 'Always allow in this project', 'A'],
  ['widget.netRefused', 'The app refused the network grant', 'A'],
  ['widget.netOnTip', 'Remote images, other hosts, fetch and WebSocket are allowed until this artifact changes', 'A'],
  ['widget.netOffTip', 'Allow remote images, other hosts, fetch and WebSocket for this artifact until it changes', 'A'],
  ['widget.netOn', 'Network on', 'A', "'Network on'"],
  ['widget.netOff', 'Network off', 'A', "'Network off'"],
  // LibCards
  ['approval.libRegion', 'Libraries', 'L', 'aria-label="Libraries"'],
  ['approval.libAllowedOther', '; you allowed {version}', 'L', '`; you allowed ${others[0]}`'],
  ['approval.libListed', '{source} lists this version', 'L', "'cdnjs lists this version'"],
  ['approval.libUnverified', 'Unverified', 'L', "'Unverified'"],
  ['approval.askedBy', 'Asked by {requester}', 'L', '`Asked by ${requester}`'],
  ['approval.askedByNone', 'Asked by a page not opened from a session', 'L'],
  ['approval.libAuto', 'Auto-allowed: fetching it now.', 'L'],
  ['approval.libAllowing', 'Allowing…', 'L'],
  ['approval.libAllow', 'Allow', 'L', ": 'Allow'}"],
  ['approval.libDeny', "Don't allow", 'L'],
  ['approval.libOpenWith', 'Open with {version}', 'L', 'Open with {ver}'],
  ['approval.libMoreOne', '1 more library', 'L', "'1 more library'"],
  ['approval.libMoreMany', '{n} more libraries', 'L', '`${more} more libraries`'],
  ['approval.libNoLongerPinned', '{library} {version} is no longer on the list of fixed versions.', 'L', 'is no longer pinned.'],
  ['approval.libReloaded', 'The page reloaded. Choose "Open with" again.', 'L'],
  ['approval.libOpenedWith', 'Opened with {version} for this view only.', 'L', 'for this view only.'],
  // DecisionsWidget
  ['decisions.none', 'Nothing waiting', 'W'],
  ['decisions.waiting', '{count} waiting', 'W', '{count} waiting'],
  // DecisionLine
  ['decisions.waiting', '{count} waiting', 'D', '${count} waiting'],
  ['decisions.answeredWho', 'answered: {who}', 'D', '`answered: ${who}`'],
  ['decisions.lineLabel', '{who}: {kind}. {detail}', 'D', '${who}: ${kindWord[first.kind]}.'],
  ['decisions.caution', 'Caution', 'D', '>Caution</b>'],
  ['decisions.changed', '↻ Changed. It updates when you move away.', 'D', '↻ changed · updates when you move away'],
  ['decisions.answered', '✓ answered', 'D'],
  ['decisions.more', '{what} +{more}', 'D', '${what} +${count - 1}'],
  ['decisions.allowTip', 'Allow (1)', 'D'],
  ['decisions.detailsTip', 'Details (2)', 'D'],
  ['decisions.denyTip', 'Deny (3)', 'D'],
  ['decisions.peekTip', 'Peek (Space)', 'D'],
  ['decisions.choose', 'choose', 'D', 'choose <Icon'],
  ['decisions.denyNotePh', 'Tell it what to do instead', 'D', 'placeholder="Tell it what to do instead'], // ticket 559 dropped " (optional)": the prefix still matches the base file
  ['decisions.denyNoteLabel', 'Instruction sent with the deny (optional)', 'D'],
  ['decisions.send', 'Send', 'D', 'Send\n      </button>'],
  ['decisions.justDeny', 'Just deny', 'D'],
  ['decisions.peekLabel', 'Peek: {what}', 'D', '`Peek: ${what}`'],
  ['decisions.openInPanel', 'Open in panel', 'D'],
  // DecisionCard
  ['decisions.waiting', '{count} waiting', 'C', '${items.length} waiting'],
  ['decisions.cardOne', '{name}: decision', 'C', "'decision'"],
  ['decisions.cardMany', '{name}: {count} decisions', 'C', '`${items.length} decisions`'],
  ['decisions.back', '← Back to {name} ({key})', 'C', '← Back to {from.name} (⌘[)'],
  ['decisions.kindQuestion', 'question', 'C', "? 'question' : isRisky"],
  ['decisions.kindRisky', 'risky permission', 'C', "'risky permission'"],
  ['decisions.kindPermission', 'permission', 'C', ": 'permission')"],
  ['decisions.oneAtATime', 'One at a time: there is no "allow all".', 'C'],
  ['decisions.what', 'What', 'C', '<b>What</b>'],
  ['decisions.why', 'Why', 'C', '<b>Why</b>'],
  ['decisions.fullRequest', 'Full request', 'C', 'aria-label="Full request"'],
  ['decisions.caution', 'Caution', 'C', '>Caution</b>'],
  ['decisions.allow', 'Allow', 'C', 'Allow\n            </button>'],
  ['decisions.deny', 'Deny', 'C', ": 'Deny'}"],
  ['decisions.cancel', 'Cancel', 'C', "'Cancel' :"],
  ['decisions.allowTip', 'Allow (1)', 'C', 'Allow (1)'],
  ['decisions.denyTip', 'Deny (3)', 'C', 'Deny (3)'],
  ['decisions.riskyAllowTip', 'Allow: focus this button, then press Enter', 'C'],
  ['decisions.riskyAllow', 'Allow (press Enter)', 'C', 'Allow (focus, then Enter)'],
  ['decisions.alwaysTip', "Mouse only · the agent's option: {option}", 'C', "Mouse only · the agent's option: ${d.allow_always}"],
  ['decisions.always', "Allow for this session", 'C', "Don't ask again this session"],
  ['decisions.inTerminal', 'answer in the terminal', 'C'],
  ['decisions.denyNoteSentPh', 'Tell it what to do instead (optional, sent with the deny)', 'C'],
  ['decisions.denyNoteLabel', 'Instruction sent with the deny (optional)', 'C', 'aria-label="Instruction sent with the deny (optional)"'],
  ['decisions.clickHint', 'A click does not allow a risky request: keep focus on the button and press Enter.', 'C'],
];

const base = (f: F) => BASE[FILE[f]];
const now = (f: F) => fs.readFileSync(path.join(WEB, FILE[f]), 'utf8');
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/ \/\/ .*$/gm, '');
/** The model check of language-page.spec.ts: JSX text and text attributes. */
const literals = (text: string) => {
  const code = stripComments(text);
  return [
    ...[...code.matchAll(/(?<![=\-])>\s*([A-Za-z][^<>{}]*?)\s*<(?=[\/A-Za-z])/g)].map((m) => m[1]),
    ...[...code.matchAll(/(?:placeholder|aria-label|title)="([^"]+)"/g)].map((m) => m[1]),
  ].filter((x) => !/^\w+_\w+$/.test(x)); // a system-call name such as posix_spawn is code, not prose
};
// mode-list (ticket 294 item 3) added two decisions.* keys, hidden-marker (V2.5-49) a third, and the folder-trust dialog
// card (ebb8a274, shell defects 11-10 item 5) eight more, after this slice; none has a base literal to compare.
const LATER = new Set([
  'decisions.optionsLabel', 'decisions.optionTerminal', 'decisions.hiddenRemoved',
  'decisions.kindDialog', 'decisions.dialogWhy', 'decisions.dialogEsc', 'decisions.dialogEscTip', 'decisions.escCancels', 'decisions.escExits', 'decisions.openTerminal', 'decisions.openTerminalTip',
  'decisions.someSession', // ticket 551 added it; the check was not run then (found by 559)
  'decisions.whatEdit', 'decisions.whatWrite', 'decisions.whyScreen', // ticket 991 B3/B4 (e5929c1b): the card's request words, new
  'decisions.everyPlace', 'decisions.windowShort', // added after this slice by later tickets; the check was not run then (found by w26-en)
  'decisions.alsoInDecisions', 'decisions.alsoInChat', 'decisions.allowOnce', 'decisions.focusEnter', // ticket 1030: the card above the composer, English only
  'decisions.outward.calendar', 'decisions.outward.mail', 'decisions.outward.post', 'decisions.outward.publish', // the outward-action mark on a card, added later
]);
const newKeys = () => Object.keys(EN).filter((k) => PREFIXES.some((p) => k.startsWith(p)) && !LATER.has(k));

test('no_hardcoded_in_extracted_files: no JSX text, text attribute or moved literal is left in the six files', () => {
  for (const f of Object.keys(FILE) as F[]) expect(literals(now(f)), FILE[f]).toEqual([]);
  for (const [key, , f, frag] of ROWS) expect(stripComments(now(f)).includes(frag ?? EN[key as keyof typeof EN] ?? ''), `${key} still a literal in ${FILE[f]}`).toBe(false);
  // Mutation: a literal put back is caught by the same check.
  expect(literals(`${now('C')}\n<b className="warn">Caution</b>`)).toEqual(['Caution']);
});

test('english_text_unchanged: every new key holds exactly the text the base source had', () => {
  expect(ROWS.length).toBeGreaterThan(100);
  for (const [key, en, f, frag] of ROWS) {
    expect(EN[key as keyof typeof EN], key).toBe(en);
    expect(base(f).includes(frag ?? en), `${key}: "${frag ?? en}" is in the base ${FILE[f]}`).toBe(true);
  }
});

test('approval_placeholders_data_only: no approval key names a host, library or version; the data keys take placeholders', () => {
  const approval = Object.entries(EN).filter(([k]) => k.startsWith('approval.') || k.startsWith('widget.'));
  for (const [k, v] of approval) {
    expect(v, k).not.toMatch(/https?:|cdnjs|jsdelivr|unpkg|jquery|tailwind|cloudflare|github\.com|chart\.?js|\d+\.\d+\.\d+/i);
  }
  const needs: Record<string, string[]> = {
    'approval.title': ['{name}'],
    'approval.hash': ['{hash}'],
    'approval.commandEvery': ['{secs}'],
    'approval.logged': ['{name}'],
    'approval.libAllowedOther': ['{version}'],
    'approval.libListed': ['{source}'],
    'approval.askedBy': ['{requester}'],
    'approval.libOpenWith': ['{version}'],
    'approval.libNoLongerPinned': ['{library}', '{version}'],
    'approval.libOpenedWith': ['{version}'],
    'widget.libsToAllowOne': ['{n}'],
    'widget.libsToAllowMany': ['{n}'],
  };
  for (const [k, ph] of Object.entries(needs)) for (const p of ph) expect(EN[k as keyof typeof EN], k).toContain(p);
});

test('fallback_per_string: an injected ko table shows its key in Korean and every other new key in English', () => {
  const ko = { 'approval.title': '“{name}” 허용?' };
  const t = makeT('ko', 'en-US', { en: EN, ko });
  expect(t('approval.title', { name: 'open-prs' })).toBe('“open-prs” 허용?');
  for (const k of newKeys()) if (k !== 'approval.title') expect(t(k as keyof typeof EN, { name: 'x' }), k).toBe(makeT('en', 'en-US')(k as keyof typeof EN, { name: 'x' }));
});

test('no_catalogue_collision: every new key has a slice prefix, is in the table, and is not a key of the base catalogue', () => {
  const before = new Set([...BASE['src/i18n/index.ts'].matchAll(/^\s*'([\w.]+)':/gm)].map((m) => m[1]));
  expect(before.size).toBeGreaterThan(50);
  const tabled = new Set(ROWS.map((r) => r[0]));
  expect(newKeys().sort()).toEqual([...tabled].sort());
  for (const k of tabled) {
    expect(PREFIXES.some((p) => k.startsWith(p)), k).toBe(true);
    expect(before.has(k), `${k} already in the base catalogue`).toBe(false);
  }
});

// ---- rendered text of the approval states, snapshotted from the base commit's build -------------------------------

const SHEET = '/__sheet-f/';
const FIXTURE = path.join(REPO, 'crates/nunchiro-core/tests/fixtures/approval/open-prs');
const widget = (core: Core, name: string, edit?: (manifest: string) => string) => {
  const dir = path.join(core.home, 'widgets', name);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  if (edit) fs.writeFileSync(path.join(dir, 'widget.toml'), edit(fs.readFileSync(path.join(dir, 'widget.toml'), 'utf8')));
  return dir;
};
/** The sheet's whole text and the accessible names/tips on it, with the content hash (it follows the fixture) masked. */
const sheetText = async (app: Page, core: Core, name: string) => {
  await app.addInitScript((boot) => (window.__NUNCHIRO__ = boot), core.boot());
  await app.goto(`${SHEET}tests/sheet-harness.html?name=${name}`);
  await expect(app.locator('[data-field="command"], [role="alert"]').first()).toBeVisible();
  const sheet = app.getByRole('dialog');
  return (await sheet.evaluate((el) => {
    const names = [...el.querySelectorAll('[aria-label],[title]')].map((e) => e.getAttribute('aria-label') ?? e.getAttribute('title'));
    return `${(el as HTMLElement).innerText}\n#${names.join('|')}`;
  })).replace(/hash [0-9a-f]{12}/, 'hash <hash>');
};

test.describe('approval_wording_unchanged (permission sheet)', () => {
  test.beforeAll(async () => {
    const out = await buildQuiet({
      configFile: path.join(REPO, 'web/vite.config.ts'),
      root: path.join(REPO, 'web'),
      base: SHEET,
      logLevel: 'silent',
      build: { write: false, rollupOptions: { input: path.join(REPO, 'web/tests/sheet-harness.html') } },
    });
    for (const o of (Array.isArray(out) ? out : [out as Rollup.RollupOutput]).flatMap((r) => ('output' in r ? r.output : []))) {
      const dest = path.join(REPO, 'web/dist', SHEET, o.fileName);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(`${dest}.${process.pid}`, o.type === 'chunk' ? o.code : o.source);
      fs.renameSync(`${dest}.${process.pid}`, dest);
    }
  });

  test('script widget with hosts and act', async ({ app, core }) => {
    widget(core, 'open-prs');
    expect(await sheetText(app, core, 'open-prs')).toBe(SNAP.script);
  });
  test('read only, no author, no network', async ({ app, core }) => {
    widget(core, 'plain', (m) => m.replace('author = "owner"\n', '').replace(/network = .*\n?/, '').replace('["read", "act"]', '["read"]'));
    expect(await sheetText(app, core, 'plain')).toBe(SNAP.plain);
  });
  test('changed since allowed', async ({ app, core }) => {
    const dir = widget(core, 'edited');
    core.run(['widget', 'allow', 'edited', '--read']);
    fs.appendFileSync(path.join(dir, 'open-prs.sh'), '# tweak\n');
    expect(await sheetText(app, core, 'edited')).toBe(SNAP.changed);
  });
  test('whole-home read warning and a declared read list', async ({ app, core }) => {
    widget(core, 'home-read', (m) => `${m}read = ["~", "~/other"]\n`);
    expect(await sheetText(app, core, 'home-read')).toBe(SNAP.home);
  });
  test('web widget whose act is refused', async ({ app, core }) => {
    const dir = path.join(core.home, 'widgets', 'cdn');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'widget.toml'), 'version = 1\nkind = "web"\nentry = "index.html"\npermissions = ["read", "act"]\nnetwork = ["cdn.jsdelivr.net"]\n');
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><p>w</p>');
    core.run(['widget', 'allow', 'cdn', '--read']);
    expect(await sheetText(app, core, 'cdn')).toBe(SNAP.web);
  });
  test('an unknown widget', async ({ app, core }) => {
    expect(await sheetText(app, core, 'missing')).toBe(SNAP.missing);
  });
});

// ---- the frame bar and the library cards ----------------------------------------------------------------------------

const LIB = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js';
const card = (v: string, o: Record<string, unknown> = {}) => ({
  url: `${LIB}/${v}/chart.umd.min.js`,
  host: 'cdnjs.cloudflare.com',
  library: 'Chart.js',
  version: v,
  file: 'chart.umd.min.js',
  listed: false,
  auto: false,
  other_versions: [],
  message: `Chart.js ${v} is not on this Mac yet.`,
  integrity: null,
  ...o,
});
const SETS: Record<string, { cards: unknown[]; requester?: string }> = {
  one: { cards: [card('4.4.1', { other_versions: ['4.4.0', '4.3.9'] })], requester: 'alpha' },
  twoAnon: { cards: [card('4.4.1', { listed: true }), card('4.4.2', { auto: true })] },
  nine: { cards: Array.from({ length: 9 }, (_, i) => card(`4.4.${i}`)), requester: 'alpha' },
  twelve: { cards: Array.from({ length: 12 }, (_, i) => card(`4.4.${i}`)) },
};

test.describe('approval_wording_unchanged (frame bar and library cards)', () => {
  test('every card set renders the same text, buttons and tips', async ({ page }) => {
    const srv = await libServer();
    const harness = await harnessServer(srv.origin);
    try {
      await page.exposeFunction('__grant', () => {});
      await page.goto(harness.url);
      const got: Record<string, string> = {};
      for (const [name, set] of Object.entries(SETS)) {
        const art = srv.set(`a-${name}`, '<!doctype html><title>t</title><p>x</p>');
        await page.evaluate(
          ({ a, o, s }) => {
            const w = window as any;
            w.__mount({ artifact: a, origin: o, requester: s.requester, libs: { cards: async () => ({ cards: s.cards, refused: [], pinned: 0 }), list: async () => ({ entries: [], auto_allow: [], saved: true }), allow: async () => {}, openWith: async () => '' } });
          },
          { a: art, o: srv.origin, s: set },
        );
        await expect(page.locator('.af-lib').first()).toBeVisible();
        got[name] = await page.locator('.artifact-frame').evaluate((el, full) => {
          const names = [...el.querySelectorAll('[aria-label],[title]')].filter((e) => e.tagName !== 'IFRAME').map((e) => e.getAttribute('aria-label') ?? e.getAttribute('title'));
          const bar = (el.querySelector('.af-bar') as HTMLElement).innerText;
          const libs = el.querySelector('.af-libs') as HTMLElement;
          // The long lists: the chip, how many cards show, the "more" line and the distinct tips (each card repeats the same text).
          if (!full) return `${bar}|${el.querySelectorAll('.af-lib').length}|${(el.querySelector('.af-lib-more') as HTMLElement).innerText}|#${[...new Set(names)].join('|')}`;
          return `${bar}\n${libs.innerText}\n#${names.join('|')}`;
        }, name === 'one' || name === 'twoAnon');
      }
      expect(got).toEqual(SNAP.libs);
    } finally {
      await harness.close();
      await srv.close();
    }
  });
});

const SNAP = {
  script: "Allow “open-prs”?\nCustom widget · script · made by owner · ~/.nunchiro/widgets/open-prs/ · hash <hash> · asked once, and again after any change\nCommand to run (exactly this, every 60 s)\nsh open-prs.sh --state open\n\nCommands whose runtime spawns children with posix_spawn fail closed. A run stops after 5 seconds. A run can start at most 64 processes. Memory has no limit of its own; these two limits are the only ones.\n\nRead\nShow the command’s output (text or JSON) as a table\nProject names and the session list with states\ndefault · on\nAct\nSend text you set to a session, or start a session\nLogged as “widget open-prs”\noff\nNever\nAnswer pending decisions\nChange settings · touch agent config\nalways\nNetwork\nHosts it may reach: api.github.com · github.com · all other hosts blocked\nallowed\nFiles\nIts project folder, its cache, system tools, ~/.cargo/bin and ~/.local/bin · nothing else in your home\ndefault\nView widget.toml\n= nunchiro widget allow open-prs --read\nCancel\nAllow read only\n#Allow act",
  plain: "Allow “plain”?\nCustom widget · script · made by unknown · ~/.nunchiro/widgets/plain/ · hash <hash> · asked once, and again after any change\nCommand to run (exactly this, every 60 s)\nsh open-prs.sh --state open\n\nCommands whose runtime spawns children with posix_spawn fail closed. A run stops after 5 seconds. A run can start at most 64 processes. Memory has no limit of its own; these two limits are the only ones.\n\nRead\nShow the command’s output (text or JSON) as a table\nProject names and the session list with states\ndefault · on\nAct\nNot requested by this widget\nLogged as “widget plain”\noff\nNever\nAnswer pending decisions\nChange settings · touch agent config\nalways\nNetwork\nNo network · all hosts blocked\nnone\nFiles\nIts project folder, its cache, system tools, ~/.cargo/bin and ~/.local/bin · nothing else in your home\ndefault\nView widget.toml\n= nunchiro widget allow plain --read\nCancel\nAllow read only\n#Allow act",
  changed: "Allow “edited”?\nCustom widget · script · made by owner · ~/.nunchiro/widgets/edited/ · hash <hash> · asked once, and again after any change\n\nChanged since you allowed it. Review it again.\n\nCommand to run (exactly this, every 60 s)\nsh open-prs.sh --state open\n\nCommands whose runtime spawns children with posix_spawn fail closed. A run stops after 5 seconds. A run can start at most 64 processes. Memory has no limit of its own; these two limits are the only ones.\n\nRead\nShow the command’s output (text or JSON) as a table\nProject names and the session list with states\ndefault · on\nAct\nSend text you set to a session, or start a session\nLogged as “widget edited”\noff\nNever\nAnswer pending decisions\nChange settings · touch agent config\nalways\nNetwork\nHosts it may reach: api.github.com · github.com · all other hosts blocked\nallowed\nFiles\nIts project folder, its cache, system tools, ~/.cargo/bin and ~/.local/bin · nothing else in your home\ndefault\nView widget.toml\n= nunchiro widget allow edited --read\nCancel\nAllow read only\n#Allow act",
  home: "Allow “home-read”?\nCustom widget · script · made by owner · ~/.nunchiro/widgets/home-read/ · hash <hash> · asked once, and again after any change\nCommand to run (exactly this, every 60 s)\nsh open-prs.sh --state open\n\nCommands whose runtime spawns children with posix_spawn fail closed. A run stops after 5 seconds. A run can start at most 64 processes. Memory has no limit of its own; these two limits are the only ones.\n\nRead\nShow the command’s output (text or JSON) as a table\nProject names and the session list with states\ndefault · on\nAct\nSend text you set to a session, or start a session\nLogged as “widget home-read”\noff\nNever\nAnswer pending decisions\nChange settings · touch agent config\nalways\nNetwork\nHosts it may reach: api.github.com · github.com · all other hosts blocked\nallowed\nFiles\nIts project folder, its cache, system tools, ~/.cargo/bin and ~/.local/bin, and also:\n~\n~/other\n\nReads your whole home folder: documents, other projects and app data. Agent config and keys stay blocked.\n\ndeclared\nView widget.toml\n= nunchiro widget allow home-read --read\nCancel\nAllow read only\n#Allow act",
  web: "Allow “cdn”?\nCustom widget · web · made by unknown · ~/.nunchiro/widgets/cdn/ · hash <hash> · asked once, and again after any change\nPage to show\nindex.html\nRead\nShow its page\nProject names and the session list with states\ndefault · on\nAct\nact refused: a web widget that can act loads scripts only from its own folder, and cdn.jsdelivr.net serves code outside the approval; copy the library into the entry file, or allow read only\nLogged as “widget cdn”\noff\nNever\nAnswer pending decisions\nChange settings · touch agent config\nalways\nNetwork\nHosts it may reach: cdn.jsdelivr.net · all other hosts blocked\nallowed\nView widget.toml\n= nunchiro widget allow cdn --read\nCancel\nAllow read only\n#Allow act",
  missing: "Allow “missing”?\nCustom widget · ~/.nunchiro/widgets/missing/ · asked once, and again after any change\nThat file or folder is not there. Check the path, then try again.\nDetails\nView widget.toml\n= nunchiro widget allow missing --read\nCancel\nAllow read only\n#",
  libs: {
    one: "a-one\n1 library to allow\nNetwork off\nChart.js 4.4.1; you allowed 4.4.0\nUnverified\nchart.umd.min.js · cdnjs.cloudflare.com\nAsked by alpha\nSame CDN and exact-version rule as Claude.ai artifacts\nOnly this library request goes to cdnjs.cloudflare.com: your IP and the URL. Nothing from the page is sent.\nChart.js 4.4.1 is not on this Mac yet.\nAllow\nDon't allow\nOpen with 4.4.0\nOpen with 4.3.9\n#Allow remote images, other hosts, fetch and WebSocket for this artifact until it changes|Libraries|Not checked against cdnjs's published hashes: the file came from the host as is.",
    twoAnon: "a-twoAnon\n2 libraries to allow\nNetwork off\nChart.js 4.4.1\ncdnjs lists this version\nchart.umd.min.js · cdnjs.cloudflare.com\nAsked by a page not opened from a session\nSame CDN and exact-version rule as Claude.ai artifacts\nOnly this library request goes to cdnjs.cloudflare.com: your IP and the URL. Nothing from the page is sent.\nChart.js 4.4.1 is not on this Mac yet.\nAllow\nDon't allow\nChart.js 4.4.2\nUnverified\nchart.umd.min.js · cdnjs.cloudflare.com\nAsked by a page not opened from a session\nSame CDN and exact-version rule as Claude.ai artifacts\nOnly this library request goes to cdnjs.cloudflare.com: your IP and the URL. Nothing from the page is sent.\nAuto-allowed: fetching it now.\nAllow\nDon't allow\n#Allow remote images, other hosts, fetch and WebSocket for this artifact until it changes|Libraries|Not checked against cdnjs's published hashes: the file came from the host as is.",
    nine: "a-nine\n9 libraries to allow\nNetwork off|8|1 more library|#Allow remote images, other hosts, fetch and WebSocket for this artifact until it changes|Libraries|Not checked against cdnjs's published hashes: the file came from the host as is.",
    twelve: "a-twelve\n12 libraries to allow\nNetwork off|8|4 more libraries|#Allow remote images, other hosts, fetch and WebSocket for this artifact until it changes|Libraries|Not checked against cdnjs's published hashes: the file came from the host as is.",
  } as Record<string, string>,
};
