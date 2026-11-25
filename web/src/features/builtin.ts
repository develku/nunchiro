// The built-in Settings pages in nav order, and their searchable fields (V1A-57; needs 69). A feature added later registers
// its own page from its own file (registry.ts); only the pages that predate the registry are listed here.
import type { Field } from './registry';

// Ticket 250 (needs 190, 192): the pages of the approved final draft, in nav order, each in its group; D2 (owner 2026-11-06)
// split its Accounts & Usage page in two; ticket 391 merged Agents and Accounts into Providers and moved Orchestration
// and Advanced into 스킬·훅 (the registered `extensions`), so 14; ticket 993 moved Schedules to its own widget
// (schedule/SchedulesView.tsx), so 13. Ids are stored as
// the window's last page, so they never change once shipped (alerts = Notifications, keys = Keyboard).
export const BUILTIN_PAGES = ['general', 'appearance', 'terminal', 'layout', 'alerts', 'keys', 'providers', 'usage', 'git', 'machines', 'browser', 'libraries', 'history'];

/** Each built-in page's nav group (registry.ts GROUPS). */
export const BUILTIN_GROUP: Record<string, string> = {
  general: 'general',
  appearance: 'interface',
  terminal: 'interface',
  layout: 'interface',
  alerts: 'interface',
  keys: 'interface',
  providers: 'agents',
  usage: 'agents',
  git: 'git',
  machines: 'remote',
  browser: 'privacy',
  libraries: 'privacy',
  history: 'privacy',
};

/** The pages folded into another one, by old id: a stored last page or an old link opens the new home. The ids
 *  v25-fix-settings folded into Advanced and Agents are pages again (ticket 250). */
export const MOVED_PAGES: Record<string, string> = {
  lifetime: 'general',
  theme: 'appearance',
  agents: 'providers', // ticket 391
  accounts: 'providers',
  advanced: 'extensions', // ticket 391 part 2: the hook switch and the orchestration card are in Nunchiro 기본
  orchestration: 'extensions',
};

/** Every built-in setting by page: the Settings search lists these, the palette has `settings.<page>.<key>` for each, and
 *  `at` finds the field to focus (a radio group's checked radio first). */
export const BUILTIN_FIELDS: Field[] = [
  { page: 'providers', key: 'usage.codex_resets', at: '[data-setting="usage.codex_resets"]' }, // needs 225
  { page: 'providers', key: 'usage.codex_reset_agent', at: '[data-setting="usage.codex_reset_agent"]' },
  { page: 'machines', key: 'machines', at: '#h-machines' },
  { page: 'browser', key: 'browserAccess', at: '[data-setting="browserAccess"]' }, // V2.5-15
  { page: 'appearance', key: 'density', at: '[data-setting="density"]' }, // D-20261108-07: the row height stepper (key kept; any language)
  { page: 'appearance', key: 'tabFont', at: '[data-setting="tabFont"]' },
  { page: 'appearance', key: 'chatWidth', at: '[data-setting="chatWidth"]' },
  { page: 'general', key: 'language', at: '[data-setting="language"]' }, // V2-14a; one collapsed picker in General (finding 22)
  { page: 'terminal', key: 'termFontSize', at: '[data-setting="termFontSize"]' },
  { page: 'terminal', key: 'termFont', at: '#term-font' },
  { page: 'terminal', key: 'scrollback', at: '[data-setting="scrollback"]' }, // needs 191
  { page: 'terminal', key: 'copyOnSelect', at: '[data-setting="copyOnSelect"]' },
  { page: 'appearance', key: 'titleBar', at: 'input[name="titlebar"]' },
  { page: 'terminal', key: 'osc52', at: 'input[name="osc52"]' },
  { page: 'layout', key: 'newSplit', at: 'input[name="newsplit"]' }, // SPLITNEW
  { page: 'layout', key: 'barsAutohide', at: '[data-setting="barsAutohide"]' }, // ticket 1047
  { page: 'layout', key: 'scriptWidgets', at: '[data-setting="scriptWidgets"]' }, // ticket 872
  { page: 'appearance', key: 'themeMode', at: 'input[name="theme-mode"]' },
  { page: 'appearance', key: 'themes', at: '[data-setting="themes"]' },
  { page: 'appearance', key: 'themeBrowse', at: '[data-setting="themeBrowse"]' },
  { page: 'appearance', key: 'themeImport', at: '[data-setting="themeImport"]' },
  { page: 'alerts', key: 'strip', at: 'input[name="strip"]' },
  { page: 'alerts', key: 'notifyDefault', at: '[data-setting="notifyDefault"]' }, // ticket 608: "mute" found no setting; above the sounds, as on its page
  { page: 'alerts', key: 'soundDone', at: '[data-setting="soundDone"]' },
  { page: 'alerts', key: 'soundWaiting', at: '[data-setting="soundWaiting"]' },
  { page: 'alerts', key: 'soundVolume', at: '[data-setting="soundVolume"]' },
  { page: 'alerts', key: 'notifyFocused', at: '[data-setting="notifyFocused"]' }, // ticket 372
  { page: 'keys', key: 'prefix', at: '[data-command="prefix"] button.kchange' }, // final.html: the prefix card opens the page
  { page: 'keys', key: 'prefixHelpDelay', at: '[data-setting="prefixHelpDelay"]' },
  { page: 'keys', key: 'bindings', at: '.ksearch input[type="search"]' },
  { page: 'keys', key: 'hintKeys', at: '[data-setting="hintKeys"]' },
  { page: 'keys', key: 'hintKinds', at: '[data-setting="hintKinds"]' },
  { page: 'general', key: 'lifetime', at: 'input[name="lifetime"]' },
  { page: 'general', key: 'startAtLogin', at: '[data-setting="startAtLogin"]' },
  { page: 'extensions', key: 'hooks', at: '[data-setting="hooks"]' },
  { page: 'history', key: 'history', at: '[data-setting="history"]' },
  { page: 'history', key: 'maskHistory', at: '[data-setting="maskHistory"]' },
  { page: 'git', key: 'livePrStatus', at: '[data-setting="livePrStatus"]' },
  { page: 'git', key: 'autoPull', at: '[data-setting="autoPull"]' }, // ticket 335
  { page: 'git', key: 'autoCleanWorktrees', at: '[data-setting="autoCleanWorktrees"]' }, // V2-8a
  { page: 'git', key: 'branchPrefix', at: '[data-setting="branchPrefix"]' }, // F7
  { page: 'git', key: 'worktreeRoot', at: '[data-setting="worktreeRoot"]' }, // F7
  { page: 'general', key: 'keepAwake', at: '[data-setting="keepAwake"]' }, // V2-CF5
  { page: 'general', key: 'confirmCloseRunning', at: '[data-setting="confirmCloseRunning"]' }, // ticket 338
  { page: 'libraries', key: 'artifactLibs', at: '[data-setting="artifactLibs"]' },
  // V2.5-31
  { page: 'extensions', key: 'orchEnabled', at: '[data-setting="orchEnabled"]' },
];
