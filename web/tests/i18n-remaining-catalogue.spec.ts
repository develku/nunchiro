// UI language, V2-14g (needs 93; ticket 122): window chrome, Agents page and ACP sheet, first run, problem cards and the
// Settings page bodies read their text from the catalogue. Pure checks over the source and the tables, no page.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { EN, makeT } from './i18n-tables';

const src = path.resolve(import.meta.dirname, '../src');

const FILES = [
  'settings/onboarding/OnboardingPage.tsx',
  'chat/ProblemCard.tsx',
  // Ticket 391 (3af88775): the Agents page and its sheet (a869d98e) moved into the Providers page and its parts.
  'settings/accounts/defaults.tsx',
  'settings/accounts/head.tsx',
  'settings/accounts/AccountsPage.tsx',
  'settings/alerts/AlertsPage.tsx',
  'settings/appearance/AppearancePage.tsx',
  'settings/keys/KeysPage.tsx',
  'settings/keys/HintsSection.tsx',
  'settings/keys/HintPreview.tsx',
  'settings/layout/LayoutPage.tsx',
  'settings/libs/LibsPage.tsx',
  'settings/theme/ThemePage.tsx',
  'settings/theme/ThemeCard.tsx',
  'settings/theme/ImportTheme.tsx',
  'settings/theme/ThemeLicences.tsx',
  'settings/lifetime/QuitDialog.tsx',
  'settings/lifetime/ResumeOffer.tsx',
  'settings/lifetime/LivePrStatus.tsx',
];

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/ \/\/ .*$/gm, '');
/** User-visible English the model spec of v2-14a looks for, plus quoted prose in data tables and template strings. */
function literals(text: string): string[] {
  const code = strip(text);
  return [
    ...[...code.matchAll(/(?<![=\-])>\s*([A-Za-z][^<>{}]*?)\s*<(?=[\/A-Za-z])/g)].map((m) => m[1]),
    ...[...code.matchAll(/(?:placeholder|aria-label|title|alt|data-tip)="([^"]+)"/g)].map((m) => m[1]),
    ...[...code.matchAll(/(?:placeholder|aria-label|title|alt|data-tip)=\{`([^`]*)`\}/g)].map((m) => m[1]).filter((x) => /[A-Za-z]{3}/.test(x.replace(/\$\{[^}]*\}/g, ''))),
    ...[...code.matchAll(/'([A-Z][a-z]+(?: [A-Za-z·‘’“”.,()/:;-]+)+)'/g)].map((m) => m[1]),
  ];
}

/** The tab strip and the status bar of App.tsx (the only regions this slice may touch). */
function appRegions(): string[] {
  const centre = fs.readFileSync(path.join(src, 'chrome/CentreView.tsx'), 'utf8');
  const tabs = centre.slice(centre.indexOf('<div className="tabs"'), centre.indexOf('<span className="sr" data-live="tabs"'));
  const bar = fs.readFileSync(path.join(src, 'chrome/StatusBar.tsx'), 'utf8');
  const status = bar.slice(bar.indexOf('<footer className="status">'), bar.indexOf('</footer>'));
  return [tabs, status];
}

test('no_hardcoded_in_extracted_files: the extracted files and App.tsx tab strip / status bar hold no English literal outside the catalogue', () => {
  for (const f of FILES) expect(literals(fs.readFileSync(path.join(src, f), 'utf8')), f).toEqual([]);
  const [tabs, status] = appRegions();
  expect(literals(tabs), 'tab strip').toEqual([]);
  expect(literals(status), 'status bar').toEqual([]);
});

test('no_hardcoded_in_extracted_files (mutation): the detector catches a literal text, attribute, template attribute and table row', () => {
  expect(literals('<b>Hello there</b>')).toEqual(['Hello there']);
  expect(literals('<button aria-label="Close it" />')).toEqual(['Close it']);
  expect(literals('<i aria-label={`Stop ${name}`} />')).toEqual(['Stop ${name}']);
  expect(literals("const M = [['on', 'Answer strip here']];")).toEqual(['Answer strip here']);
  expect(literals('<b>{t("x.y")}</b>')).toEqual([]);
});

// Later slices added their own settings.<group>. keys to the same catalogue: settings-polish 6a167914 (density, step, group,
// clip), the 9 pages 309459ab (page, migrated; needs 149/150), Keyboard page f34bb5cf (kbd; needs 166). They are not this slice's, so they leave its key set; any other new prefix still fails the collision check.
const LATER = /^settings\.(density|step|group|clip|page|migrated|kbd|desc|section|navGroup|row|extensions|source)\./; // desc, section, navGroup, row: ticket 250 (the final draft's page and row text); extensions: ticket 276 (agent extensions page); source: ticket 518 (d20a670c, the value-source tag)
// Keys later slices added under this slice's own prefixes, by commit; a key not listed here still needs a BEFORE row.
const LATER_KEYS = new Set([
  // Ticket 325: the Agents page rows.
  'agents.page.checked', 'agents.page.checking', 'agents.page.inTerminal', 'agents.page.lineChanged', 'agents.page.lineFound', 'agents.page.lineUnapproved', 'agents.page.missingFile', 'agents.page.missingLine', 'agents.page.noneFound', 'agents.page.recheck', 'agents.page.review', 'agents.page.reviewFor', 'agents.page.signInLine', 'agents.page.signInUnchecked', 'agents.page.stApproval', 'agents.page.stAttention', 'agents.page.stInstalled', 'agents.page.stMissing', 'agents.page.stReady', 'agents.page.stSignedOut',
  // v26 tickets 313, 314 (settings and terminal mockup rows).
  'settings.scrollback.desc', 'settings.scrollback.invalid', 'settings.scrollback.lines', 'settings.scrollback.restart', 'settings.theme.importDesc', 'settings.theme.inUse', 'settings.theme.modeDesc', 'settings.theme.pick', 'settings.theme.pickDesc', 'settings.theme.whenDark', 'settings.theme.whenLight',
  'firstrun.chooseFolder', // dbba2aa3 (ticket 202)
  'settings.keys.options', 'settings.keys.optionsOf', // ticket 250: the hints row's Options link and the hints part heading
  'settings.accounts.closeRemove', 'settings.accounts.inUseByTab', 'settings.accounts.tabOpen', // 539d0772 (ticket 178)
  'settings.accounts.tabResumable', // 3484a3fc (ticket 178 r2)
  'settings.lifetime.resumeDismiss', // a17d5e46 (rc2b-fb 1, merged in 58084cbc)
  'settings.theme.moreThemes', 'settings.theme.fewer', // 6a167914
  'settings.theme.backTo', // D-20261108-12 (F17)
  'settings.theme.previewLoading', 'settings.theme.previewNotLoaded', // ticket 991 C18: an online card's preview not here yet
  // 89a1704f (ticket 178 finding 20, needs 149): browser sign-in
  'settings.accounts.signIn', 'settings.accounts.signInTerminal', 'settings.accounts.signInLede', 'settings.accounts.signInRule',
  'settings.accounts.signInGroup', 'settings.accounts.opening', 'settings.accounts.browserOpened', 'settings.accounts.copyLink',
  'settings.accounts.linkCopied', 'settings.accounts.pasteCode', 'settings.accounts.submitCode', 'settings.accounts.signedInDone',
  'settings.accounts.retry', 'settings.accounts.signInCancelled', 'settings.accounts.fail.codeRejected', 'settings.accounts.fail.exited',
  'settings.accounts.fail.noLink', 'settings.accounts.fail.badLink', 'settings.accounts.fail.timedOut', 'settings.accounts.fail.notSignedIn',
  'settings.accounts.fail.startFailed', 'settings.accounts.fail.unknown', 'settings.accounts.fail.notSaved',

  'settings.accounts.cleanClaude', 'settings.accounts.cleanCodex', // a380f8d0 (ticket 391): a new account starts clean, per agent
]);
// rc2b-fb 58084cbc (V2.5-41): the Keyboard page's command names, under this slice's settings.keys. prefix.
const later = (k: string) => LATER_KEYS.has(k) || /^settings\.(keys\.cmd|err|kit)\./.test(k) || /^agents\.new\./.test(k); // err, kit: tickets 311, 312; agents.new: ticket 223
const NEW = Object.keys(EN).filter((k) => (/^(chrome|agents|firstrun|problem)\./.test(k) || /^settings\.[a-z]+\./.test(k)) && !LATER.test(k) && !later(k));
// The keys v2-14a and v2-14b added (the catalogue on main before this slice).
const BEFORE_KEYS = [
  'settings.region', 'settings.nav', 'settings.search', 'settings.matches', 'settings.results', 'settings.none', 'settings.stored', 'settings.hints',
  'page.appearance', 'page.layout', 'page.theme', 'page.alerts', 'page.keys', 'page.lifetime', 'page.accounts', 'page.agents', 'page.libraries', 'page.language',
  'language.applies', 'language.system', 'language.systemNote', 'language.note', 'language.scope',
  'palette.dialog', 'palette.search', 'palette.list', 'palette.placeholder', 'palette.settings',
];

test('no_catalogue_collision: every new key starts with this slice’s prefix and none is a v2-14a/b key or a duplicate', () => {
  // Other slices (c-f) add their own prefixes (board., chat., ...); this slice owns the ones below.
  const mine = Object.keys(EN).filter((k) => !BEFORE_KEYS.includes(k) && !later(k) && /^(chrome|agents|firstrun|problem|settings\.(alerts|layout|appearance|keys|theme|lifetime|accounts|agents|libraries))\./.test(k));
  expect(mine.length).toBeGreaterThan(100);
  expect(mine.length).toBe(NEW.length);
  expect(NEW.filter((k) => BEFORE_KEYS.includes(k))).toEqual([]);
  const index = fs.readFileSync(path.join(src, 'i18n/index.ts'), 'utf8');
  const all = [...index.matchAll(/^ {2}['"]([^'"]+)['"]:/gm)].map((m) => m[1]);
  expect(all.filter((k, i) => all.indexOf(k) !== i), 'duplicate keys').toEqual([]);
});

// The strings main held (193ac455), key by key, with the arguments the code gave them. Plural pairs are `.one`/`.other`.
const BEFORE: [string, Record<string, string | number> | undefined, string][] = [
  ["agents.sheet.custom", undefined, "a custom command"],
  ["agents.page.acp", undefined, "ACP agents"],
  ["agents.page.approvedNote", { label: "LABEL" }, "LABEL approved. Any change to the entry asks again."],
  ["agents.page.copied", undefined, "Path copied."],
  ["agents.page.copy", undefined, "Copy"],
  ["agents.page.custom", undefined, "Custom command"],
  ["agents.page.install", undefined, "Install page ↗"],
  ["agents.page.openFile", undefined, "Open agents.toml"],
  ["agents.page.setUp", { label: "LABEL" }, "Set up LABEL"],
  ["agents.page.setUpShort", undefined, "Set up…"],
  ["agents.page.terminal", undefined, "Terminal agents"],
  ["agents.sheet.allPassed", undefined, "all passed"],
  ["agents.sheet.approve", undefined, "Approve and add"],
  ["agents.sheet.approveFirst", undefined, "Approve the agent first; its login tab runs the approved command."],
  ["agents.sheet.askAgain", undefined, "Any change to this entry asks again."],
  ["agents.sheet.asks", { list: "LIST" }, "Asks for: LIST"],
  ["agents.sheet.canDo", { label: "LABEL" }, "What LABEL can do here."],
  ["agents.sheet.canDoBody", { label: "LABEL" }, "Reads and writes files only inside the session folder. Links that point outside the folder are refused. Terminals that it asks for run in Nunchiro and show in the tab. Each permission request waits in the tree, as for Claude. You can answer Allow once or Reject once. Nunchiro stores no API key. LABEL uses its own login or the env names below."],
  ["agents.sheet.cancel", undefined, "Cancel"],
  ["agents.sheet.capabilities", undefined, "capabilities"],
  ["agents.sheet.changed", undefined, "The entry changed; review it again."],
  ["agents.sheet.changedSince", undefined, "This entry changed since you approved it. Review it again."],
  ["agents.sheet.command", undefined, "Command"],
  ["agents.sheet.control", undefined, "The command cannot hold control characters."],
  ["agents.sheet.corePath", undefined, "Nunchiro's PATH"],
  ["agents.sheet.covers", undefined, "Approval covers exactly:"],
  ["agents.sheet.enterCommand", undefined, "Enter the command to test it."],
  ["agents.sheet.enterShort", undefined, "(enter a command)"],
  ["agents.sheet.env", undefined, "env:"],
  ["agents.sheet.envAdd", undefined, "＋ name"],
  ["agents.sheet.envName", undefined, "Env name"],
  ["agents.sheet.envNames", undefined, "Env names"],
  ["agents.sheet.envRule", undefined, "Env names are names only (A-Z, 0-9, _); values stay in your environment."],
  ["agents.sheet.failed", undefined, "failed"],
  ["agents.sheet.found", undefined, "Found"],
  ["agents.sheet.foundAt", { path: "PATH" }, "Found PATH"],
  ["agents.sheet.fullPath", undefined, "Use the full path of the command (it starts with /)."],
  ["agents.sheet.inFile", undefined, "This entry is in agents.toml; edit it there."],
  ["agents.sheet.lastTest", { time: "TIME", result: "RESULT" }, "Last test TIME · RESULT"],
  ["agents.sheet.loginOpened", { tab: "TAB" }, "Login opened in the tab “TAB”. Test again when you are signed in."],
  ["agents.sheet.loginTab", undefined, "Sign in with a terminal tab"],
  ["agents.sheet.name", undefined, "Name"],
  ["agents.sheet.namePlaceholder", undefined, "my-agent"],
  ["agents.sheet.nameRule", undefined, "The name takes lowercase letters, digits, - and _."],
  ["agents.sheet.namesOnly", undefined, "names only; values stay in your environment"],
  ["agents.sheet.none", undefined, "(none)"],
  ["agents.sheet.notAll", undefined, "not all passed"],
  ["agents.sheet.notRun", undefined, "not run"],
  ["agents.sheet.notSigned", { label: "LABEL" }, "Not signed in (reported by LABEL)"],
  ["agents.sheet.nothing", undefined, "nothing declared"],
  ["agents.sheet.nothingRun", undefined, "Nothing has run. Read the command and env names, then Run check."],
  ["agents.sheet.passed", undefined, "passed"],
  ["agents.sheet.remove", { name: "NAME" }, "Remove NAME"],
  ["agents.sheet.runCheck", undefined, "Run check"],
  ["agents.sheet.signed", { label: "LABEL" }, "Signed in (reported by LABEL)"],
  ["agents.sheet.speaks", undefined, "Uses ACP version 1 (initialize, session/new)"],
  ["agents.sheet.startFirst", undefined, "Start a session in a project folder first; the login tab opens there."],
  ["agents.sheet.testAgain", undefined, "Test again"],
  ["agents.sheet.testing", undefined, "Testing…"],
  ["agents.sheet.title", { label: "LABEL" }, "Set up LABEL"],
  ["agents.sheet.unclosed", undefined, "The command line has an unclosed quote."],
  ["chrome.closeTab", { name: "NAME" }, "Close tab NAME"],
  // Ticket 377 (F4 keys) added this key without its row here; ticket 603 adds the row.
  ["chrome.closeTip", undefined, "Close tab"],
  ["chrome.connected", undefined, "Connected"],
  ["chrome.disconnected", undefined, "Disconnected · reconnecting"],
  ["chrome.folded", { names: "NAMES" }, "NAMES folded to make room"],
  ["chrome.listSep", undefined, ", "],
  ["chrome.lastGood", undefined, "· using the last good layout"],
  ["chrome.newSession", undefined, "New session"],
  ["chrome.notSaved", { error: "ERROR" }, "layout not saved: ERROR"],
  ["chrome.paneMode", undefined, "Pane mode · hjkl focus · ⇧ swap · ⌃ resize · esc leave"],
  ["chrome.sessions", undefined, "Sessions"],
  ["chrome.stale", { n: 2 }, "stale 2"],
  ["chrome.stripRemoved", undefined, "answer strip removed: signals only (Layout)"],
  ["firstrun.addAccount", undefined, "Add another account"],
  ["firstrun.again", undefined, "Look again"],
  ["firstrun.agent", undefined, "Agent"],
  ["firstrun.agentsFound", undefined, "Agents found"],
  ["firstrun.approved", { label: "LABEL" }, "LABEL approved. Pick a project folder in “First project” and press New session…."],
  ["firstrun.check", undefined, "Check sign-in"],
  ["firstrun.existing", { total: "TOTAL" }, "Found TOTAL existing sessions in ~/.claude / ~/.codex (read only)"],
  ["firstrun.folder", undefined, "Folder"],
  ["firstrun.folderPlaceholder", undefined, "/path/to/project"],
  ["firstrun.found", undefined, "found"],
  ["firstrun.foundUnknown", undefined, "found (version unknown)"],
  ["firstrun.hintsEverywhere", undefined, "shows hints everywhere."],
  ["firstrun.install", undefined, "Install page ↗"],
  ["firstrun.keySheet", undefined, "Show key sheet"],
  ["firstrun.keys", undefined, "Keys"],
  ["firstrun.listsCommands", undefined, "lists all commands."],
  ["firstrun.login", undefined, "Sign in"],
  ["firstrun.loginOpened", { label: "LABEL", tab: "TAB" }, "Login for “LABEL” opened in the tab “TAB”."],
  ["firstrun.looking", undefined, "Looking for claude and codex…"],
  ["firstrun.macAccess", undefined, "macOS may ask for file access. In System Settings, allow Nunchiro under Files and Folders (Removable Volumes, or Desktop, Documents, Downloads), or turn on Full Disk Access. The agent asks for folder trust itself."],
  ["firstrun.name", undefined, "Name"],
  ["firstrun.needFolder", undefined, "Type the project folder first"],
  ["firstrun.newSession", undefined, "New session…"],
  ["firstrun.noAgent", undefined, "No agent found yet; step 1 shows where to get one."],
  ["firstrun.noChat", { label: "LABEL" }, "Chat view and waiting detection are not available for LABEL."],
  ["firstrun.notChecked", undefined, "Not checked"],
  ["firstrun.notFound", undefined, "Not found."],
  ["firstrun.optional", undefined, "optional"],
  ["firstrun.prefix", undefined, "Prefix"],
  ["firstrun.project", undefined, "First project"],
  ["firstrun.region", undefined, "Getting started"],
  ["firstrun.shell", undefined, "Shell"],
  ["firstrun.show", undefined, "Show"],
  ["firstrun.showStep", { title: "TITLE" }, "Show TITLE"],
  ["firstrun.signedIn", undefined, "Signed in"],
  ["firstrun.signedInStep", undefined, "Signed in"],
  ["firstrun.signedOut", undefined, "Signed out"],
  ["firstrun.skip", undefined, "Skip"],
  ["firstrun.skipStep", { title: "TITLE" }, "Skip TITLE"],
  ["firstrun.startShell", { label: "LABEL" }, "Start LABEL in a shell"],
  ["firstrun.terminalOnly", undefined, "terminal only"],
  ["firstrun.then", undefined, ", then"],
  ["firstrun.use", { label: "LABEL" }, "Use LABEL"],
  ["firstrun.useCheck", { label: "LABEL" }, "Use LABEL (check command)…"],
  ["firstrun.yourOwn", undefined, "Default:"],
  ["problem.details", undefined, "Details"],
  ["problem.fixCommand", undefined, "Fix command"],
  ["problem.hookless", undefined, "Without Nunchiro hooks, Nunchiro finds waiting sessions only by reading the screen. This is a little later, and it gives no hook details."],
  ["problem.install", undefined, "Install page ↗"],
  ["problem.login", undefined, "Sign in"],
  ["problem.machineStatus", undefined, "Machine status"],
  ["problem.machineUnknown", { label: "LABEL" }, "LABEL: unknown"],
  // Ticket 603: the missing-agent cause in the window's language (all eight in areas/common.ts).
  ["problem.notInstalled", { name: "NAME", program: "PROG" }, "NAME is not installed (PROG is not on PATH)."],
  // Ticket 604: every other fixed cause (areas/problem-causes.ts).
  ["problem.cause.acpNoAnswer", { name: "NAME" }, "NAME did not answer ACP: check its command."],
  ["problem.cause.acpRefused", undefined, "a Claude ACP agent needs ANTHROPIC_API_KEY (or CLAUDE_CODE_USE_BEDROCK with AWS_PROFILE or AWS_ACCESS_KEY_ID, or CLAUDE_CODE_USE_VERTEX with ANTHROPIC_VERTEX_PROJECT_ID) in its env names; Nunchiro never uses a Claude.ai login over ACP"],
  ["problem.cause.hookTrust", { name: "NAME" }, "NAME refused Nunchiro's hooks."],
  ["problem.cause.limit", { name: "NAME" }, "NAME usage limit reached."],
  ["problem.cause.limitReset", { name: "NAME", at: "AT" }, "NAME usage limit reached. Resets AT per NAME."],
  ["problem.cause.machineDown", { alias: "ALIAS" }, "Can't reach ALIAS."],
  ["problem.cause.machineVersion", { alias: "ALIAS" }, "ALIAS runs another Nunchiro version."],
  ["problem.cause.missing", { name: "NAME" }, "NAME is not installed."],
  ["problem.cause.setAside", undefined, "A sessions.json of another version was set aside. Saved scrollback and exports are not cleaned up until you remove it."],
  ["problem.cause.signedOut", { name: "NAME" }, "NAME is signed out."],
  ["problem.cause.unexpected", undefined, "Session ended unexpectedly."],
  ["problem.cause.unexpectedCode", { code: "CODE" }, "Session ended unexpectedly (exit code CODE)."],
  ["problem.openInstall", undefined, "Open install page"],
  ["problem.restart", undefined, "Restart"],
  ["problem.restartCore", undefined, "Restart background service"],
  ["problem.retry", undefined, "Retry"],
  ["problem.startWithout", undefined, "Start without Nunchiro hooks"],
  ["problem.startedHookless", undefined, "Started without Nunchiro hooks."],
  ["problem.switchAgent", undefined, "Switch agent"],
  ["problem.unreachable", undefined, "Can't reach Nunchiro's background service."],
  ["settings.accounts.add", undefined, "+ Add account"],
  ["settings.accounts.addGroup", { name: "NAME" }, "Add NAME account"],
  ["settings.accounts.addLogin", undefined, "Add and sign in"],
  ["settings.accounts.cancel", undefined, "Cancel"],
  ["settings.accounts.check", undefined, "Check"],
  ["settings.accounts.checkOwn", { name: "NAME", label: "LABEL" }, "Check NAME sign-in for LABEL"],
  ["settings.accounts.clean", undefined, "A new account starts empty. Skills, hooks, plugins and CLAUDE.md from ~/.claude are not loaded. Add what you need in Agent extensions."],
  ["settings.accounts.colAccount", undefined, "Account"],
  ["settings.accounts.colActions", undefined, "Actions"],
  ["settings.accounts.colFolder", undefined, "Config folder"],
  ["settings.accounts.colSessions", undefined, "Sessions"],
  ["settings.accounts.colSigned", undefined, "Signed in"],
  ["settings.accounts.colToday", undefined, "Today"],
  ["settings.accounts.colWeek", undefined, "7 days"],
  ["settings.accounts.confirm", { label: "LABEL", loss: "LOSS" }, "Remove “LABEL”? LOSS The agent’s own sign-out runs in a new terminal tab first. The folder stays in the trash for 7 days, then Nunchiro deletes it. You cannot undo this in Nunchiro."],
  ["settings.accounts.default", undefined, "default"],
  ["settings.accounts.didNotFinish", undefined, "did not finish"],
  ["settings.accounts.exited", { code: 2 }, "exited with 2"],
  ["settings.accounts.keep", undefined, "Keep account"],
  ["settings.accounts.kept", undefined, "Always kept"],
  ["settings.accounts.keychain", undefined, "Claude keeps its sign-in in the Keychain for each config folder, so removing the folder alone does not sign out. "],
  ["settings.accounts.lede", undefined, "Each account has its own config folder. Sign-in runs in a terminal tab you can see, with the agent’s own command. Nunchiro never reads credentials. The Today and 7 days columns count tokens from the agent’s local transcripts."],
  ["settings.accounts.limit", { when: "WHEN" }, "limit · resets WHEN"],
  ["settings.accounts.loggingOut", undefined, "Signing out in its terminal tab; the folder moves once it ends."],
  ["settings.accounts.loggingOutBtn", undefined, "Signing out…"],
  ["settings.accounts.loginOpened", { label: "LABEL", tab: "TAB" }, "Login for “LABEL” opened in the tab “TAB”."],
  ["settings.accounts.logout", undefined, "Logout"],
  ["settings.accounts.logoutOpened", { label: "LABEL", tab: "TAB" }, "Logout for “LABEL” opened in the tab “TAB”."],
  ["settings.accounts.logoutRemove", undefined, "Sign out and remove"],
  ["settings.accounts.loss.other", { n: 2 }, "2 sessions can no longer be resumed, and their usage history and search results are lost."],
  ["settings.accounts.loss.one", undefined, "1 session can no longer be resumed, and its usage history and search results are lost."],
  ["settings.accounts.name", undefined, "Name"],
  ["settings.accounts.nameRule", undefined, "1-64 characters. The sign-in opens in a new terminal tab."],
  ["settings.accounts.notChecked", undefined, "Not checked"],
  ["settings.accounts.notCounted", undefined, "not counted yet"],
  ["settings.accounts.partial", undefined, "Partial: the count stopped at its work limit"],
  ["settings.accounts.reading", undefined, "Reading accounts…"],
  ["settings.accounts.remove", undefined, "Remove…"],
  ["settings.accounts.removeAnyway", { label: "LABEL" }, "Remove “LABEL” anyway? This cannot be undone here."],
  ["settings.accounts.removeAnywayBtn", undefined, "Remove anyway"],
  ["settings.accounts.removeAria", { name: "NAME", label: "LABEL" }, "Remove NAME account LABEL"],
  ["settings.accounts.removeGroup", { label: "LABEL" }, "Remove account LABEL"],
  ["settings.accounts.removed", { label: "LABEL" }, "Removed “LABEL”. Its folder stays in the trash for 7 days."],
  ["settings.accounts.signedIn", undefined, "Signed in"],
  ["settings.accounts.signedOut", undefined, "Signed out"],
  ["settings.accounts.someLeft", undefined, "Some sign-in data may be left. "],
  ["settings.accounts.sub", undefined, "one config folder per account"],
  ["settings.accounts.unknown", undefined, "Unknown"],
  ["settings.accounts.viewUsage", undefined, "View usage →"],
  ["settings.accounts.viewUsageAria", { name: "NAME" }, "View usage for NAME"],
  ["settings.alerts.always", undefined, "waiting always shows in the tree"],
  ["settings.alerts.done", undefined, "When a session ends"],
  ["settings.alerts.every", undefined, "Every mode keeps the tab dot, the AGENTS dot and the menu bar count."],
  ["settings.alerts.off", undefined, "Off"],
  ["settings.alerts.offCap", undefined, "Clicking a tree row opens its answer card in that session tab."],
  ["settings.alerts.offTitle", undefined, "No answer strip"],
  ["settings.alerts.onCap", undefined, "A strip of cards, one for each agent that waits for your answer. The tree marks the session; you answer on its card."],
  ["settings.alerts.onTitle", undefined, "Answer strip"], // 02be66ec (needs 162, ticket 180): the strip moved under the composer
  ["settings.alerts.previewDone", undefined, "Preview the done sound"],
  ["settings.alerts.previewWaiting", undefined, "Preview the waiting sound"],
  ["settings.alerts.signalCap", undefined, "No cards. The tree only marks the session that waits and counts it; open the session to see the question."],
  ["settings.alerts.signalTitle", undefined, "Mark in the tree only"],
  ["settings.alerts.soundDone", undefined, "Sound when a session is done"],
  ["settings.alerts.soundWaiting", undefined, "Sound when a session is waiting"],
  ["settings.alerts.sounds", undefined, "Sounds"],
  ["settings.alerts.soundsNote", undefined, "macOS system sounds · muted sessions stay silent"],
  ["settings.alerts.title", undefined, "Waiting alerts"],
  ["settings.alerts.volume", undefined, "Sound volume"],
  ["settings.alerts.waiting", undefined, "When a session is waiting"],
  ["settings.appearance.allowCap", undefined, "Any program in a session can replace your clipboard."],
  ["settings.appearance.allowTitle", undefined, "Copy without asking"],
  ["settings.appearance.always", undefined, "Always shown"],
  ["settings.appearance.askCap", undefined, "A line above the terminal names the session and the size; nothing is copied until you press Copy."],
  ["settings.appearance.askTitle", undefined, "Ask"], // 309459ab (needs 150, Lane C copy): "· default" dropped
  ["settings.appearance.auto", undefined, "Auto-hide"],
  ["settings.appearance.autoCap", undefined, "Hidden until the pointer reaches the top edge of the window."],
  ["settings.appearance.clipboard", undefined, "Terminal clipboard"],
  ["settings.appearance.clipboardNote", undefined, "OSC 52 is a code that a terminal program (for example vim or tmux, also over SSH) sends to put text on your clipboard. Nunchiro never answers requests to read the clipboard."],
  ["settings.appearance.comfortable", undefined, "comfortable"],
  ["settings.appearance.compact", undefined, "compact"],
  ["settings.appearance.compactDefault", undefined, "Compact is the default."],
  ["settings.appearance.copyNote", undefined, "Off by default. Text you select with the mouse in a terminal is copied when you release the mouse button."],
  ["settings.appearance.custom", undefined, "Custom…"],
  ["settings.appearance.customList", undefined, "Custom font list"],
  ["settings.appearance.default", undefined, "Default"],
  ["settings.appearance.defaultSuffix", undefined, " · default"],
  ["settings.appearance.density", undefined, "Density"],
  ["settings.appearance.densityNote", undefined, "tree · agents · tab row height"],
  ["settings.appearance.denyCap", undefined, "Programs cannot write the clipboard."],
  ["settings.appearance.denyTitle", undefined, "Never"],
  ["settings.appearance.fontError", { value: "VALUE" }, "Font names separated by commas; a quoted name needs its closing quote. The terminal keeps VALUE."],
  ["settings.appearance.fontNote", undefined, "Coding fonts installed on this Mac, or your own list. Icons and symbols a font lacks use the fonts that come with Nunchiro."],
  ["settings.appearance.fontsInstalled", undefined, "Coding fonts installed on this Mac, ~/Library/Fonts included."],
  ["settings.appearance.heights", { tree: 2, agents: 2, tabs: 2 }, "tree 2 · agents 2 · tabs 2 px"],
  ["settings.appearance.hidden", undefined, "Hidden"],
  ["settings.appearance.hiddenCap", undefined, "Edit layout and Show title bar stay in the command palette."],
  ["settings.appearance.osc52", undefined, "When a program asks to set the clipboard (OSC 52)"],
  ["settings.appearance.row", { px: 2 }, "row 2 px"],
  ["settings.appearance.spacious", undefined, "spacious"],
  ["settings.appearance.symbolsMissing", { font: "FONT" }, "FONT is not installed."],
  ["settings.appearance.symbolsNote", undefined, "On by default; Nunchiro includes this font. Prompt symbols use Symbols Nerd Font Mono. Your main font stays."],
  ["settings.appearance.symbolsOnly", { font: "FONT" }, "FONT is the only font in the list, so it stays; pick another font first."],
  ["settings.appearance.symbolsTooLong", { font: "FONT" }, "Adding FONT would go over the 200-character limit of the font list; shorten it in Custom… first."],
  ["settings.appearance.tab", undefined, "tab"],
  ["settings.appearance.termDefault", undefined, "Default 12 px"],
  ["settings.appearance.sampleAsk", undefined, "Fix the failing test in api/"], // Q5-7 (ticket 991)
  ["settings.appearance.sampleDone", undefined, "Done: 3 files changed, tests pass."],
  ["settings.appearance.titleNote", undefined, "When the title bar is hidden, Edit layout and Show title bar are still in the command palette."],
  ["settings.keys.advanced", undefined, "Advanced"],
  ["settings.keys.alphabet", undefined, "Hint alphabet"],
  ["settings.keys.anyKeys", undefined, "Use any keys. The first key makes the shortest labels. Press a key below to add or remove it. Each key can be used once."],
  ["settings.keys.bindings", undefined, "Key bindings"],
  ["settings.keys.bindingsNote", undefined, "every action is a command · press its direct shortcut, or press a key right after your prefix"],
  ["settings.keys.boundTo", undefined, "Bound to"],
  ["settings.keys.cancel", undefined, "Cancel"],
  ["settings.keys.changed", undefined, "Changed by you"],
  ["settings.keys.changedComma", undefined, ", changed by you"],
  ["settings.keys.clearKey", undefined, "Clear the key"],
  ["settings.keys.cleared", { title: "TITLE" }, "Cleared the search to show TITLE."],
  ["settings.keys.clickJump", undefined, "click a key to jump to its command"],
  ["settings.keys.conflicts", { list: "LIST" }, "conflicts with LIST"],
  ["settings.keys.copyMode", undefined, "Copy mode"],
  ["settings.keys.default", undefined, "Default"],
  ["settings.keys.directChord", undefined, "Direct chord"],
  ["settings.keys.directChords", undefined, "Direct chords"],
  ["settings.keys.edit", undefined, "Edit"],
  ["settings.keys.editRow", { title: "TITLE" }, "Edit TITLE"],
  ["settings.keys.fewKeys", undefined, "Kind keys leave fewer than two keys for labels: add more keys to the alphabet."],
  ["settings.keys.find", undefined, "Find a command or key"],
  ["settings.keys.fixed", undefined, "fixed keys"],
  ["settings.keys.followLayout", undefined, "Key labels follow your keyboard layout."],
  ["settings.keys.helpAfter", undefined, "Prefix help after"],
  ["settings.keys.helpAtOnce", undefined, "shows it at once)"],
  ["settings.keys.helpDelay", undefined, "Prefix help delay (ms, 0 = off)"],
  ["settings.keys.helpMs", undefined, "ms with no next key (0 = off;"],
  ["settings.keys.hintKeys", undefined, "Hint keys"],
  ["settings.keys.keyChanged", undefined, "a key you changed"],
  ["settings.keys.keyFor", { title: "TITLE" }, "Key for TITLE"],
  ["settings.keys.keyLabels", undefined, "Key labels"],
  ["settings.keys.keyMap", undefined, "Key map"],
  ["settings.keys.keyboard", undefined, "Keyboard"],
  ["settings.keys.keyboardNote", undefined, "every key after your prefix"],
  ["settings.keys.kindKey", { kind: "KIND" }, "KIND kind key"],
  ["settings.keys.kindKeys", undefined, "Kind keys"],
  ["settings.keys.kindOf", { kind: "KIND" }, "KIND kind"],
  ["settings.keys.kind_hash", undefined, "Commit IDs (hashes)"],
  ["settings.keys.kind_left", undefined, "Left bar icons"],
  ["settings.keys.kind_other", undefined, "Other"],
  ["settings.keys.kind_pane", undefined, "Panes and splits"],
  ["settings.keys.kind_path", undefined, "Files and paths"],
  ["settings.keys.kind_project", undefined, "Projects"],
  ["settings.keys.kind_right", undefined, "Right bar icons"],
  ["settings.keys.kind_session", undefined, "Sessions"],
  ["settings.keys.kind_tab", undefined, "Tabs"],
  ["settings.keys.kind_url", undefined, "URLs"],
  ["settings.keys.labelKey", { n: 2 }, "label key 2"],
  ["settings.keys.leave", undefined, "leave"],
  ["settings.keys.legendHint", undefined, "Hint keys (labels use these, in this order)"],
  ["settings.keys.modeKeys", undefined, "Mode keys"],
  ["settings.keys.modeNote", undefined, "copy mode and pane mode · fixed"],
  ["settings.keys.none", undefined, "none"],
  ["settings.keys.notKey", { key: "KEY" }, "“KEY” is not a key on the keyboard shown here."],
  ["settings.keys.onDrawing", undefined, "Keys on the drawing"],
  ["settings.keys.paneKeys", { dir: "DIR" }, "focus DIR · ⇧ swap · ⌃ resize"],
  ["settings.keys.paneMode", undefined, "Pane mode"],
  ["settings.keys.prefixEq", undefined, "prefix ="],
  ["settings.keys.prefixWord", undefined, "prefix"],
  ["settings.keys.pressDigit", undefined, "press a digit 1-9 (the nine move together)… (Esc cancels)"],
  ["settings.keys.pressKeys", undefined, "press keys… (Esc cancels)"],
  ["settings.keys.pressOne", undefined, "press a key… (Esc cancels)"],
  ["settings.keys.pressToFind", undefined, "Press a key to find"],
  ["settings.keys.previewLabel", undefined, "Live preview of hint labels in a mock window"],
  ["settings.keys.replace", undefined, "Replace"],
  ["settings.keys.reset", undefined, "Reset to defaults"],
  ["settings.keys.save", undefined, "Save"],
  ["settings.keys.struck", undefined, "Crossed-out keys are used as kind keys, so labels do not use them. They return when you change the kind key."],
  ["settings.keys.tabN", { n: 2 }, "Tab 2"],
  ["settings.keys.tabsDiffer", undefined, "The nine tab keys are not the same. Edit or Default sets all nine."],
  ["settings.keys.thePrefix", undefined, "the prefix"],
  ["settings.keys.thenKey", undefined, "then a key"],
  ["settings.keys.twoKeys", undefined, "Enter at least two keys. One key can make only one hint label."],
  ["settings.keys.underPointer", undefined, "the key under the pointer"],
  ["settings.keys.usedAsKind", undefined, "used as kind key"],
  ["settings.keys.usedInLabels", undefined, "Keys used in labels"],
  ["settings.keys.usedNotLabel", undefined, "used as kind key, not in labels"],
  ["settings.keys.views", undefined, "Keyboard views"],
  ["settings.keys.withoutAKey", undefined, "Without a key"],
  ["settings.keys.withoutKey.one", { n: 2 }, "2 command without a key"],
  ["settings.keys.withoutKey.other", { n: 2 }, "2 commands without a key"],
  ["settings.layout.chat", undefined, "Agent chat"],
  ["settings.layout.chatCap", undefined, "A new agent session in this session’s folder, with the New Session defaults."],
  ["settings.layout.chooser", undefined, "Chooser"], // 309459ab (needs 150, Lane C copy): "· default" dropped
  ["settings.layout.chooserCap", undefined, "The new split first shows a list (the chooser): pick an agent, a terminal or a widget there."],
  ["settings.layout.chooserName", undefined, "Chooser"],
  ["settings.layout.newSplit", undefined, "Open in a new split"],
  ["settings.layout.noKey", undefined, "no split key bound (Settings › Keys)"],
  ["settings.layout.terminal", undefined, "Terminal"],
  ["settings.layout.terminalCap", undefined, "A new shell in this session’s folder."],
  ["settings.libraries.auto", undefined, "Auto-allow (cdnjs only)"],
  ["settings.libraries.autoNote", undefined, "Auto-allow exact versions that match the manifest"],
  ["settings.libraries.broken", undefined, "The library list on disk is broken or from a newer Nunchiro, so it was left as it is. Changes here last until Nunchiro quits."],
  ["settings.libraries.colActions", undefined, "Actions"],
  ["settings.libraries.colAsked", undefined, "First asked by"],
  ["settings.libraries.colBadge", undefined, "Badge"],
  ["settings.libraries.colFetched", undefined, "Fetched"],
  ["settings.libraries.colFile", undefined, "File"],
  ["settings.libraries.colHost", undefined, "Host"],
  ["settings.libraries.colLibrary", undefined, "Library"],
  ["settings.libraries.lede", undefined, "These are libraries you allowed for artifacts. Each is one file at one exact version, fetched once and served from this Mac. If you remove one, the next page that needs it asks again."],
  ["settings.libraries.matches", undefined, "Matches cdnjs"],
  ["settings.libraries.none", undefined, "No libraries yet. A page that loads one from a CDN shows a card to allow it."],
  ["settings.libraries.reading", undefined, "Reading libraries…"],
  ["settings.libraries.remove", undefined, "Remove"],
  ["settings.libraries.removeOne", { name: "NAME" }, "Remove NAME"],
  ["settings.libraries.sub", undefined, "fixed to one exact file, works offline"],
  ["settings.libraries.title", undefined, "Artifact libraries"],
  ["settings.libraries.unverified", undefined, "Unverified"],
  ["settings.lifetime.cancel", undefined, "Cancel"],
  ["settings.lifetime.closeNote", { fullQuit: "FULLQUIT" }, "Closing the window leaves your agents working. The menu bar icon stays. You still get a notification, without sound, with the number of agents that wait. To end everything, use “Quit and stop all agents” (FULLQUIT) or"],
  ["settings.lifetime.closeWindow", undefined, "Close the window"],
  ["settings.lifetime.closing", undefined, "Closing the window"],
  ["settings.lifetime.dropped", undefined, "Nunchiro discards them. You cannot answer them after a restart. Nunchiro does not send them again."],
  ["settings.lifetime.keepRunning", undefined, "Agents keep running"],
  ["settings.lifetime.keepWindow", undefined, "Keep the window"],
  ["settings.lifetime.none", undefined, "none"],
  ["settings.lifetime.once", undefined, ". This notice shows once."],
  ["settings.lifetime.pending", { n: 2 }, "Pending queue items (2)"],
  ["settings.lifetime.prNote", undefined, "Off by default. While this window is in front, Nunchiro runs the GitHub CLI (gh) once a minute. It makes one call per repository, for PRs your agents opened or that you watch. Nunchiro reads no token."],
  ["settings.lifetime.quit", undefined, "Quit and stop all agents"],
  ["settings.lifetime.quitAsk", undefined, "Quit and stop all agents?"],
  ["settings.lifetime.quitEnds.one", { n: 2 }, "This ends the 2 running agent below and the background service. Nunchiro offers to resume each session next time."],
  ["settings.lifetime.quitEnds.other", { n: 2 }, "This ends the 2 running agents below and the background service. Nunchiro offers to resume each session next time."],
  ["settings.lifetime.resume", undefined, "Resume"],
  ["settings.lifetime.resumeOne", { name: "NAME" }, "Resume NAME"],
  ["settings.lifetime.resumeRegion", undefined, "Sessions to resume"],
  ["settings.lifetime.resumeTitle", undefined, "Resume where you left off"],
  ["settings.lifetime.running", { n: 2 }, "Running agents (2)"],
  ["settings.lifetime.stopping", undefined, "Stopping…"],
  ["settings.theme.browseNote", undefined, "The list loads when this page opens. Theme files load only for the cards on screen. Everything comes from GitHub (iTerm2-Color-Schemes)."],
  ["settings.theme.builtinFailed", undefined, "The built-in themes did not load."],
  ["settings.theme.chipAll", undefined, "All"],
  ["settings.theme.chipDark", undefined, "Dark"],
  ["settings.theme.chipInstalled", undefined, "Installed"],
  ["settings.theme.chipLight", undefined, "Light"],
  ["settings.theme.credits", undefined, "Theme credits"],
  ["settings.theme.creditsLink", undefined, "credits"],
  ["settings.theme.creditsNote", undefined, "Catalog themes come from iTerm2-Color-Schemes (MIT, Copyright (c) 2011 to Present Mark Badolato). Each theme keeps its author's licence and notice:"],
  ["settings.theme.didNotLoad", undefined, "Did not load"],
  ["settings.theme.follow", undefined, "Follow the system"],
  ["settings.theme.from", undefined, "Themes from iTerm2-Color-Schemes (MIT) ·"],
  ["settings.theme.fullTexts", undefined, "Full licence texts"],
  ["settings.theme.hide", undefined, "Hide"],
  ["settings.theme.importAdd", undefined, "Add"],
  ["settings.theme.importFormat", undefined, "Ghostty format: background, foreground, palette = N=#rrggbb, cursor and selection colours. Other lines are ignored."],
  ["settings.theme.importFull", { cap: 2 }, "You have 2 imported themes; remove one to add another."],
  ["settings.theme.importName", undefined, "Name"],
  ["settings.theme.importOpen", undefined, "Or open a file"],
  ["settings.theme.importSource", undefined, "Source (optional)"],
  ["settings.theme.importText", undefined, "Theme file text"],
  ["settings.theme.installFull", { cap: 2 }, "You have 2 imported themes; remove one to install another."],
  ["settings.theme.installed", undefined, "Installed"],
  ["settings.theme.lightDark", { light: "LIGHT", dark: "DARK" }, "Light: LIGHT · Dark: DARK"],
  ["settings.theme.loading", undefined, "Loading online themes…"],
  ["settings.theme.mode", undefined, "Theme mode"],
  ["settings.theme.more", undefined, "More online themes"],
  ["settings.theme.movedDark", undefined, "dark mode now uses Nunchiro Dark"],
  ["settings.theme.movedFixed", { name: "NAME" }, "the one theme is now NAME"],
  ["settings.theme.movedLight", undefined, "light mode now uses Nunchiro Light"],
  ["settings.theme.noMatch", { query: "QUERY" }, "No theme matches “QUERY”."],
  ["settings.theme.notInstalled", undefined, "Not installed"],
  ["settings.theme.notStated", undefined, "not stated"],
  ["settings.theme.one", undefined, "One theme"],
  ["settings.theme.oneTheme", { name: "NAME" }, "One theme: NAME"],
  ["settings.theme.options", { name: "NAME" }, "Options for NAME"],
  ["settings.theme.remove", undefined, "Remove"],
  ["settings.theme.retry", undefined, "Retry"],
  ["settings.theme.search", undefined, "Search themes"],
  ["settings.theme.show", undefined, "Show"],
  ["settings.theme.showHidden", { n: 2 }, "Show hidden (2)"],
  ["settings.theme.themes", undefined, "Themes"],
  ["settings.theme.tooLarge", { kib: 2 }, "That file is too large for a theme (2 KiB at most)."],
  ["settings.theme.tryAgain", undefined, "Try again"],
  ["settings.theme.undoHid", { name: "NAME" }, "Hid theme NAME"],
  ["settings.theme.undoRemoved", { name: "NAME" }, "Removed theme NAME"],
  ["settings.theme.unreadable", undefined, "Could not read that file."],
  ["settings.theme.useDark", undefined, "Use for dark"],
  ["settings.theme.useLight", undefined, "Use for light"],
  ["settings.theme.wasInUse", { name: "NAME", moved: "MOVED" }, "NAME was in use, so MOVED."],
];

test('english_text_unchanged: every new EN key holds exactly the string the source had on main', () => {
  const t = makeT('en', 'en-US');
  for (const [key, args, was] of BEFORE) expect(t(key as never, args), key).toBe(was);
  // No new key without a row above, and none above that is not in the catalogue.
  expect(BEFORE.map(([k]) => k).sort()).toEqual([...NEW].sort());
});

test('fallback_per_string: an injected ko table with one new key shows Korean there and English elsewhere', () => {
  expect(NEW.length).toBeGreaterThan(100);
  const [one, other] = [NEW[0], NEW[NEW.length - 1]];
  const t = makeT('ko', 'en-US', { en: EN, ko: { [one]: '한국어' } });
  expect(t(one as never)).toBe('한국어');
  expect(t(other as never)).toBe(EN[other as keyof typeof EN]);
  expect(makeT('fr', 'en-US', { en: EN, ko: { [one]: '한국어' } })(one as never)).toBe(EN[one as keyof typeof EN]);
});

// Look 1117 v6r (C, wording list): a Settings row that carries a technical name or a word of Nunchiro's own says in the
// same row what it is, in plain words (English; the other languages are read at the end on the settled text).
test('settings_rows_explain_their_terms_en: the eleven texts the look named', () => {
  const t = makeT('en', 'en-US');
  const rows: [string, RegExp][] = [
    ['notes.lede', /A teammate \(Settings > Team\) reads/],
    ['settings.alerts.onCap', /strip of cards, one for each agent that waits/],
    ['settings.alerts.signalCap', /^No cards\. The tree only marks/],
    ['settings.appearance.clipboardNote', /^OSC 52 is a code that a terminal program/],
    ['terminal.optionNote', /^Meta is the key that shells and editors use/],
    ['chatType.mathNote', /KaTeX draws them/],
    ['settings.kbd.prefixTitle', /^Prefix \(the key before a command's key\)$/],
    ['settings.layout.chooserCap', /first shows a list \(the chooser\)/],
    ['bprefs.uaDesc', /^The name this browser gives to websites/],
    ['settings.extensions.skillAbout', /It comes with Nunchiro/], // eighth look (C): "Shipped" read as jargon: the chip says "Built in"
    ['extView.shipped', /^Built in$/],
    ['settings.alerts.signalTitle', /^Mark in the tree only$/],
    ['orch.enabledHint', /^This skill teaches an agent to split a task among other agent sessions.*It comes with Nunchiro/],
  ];
  for (const [key, says] of rows) expect(t(key as never), key).toMatch(says);
  expect(t('notes.lede' as never)).not.toMatch(/\bseat\b/);
});

// Seventh and eighth look (C): the Japanese Close button read "設定 を閉じる", with a stray space before the particle.
test('ja_close_label_has_no_stray_space', () => {
  expect(makeT('ja', 'en-US')('mw.agents.close' as never, { name: '設定' })).toBe('設定を閉じる');
});
