// Ticket 475 (453 step 2, pick B): a Settings control that cannot work right now says why in one line on its row
// (`[data-why]`, the kit's Why) and offers the fix. Seeded conditions: gh missing, GitHub not signed in, notifications
// blocked, the browser build (no Nunchiro app). Then every page: a disabled control points at a why line through
// aria-describedby, unless it is busy (aria-busy), a stepper end (tabindex -1) or has nothing to act on yet (data-idle).
// Real core; the fixture core's PATH is its bin folder then /usr/bin:/bin, so gh is missing until a stub is written.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { STORE_VERSION } from '../src/settings';
import { agentsToml, ownerOk, tomlEntry } from './acp-fakes';
import { openAdd, openRow } from './accounts-rows';
import { expect, openWindow, test, type Core } from './fixtures';
import { openSettings } from './settings-modal';
import { openWidget } from './schedules-seed';

test.beforeEach(({ core }) => void core.shell(core.project('demo'), 'alpha'));

const stub = (core: Core, name: string, body: string) => fs.writeFileSync(path.join(core.home, 'bin', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
const ghOut = `[ "$1" = --version ] && { echo "gh version 2.62.0 (2024-11-14)"; exit 0; }\nif [ "$1 $2" = "auth login" ]; then echo "gh login ran"; exec /bin/cat; fi\necho "You are not logged into any GitHub hosts." >&2; exit 1`;

/** Every agent turned off in Providers (ticket 358's Use switch), seeded once before the first load. */
const agentsOff = (app: Page) =>
  app.addInitScript((version) => {
    if (sessionStorage.getItem('seeded')) return;
    localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ version, features: { 'agents.off': ['claude', 'codex'] } }));
    sessionStorage.setItem('seeded', '1');
  }, STORE_VERSION);

async function go(app: Page, id: string) {
  await openWindow(app);
  await openSettings(app);
  await app.locator(`.settings > nav button[data-page="${id}"]`).click();
}
const body = (app: Page) => app.locator('.sbody');
const opened = (app: Page) =>
  app.evaluate(() => {
    const w = window as unknown as { __opened: string[]; open: unknown };
    w.__opened = [];
    w.open = (url: string) => (w.__opened.push(url), null);
  });
const openedUrls = (app: Page) => app.evaluate(() => (window as unknown as { __opened: string[] }).__opened);

/** The why line a control points at, through aria-describedby. */
async function whyOf(app: Page, control: ReturnType<Page['locator']>) {
  const ids = (await control.getAttribute('aria-describedby')) ?? '';
  return app.locator(ids.split(/\s+/).filter(Boolean).map((id) => `[id="${id}"][data-why]`).join(', ') || '[data-why="none"]');
}

test('why_gh_missing: Live PR status is off, says gh is not installed, and How to install opens the gh page', async ({ app }) => {
  await go(app, 'git');
  const live = body(app).getByRole('switch', { name: 'Live PR status (uses your gh)', exact: true });
  await expect(live).toBeDisabled();
  // It stays focusable (aria-disabled) so the palette's jump lands on it, and Space does not turn it on.
  await live.focus();
  await app.keyboard.press('Space');
  await expect(live).not.toBeChecked();
  const why = await whyOf(app, live);
  await expect(why).toHaveText(/gh is not installed, so this cannot be turned on\./);
  await opened(app);
  await why.getByRole('button', { name: 'Install guide', exact: true }).click();
  await expect.poll(() => openedUrls(app)).toEqual(['https://cli.github.com/']);
});

test('why_gh_signed_out: Live PR status says GitHub is not signed in, and Sign in opens the gh login tab', async ({ app, core }) => {
  stub(core, 'gh', ghOut);
  await go(app, 'git');
  const live = body(app).getByRole('switch', { name: 'Live PR status (uses your gh)', exact: true });
  const row = body(app).locator('[data-row="livePrStatus"]');
  const why = row.locator('[data-why]');
  await expect(why).toHaveText(/GitHub is not signed in/);
  await expect(live).toBeEnabled();
  await why.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Eighth look (C): a sign-in asks before it opens a terminal, in GitHub's row.
  await app.locator('[data-provider="github"]').getByRole('group', { name: 'Open a terminal tab to sign in with gh?' }).getByRole('button', { name: 'Open terminal', exact: true }).click();
  await expect(app.locator('.tab').filter({ hasText: 'Login: gh' })).toBeVisible();
  const tab = core.cli('snapshot', '--json').sessions.find((s: { label: string }) => s.label === 'Login: gh');
  await expect.poll(() => core.read(tab.id)).toContain('gh login ran');
});

// No button: the window capability may not open the Notifications pane (permission-needed.spec.ts), so the line says where.
test('why_notifications_blocked: the system row says macOS blocks them and where to turn them on', async ({ app }) => {
  await app.addInitScript(() => Object.defineProperty(Notification, 'permission', { get: () => 'denied' }));
  await go(app, 'alerts');
  const why = body(app).locator('[data-why="notifications"]');
  await expect(why).toHaveText('macOS is not delivering notifications for Nunchiro. Turn them on in System Settings > Notifications > Nunchiro.');
  await expect(why.getByRole('button')).toHaveCount(0);
});

test('why_needs_app: browser profile Clear says it needs the Nunchiro app on its row, not in a tooltip', async ({ app }) => {
  await go(app, 'inapp-browser');
  const clear = body(app).getByRole('button', { name: /^Clear cookies and site data: / }).first();
  await expect(clear).toBeDisabled();
  await expect(clear).not.toHaveAttribute('title');
  await expect(await whyOf(app, clear)).toHaveText(/only in the Nunchiro app/);
});

// Ticket 993: the form is the Schedules widget's (the kit's Why line there too); the fix opens Settings on Providers.
test('why_schedule_agents_off: Add schedule says every agent is off, and Open Providers goes to the Use switch', async ({ app }) => {
  await agentsOff(app);
  await openWindow(app);
  const widget = await openWidget(app);
  await widget.getByRole('button', { name: 'Add schedule', exact: true }).click();
  const why = widget.locator('[data-why="why-schedule-agents"]');
  await expect(why).toContainText('Every agent is turned off in Providers, so nothing can be scheduled.');
  const agent = widget.getByRole('combobox', { name: /agent/i });
  await expect(agent).toBeDisabled();
  await expect(agent).toHaveAttribute('aria-describedby', 'why-schedule-agents');
  await expect(widget.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await why.getByRole('button', { name: 'Open Providers', exact: true }).click();
  await expect(app.locator('.settings > nav button[data-page="providers"]')).toHaveAttribute('aria-current', 'page');
  await expect(app.locator('[data-field="use"] input').first()).toBeFocused();
});

/** Disabled controls in `root` that are not busy, idle or a stepper end and point at no why line. */
const bareIn = (app: Page, page: string) =>
  app.locator('.settings[role="region"]').evaluate((root, page) => {
    const out: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>('button:disabled, input:disabled, select:disabled, textarea:disabled, option:disabled, [aria-disabled="true"]')) {
      const ctl = el.tagName === 'OPTION' ? el.closest('select')! : el;
      if (ctl.getAttribute('tabindex') === '-1' || ctl.getAttribute('aria-busy') === 'true' || ctl.hasAttribute('data-idle')) continue;
      const ids = (ctl.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      if (ids.some((i) => document.getElementById(i)?.hasAttribute('data-why') && document.getElementById(i)!.textContent!.trim())) continue;
      out.push(`${page}: ${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}"`);
    }
    return out;
  }, page);

/** Walks every Settings page and then the same page with every add form, fold and row opened; returns each disabled control that
 *  neither waits (aria-busy, data-idle, stepper end) nor points at a why line. */
async function walkBare(app: Page) {
  await openWindow(app);
  await openSettings(app);
  const pages = await app.locator('.settings > nav button[data-page]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.page!));
  expect(pages.length).toBeGreaterThanOrEqual(17);
  const bare: string[] = [];
  for (const id of pages) {
    await app.locator(`.settings > nav button[data-page="${id}"]`).click();
    await expect(app.locator(`.settings > nav button[data-page="${id}"]`)).toHaveAttribute('aria-current', 'page');
    await app.waitForTimeout(400); // the page's core reads settle (probes, permissions)
    bare.push(...(await bareIn(app, id)));
    // Then every closed add form, folded card and row on the page opened (Add schedule, Add machine, Add profile, …).
    const closed = app.locator('.settings[role="region"] [aria-expanded="false"]:not(nav *)');
    for (let n = await closed.count(); n > 0; n--) {
      const next = closed.first();
      if (!(await next.isVisible()) || (await next.isDisabled())) break;
      await next.click();
    }
    await app.locator('.settings[role="region"] details:not([open])').evaluateAll((els) => els.forEach((e) => e.setAttribute('open', ''))); // ticket 543
    // Ticket 543: the add-account forms open by a button with no aria-expanded.
    for (const add of await app.locator('.settings[role="region"] .acct-add button:not(:disabled)').all()) if (await add.isVisible()) await add.click();
    await app.waitForTimeout(200);
    bare.push(...(await bareIn(app, `${id} (opened)`)));
    // Ticket 543: a form that opens with a good value hides its refusals, so each form is also left empty and filled with a name
    // or path the core refuses (a taken or invisible-character account name, a relative command path, a host with a space).
    const forms: [string, string[]][] = [
      ['.acct-add.open input', ['', 'Second', 'a\u200bb']],
      ['.machine-add input#machine-alias', ['', 'bad host!']],
    ];
    for (const [sel, values] of forms)
      for (const input of await app.locator(`.settings[role="region"] ${sel}`).all())
        for (const v of values) {
          await input.fill(v);
          bare.push(...(await bareIn(app, `${id} (form "${v}")`)));
        }
    for (const change of await app.locator('.settings[role="region"] [data-field="command"] button:not(:disabled)').filter({ hasText: /^Change$/ }).all()) {
      await change.click();
      const path = app.locator('.settings[role="region"] [data-field="command"] input[id^="cmd-path-"]').first();
      for (const v of ['', 'relative/agent']) {
        await path.fill(v);
        bare.push(...(await bareIn(app, `${id} (command "${v}")`)));
      }
      await app.locator('.settings[role="region"] [data-field="command"]').getByRole('button', { name: 'Cancel', exact: true }).first().click();
    }
  }
  return bare;
}

test('why_every_page: no disabled control on any Settings page lacks a why line, add forms open, every agent off', async ({ app }) => {
  await agentsOff(app);
  expect(await walkBare(app)).toEqual([]);
});

// Ticket 543: the first state hides the accounts forms and the command rows (every agent is off), so a second one has the
// agents on and one added account; a third has a provider that failed to start and a machine whose channel is down.
const SIGNED_OUT = (name: string, variable: string, status: string, login: string) => `#!/bin/sh
D="\${${variable}}"
case "$1" in --version) echo "${name} 1.0.0"; exit 0;; esac
if [ "$1 $2" = "${status}" ]; then ${name === 'claude' ? `echo '{"loggedIn": false}'` : `echo 'Not logged in' >&2`}; exit 1; fi
if [ "$*" = "${login}" ]; then printf 'login for %s\\r\\n' "$D"; exec sleep 600; fi
exec /bin/cat
`;
const ADD = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, agent, label] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'account_add', agent, label } }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;
function accountPresent(core: Core) {
  for (const [name, variable, status, login] of [
    ['claude', 'CLAUDE_CONFIG_DIR', 'auth status', 'auth login'],
    ['codex', 'CODEX_HOME', 'login status', 'login'],
  ])
    fs.writeFileSync(path.join(core.home, 'bin', name), SIGNED_OUT(name, variable, status, login), { mode: 0o700 });
  const r = JSON.parse(execFileSync(process.execPath, ['-e', ADD, core.home, 'claude', 'Second'], { encoding: 'utf8', timeout: 20_000 }));
  expect(r.Ok.type).toBe('account_added');
}

test('why_every_page_accounts: agents on and one added account, so the account forms and command rows are on screen', async ({ app, core }) => {
  accountPresent(core);
  const bare = await walkBare(app);
  // The state is the one the name says: Claude's card holds "Your own" and the added account.
  await app.locator('.settings > nav button[data-page="providers"]').click();
  await openRow(app, 'Claude');
  await expect(app.locator('#s-accounts .acct-card[data-agent-name="Claude"]')).toHaveCount(2);
  expect(bare).toEqual([]);
});

test('why_add_account_refused: a taken name says so on the form and points the buttons at it; an empty name only waits', async ({ app, core }) => {
  accountPresent(core);
  await go(app, 'providers');
  await openRow(app, 'Claude');
  await openAdd(app, 'claude');
  const form = app.getByRole('group', { name: 'Add Claude account' });
  const name = form.getByRole('textbox', { name: 'Name' });
  const go1 = form.getByRole('button', { name: 'Sign in with browser' });
  await name.fill('');
  await expect(go1).toBeDisabled();
  await expect(go1).toHaveAttribute('data-idle', 'true');
  await name.fill('Second');
  const why = await whyOf(app, go1);
  await expect(why).toHaveText('An account with this name already exists.');
  await expect(go1).not.toHaveAttribute('data-idle');
  await name.fill('a​b'); // a zero-width character, which the core refuses
  await expect(await whyOf(app, go1)).toContainText('64 characters');
});

test('why_every_page_failed: a provider that failed to start and a machine whose channel is down', async ({ app, core }) => {
  fs.writeFileSync(agentsToml(core), tomlEntry('gone', '/nonexistent/gone'));
  const view = ownerOk(core, { op: 'acp_agent_status', name: 'gone' }).view;
  ownerOk(core, { op: 'acp_agent_grant', name: 'gone', hash: view.hash });
  const machines = [
    { machine: 'down', host: null, user: null, port: null, keys: [], fingerprint: null, channel: { state: 'down', since_ms: 0, error: 'SSH unavailable' } },
    { machine: 'studio', host: 'studio', user: 'me', port: 2222, keys: ['~/.ssh/id_rsa'], fingerprint: null, channel: { state: 'version_mismatch', since_ms: 0, remote_version: '0.7.1', remote_protocol: 1, local_protocol: 2, error: 'version mismatch: remote protocol 1, local protocol 2' } },
  ];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.request?.op === 'machine_details') ws.send(JSON.stringify({ id: msg.id, response: { Ok: { type: 'machine_details', machines } } }));
      else server.send(raw);
    });
    server.onMessage((raw) => ws.send(raw));
  });
  expect(await walkBare(app)).toEqual([]);
  await app.locator('.settings > nav button[data-page="machines"]').click();
  await expect(app.locator('[data-machine="down"]')).toBeVisible();
});

// SHOTS=<dir>: the three changed pages (Git, Notifications, In-app browser) in light and dark, gh signed out and
// notifications blocked, for the lane report's before/after.
test('why_shots', async ({ app, core }) => {
  const shots = process.env.SHOTS;
  test.skip(!shots || test.info().project.name !== 'chromium', 'SHOTS=<dir> on chromium only');
  stub(core, 'gh', ghOut);
  await app.addInitScript(() => Object.defineProperty(Notification, 'permission', { get: () => 'denied' }));
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    for (const [id, at] of [
      ['git', 'section[aria-labelledby="h-git"]'],
      ['alerts', 'section[aria-labelledby="h-system-notes"]'],
      ['inapp-browser', 'section[aria-labelledby="h-bprofiles"]'],
    ]) {
      await go(app, id);
      await app.waitForTimeout(600);
      await body(app).locator(at).screenshot({ path: path.join(shots!, `${process.env.SHOTS_TAG ?? 'after'}-${id}-${scheme}.png`) });
    }
  }
});
