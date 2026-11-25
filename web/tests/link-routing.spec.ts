// Ticket 256 (needs 197, G06): http(s) links the user clicks in a terminal, the chat or a file open in the user's browser
// (default, ADR 0001:122) or, when set, in the in-app browser of the clicked session's own space, never the "you" store.
// Artifact frames and web widgets keep `openExternal` whatever the setting. The window events are recorded: the user's
// browser is `window.open` outside the app, the in-app browser is the `nunchiro:browser.go` event naming the space.
import fs from 'node:fs';
import path from 'node:path';
import { expect as pwExpect, test as pwTest, type Page } from '@playwright/test';
import { expect, openWindow, REPO, test, type Core } from './fixtures';
import { append, chat, openChat, rec, test as chatTest, type ChatCore } from './fixtures/chat/harness';
import { openAt, view as fileView } from './fixtures/files/harness';
import { icon } from './d5b';
import { labelHost, labelled, route, type Prefs } from '../src/pane/browser/route';

type W = { __opened: string[]; __go: string[] };
/** Records where links go; `features` is the window store's feature values (Settings › In-app browser › Links). */
const record = (page: Page, features: Record<string, unknown> = {}) =>
  page.addInitScript((f) => {
    const w = window as unknown as W;
    w.__opened = [];
    w.__go = [];
    window.open = (u?: string | URL) => (w.__opened.push(String(u)), null);
    window.addEventListener('nunchiro:browser.go', (e) => w.__go.push((e as CustomEvent<{ space: string }>).detail.space));
    if (Object.keys(f).length) localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ features: f }));
  }, features);
const got = (page: Page) => page.evaluate(() => ({ opened: (window as unknown as W).__opened, go: (window as unknown as W).__go }));
const IN_APP = { 'browser.links_in_app': true };

/** Centre of the first character of `text` on the terminal's screen (as terminal-links.spec.ts). */
async function cellOf(app: Page, id: string, text: string) {
  const p = await app.evaluate(
    ([id, text]) => {
      const rows = document.querySelector(`.term[data-session="${id}"] .xterm-rows`)!;
      const walk = document.createTreeWalker(rows, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const i = n.textContent!.indexOf(text);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + 1);
        const b = r.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }
      return null;
    },
    [id, text] as const,
  );
  if (!p) throw new Error(`${text} is not on screen`);
  return p;
}
async function cmdClick(app: Page, id: string, text: string, shift = false) {
  const { x, y } = await cellOf(app, id, text);
  await app.mouse.move(x, y);
  await app.waitForTimeout(100);
  await app.keyboard.down('Meta');
  if (shift) await app.keyboard.down('Shift');
  await app.mouse.click(x, y);
  if (shift) await app.keyboard.up('Shift');
  await app.keyboard.up('Meta');
}
async function terminal(app: Page, core: Core, features: Record<string, unknown> = {}) {
  const s = core.replay(core.project('links'), 'links', 'see https://example.com/docs\r\nend\r\n');
  await record(app, features);
  await openWindow(app);
  await expect(app.locator(`.term[data-session="${s.id}"] .xterm-rows`)).toContainText('end');
  return s;
}
/** An agent session's PTY (its side pane's Terminal) showing a URL: the only terminal whose session has a Browser tab. */
async function agentTerminal(page: Page, chatCore: ChatCore, features: Record<string, unknown> = {}) {
  await record(page, features);
  const s = chatCore.chat('links');
  await openChat(page, s.id);
  await icon(page, 'right', 'Terminal').click();
  chatCore.cli('session', 'send-text', s.id, 'see https://example.com/docs\r'); // the PTY echoes the line
  await expect(page.locator(`[data-side-pane] .term[data-session="${s.id}"] .xterm-rows`)).toContainText('example.com/docs');
  return s;
}
async function chatWithLink(page: Page, chatCore: { chat: (label: string) => { id: string; file: string } }, features: Record<string, unknown> = {}) {
  await record(page, features);
  const s = chatCore.chat('md');
  append(s.file, rec.user('go'), rec.assistant('Read the [web](https://example.com/page) page.'));
  await openChat(page, s.id);
  return { s, view: chat(page, s.id) };
}

test('default_still_opens_users_browser', async ({ app, core }) => {
  const s = await terminal(app, core);
  await cmdClick(app, s.id, 'example.com');
  await expect.poll(() => got(app)).toEqual({ opened: ['https://example.com/docs'], go: [] });
});

chatTest('default_still_opens_users_browser: chat', async ({ page, chatCore }) => {
  const { view } = await chatWithLink(page, chatCore);
  await view.getByRole('link', { name: 'web' }).click();
  await expect.poll(() => got(page)).toEqual({ opened: ['https://example.com/page'], go: [] });
});

chatTest('terminal_link_opens_in_inapp_browser_when_set', async ({ page, chatCore }) => {
  const s = await agentTerminal(page, chatCore, IN_APP);
  await cmdClick(page, s.id, 'example.com');
  await expect.poll(() => got(page)).toEqual({ opened: [], go: [s.id] });
});

chatTest('terminal_link_opens_in_inapp_browser_when_set: journey through Settings › In-app browser › Links', async ({ page: app, chatCore }) => {
  const s = await agentTerminal(app, chatCore);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await app.locator('.settings > nav button[data-page="inapp-browser"]').click();
  const links = app.getByRole('radiogroup', { name: 'Open http(s) links in' });
  await expect(links.getByRole('radio', { name: 'Your browser' })).toBeChecked(); // the default is unchanged
  await links.getByRole('radio', { name: 'In-app browser' }).click(); // the radio covers its text
  await expect(app.getByRole('switch', { name: 'Shift+click opens the other browser' })).toBeChecked();
  await expect(app.getByRole('switch', { name: 'Open in the background' })).not.toBeChecked();
  await app.getByRole('button', { name: 'Close Settings' }).click(); // Settings is a modal: the tab behind it cannot be clicked
  await app.getByRole('tab', { name: /links/ }).click();
  await expect(app.locator(`[data-side-pane] .term[data-session="${s.id}"] .xterm-rows`)).toContainText('example.com/docs');
  await cmdClick(app, s.id, 'example.com');
  await expect.poll(() => got(app)).toEqual({ opened: [], go: [s.id] });
});

chatTest('chat_link_opens_in_inapp_browser_when_set', async ({ page, chatCore }) => {
  const { s, view } = await chatWithLink(page, chatCore, IN_APP);
  await view.getByRole('link', { name: 'web' }).click();
  await expect.poll(() => got(page)).toEqual({ opened: [], go: [s.id] });
  // The session's side pane opens on its Browser tab (outside the app the tab says the browser needs it).
  await expect(page.getByText('The browser needs the Nunchiro app')).toBeVisible();
});

const P = (p: Partial<Prefs> = {}): Prefs => ({ inApp: false, shiftFlips: true, background: false, labels: false, ...p });

chatTest('shift_click_does_the_opposite', async ({ page, chatCore }) => {
  // The rule: Shift flips the setting while "Shift+click opens the other browser" is on (the default), and not when it is off.
  pwExpect(route(P(), true, 'terminal')).toBe('pane');
  pwExpect(route(P({ inApp: true }), true, 'chat')).toBe('external');
  pwExpect(route(P({ shiftFlips: false }), true, 'terminal')).toBe('external');
  pwExpect(route(P({ inApp: true, shiftFlips: false }), true, 'files')).toBe('pane');
  // In the window: the default with Shift opens in the agent session's in-app browser.
  const s = await agentTerminal(page, chatCore);
  await cmdClick(page, s.id, 'example.com', true);
  await expect.poll(() => got(page)).toEqual({ opened: [], go: [s.id] });
});

// Review M1: a session that cannot show its Browser tab now (a shell, a stopped agent, a file tab in front) never
// swallows a link; it goes to the user's browser, whatever the setting or Shift says.
test('no_browser_tab_falls_back_to_users_browser: shell tab, in-app on', async ({ app, core }) => {
  const s = await terminal(app, core, IN_APP);
  await cmdClick(app, s.id, 'example.com');
  await expect.poll(() => got(app)).toEqual({ opened: ['https://example.com/docs'], go: [] });
});

test('no_browser_tab_falls_back_to_users_browser: shell tab, default with Shift', async ({ app, core }) => {
  const s = await terminal(app, core);
  await cmdClick(app, s.id, 'example.com', true);
  await expect.poll(() => got(app)).toEqual({ opened: ['https://example.com/docs'], go: [] });
});

chatTest('no_browser_tab_falls_back_to_users_browser: stopped session chat', async ({ page, chatCore }) => {
  const { s, view } = await chatWithLink(page, chatCore, IN_APP);
  chatCore.cli('session', 'send-text', s.id, 'EXIT\r');
  await expect(page.locator(`.tab[data-tab="${s.id}"] .tdot`)).toHaveAttribute('data-s', 'done');
  await view.getByRole('link', { name: 'web' }).click();
  await expect.poll(() => got(page)).toEqual({ opened: ['https://example.com/page'], go: [] });
});

chatTest('no_browser_tab_falls_back_to_users_browser: Files viewer Markdown link', async ({ page, chatCore }) => {
  await record(page, IN_APP);
  const s = chatCore.chat('md');
  fs.writeFileSync(path.join(s.cwd, 'note.md'), 'Read the [web](https://example.com/page) page.\n');
  await openChat(page, s.id);
  await openAt(page, s.id, 'note.md'); // the file tab is in front; the session's pane is not on screen
  await fileView(page, 'note.md').locator('.fv-md').getByRole('link', { name: 'web' }).click();
  await expect.poll(() => got(page)).toEqual({ opened: ['https://example.com/page'], go: [] });
});

chatTest('shift_click_does_the_opposite: chat set to in-app, Shift opens the user browser', async ({ page, chatCore }) => {
  const { view } = await chatWithLink(page, chatCore, IN_APP);
  await view.getByRole('link', { name: 'web' }).click({ modifiers: ['Shift'] });
  await expect.poll(() => got(page)).toEqual({ opened: ['https://example.com/page'], go: [] });
});

chatTest('inapp_open_uses_session_space_never_you_store', async ({ page, chatCore }) => {
  const { s, view } = await chatWithLink(page, chatCore, IN_APP);
  await view.getByRole('link', { name: 'web' }).click();
  await expect.poll(async () => (await got(page)).go).toEqual([s.id]);
  pwExpect((await got(page)).go).not.toContain('you');
  // The opener never names the "you" space: no session (or "you") falls back to the user's browser.
  const src = fs.readFileSync(path.join(REPO, 'web/src/features/link-routing.tsx'), 'utf8');
  pwExpect(src).toMatch(/at\.session !== YOU_SPACE/);
  pwExpect(src).not.toMatch(/queueBrowserGo\(\s*YOU_SPACE/);
});

chatTest('background_open_only_for_user_clicked_terminal_or_chat_link', async ({ page, chatCore }) => {
  // A Files viewer link never opens in the background; terminal and chat links do.
  pwExpect(route(P({ inApp: true, background: true }), false, 'files')).toBe('pane');
  pwExpect(route(P({ inApp: true, background: true }), false, 'terminal')).toBe('background');
  pwExpect(route(P({ inApp: true, background: true }), false, 'chat')).toBe('background');
  // Only click handlers call the opener (agent-chosen URLs use `nunchiro browser` verbs, never this path).
  // Every file under web/src that calls it (the Files viewer reaches it through Rows' Link), the definition aside.
  const callers = (fs.readdirSync(path.join(REPO, 'web/src'), { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f) && f !== path.join('features', 'link-routing.tsx'))
    .filter((f) => fs.readFileSync(path.join(REPO, 'web/src', f), 'utf8').includes('openRouted('))
    .map((f) => f.split(path.sep).join('/'))
    .sort();
  pwExpect(callers).toEqual(['chat/Rows.tsx', 'terminal/links.ts']);
  const { s, view } = await chatWithLink(page, chatCore, { ...IN_APP, 'browser.links_background': true });
  await view.getByRole('link', { name: 'web' }).click();
  await expect.poll(async () => (await got(page)).go).toEqual([s.id]);
  // Loaded for the space, but the pane is not shown: checked once the click has rendered (two frames on).
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  pwExpect(await page.getByText('The browser needs the Nunchiro app').count()).toBe(0);
});

chatTest('artifact_links_ignore_inapp_setting: Markdown artifact link in Preview', async ({ page, chatCore }) => {
  // Preview renders a Markdown artifact through Rows' Md and Link: with in-app on, its link still opens the user's browser.
  await record(page, IN_APP);
  const s = chatCore.chat('art');
  const full = path.join(s.cwd, 'notes.md');
  const text = '# Notes\n\nRead the [web](https://example.com/page) page.';
  fs.writeFileSync(full, text);
  append(
    s.file,
    rec.use('m1', 'Write', { file_path: full, content: text }),
    rec.result('m1', `File created successfully at: ${full}`, { toolUseResult: { type: 'create', filePath: full, content: text, structuredPatch: [] } }),
  );
  await openChat(page, s.id);
  await chat(page, s.id).locator('.chcard li.art').getByRole('button', { name: 'Open' }).click(); // ticket 1086: Open on the changed-files row
  await page.locator('.preview .pv-body').getByRole('link', { name: 'web' }).click();
  await expect.poll(() => got(page)).toEqual({ opened: ['https://example.com/page'], go: [] });
});

pwTest('worktree_label_host_refuses_tauri_and_nunchiro_artifact', () => {
  pwExpect(labelHost('feat-x')).toBe('feat-x.localhost');
  pwExpect(labelHost('Feat/Login UI')).toBe('feat-login-ui.localhost');
  for (const bad of ['tauri', 'TAURI', 'Tauri.', 'nunchiro-artifact', 'Nunchiro-Artifact.', 'nunchiro-artifact..', '', '...', '/']) pwExpect(labelHost(bad), bad).toBeNull();
  pwExpect(labelled('http://localhost:5173/a?b=1', 'feat-x')).toBe('http://feat-x.localhost:5173/a?b=1');
  pwExpect(labelled('http://localhost:5173/', 'tauri.')).toBe('http://localhost:5173/');
  pwExpect(labelled('https://example.com/', 'feat-x')).toBe('https://example.com/');
});
