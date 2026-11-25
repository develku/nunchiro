// Ticket 276 (needs 197, 198; G16): Settings > Agent extensions in the agents group (ticket 391: renamed Skills & hooks). The core ops land in phase 2, so
// the window's `extensions_list` and `widget_list` requests are answered here; every other frame goes to the real core.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { ownerOk } from './acp-fakes';
import { expect, openWindow, test } from './fixtures';

const LIST = {
  dir: '~/.nunchiro/extensions/',
  items: [
    { id: 'nunchiro', name: 'Nunchiro skill', kind: 'skill', source: 'default' },
    { id: 'custom:lint-hook', name: 'lint-hook', kind: 'hook', source: 'custom' },
  ],
  mcp: [{ agent: 'claude', name: 'github', command: ['/Users/me/.local/bin/gh-mcp', '--stdio'], env: ['GITHUB_TOKEN'] }],
  own: [],
};
const WIDGETS = {
  enabled: true,
  unavailable: null,
  web_enabled: true,
  widgets: [
    { name: 'clock', state: 'approved', kind: 'script', author: 'me', interval_secs: 60, error: null },
    { name: 'weather', state: 'changed', kind: 'web', author: 'me', interval_secs: null, error: null },
  ],
};
const STUB: Record<string, unknown> = { extensions_list: LIST, widget_list: { list: WIDGETS } };

/** Answers the stubbed ops from the window; the rest passes through. */
async function stub(app: Page, over: Record<string, unknown> = {}, seen: { op: string; command?: string[] }[] = []) {
  const answers = { ...STUB, ...over };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      const op = msg?.request?.op as string | undefined;
      if (op) seen.push(msg.request);
      if (op && op in answers) return ws.send(JSON.stringify({ id: msg.id, response: { Ok: answers[op] } }));
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
}

/** The visible route: the Settings button, then the nav item (two clicks). */
async function openExtensions(app: Page) {
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Skills & hooks' }).click();
  await expect(app.getByRole('heading', { level: 1, name: 'Skills & hooks', exact: true })).toBeVisible();
}
const widgets = (app: Page) => app.locator('section[data-section="widgets"]');

test('extensions_page_in_agents_group_within_two_clicks: the page sits in the agents group and shows skills and read-only MCP', async ({ app }) => {
  await stub(app);
  await openWindow(app);
  await openExtensions(app);
  const nav = app.getByRole('navigation', { name: 'Settings pages' });
  // The page's button sits in the agents group, after Providers, Usage and Schedules (scene c).
  await expect(nav.locator('[data-group="agents"] button[data-page]')).toHaveText(['Providers', 'Usage', 'Team', 'Assistants', 'Notes', 'Skills & hooks']); // Team: ticket 970; Assistants: Home assistants; Notes: ticket 990 (21ef73729); Schedules left for its widget: ticket 993
  // Ticket 391: the shipped skill sits in the Nunchiro defaults card, on; Skills and hooks lists custom folders only, off by default.
  const base = app.getByRole('region', { name: 'Nunchiro defaults' });
  await expect(base.getByRole('switch', { name: 'Nunchiro skill' })).toBeChecked();
  await expect(base.getByRole('switch')).toHaveCount(3);
  const skills = app.locator('section[aria-labelledby="h-ext-skills"]');
  await expect(skills.getByRole('switch')).toHaveCount(1);
  await expect(skills.getByRole('switch', { name: 'lint-hook' })).not.toBeChecked();
  await expect(app.getByRole('heading', { name: 'Your extensions' })).toBeVisible();
  // MCP: listed with the env name only, and no remove control on the agent's own server.
  const mcp = app.locator('[data-mcp="agents"]');
  await expect(mcp).toContainText('github');
  await expect(mcp).toContainText('GITHUB_TOKEN');
  await expect(mcp.getByRole('button')).toHaveCount(0);
  // Ticket 471: the home folder reads as ~, as everywhere else in the app.
  await expect(mcp).toContainText('claude: ~/.local/bin/gh-mcp --stdio');
  await expect(mcp).not.toContainText('/Users/');
});

test('agent_config_too_large_is_named_not_empty: a config past the core read cap shows its size, not "No MCP servers"', async ({ app }) => {
  await stub(app, { extensions_list: { ...LIST, mcp: [], mcp_too_large: [{ file: '~/.claude.json', bytes: 20 * 2 ** 20 }] } });
  await openWindow(app);
  await openExtensions(app);
  const mcp = app.locator('[data-mcp="agents"]');
  await expect(mcp).toContainText('~/.claude.json is too large to read (20 MB).');
  await expect(mcp).not.toContainText('No MCP servers configured');
});

test('widgets_section_links_library_and_shows_approval_read_only: the link opens the Widget library; states are text', async ({ app }) => {
  await stub(app);
  await openWindow(app);
  await openExtensions(app);
  await expect(widgets(app).locator('[data-row="widget:clock"]')).toContainText('approved');
  await expect(widgets(app).locator('[data-row="widget:weather"]')).toContainText('changed since approval');
  await widgets(app).getByRole('button', { name: 'Open Widget library' }).click();
  await expect(app.getByRole('complementary', { name: 'Widget library' })).toBeVisible();
  // Look 1117 v16 C: Settings closes first, so the edit bar (Done, Cancel) is not left behind the sheet.
  await expect(app.getByRole('dialog', { name: 'Settings' })).toBeHidden();
});

// F24: an old core answers an op it does not know with this fixed refusal; the window never shows it raw.
test('old_core_refusal_reads_as_a_plain_sentence: an op the core does not know says the core is older', async ({ app }) => {
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request?.op === 'extensions_list') return ws.send(JSON.stringify({ id: msg.id, response: { Err: 'malformed request' } }));
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await openWindow(app);
  await openExtensions(app);
  await expect(app.getByText("The background service is older than this window").first()).toBeVisible();
  await expect(app.getByText('malformed request')).toHaveCount(0);
});

// F24: a kept old core is named in plain words, and the notice leaves with the boot the shell hands after the swap.
test('kept_core_notice_leaves_when_the_core_is_replaced: the toast follows the boot object', async ({ app }) => {
  await openWindow(app, { coreKept: true });
  const notice = app.locator('.toast', { hasText: 'the old background service still runs' });
  await expect(notice).toBeVisible();
  await app.evaluate(() => {
    window.__NUNCHIRO__ = { ...window.__NUNCHIRO__!, coreKept: false };
    window.dispatchEvent(new Event('nunchiro:boot'));
  });
  await expect(notice).toHaveCount(0);
});

test('widgets_section_has_no_toggle: no switch, checkbox or approve control in the widgets section', async ({ app }) => {
  await stub(app);
  await openWindow(app);
  await openExtensions(app);
  await expect(widgets(app).locator('[data-row^="widget:"]')).toHaveCount(2);
  await expect(widgets(app).getByRole('switch')).toHaveCount(0);
  await expect(widgets(app).getByRole('checkbox')).toHaveCount(0);
  await expect(widgets(app).getByRole('button')).toHaveCount(1); // the library link alone
});

test('mcp_command_keeps_quotes_and_spaces_as_arguments: the core gets the exact words and the row reads back to them', async ({ app }) => {
  const words = ['/Applications/My Tools/srv', '--name', 'a b', "it's", '--x=1'];
  const frames: { op: string; command?: string[] }[] = [];
  await stub(app, { extensions_mcp_add: { ...LIST, own: [{ agent: 'nunchiro', name: 'srv', command: words, env: [] }] } }, frames);
  await openWindow(app);
  await openExtensions(app);
  const own = app.locator('[data-mcp="own"]');
  await own.getByRole('textbox', { name: 'Server name' }).fill('srv');
  const command = own.getByRole('textbox', { name: 'Command' });
  const add = own.getByRole('button', { name: 'Add for Nunchiro sessions' });
  // An unclosed quote is refused, not split into guessed words.
  await command.fill('/bin/srv "a b');
  await expect(own.locator('[data-field="mcp-problem"]')).toHaveText('The command line has an unclosed quote.');
  await expect(add).toBeDisabled();
  await command.fill(`"/Applications/My Tools/srv" --name 'a b' "it's" --x=1`);
  await add.click();
  await expect.poll(() => frames.find((f) => f.op === 'extensions_mcp_add')?.command).toEqual(words);
  await expect(own).toContainText(String.raw`nunchiro: '/Applications/My Tools/srv' --name 'a b' 'it'\''s' --x=1`);
});

test('extensions_rows_reach_the_settings_search: a search result opens the page on its control', async ({ app }) => {
  await stub(app);
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('searchbox').fill('MCP servers');
  await app.getByRole('button', { name: /MCP servers/ }).first().click();
  await expect(app.getByRole('heading', { level: 1, name: 'Skills & hooks', exact: true })).toBeVisible();
  await expect(app.locator('[data-mcp="own"]').getByRole('textbox', { name: 'Command' })).toBeFocused(); // ticket 1123: the one field comes first
});

// Ticket 391: the shipped skill's switch moved into the Nunchiro defaults card, and the custom rows still write the same list.
test('nunchiro_skill_off_survives_a_custom_toggle: turning a custom folder on keeps the shipped skill off', async ({ app, core }) => {
  await stub(app);
  await openWindow(app);
  await openExtensions(app);
  const stored = () => JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features?.['extensions.enabled'];
  // The switches follow the core's reply, so a click, then the stored value.
  await app.getByRole('region', { name: 'Nunchiro defaults' }).getByRole('switch', { name: 'Nunchiro skill' }).click();
  await expect.poll(stored).toEqual([]);
  await app.getByRole('switch', { name: 'lint-hook' }).click();
  await app.getByRole('alertdialog', { name: 'Turn on lint-hook?' }).getByRole('button', { name: 'Turn on', exact: true }).click(); // ticket 456
  await expect.poll(stored).toEqual(['custom:lint-hook']);
  await expect(app.getByRole('switch', { name: 'Nunchiro skill' })).not.toBeChecked();
});

// Ticket 991 C11: a skill the user made can be removed in the app: Remove asks first and says where the folder goes; the
// folder moves under extensions/.removed (files kept), the row leaves, and its switch is off first.
test('custom_item_remove_C11: Remove asks, then moves the folder aside and drops the row and its switch', async ({ app, core }) => {
  ownerOk(core, { op: 'extensions_skill_new', name: 'review', description: 'Checks a diff.', hook: false });
  ownerOk(core, { op: 'quit_settings', patch: { features: { 'extensions.enabled': ['nunchiro', 'custom:review'] }, extensions_confirmed: ['custom:review'] } });
  await openWindow(app);
  await openExtensions(app);
  await app.getByRole('button', { name: 'Remove review', exact: true }).click();
  const ask = app.getByRole('group', { name: 'Remove review', exact: true });
  await expect(ask).toContainText('extensions/.removed, so its files are kept');
  await ask.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(app.getByRole('switch', { name: 'review' })).toHaveCount(0);
  const removed = fs.readdirSync(path.join(core.home, 'extensions/.removed'));
  expect(removed).toHaveLength(1);
  expect(fs.existsSync(path.join(core.home, 'extensions/.removed', removed[0], 'skills/review/SKILL.md'))).toBe(true);
  const stored = JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features?.['extensions.enabled'];
  expect(stored).toEqual(['nunchiro']);
});
