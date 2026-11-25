// Ticket 258 (needs 197 G09): chat and UI typography rows on Settings > Appearance, their CSS variables on the window
// root, code blocks on the terminal font, chat contrast, and KaTeX math in chat Markdown. A real core and a fake Claude
// (the chat harness); values are seeded into the window store, so each test is deterministic.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';
import { REPO } from './fixtures';

const STORE = 'nunchiro.settings.v1';
/** Seeds the window store once (a reload keeps what the window saved since). */
const seed = (page: Page, s: Record<string, unknown>) =>
  page.addInitScript(
    ({ s, key }) => {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem(key, JSON.stringify(s));
        sessionStorage.setItem('seeded', '1');
      }
    },
    { s, key: STORE },
  );
const stored = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}'), STORE);
const css = (page: Page, sel: string, prop: string) => page.locator(sel).first().evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);
const rootVar = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

const ALL = {
  'type.ui_font': 'Menlo',
  'type.chat_font': 'Menlo',
  'type.chat_size': 16,
  'type.chat_line': 1.8,
  'type.code_size': 13,
  'type.code_font': 'terminal',
  'type.composer_font': 'Menlo',
  'type.composer_size': 16,
  'type.contrast': 'high',
  'type.math': true,
};

async function chatWith(page: Page, chatCore: { chat: (n: string) => { id: string; file: string } }, text: string) {
  const s = chatCore.chat('ty');
  append(s.file, rec.user('go'), rec.assistant(text));
  await openChat(page, s.id);
  await expect(chat(page, s.id).locator('.md').first()).toBeVisible();
  return s;
}

async function openAppearance(page: Page) {
  await page.keyboard.press('Meta+Comma');
  const nav = page.getByRole('navigation', { name: 'Settings pages' });
  await expect(nav).toBeVisible();
  await page.locator('.settings > nav button[data-page="appearance"]').click();
}

test('typography_rows_on_appearance_and_searchable', async ({ page, chatCore }) => {
  await chatWith(page, chatCore, 'hello');
  await openAppearance(page);
  const sec = page.getByRole('region', { name: 'Chat typography' });
  await expect(sec).toBeVisible();
  for (const name of ['UI font', 'Chat font', 'Composer font']) await expect(sec.getByRole('combobox', { name })).toBeVisible();
  for (const name of ['Chat text size', 'Chat line height', 'Code text size', 'Composer text size']) await expect(sec.getByRole('spinbutton', { name })).toBeVisible();
  await expect(sec.getByRole('switch', { name: 'Math in chat' })).toBeVisible();
  await expect(sec.getByRole('button', { name: 'Reset typography' })).toBeVisible();
  // Controls are wired: a pick lands in the store.
  await sec.getByRole('radio', { name: 'High' }).check();
  await expect.poll(async () => (await stored(page)).features?.['type.contrast']).toBe('high');
  await sec.getByRole('switch', { name: 'Math in chat' }).click();
  await expect.poll(async () => (await stored(page)).features?.['type.math']).toBe(true);
  // Searchable: the settings search finds a row and focuses it.
  const search = page.getByRole('searchbox', { name: 'Search settings' });
  await search.fill('Chat text size');
  await page.getByRole('list', { name: 'Matching settings' }).getByRole('button').filter({ hasText: 'Chat text size' }).first().click();
  await expect(page.getByRole('spinbutton', { name: 'Chat text size' })).toBeFocused();
});

test('defaults_leave_chat_unchanged', async ({ page, chatCore }) => {
  await chatWith(page, chatCore, 'Plain answer with `code` and $5 or $10.\n\n```\nlet x = 1;\n```');
  // The tokens exist, and equal today's look.
  expect(await rootVar(page, '--fs-chat')).not.toBe('');
  expect(await css(page, '.cin', 'font-size')).toBe('14.5px');
  expect(parseFloat(await css(page, '.cin', 'line-height'))).toBeCloseTo(14.5 * 1.65, 3); // WebKit rounds to 23.924999px
  expect(await css(page, '.cin', 'font-family')).toBe(await page.evaluate(() => getComputedStyle(document.body).fontFamily));
  expect(await css(page, '.md pre', 'font-size')).toBe('11.5px');
  expect(await css(page, '.md pre', 'font-family')).toMatch(/^"?SF Mono"?, Menlo, D2Coding, monospace$/);
  expect(await css(page, '.md p code', 'font-size')).toBe('12px');
  expect(await css(page, '.cbox textarea', 'font-size')).toBe('14.5px');
  // styles.css's .cbox textarea list, as this engine serialises it (Chromium writes BlinkMacSystemFont as system-ui).
  const composerList = await page.evaluate(() => {
    const probe = document.createElement('textarea');
    probe.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif";
    document.body.append(probe);
    const f = getComputedStyle(probe).fontFamily;
    probe.remove();
    return f;
  });
  expect(await css(page, '.cbox textarea', 'font-family')).toBe(composerList);
  // Math is off by default: dollar amounts stay text.
  await expect(page.locator('.md .katex')).toHaveCount(0);
  await expect(page.locator('.md').first()).toContainText('$5 or $10');
  expect(await page.evaluate(() => document.documentElement.getAttribute('style') ?? '')).not.toMatch(/--font-chat|--fs-chat|--fs-code|--font-composer|--fs-composer/);
});

test('chat_font_and_sizes_apply_to_chat_and_composer', async ({ page, chatCore }) => {
  await seed(page, { features: { 'type.chat_font': 'Menlo', 'type.chat_size': 16, 'type.chat_line': 1.8, 'type.code_size': 13, 'type.composer_font': 'Menlo', 'type.composer_size': 16, 'type.ui_font': 'Menlo' } });
  await chatWith(page, chatCore, 'Some text\n\n```\ncode\n```');
  expect(await css(page, '.cin', 'font-size')).toBe('16px');
  expect(parseFloat(await css(page, '.cin', 'line-height'))).toBeCloseTo(16 * 1.8, 3);
  expect(await css(page, '.cin', 'font-family')).toMatch(/^Menlo/);
  expect(await css(page, '.md pre', 'font-size')).toBe('13px');
  expect(await css(page, '.cbox textarea', 'font-size')).toBe('16px');
  expect(await css(page, '.cbox textarea', 'font-family')).toMatch(/^Menlo/);
  expect(await rootVar(page, '--font-ui')).toMatch(/^"?Menlo"?/);
});

test('code_blocks_follow_terminal_font', async ({ page, chatCore }) => {
  await seed(page, { termFont: '"Menlo", monospace', features: { 'type.code_font': 'terminal' } });
  await chatWith(page, chatCore, 'See `x`\n\n```\ncode\n```');
  expect(await css(page, '.md pre', 'font-family')).toBe('Menlo, monospace');
  expect(await css(page, '.md p code', 'font-family')).toBe('Menlo, monospace');
});

test('high_contrast_raises_chat_text_role', async ({ page, chatCore }) => {
  await seed(page, { features: { 'type.contrast': 'high' } });
  await chatWith(page, chatCore, '> quoted aside');
  const text = await page.evaluate(() => {
    const probe = document.createElement('i');
    probe.style.color = 'var(--text)';
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  expect(await css(page, '.md blockquote', 'color')).toBe(text);
});

test('reset_restores_every_typography_default', async ({ page, chatCore }) => {
  await seed(page, { termFont: '"Menlo", monospace', features: ALL });
  await chatWith(page, chatCore, 'text');
  expect(await css(page, '.cin', 'font-size')).toBe('16px');
  await openAppearance(page);
  await page.getByRole('button', { name: 'Reset typography' }).click();
  // useFeatureSetting has no delete: Reset stores each default.
  const DEFAULTS = { 'type.ui_font': '', 'type.chat_font': '', 'type.chat_size': 14.5, 'type.chat_line': 1.65, 'type.code_size': 11.5, 'type.code_font': 'default', 'type.composer_font': '', 'type.composer_size': 14.5, 'type.contrast': 'normal', 'type.math': false };
  // Ticket 391: showing the Appearance page also marks onboarding's look step as seen, beside the type keys; ticket 582 (819078dcb):
  // the running chat agent ticked the first-session step before the page opened.
  await expect.poll(async () => (await stored(page)).features).toEqual({ ...DEFAULTS, 'onboarding.marks': ['session', 'appearance'] });
  expect(await css(page, '.cin', 'font-size')).toBe('14.5px');
  expect(await page.evaluate(() => document.documentElement.getAttribute('style') ?? '')).not.toMatch(/--font-chat|--fs-chat|--lh-chat|--fs-code|--font-code|--font-composer|--fs-composer|--font-ui/);
  expect(await page.evaluate(() => document.documentElement.dataset.chatContrast)).toBeUndefined();
});

test('chat_math_renders_with_local_katex', async ({ page, chatCore }) => {
  const hosts = new Set<string>();
  page.on('request', (r) => hosts.add(new URL(r.url()).hostname));
  await seed(page, { features: { 'type.math': true } });
  await chatWith(page, chatCore, 'Euler $e^{i\\pi}+1=0$ and\n\n$$\n\\int_0^1 x\\,dx\n$$');
  await expect(page.locator('.md .katex')).toHaveCount(2);
  await expect(page.locator('.md .katex-display')).toHaveCount(1);
  // KaTeX's own stylesheet and fonts, bundled: no CDN.
  expect(await css(page, '.md .katex', 'font-family')).toContain('KaTeX_Main');
  // The stylesheet matches the renderer's class names (0.19 CSS renamed .base to .katex-base).
  expect(await css(page, '.md .katex .katex-base', 'display')).toBe('inline-block');
  expect([...hosts].filter((h) => h !== 'localhost' && h !== '127.0.0.1')).toEqual([]);
});

test('chat_math_link_is_not_live', async ({ page, chatCore }) => {
  await seed(page, { features: { 'type.math': true } });
  await chatWith(page, chatCore, '$\\llap{Q\\hspace{8em}}$ Bad $\\href{https://evil.example}{click}$ and $\\htmlId{x}{y}$ end');
  const md = page.locator('.md').first();
  await expect(md.locator('.katex')).not.toHaveCount(0);
  await expect(md.locator('a')).toHaveCount(0);
  await expect(md.locator('#x')).toHaveCount(0);
  await expect(md).toContainText('\\href');
  // A box pushed out of its line (\llap) is clipped to the math: nothing of it shows, or takes clicks, beside the message.
  // (A box raised or lowered with \smash{\raisebox} grows the message instead, in both engines.)
  const hit = await md.evaluate((m) => {
    const q = [...m.querySelectorAll('.katex span')].find((e) => e.childElementCount === 0 && e.textContent === 'Q')!;
    const r = q.getBoundingClientRect();
    const box = m.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    return { outside: x < box.left || x > box.right || y > box.bottom || y < box.top, inKatex: !!document.elementFromPoint(x, y)?.closest('.md .katex') };
  });
  expect(hit.outside).toBe(true); // the box does leave the message's layout box
  expect(hit.inKatex).toBe(false); // but nothing of it can be seen or clicked there
});

test('artifact_and_widget_frames_keep_their_fonts', async ({ page, chatCore }) => {
  await seed(page, { features: { 'type.chat_font': 'Menlo', 'type.ui_font': 'Menlo' } });
  await chatWith(page, chatCore, 'text');
  expect(await rootVar(page, '--font-chat')).toMatch(/Menlo/);
  // A frame is its own document: the window's variables do not reach it, and nothing passes them in.
  const inFrame = await page.evaluate(async () => {
    const f = document.createElement('iframe');
    f.srcdoc = '<p style="font-family: var(--font-chat, serif)">x</p>';
    document.body.append(f);
    await new Promise((r) => f.addEventListener('load', r, { once: true }));
    const v = getComputedStyle(f.contentDocument!.querySelector('p')!).fontFamily;
    f.remove();
    return v;
  });
  expect(inFrame).toBe('serif');
  // The artifact CSP's font-src is unchanged (widget-check G09).
  const csp = fs.readFileSync(path.join(REPO, 'app/src-tauri/src/artifacts/csp-default.txt'), 'utf8');
  expect(csp).toContain("font-src data: https://fonts.gstatic.com;");
});
