// Ticket 204 (V2.5-12, needs 171 IMPORTOPEN A): a first-run import hit or imported row opens that conversation read-only in
// a centre tab `imported:<id>`. The composer is replaced by "Imported · read-only"; nothing can be sent; opening is a view
// (needs 137: ~/.claude and ~/.codex are never written). Each test runs a real core on fixture agent homes.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, test, type Core } from './fixtures';

const rec = (o: object) => JSON.stringify(o) + '\n';
const user = (text: string) => rec({ type: 'user', cwd: '/work/app', message: { role: 'user', content: text } });
const assistant = (text: string) => rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolUse = rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm run unit-suite' } }] } });
const toolResult = rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'all green' }] } });
const ID = 'claude:c1';
const CODEX = 'codex:rollout-2026-10-27T10-00-00-x1';

function transcripts(core: Core, extra = '') {
  const dir = path.join(core.home, 'claude-home/projects/-work-app');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'c1.jsonl'), user('migrate the zebra table') + assistant('Done, the **zebra** table is renamed.') + toolUse + toolResult + extra);
  fs.writeFileSync(path.join(dir, 'c2.jsonl'), user('write the release notes'));
  const codex = path.join(core.home, 'codex-home/sessions/2026/10/27');
  fs.mkdirSync(codex, { recursive: true });
  const meta = rec({ type: 'session_meta', payload: { id: 'x1', cwd: '/work/api' } });
  const msg = (role: string, kind: string, text: string) => rec({ type: 'response_item', payload: { type: 'message', role, content: [{ type: kind, text }] } });
  fs.writeFileSync(path.join(codex, 'rollout-2026-10-27T10-00-00-x1.jsonl'), meta + msg('user', 'input_text', 'add a giraffe limit') + msg('assistant', 'output_text', 'Added the giraffe limit.'));
}

// Ticket 305: the import block lives on Settings > Onboarding, which a first run opens.
test.use({ firstRun: true });
const step = (p: Page) => p.locator('[data-step="import"]');
const tab = (p: Page, id: string) => p.locator(`.tab[data-tab="imported:${id}"]`);
const view = (p: Page, id: string) => p.locator(`.fview[data-imported="${id}"]`);

/** First run: look, import everything, search `query`. */
async function importAll(p: Page, query = 'zebra') {
  const s = step(p);
  await s.getByRole('button', { name: 'Look for conversations' }).click();
  await s.getByRole('button', { name: 'Select all' }).click();
  await s.getByRole('button', { name: /^Import \d+ selected/ }).click();
  await expect(s.getByRole('status')).toContainText('Imported');
  const box = s.getByRole('textbox', { name: 'Search imported conversations' });
  await box.fill(query);
  await box.press('Enter');
  await expect(s.locator('[data-hit]')).not.toHaveCount(0);
}
/** Back to the first-run list through the palette (it forgets its results): look again and search `query`. */
async function reopen(p: Page, query: string) {
  await p.keyboard.press('ControlOrMeta+k');
  await p.getByRole('combobox').fill('First run');
  await p.keyboard.press('Enter');
  await expect(step(p)).toBeVisible();
  await step(p).getByRole('button', { name: /^(Look for conversations|Look again)$/ }).click();
  const box = step(p).getByRole('textbox', { name: 'Search imported conversations' });
  await box.fill(query);
  await box.press('Enter');
  await expect(step(p).locator('[data-hit]')).not.toHaveCount(0);
}
const hit = (p: Page, text: RegExp) => step(p).locator('[data-hit]').getByRole('button', { name: text });

/** Every request the window sends over its sockets from now on. */
function requests(p: Page) {
  const ops: string[] = [];
  p.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      try {
        const m = JSON.parse(String(f.payload));
        if (m && typeof m === 'object' && m.request) ops.push(String(m.request.op ?? 'chat'));
      } catch {
        /* not JSON */
      }
    }),
  );
  return ops;
}

test('import_hit_opens_the_conversation', async ({ app, core }) => {
  transcripts(core);
  await openWindow(app);
  await importAll(app);
  await hit(app, /zebra/).click();
  await expect(tab(app, ID)).toHaveAttribute('aria-selected', 'true');
  await expect(tab(app, ID)).toContainText('migrate the zebra table');
  const v = view(app, ID);
  await expect(v).toBeVisible();
  // The messages and the tool row are there, in the normal chat look.
  await expect(v.locator('.msg.user')).toContainText('migrate the zebra table');
  await expect(v.locator('.md')).toContainText('the zebra table is renamed');
  await expect(v.getByText('npm run unit-suite')).toBeVisible();
  // The imported tab is in front of Settings.
  await expect(step(app)).toBeHidden();
  // One line header: the agent, the project and the title.
  await expect(v.locator('.fv-head')).toContainText('claude');
  await expect(v.locator('.fv-head')).toContainText('· app ·'); // ticket 551: the project's name, its path only as the tooltip
  await expect(v.locator('.fv-head')).not.toContainText('/work/app');
  await app.screenshot({ path: path.join(REPO, `.scratch/shots/import-open-${test.info().project.name}.png`) });
});

test('import_open_twice_focuses_one_tab', async ({ app, core }) => {
  transcripts(core);
  await openWindow(app);
  await importAll(app);
  await hit(app, /zebra/).click();
  await expect(tab(app, ID)).toHaveAttribute('aria-selected', 'true');
  // Back to the first-run list through the palette, then the same hit again.
  await reopen(app, 'zebra');
  await expect(step(app).locator('[data-hit]')).toHaveCount(1);
  await hit(app, /zebra/).click();
  await expect(tab(app, ID)).toHaveCount(1);
  await expect(tab(app, ID)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator('.tab[data-tab^="imported:"]')).toHaveCount(1);
});

test('import_imported_row_opens', async ({ app, core }) => {
  transcripts(core);
  await openWindow(app);
  await importAll(app);
  // An imported row opens its conversation; a listed one that is not imported stays a plain checkbox row.
  const row = step(app).locator('[data-imported="true"]').filter({ hasText: 'add a giraffe limit' });
  await row.getByRole('button', { name: 'add a giraffe limit' }).click();
  await expect(tab(app, CODEX)).toHaveAttribute('aria-selected', 'true');
  await expect(view(app, CODEX).locator('.md')).toContainText('Added the giraffe limit.');
  await expect(view(app, CODEX).locator('.msg.user')).toContainText('add a giraffe limit');
});

test('imported_tab_has_no_composer', async ({ app, core }) => {
  transcripts(core);
  await openWindow(app);
  await importAll(app);
  await hit(app, /zebra/).click();
  const v = view(app, ID);
  await expect(v).toBeVisible();
  // The window's composer stays out of the tab: the files frame hides it (a hidden one cannot be typed into).
  await expect(app.locator('textarea:visible')).toHaveCount(0);
  await expect(app.locator('.composer:visible')).toHaveCount(0);
  await expect(v.getByRole('button', { name: /send/i })).toHaveCount(0);
  const note = v.getByRole('note');
  await expect(note).toHaveText('Imported · read-only');
  // The note is text: not an input, not focusable.
  expect(await note.evaluate((n) => ({ tag: n.tagName, tab: (n as HTMLElement).tabIndex, editable: (n as HTMLElement).isContentEditable }))).toEqual({ tag: 'DIV', tab: -1, editable: false });
  await expect(v.locator('input, textarea, [contenteditable="true"]')).toHaveCount(0);
});

test('imported_tab_sends_nothing', async ({ app, core }) => {
  transcripts(core);
  const ops = requests(app);
  await openWindow(app);
  await importAll(app);
  await hit(app, /zebra/).click();
  const v = view(app, ID);
  await expect(v.locator('.msg.user')).toBeVisible();
  const from = ops.length;
  await v.locator('.fv-scroll').click({ position: { x: 20, y: 20 } });
  await app.keyboard.type('hello there');
  await app.keyboard.press('Enter');
  await app.keyboard.press('ControlOrMeta+Enter');
  await app.waitForTimeout(300);
  // `queue_connect` is the window's presence heartbeat (queue/connect.ts, one a second while connected), not a send from
  // this tab: the typing above takes about half a second, so a beat can land in it (9 of 20 runs red on 74462546 at 1 worker).
  const since = ops.slice(from);
  expect(ops.slice(0, from)).toContain('queue_connect'); // it beat before this tab got any input
  expect(since.filter((o) => o !== 'import_read' && o !== 'queue_connect' && o !== 'board_snapshot')).toEqual([]);
  expect(ops.filter((o) => o === 'import_read').length).toBeGreaterThanOrEqual(1);
  // Nothing was written into the agent folders either.
  expect(fs.readFileSync(path.join(core.home, 'claude-home/projects/-work-app/c1.jsonl'), 'utf8')).not.toContain('hello there');
});

test('imported_html_and_js_links_are_inert', async ({ app, core }) => {
  const evil = [
    user('<img src=x onerror="window.__pwned=1"> and <script>window.__pwned=2</script>'),
    assistant('[click me](javascript:window.__pwned=3) <b onmouseover="window.__pwned=4">raw html</b> \u001b]0;title\u0007 plain'),
  ].join('');
  const dir = path.join(core.home, 'claude-home/projects/-work-app');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'c1.jsonl'), evil);
  const dialogs: string[] = [];
  app.on('dialog', (d) => (dialogs.push(d.message()), void d.dismiss()));
  await openWindow(app);
  await importAll(app, 'onerror');
  await hit(app, /onerror/).click();
  const v = view(app, ID);
  await expect(v).toBeVisible();
  // The text is shown as text; no element came out of it.
  await expect(v.locator('.msg.user')).toContainText('<img src=x onerror=');
  await expect(v.locator('img, script, b')).toHaveCount(0);
  const link = v.getByRole('link', { name: 'click me' });
  const url = app.url();
  await link.click();
  await link.focus();
  await app.keyboard.press('Enter');
  expect(app.url()).toBe(url);
  expect(await app.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(dialogs).toEqual([]);
});

test('import_hit_button_keys', async ({ app, core }) => {
  transcripts(core);
  await openWindow(app);
  await importAll(app);
  const b = hit(app, /zebra/);
  // A real button with the title as its name and the tooltip that says what it does.
  expect(await b.evaluate((e) => e.tagName)).toBe('BUTTON');
  await expect(b).toHaveAttribute('data-tip', 'Open this conversation (read-only)');
  // Visible focus.
  await b.focus();
  expect(await b.evaluate((e) => getComputedStyle(e).outlineStyle !== 'none' || getComputedStyle(e).boxShadow !== 'none')).toBe(true);
  // Enter opens it.
  await app.keyboard.press('Enter');
  await expect(tab(app, ID)).toHaveAttribute('aria-selected', 'true');
  // Space opens it too: close the tab, come back to the list and press Space on the hit.
  await tab(app, ID).click({ button: 'middle' });
  await expect(tab(app, ID)).toHaveCount(0);
  await reopen(app, 'zebra');
  await hit(app, /zebra/).focus();
  await app.keyboard.press('Space');
  await expect(tab(app, ID)).toHaveAttribute('aria-selected', 'true');
});

test('imported_tab_closes_with_undo', async ({ app, core }) => {
  transcripts(core);
  await openWindow(app);
  await importAll(app);
  await hit(app, /zebra/).click();
  await expect(tab(app, ID)).toBeVisible();
  // Middle-click closes it; the status line offers Undo, which puts the tab back, active.
  await tab(app, ID).click({ button: 'middle' });
  await expect(tab(app, ID)).toHaveCount(0);
  const undo = app.locator('footer.status .undoline');
  await expect(undo).toContainText('migrate the zebra table');
  await undo.getByRole('button', { name: 'Undo' }).click();
  await expect(tab(app, ID)).toHaveAttribute('aria-selected', 'true');
  await expect(view(app, ID).locator('.msg.user')).toBeVisible();
  // Cmd/Ctrl+W closes the active one too.
  await app.keyboard.press('ControlOrMeta+w');
  await expect(tab(app, ID)).toHaveCount(0);
  // Esc in the tab does nothing.
  await undo.getByRole('button', { name: 'Undo' }).click();
  await expect(tab(app, ID)).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(tab(app, ID)).toHaveAttribute('aria-selected', 'true');
});

test('imported_tab_arrows_between_tabs', async ({ app, core }) => {
  transcripts(core);
  await openWindow(app);
  await importAll(app);
  await hit(app, /zebra/).click();
  await reopen(app, 'giraffe');
  await hit(app, /giraffe/).click();
  await expect(tab(app, CODEX)).toHaveAttribute('aria-selected', 'true');
  const first = tab(app, ID);
  await tab(app, CODEX).focus();
  await app.keyboard.press('ArrowLeft');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(first).toBeFocused();
  await app.keyboard.press('ArrowRight');
  await expect(tab(app, CODEX)).toHaveAttribute('aria-selected', 'true');
});

test('imported_truncated_note', async ({ app, core }) => {
  // 5 005 messages: the first 5 000 are shown and the line says how many were left out.
  const many = Array.from({ length: 5002 }, (_, i) => user(`filler ${i}`)).join('');
  transcripts(core, many);
  await openWindow(app);
  await importAll(app, 'migrate');
  await hit(app, /migrate the zebra/).click();
  const v = view(app, ID);
  await expect(v.getByText('Showing the first 5000 entries; 6 left out')).toBeVisible({ timeout: 30_000 });
  await expect(v.getByRole('note')).toHaveText('Imported · read-only');
});

test('import_read_error_is_one_line', async ({ app, core }) => {
  transcripts(core);
  await openWindow(app);
  await importAll(app);
  // The transcript goes away after the import: the tab says why, in one line, and still has no composer.
  fs.rmSync(path.join(core.home, 'claude-home/projects/-work-app/c1.jsonl'));
  await hit(app, /zebra/).click();
  const v = view(app, ID);
  await expect(v.getByRole('alert')).toContainText('Could not read this conversation');
  await expect(app.locator('textarea:visible')).toHaveCount(0);
});

test('imported_tab_shots: the note shows at 1440 px and the page does not scroll sideways at 320', async ({ app, core }) => {
  transcripts(core);
  await openWindow(app);
  await importAll(app);
  await hit(app, /zebra/).click();
  const v = view(app, ID);
  await expect(v.locator('.msg.user')).toBeVisible();
  for (const width of [1440, 320]) {
    await app.setViewportSize({ width, height: 800 });
    // At 320 the window shell leaves the centre no width for any tab (not this lane's layout); the page itself must not overflow.
    if (width >= 1000) expect((await v.getByRole('note').boundingBox())?.width).toBeGreaterThan(100);
    expect(await app.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await app.screenshot({ path: path.join(REPO, `.scratch/shots/import-open-tab-${width}.png`) });
  }
});
