// UI language, V2-14b (needs 93; tickets 116, 117): field labels, palette titles, <html lang>. Pure model checks, no page.
import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlLang, makeT, mergeAreas, type AreaFile } from '../src/i18n';
import { FIELDS, fieldLabel, fieldMatches, settingsCommandTitle } from '../src/settings';

// Node has no import.meta.glob, so the feature that owns FIELDS keys (ticket 255) is imported by hand too.
await import('../src/features/browser-prefs');
// Node has no import.meta.glob, so the shipped catalogue is merged here from the area files (ticket 170).
const dir = fileURLToPath(new URL('../src/i18n/areas', import.meta.url));
const files: Record<string, AreaFile> = {};
for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) files[`./areas/${f}`] = await import(join(dir, f));
const TABLES = mergeAreas({ en: {}, ko: {}, ja: {}, 'zh-Hans': {}, 'zh-Hant': {}, es: {}, fr: {}, pt: {} }, files);
const EN = TABLES.en;
const tFor = (lang: 'en' | 'ko') => makeT(lang, 'en-US', TABLES as never);

// The labels FIELDS carried on main before this slice (32 entries; the brief's "33" was a miscount).
const BEFORE: Record<string, string> = {
  density: "Density (row height)",
  tabFont: "Tab font size",
  termFontSize: "Terminal font size",
  termFont: "Terminal font",
  copyOnSelect: "Copy on select",
  scrollback: "Lines you can scroll back to",
  titleBar: "Title bar",
  osc52: "Clipboard writes from programs (OSC 52)",
  newSplit: "Open in a new split (agent chat, terminal or a chooser)",
  themeMode: "Theme: follow the system or one theme",
  themes: "Find a theme",
  themeBrowse: "Browse themes online",
  themeImport: "Import a theme file",
  strip: "Waiting alerts (answer strip)",
  soundDone: "Sound when a session is done",
  soundWaiting: "Sound when a session is waiting",
  soundVolume: "Sound volume",
  prefix: "Prefix key",
  prefixHelpDelay: "Prefix help delay",
  scriptWidgets: "Script widgets", // ticket 872
  bindings: "Key bindings (find a command or key)",
  hintKeys: "Hint label keys (alphabet)",
  hintKinds: "Hint kind keys",
  lifetime: "When the app quits: keep agents running or end them",
  startAtLogin: "Start at login",
  hooks: "Add Nunchiro hooks to new sessions", // ticket 391 follow-up F: the switch says "add" now; its search hit is titled with that label
  history: "Keep terminal history for restarts",
  maskHistory: "Mask secrets in saved terminal history",
  livePrStatus: "Live PR status (uses your gh)",
  autoCleanWorktrees: "Auto-clean merged worktrees",
  branchPrefix: "Branch name prefix for new worktrees",
  worktreeRoot: "Folder for new worktrees",
  language: "Language",
  machines: "Machines", // pins brought up to FIELDS as of main 20c098fe
  browserAccess: "Allow browser access",
  browserEngine: "Search engine", // the In-app browser page (ticket 255)
  browserHome: "Home page",
  browserZoom: "Default zoom",
  browserViewport: "Agent page size",
  browserAppearance: "Page appearance",
  browserUserAgent: "User agent",
  browserSites: "Site permissions",
  browserShowPane: "Show the browser when an agent opens a page",
  keepAwake: "Keep this Mac awake while a session is working",
  artifactLibs: "Artifact libraries (fixed versions from a CDN, allowed automatically)",
  chatWidth: "Chat width",
  orchEnabled: "Orchestration skill for new sessions", // the Orchestration page (ticket 167)
  autoPull: "Keep default branch up to date", // ticket 335
  confirmCloseRunning: "Ask before closing a running session tab", // ticket 338
  'usage.codex_resets': "Show Codex resets", // needs 225
  'usage.codex_reset_agent': "When an agent wants to use a Codex reset",
  notifyFocused: "Do not alert for the session you are viewing", // ticket 372
  notifyDefault: 'Notification level for new sessions', // ticket 608 (b430fbddd)
};

// Fields features register at runtime (registerSettingsPage / Section `fields`). Node cannot load the feature modules (about.tsx imports
// a ?raw file; a registering import would also leak into other specs in the worker), so the keys are pinned here by name, and each
// must still appear in its feature source so a pin cannot outlive its registration. `tail` maps a key to how that source spells it.
const FEATURE_FIELDS: { file: string; keys: string[]; tail: (k: string) => string }[] = [
  { file: 'features/about.tsx', keys: ['buildInfo'], tail: (k) => k },
  { file: 'features/small-rows-values.ts', keys: ['alertMachines', 'tabCycleOrder', 'stripAgentCredits'], tail: (k) => k },
  { file: 'features/diff-options.tsx', keys: ['diffHideWhitespace', 'diffWrap', 'diffCollapse', 'diffHideList', 'diffColours'], tail: (k) => k },
  { file: 'features/chat-type.tsx', keys: ['uiFont', 'chatFont', 'chatSize', 'chatLine', 'codeFont', 'codeSize', 'composerFont', 'composerSize', 'chatContrast', 'chatMath'], tail: (k) => k },
  { file: 'features/link-routing.tsx', keys: ['linksOpenIn', 'linksShift', 'linksBackground'], tail: (k) => k },
  { file: 'features/extensions.tsx', keys: ['extSkills', 'extMcp', 'extWidgets'], tail: (k) => k }, // ticket 276
  { file: 'features/browser-profiles.tsx', keys: ['browserProfiles'], tail: (k) => k },
  { file: 'features/followup-default.tsx', keys: ['followupDefault'], tail: (k) => k }, // ticket 517
  { file: 'features/onboarding.tsx', keys: ['onboarding'], tail: (k) => k }, // ticket 608 (b430fbddd)
  { file: 'features/new-session-defaults.tsx', keys: ['newDefaultAgent', 'newDefaultModel', 'newDefaultPermissions'], tail: (k) => k }, // ticket 391
  {
    file: 'features/terminal.tsx',
    keys: ['Scroll', 'FastScroll', 'TuiScroll', 'RightClickPaste', 'FocusFollowsMouse', 'WordSeparators', 'OptionMeta', 'HidePointer', 'Cursor', 'CursorBlink', 'CursorOpacity', 'FontWeight', 'BoldWeight', 'Ligatures', 'PadLeft', 'PadTop', 'Gpu'].map((k) => `term${k}`),
    tail: (k) => k[4].toLowerCase() + k.slice(5), // 'termFastScroll' is listed as 'fastScroll'
  },
  // The font picker's labels: field.* keys the Appearance page reads directly, with no settings row of their own.
  { file: 'settings/appearance/AppearancePage.tsx', keys: ['fontSearch', 'fontMonospace', 'fontAll', 'fontNone'], tail: (k) => `field.${k}` },
  { file: 'features/team.tsx', keys: ['team', 'levels'], tail: (k) => k }, // owner 2026-11-16: Settings > Team; ticket 992: its Levels table (46a189a3a)
  { file: 'features/notes.tsx', keys: ['notes'], tail: (k) => k }, // ticket 990 slice h: Settings > Notes (21ef73729)
  { file: 'features/setup-scripts.tsx', keys: ['setupScript', 'cleanupScript', 'setupPolicy', 'setupWait'], tail: (k) => `field.${k}` }, // ticket 259
  { file: 'features/cache-timer.tsx', keys: ['cacheTimer', 'cacheTtl'], tail: (k) => `field.${k}` }, // ticket 257 (8705b4d3c)
  { file: 'features/editor.tsx', keys: ['editorApp'], tail: (k) => `field.${k}` }, // 806ffce9b
  { file: 'features/user-env.tsx', keys: ['envInheritShell', 'envNames', 'envStripSecrets', 'envKeepSecrets'], tail: (k) => `field.${k}` }, // ticket 260 (4210e1239); ticket 1008 (bf1143e1b)
  { file: 'features/assistants.tsx', keys: ['homeChief'], tail: (k) => k }, // ticket 1002 (38ba57d59)
  { file: 'features/wt-files.tsx', keys: ['sharedFiles', 'sparsePreset'], tail: (k) => `field.${k}` }, // ticket 253 (5527d53b6)
];
const featureKeys = FEATURE_FIELDS.flatMap((f) => f.keys);

test('field_labels_all_keyed: every FIELDS key has field.<key> in English, equal to the old label; no stray entry', () => {
  // FIELDS is shared by a worker: a spec that ran before may have loaded a feature that registers its own keys, or have
  // loaded browser-prefs into another copy of the settings module. So each key here must be known; the list is not counted.
  const keys = Object.keys(BEFORE);
  for (const f of FIELDS) expect([...keys, ...featureKeys], f.key).toContain(f.key);
  const t = tFor('en');
  for (const [k, label] of Object.entries(BEFORE)) expect(fieldLabel(t, k), k).toBe(label);
  const catalogued = Object.keys(EN).filter((k) => k.startsWith('field.')).map((k) => k.slice(6));
  // Catalogued = built-ins + feature-registered; a `field.*` key nobody registers is stray and fails here.
  expect(catalogued.sort()).toEqual([...keys, ...featureKeys].sort());
  for (const f of FEATURE_FIELDS) {
    const src = readFileSync(fileURLToPath(new URL(`../src/${f.file}`, import.meta.url)), 'utf8');
    for (const k of f.keys) expect(src, `${f.file} registers ${k}`).toContain(`'${f.tail(k)}'`);
  }
  expect(FIELDS.every((f) => !('label' in f))).toBe(true);
});

test('field_label_falls_back_per_string: a ko table with one field key shows it; any other shows English', () => {
  const tables = { en: { 'field.density': 'Density', 'field.tabFont': 'Tab font size' }, ko: { 'field.density': '밀도' } };
  const t = makeT('ko', 'en-US', tables);
  expect(fieldLabel(t, 'density')).toBe('밀도');
  expect(fieldLabel(t, 'tabFont')).toBe('Tab font size');
});

test('palette_settings_titles_follow_language: the title is built from palette.settings and the translated label', () => {
  expect(settingsCommandTitle(tFor('en'), 'titleBar')).toBe('Settings: Title bar');
  const tables = { en: { 'palette.settings': 'Settings: {label}', 'field.titleBar': 'Title bar' }, ko: { 'palette.settings': '설정: {label}', 'field.titleBar': '제목 표시줄' } };
  expect(settingsCommandTitle(makeT('ko', 'en-US', tables), 'titleBar')).toBe('설정: 제목 표시줄');
  const half = { ...tables, ko: { 'palette.settings': '설정: {label}' } };
  expect(settingsCommandTitle(makeT('ko', 'en-US', half), 'titleBar')).toBe('설정: Title bar');
});

test('settings_search_matches_translated_label: title, alias and label all match, case-insensitively', () => {
  expect(fieldMatches('title bar', 'Appearance', '', 'Title bar')).toBe(true);
  expect(fieldMatches('제목', 'Appearance', '', '제목 표시줄')).toBe(true);
  expect(fieldMatches('외관', '외관', '', 'Title bar')).toBe(true);
  expect(fieldMatches('lifetime', 'Sessions and startup', 'Lifetime', 'Start at login')).toBe(true);
  expect(fieldMatches('nothing', 'Appearance', '', 'Title bar')).toBe(false);
});

test('html_lang_follows_choice: the resolved language only when its table has strings, else en', () => {
  const tables = { en: { a: 'A' }, ko: { a: '가' }, 'zh-Hant': { a: '甲' }, ja: {} };
  expect(htmlLang('en', 'ko-KR', tables)).toBe('en');
  expect(htmlLang('system', 'en-US', tables)).toBe('en');
  expect(htmlLang('ko', 'en-US', tables)).toBe('ko');
  expect(htmlLang('fr', 'en-US', tables)).toBe('en');
  expect(htmlLang('ja', 'en-US', tables)).toBe('en'); // an empty table is no table
  expect(htmlLang('system', 'zh-TW', tables)).toBe('zh-Hant');
  expect(htmlLang('ko', 'en-US', TABLES as never)).toBe('ko'); // the shipped Korean catalogue has strings
});
