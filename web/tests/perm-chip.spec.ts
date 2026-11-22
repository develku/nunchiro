// CHAT-PERMCHIP: the composer's permission-mode chip. A real core and a fake Claude that draws the 2.1.310 footer
// and cycles it on Shift+Tab (crates/nunchiro-core/tests/fixtures/claude-mode, which logs every stdin read).
// CHAT-MODELIST (ticket 285): a click on the chip now opens the mode list (mode-picker.spec.ts); a pick presses the keys.
import fs from 'node:fs';
import path from 'node:path';
import { chipDisabled, chipShown, CODEX_MODES, codexMode } from '../src/chat/perm-chip';
import * as agentWords from '../src/i18n/areas/agents';
import * as modeWords from '../src/i18n/areas/mode-list';
import type { Session } from '../src/types';
import { ownerOk } from './acp-fakes';
import { expect, openWindow, REPO, test, type Core, showComposer } from './fixtures';

function fakeClaude(core: Core) {
  const src = path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode');
  fs.writeFileSync(path.join(core.home, 'bin/claude'), fs.readFileSync(src), { mode: 0o700 });
}
const reads = (core: Core, id: string) =>
  fs.existsSync(path.join(core.home, `stdin-${id}.log`))
    ? fs.readFileSync(path.join(core.home, `stdin-${id}.log`), 'utf8').split('\n').filter((l) => l.startsWith('READ ')).map((l) => l.slice(5))
    : [];

test('chip_reachable_in_2_clicks: a session tab, then the chip in the composer bottom row opens the list', async ({ app, core }) => {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'mode', 'x');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click(); // click 1
  const chip = app.locator('.composer .chips').getByRole('button', { name: 'Permission mode' });
  await expect(chip).toHaveAttribute('data-mode', 'manual');
  await chip.click(); // click 2
  await expect(app.getByRole('menu', { name: 'Permission modes' })).toBeVisible();
  await expect(app.getByRole('button', { name: 'Permission mode' })).toHaveCount(1); // NODUP
});

test('chip_click_sends_one_logged_key: one pick one step away, one Shift+Tab, one row in the send log; the value follows the screen', async ({ app, core }) => {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'mode', 'x');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  const chip = app.getByRole('button', { name: 'Permission mode' });
  await expect(chip).toHaveAttribute('data-mode', 'manual');
  await chip.click();
  await app.getByRole('menuitemradio', { name: /^Accept edits/ }).click();
  await expect(chip).toHaveAttribute('data-mode', 'accept edits');
  expect(reads(core, s.id)).toEqual(['1b5b5a']);
  const log = (core.cli('snapshot', '--json').sessions as { id: string; send_log: { sender: string; keys: string[] }[] }[]).find((x) => x.id === s.id)!.send_log;
  expect(log.map((r) => [r.sender, r.keys])).toEqual([['user', ['shift+tab']]]);
});

test('chip_refused_while_decision_pending: with a prompt on screen the chip is disabled and nothing is sent', async ({ app, core }) => {
  fakeClaude(core);
  const project = core.project('p');
  const s = core.agent(project, 'mode', 'x');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  const chip = app.getByRole('button', { name: 'Permission mode' });
  await expect(chip).toBeEnabled();
  fs.writeFileSync(path.join(project, 'dialog'), '');
  await expect(chip).toBeDisabled();
  // Ticket 991 B15: the footer is gone, so the chip keeps the last mode it read (it no longer flips to "Mode").
  await expect(chip).toHaveAttribute('data-mode', 'manual');
  expect(reads(core, s.id)).toEqual([]);
});

test('no_chip_for_codex: a shell session has no permission chip (a Codex one with no recorded mode: codex_chip_says_the_start_mode_read_only)', async ({ app, core }) => {
  const p = core.project('p');
  const sh = core.shell(p, 'plain');
  await openWindow(app);
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  await app.locator(`.tab[data-tab="${sh.id}"]`).click();
  await expect(app.locator('.composer')).toBeVisible();
  await expect(app.getByRole('button', { name: 'Permission mode' })).toHaveCount(0);
});

// Design conformance: ko/claude-feel-2.html `.ch.perm` next to the app's chip, with the computed-style numbers of each.
const MOCKUP = path.join(REPO, '.scratch/review-1028/claude-feel-2.html');
test('side_by_side_page: the chip matches the mockup chip (height, padding, radius, gap; size is the nearest token)', async ({ app, core, browser }) => {
  test.skip(!fs.existsSync(MOCKUP), `mockup frame absent: ${MOCKUP}`);
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'mode', 'x');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  const chip = app.getByRole('button', { name: 'Permission mode' });
  await expect(chip).toHaveAttribute('data-mode', 'manual');
  const props = (el: Element) => {
    const c = getComputedStyle(el);
    return { height: c.height, padding: `${c.paddingLeft}/${c.paddingRight}`, radius: c.borderTopLeftRadius, fontSize: c.fontSize, gap: c.columnGap };
  };
  const got = await chip.evaluate(props);
  const out = path.join(REPO, '.scratch/perm-chip');
  fs.mkdirSync(out, { recursive: true });
  await app.locator('.composer .chips').screenshot({ path: path.join(out, 'app.png') });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`file://${MOCKUP}`);
  const mock = page.locator('button.ch.perm');
  const want = await mock.evaluate(props);
  await mock.screenshot({ path: path.join(out, 'mockup.png') });
  await page.close();
  fs.writeFileSync(
    path.join(out, 'side-by-side.html'),
    `<!doctype html><meta charset=utf-8><title>perm-chip side by side</title><body style="font:14px sans-serif;padding:16px"><h1>Permission-mode chip</h1><p>Left: mockup <code>.ch.perm</code> (claude-feel-2.html). Right: the app's composer bottom row.</p><div style="display:flex;gap:32px;align-items:center"><img src="mockup.png"><img src="app.png"></div><pre>mockup ${JSON.stringify(want)}\napp    ${JSON.stringify(got)}</pre>`,
  );
  // Font size is the one stated difference: 12.5px in the mockup, the nearest token --fs-12 (12px) here (raw-literal ratchet).
  expect({ ...got, fontSize: '' }).toEqual({ ...want, fontSize: '' });
  expect([got.fontSize, want.fontSize]).toEqual(['12px', '12.5px']);
});

const claude = (over: Partial<Session> = {}) => ({ kind: 'claude', state: 'running', pending: [], attention: { working: false }, ...over }) as unknown as Session;

test('perm_chip_remote_session: a session of another machine has no chip (its core refuses Shift+Tab from a forwarded caller)', () => {
  expect(chipShown(claude())).toBe(true);
  expect(chipShown(claude({ machine: 'box' }))).toBe(false);
  expect(chipShown(claude({ kind: 'codex' }))).toBe(false);
  expect(chipShown(claude({ state: 'exited' }))).toBe(false);
  expect(chipShown(null)).toBe(false);
});

test('shift_tab_never_queued (window): the chip is disabled while the agent works, so nothing is clicked into a queue', () => {
  expect(chipDisabled(claude(), true, false)).toBe(false);
  expect(chipDisabled(claude({ attention: { working: true } as Session['attention'] }), true, false)).toBe(true);
  expect(chipDisabled(claude(), true, true)).toBe(true);
  expect(chipDisabled(claude(), false, false)).toBe(true);
  expect(chipDisabled(claude({ pending: [{}] as Session['pending'] }), true, false)).toBe(true);
});

// Ticket 991 (B6 chip): a Codex session the owner starts shows the mode it was started in (the stored choice of
// Settings > Providers) as a read-only chip in the place of Claude's. A real core; the fake codex only stays open.
const FAKE_CODEX = `#!/bin/sh\ncase "$1" in --version) echo 'codex-cli 0.161.0'; exit 0;; esac\nexec /bin/cat\n`;
/** The window's own start (the owner's): New tab > Codex in `folder`. */
async function startCodex(app: import('@playwright/test').Page, folder: string) {
  await app.evaluate((p) => window.dispatchEvent(new CustomEvent('nunchiro:session.new', { detail: { project: p } })), folder);
  await app.getByRole('dialog', { name: 'New tab' }).getByRole('option', { name: 'Codex', exact: true }).click();
  await expect(app.getByRole('dialog', { name: 'New tab' })).toHaveCount(0, { timeout: 15_000 });
}
const codexRows = (core: Core) => (core.cli('snapshot', '--json').sessions as { id: string; kind: string; permission_mode?: string }[]).filter((x) => x.kind === 'codex');

test('codex_chip_says_the_start_mode_read_only: the stored choice at each start, no list, the tooltip names Settings > Providers', async ({ app, core }) => {
  fs.writeFileSync(path.join(core.home, 'bin/codex'), FAKE_CODEX, { mode: 0o700 });
  const folder = core.project('p');
  // A session the owner did not start (the CLI's) has no recorded mode: no chip, as every row from before this.
  const old = core.cli('session', 'start', '--kind', 'codex', '--project', folder, '--label', 'from cli').session as { id: string };
  await openWindow(app);
  await app.locator(`.tab[data-tab="${old.id}"]`).click();
  await expect(app.locator('.composer')).toBeVisible();
  await expect(app.getByRole('button', { name: /^Permission mode/ })).toHaveCount(0);

  // Nothing stored: a new Codex session starts with full access, which Settings > Providers calls "Bypass permissions", as Claude's.
  await startCodex(app, folder);
  const modes = () => codexRows(core).map((x) => x.permission_mode ?? 'none').sort(); // the snapshot's order is not the start order
  await expect.poll(modes).toEqual(['full-access', 'none']);
  expect(codexRows(core).find((x) => x.id === old.id)?.permission_mode).toBeUndefined();
  const first = codexRows(core).find((x) => x.id !== old.id)!.id;
  await app.locator(`.tab[data-tab="${first}"]`).click();
  const chip = app.locator('.composer .chips').getByRole('button', { name: 'Permission mode · Bypass permissions', exact: true });
  await expect(chip).toHaveText('Bypass permissions');
  await expect(chip).toHaveAttribute('data-mode', 'full-access');
  await expect(chip).toHaveClass(/\bch perm ro skip\b/); // Claude's chip, in the warning look its Bypass permissions wears
  await expect(app.locator('.composer .chips .perm-wrap')).toHaveCount(1); // the same slot of the chips row
  // Read-only: it says so to assistive technology, a click opens no list and sends nothing, and it has no caret.
  await expect(chip).toHaveAttribute('aria-disabled', 'true');
  await expect(chip).not.toHaveAttribute('aria-haspopup', /./);
  await expect(chip.locator('.c')).toHaveCount(0);
  const frames: string[] = [];
  app.on('websocket', (ws) => ws.on('framesent', (f) => typeof f.payload === 'string' && frames.push(f.payload)));
  await chip.click({ force: true });
  await expect(app.getByRole('menu')).toHaveCount(0);
  expect(frames.filter((f) => f.includes('set_mode'))).toEqual([]);
  const tip = 'Permission at start: Bypass permissions. Set in Settings > Providers for new sessions.';
  await expect(chip).toHaveAttribute('title', tip);
  expect(await chip.evaluate((e) => document.getElementById(e.getAttribute('aria-describedby')!)?.textContent)).toBe(tip);
  expect(await chip.evaluate((e) => getComputedStyle(e).cursor)).toBe('default');

  // Another choice stored: the next start shows it, and the running session keeps the mode it was started in.
  ownerOk(core, { op: 'agent_permission_set', agent: 'codex', choice: 'ask' });
  await startCodex(app, folder);
  await expect.poll(modes).toEqual(['ask', 'full-access', 'none']);
  await app.locator(`.tab[data-tab="${codexRows(core).find((x) => x.permission_mode === 'ask')!.id}"]`).click();
  const asks = app.locator('.composer .chips').getByRole('button', { name: 'Permission mode · Ask every time', exact: true });
  await expect(asks).toHaveAttribute('data-mode', 'ask');
  await expect(asks).not.toHaveClass(/skip/);
  await app.locator(`.tab[data-tab="${first}"]`).click();
  await expect(chip).toHaveAttribute('data-mode', 'full-access');
  await expect(app.getByRole('button', { name: /^Permission mode/ })).toHaveCount(1); // NODUP
});

test('codex_chip_modes_and_words: the four stored names, nothing else, and eight languages have every word', () => {
  const codex = (over: Partial<Session> = {}) => ({ kind: 'codex', state: 'running', pending: [], attention: { working: false }, ...over }) as unknown as Session;
  for (const mode of ['own', 'ask', 'auto', 'full-access']) expect(codexMode(codex({ permission_mode: mode }))).toBe(mode);
  expect(codexMode(codex())).toBeNull(); // no recorded mode
  expect(codexMode(codex({ permission_mode: 'manual' }))).toBeNull(); // not a Codex mode
  expect(codexMode(codex({ permission_mode: 'toString' }))).toBeNull();
  expect(codexMode(codex({ permission_mode: 'ask', state: 'exited' }))).toBeNull();
  expect(codexMode(codex({ permission_mode: 'ask', machine: 'box' }))).toBeNull();
  expect(codexMode(codex({ permission_mode: 'ask', kind: 'claude' }))).toBeNull();
  expect(codexMode(null)).toBeNull();
  const keys = [...Object.values(CODEX_MODES), 'mode.codexStart'];
  const langs = ['en', 'ko', 'ja', 'zhHans', 'zhHant', 'es', 'fr', 'pt'] as const;
  const word = (lang: (typeof langs)[number], key: string) => ({ ...(agentWords[lang] as Record<string, string>), ...(modeWords[lang] as Record<string, string>) })[key];
  for (const lang of langs) {
    for (const key of keys) expect(word(lang, key)?.trim(), `${lang} ${key}`).toBeTruthy();
    expect(word(lang, 'mode.codexStart'), lang).toContain('{mode}');
    if (lang !== 'en') expect(word(lang, 'mode.codexStart'), lang).not.toBe(word('en', 'mode.codexStart'));
  }
});
