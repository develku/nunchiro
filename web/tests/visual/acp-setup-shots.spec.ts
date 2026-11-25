// V2-4b design conformance, measured: Settings > Agents and the "Set up Gemini CLI" sheet against the approved mockup
// 03 Option A (V2SCREENS, owner 2026-10-28 10:45, "03 A (+agents.toml link)"), light and dark, with the share of differing
// pixels per component and a side-by-side page. Not part of the gate: run with ACP_SETUP_SHOTS=1 (Chromium only). Writes
// `.scratch/acp-setup-shots/` (crops, `diff.json`, `side-by-side.html`).
import fs from 'node:fs';
import path from 'node:path';
import { fakeAcp } from '../acp-fakes';
import { REPO, expect, openWindow, test } from '../fixtures';
import { measureMockup, outDir } from './compare';
import { MOCKUPS } from './mockups';
import { r8Map } from './r8-map';

test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: 'serial' });

const OUT = path.join(REPO, '.scratch/acp-setup-shots');
const MOCK = '03-acp-setup.html';
const results: { name: string; scheme: string; ratio: number }[] = [];

for (const scheme of ['light', 'dark'] as const) {
  test(`acp setup shots (${scheme})`, { tag: '@shots' }, async ({ app, core }) => {
    outDir('acp-setup-shots');
    fakeAcp(core, 'gemini', '0.11.2');
    core.shell(core.project('nunchiro'), 'core-serve');
    await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await openWindow(app);
    await app.getByRole('button', { name: 'Settings', exact: true }).click();
    await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
    const page = app.locator('#s-agents');
    await expect(page.locator('[data-row="agent:gemini"]')).toContainText('0.11.2');
    await app.mouse.move(900, 700);
    fs.mkdirSync(OUT, { recursive: true });
    await app.screenshot({ path: path.join(OUT, `window-page-${scheme}.png`) });
    results.push({ name: 'agents-page', scheme, ratio: await measureMockup(app, MOCK, '#opt-a .sbody', app.locator('.settings .sbody'), { name: 'agents-page', prepare: async (m) => (await r8Map(app)(m), void (await m.addStyleTag({ content: '#opt-a .sheet,#opt-a .scrim{display:none!important}' }))) }) });
    await page.locator('[data-row="agent:gemini"]').getByRole('button', { name: /Set up/ }).click();
    const sheet = app.getByRole('dialog', { name: 'Set up Gemini CLI' });
    await expect(sheet.getByRole('button', { name: 'Approve and add' })).toBeEnabled({ timeout: 20_000 });
    await app.mouse.move(5, 5);
    await app.screenshot({ path: path.join(OUT, `window-sheet-${scheme}.png`) });
    results.push({ name: 'agents-sheet', scheme, ratio: await measureMockup(app, MOCK, '#opt-a .sheet', sheet, { name: 'agents-sheet', prepare: r8Map(app) }) });
    // The whole mockup frame, once per scheme, for the page.
    const m = await app.context().newPage();
    await m.setViewportSize({ width: 1440, height: 900 });
    await m.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await m.goto(`file://${path.join(MOCKUPS, MOCK)}`);
    await r8Map(app)(m);
    await m.locator('#opt-a .frame').screenshot({ path: path.join(OUT, `mock-frame-${scheme}.png`) });
    await m.close();
  });
}

test('acp setup shots: the side-by-side page', { tag: '@shots' }, () => {
  fs.writeFileSync(path.join(OUT, 'diff.json'), JSON.stringify(results, null, 2));
  const img = (f: string) => `<img src="${f}" style="max-width:100%;border:1px solid #888">`;
  const pct = (name: string, scheme: string) => `${(results.find((r) => r.name === name && r.scheme === scheme)!.ratio * 100).toFixed(2)}%`;
  const row = (title: string, name: string) =>
    `<h2>${title}</h2><table><tr><th></th><th>Mockup (03 Option A)</th><th>App</th></tr>${(['light', 'dark'] as const)
      .map((s) => `<tr><td>${s}<br><b>${pct(name, s)}</b> of pixels differ</td><td>${img(`${name}-${s}-mock.png`)}</td><td>${img(`${name}-${s}-app.png`)}</td></tr>`)
      .join('')}</table>`;
  const DIFFS = [
    'Pi row dropped: no verified ACP command exists for it; the known list is Gemini CLI, OpenCode, goose (ACP) and Aider (terminal only).',
    'Live labels: the command shown is the absolute path found on the core PATH (the mockup drew /opt/homebrew/bin/gemini); the version is what the CLI prints.',
    'The sheet shows the absolute path in Command (agents.toml needs one); the mockup drew the bare command and showed the path only under "Approval covers exactly".',
    'The "Found" line says "core PATH" (the rule of the first-run checklist); the mockup said "login-shell PATH".',
    '"Asks for" lists the capabilities the agent declared in initialize (the client offers no files or terminals to a check), not the mockup\'s "file read/write, terminal".',
    'Added where the mockup is silent: a Name field for a custom command, escaped control characters, the changed-entry line, the inline names-only error, the "Open agents.toml" path with Copy outside the app.',
    'Dark: the mockup draws light only; its dark crops take the app\'s dark tokens through r8-map.ts.',
    'Terminal-only CLI (Aider) sits in the Terminal agents table with "terminal only" (round 2, 04 follow-up).',
  ];
  fs.writeFileSync(
    path.join(OUT, 'side-by-side.html'),
    `<!doctype html><meta charset="utf-8"><title>V2-4b Agents page and setup sheet: mockup vs app</title><style>body{font:14px system-ui;margin:24px;max-width:1500px}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:6px;vertical-align:top}</style><h1>V2-4b Settings &gt; Agents and the setup sheet</h1><p>Mockup: 03 Option A (V2SCREENS, owner 2026-10-28 10:45, "03 A (+agents.toml link)"), compared after r8-map.ts, 2x scale, 1440x900.</p><h2>Whole window</h2><table><tr><th></th><th>Mockup frame</th><th>App page</th><th>App sheet</th></tr>${(['light', 'dark'] as const).map((s) => `<tr><td>${s}</td><td>${img(`mock-frame-${s}.png`)}</td><td>${img(`window-page-${s}.png`)}</td><td>${img(`window-sheet-${s}.png`)}</td></tr>`).join('')}</table>${row('Agents page', 'agents-page')}${row('Setup sheet', 'agents-sheet')}<h2>Differences</h2><ul>${DIFFS.map((d) => `<li>${d}</li>`).join('')}</ul>`,
  );
  expect(results).toHaveLength(4);
});
