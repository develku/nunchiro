// Ticket 1039 (owner 2026-11-21; approved mockup docs/design/chat-theme-1121/index.html, right column "Theme accents"):
// the marks in a chat that carry meaning take the theme's colours, and Settings > Appearance > "Chat colours" turns that
// off (Plain = the look before this ticket). WANT holds the colours the mockup's own script computes for the two themes
// it draws, written out, so this spec does not lean on themes/derive.ts. Each colour must read at 4.5:1 or more on what
// is behind it: the chat surface, and for inline code and paths the code background too.
import type { Locator, Page } from '@playwright/test';
import { THEMES } from '../src/themes/catalog/catalog.gen';
import { parseGhostty } from '../src/themes/ghostty';
import { DARK_PICK, LIGHT_PICK, type ThemePick } from '../src/themes/nunchiro';
import { append, chat, type ChatCore, expect, openChat, rec, test } from './fixtures/chat/harness';
import { openTheme, stored, token } from './theme-harness';

const WANT = {
  'Catppuccin Latte': { text: '#4c4f69', accent: '#1d61e9', code: '#984d84', link: '#12757a', mark: '#3e67b8', ok: '#307820', bad: '#d20f39' },
  'Catppuccin Mocha': { text: '#cdd6f4', accent: '#89b4fa', code: '#f5c2e7', link: '#94e2d5', mark: '#6e8fc7', ok: '#a6e3a1', bad: '#f38ba8' },
} as const;
type Name = keyof typeof WANT;
const pick = (name: Name): ThemePick => ({ id: `catalog:${name}`, name, colors: parseGhostty(THEMES[name]) });
const use = (page: Page, theme: Name | ThemePick, more: Record<string, unknown> = {}) =>
  page.addInitScript((s) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify(s)), { themeMode: 'fixed', themeFixed: typeof theme === 'string' ? pick(theme) : theme, ...more });

// The mockup's turn: three tool calls, then an answer with a heading, bold, inline code, file paths, a link and a list.
const ANSWER = [
  '### Fixed: the test expected the old token shape',
  'The test in `tests/login.spec.ts` still read `token.value`. I changed it to the new **object shape** and kept the old field for one release.',
  '- Updated `auth/token.ts` to return `{ value, expires }`\n- **All 42 tests pass**; no other caller used the old field\n- See the [migration note](https://example.com/migration) for the API change',
  "```ts\nexport function readToken(raw: string) {\n  return { value: raw, expires: '2026-12-01' } // new shape\n}\n```",
].join('\n\n');
async function open(page: Page, core: ChatCore) {
  const s = core.chat('login');
  append(
    s.file,
    rec.user('The login test fails after the token change. Fix it and run the tests.'),
    rec.use('r1', 'Read', { file_path: `${s.cwd}/auth/token.ts` }),
    rec.result('r1', 'export const token = 1;'),
    rec.edit('e1', `${s.cwd}/auth/token.ts`, ['-a', '-b', '+c', '+d', '+e', '+f', '+g', '+h']),
    rec.use('t1', 'Bash', { command: 'npm test' }),
    rec.result('t1', '42 passed'),
    rec.assistant(ANSWER),
  );
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.locator('.md h3')).toBeVisible();
  await view.locator('.turnsum .sum').click(); // the turn's tool rows
  await expect(view.locator('.tool .toolname').first()).toBeVisible();
  return view;
}
/** The marks by name; `pseudo` reads a pseudo-element's colour. */
const marks = (view: Locator): Record<string, [Locator, string?]> => ({
  heading: [view.locator('.md h3')],
  bold: [view.locator('.md p strong')],
  'inline code': [view.locator('.md code', { hasText: '{ value, expires }' })], // not `token.value`: that has a path's shape
  'file path': [view.locator('.md .mdpath code', { hasText: 'tests/login.spec.ts' })],
  'tool row path': [view.locator('.tool .tpath')],
  link: [view.locator('.md .mdlink')],
  'list marker': [view.locator('.md li'), '::marker'],
  'tool name': [view.locator('.tool .toolname', { hasText: 'Read' })],
  'command name': [view.locator('.tool .toolname', { hasText: 'Ran' })],
  'tests passed': [view.locator('.turnsum .sum .ok')],
  'lines added': [view.locator('.chcard .add')],
  'lines removed': [view.locator('.chcard .del')],
  'tool done': [view.locator('.tool .tdone')],
  body: [view.locator('.md p')],
});

/** An element's colour as #rrggbb and its lowest contrast: on the first opaque background behind it and on the chat's. */
const read = ([l, pseudo]: [Locator, string?]) =>
  l.first().evaluate((e, pseudo) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([a, b, c]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(a) + 0.7152 * f(b) + 0.0722 * f(c);
    };
    const bg = (el: Element | null): number[] => {
      for (; el; el = el.parentElement) {
        const c = rgb(getComputedStyle(el).backgroundColor);
        if (c.length >= 3 && (c[3] ?? 1) > 0.5) return c;
      }
      return [255, 255, 255];
    };
    const color = rgb(getComputedStyle(e, pseudo).color);
    const ratio = (b: number[]) => {
      const [x, y] = [lum(color), lum(b)];
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    return { color: `#${color.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`, ratio: Math.min(ratio(bg(e)), ratio(bg(e.closest('.chat')))) };
  }, pseudo);

for (const name of Object.keys(WANT) as Name[]) {
  test(`chat_text_takes_theme_accents: ${name}, each mark in its mapped colour at 4.5:1 or more`, async ({ page, chatCore }) => {
    await use(page, name);
    const view = await open(page, chatCore);
    const m = marks(view);
    const w = WANT[name];
    const want: Record<string, string> = {
      heading: w.accent, bold: w.accent,
      'inline code': w.code, 'file path': w.code, 'tool row path': w.code,
      link: w.link, 'list marker': w.mark,
      'tests passed': w.ok, 'lines added': w.ok, 'tool done': w.ok,
      'lines removed': w.bad, // the mockup draws no error; its rule names red (palette 1), by the same step
      body: w.text,
    };
    for (const [what, colour] of Object.entries(want)) {
      const got = await read(m[what]);
      expect.soft(got.color, what).toBe(colour);
      expect.soft(got.ratio, `${what} ${got.color}`).toBeGreaterThanOrEqual(4.5);
    }
    // Look v35 b S3-2: a finished row's name is the row's muted text, as the rest of its line (blue is the working light).
    const line = view.locator('.tool .tn', { hasText: 'Ran npm test' });
    await expect(line).toHaveText('Ran npm test');
    const muted = (await token(page, '--muted')).toLowerCase();
    expect((await read([line])).color).toBe(muted);
    for (const what of ['tool name', 'command name']) expect.soft((await read(m[what])).color, what).toBe(muted);
    // Fenced code keeps its own colours: the accents stop at the block.
    expect((await read([view.locator('.md pre code')])).color).not.toBe(w.code);
  });

  test(`chat_colours_plain_is_the_look_before: ${name}, no mark changes colour`, async ({ page, chatCore }) => {
    await use(page, name, { chatColours: 'plain' });
    const m = marks(await open(page, chatCore));
    const hex = async (t: string) => (await token(page, t)).toLowerCase();
    const [text, run, muted, ok, bad] = [await hex('--text'), await hex('--run'), await hex('--muted'), await hex('--ok'), await hex('--bad')];
    // Before the ticket: headings, bold, inline code and markers were body text; links and paths the link colour (--run);
    // a tool name the row's muted text; the success marks --ok and the removed count --bad, as the theme wrote them.
    const want: Record<string, string> = {
      heading: text, bold: text, 'inline code': text, 'list marker': text, body: text,
      'file path': run, 'tool row path': run, link: run,
      'tool name': muted, 'command name': muted, 'tests passed': ok, 'tool done': ok, 'lines added': ok, 'lines removed': bad,
    };
    for (const [what, colour] of Object.entries(want)) expect.soft((await read(m[what])).color, what).toBe(colour);
  });
}

// The two bundled Nunchiro themes paint tokens.css, not derive.ts: the same marks are coloured there and read at 4.5:1.
for (const bundled of [LIGHT_PICK, DARK_PICK])
  test(`chat_text_takes_theme_accents: ${bundled.name}, each mark coloured and at 4.5:1 or more`, async ({ page, chatCore }) => {
    await use(page, bundled);
    const m = marks(await open(page, chatCore));
    const body = (await read(m.body)).color;
    for (const what of Object.keys(m)) {
      const got = await read(m[what]);
      if (what !== 'body') expect.soft(got.color, what).not.toBe(body);
      expect.soft(got.ratio, `${what} ${got.color}`).toBeGreaterThanOrEqual(4.5);
    }
  });

for (const name of Object.keys(WANT) as Name[])
  test(`running_tool_name_takes_the_working_blue: ${name}, only a row still running has its name in the accent (look v35 b S3-2)`, async ({ page, chatCore }) => {
  await use(page, name);
  const s = chatCore.chat('run');
  append(s.file, rec.user('Run the tests.'), rec.use('r1', 'Read', { file_path: `${s.cwd}/a.ts` }), rec.result('r1', 'x'), rec.use('t1', 'Bash', { command: 'npm test' }));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  const sum = view.locator('.turnsum .sum');
  await sum.click();
  const running = view.locator('.tool[data-running] .toolname', { hasText: 'Ran' });
  await expect(running).toBeVisible();
  expect((await read([running])).color).toBe(WANT[name].accent);
  const finished = view.locator('.tool:not([data-running]) .toolname', { hasText: 'Read' });
  expect((await read([finished])).color).toBe((await token(page, '--muted')).toLowerCase());
  await page.screenshot({ path: `../.scratch/shots/w108-s3-2-tool-rows-${name.split(' ')[1]}-${test.info().project.name}.png` });
});

test('running_group_paints_only_its_running_row: Verbose view, an open running read group keeps its finished rows muted (w108 review S2)', async ({ page, chatCore }) => {
  await use(page, 'Catppuccin Latte');
  await page.addInitScript(() => localStorage.setItem('nunchiro.chatView.v2', 'verbose'));
  const s = chatCore.chat('group');
  append(s.file, rec.user('Read them.'), rec.use('r1', 'Read', { file_path: `${s.cwd}/a.ts` }), rec.result('r1', 'x'), rec.use('r2', 'Read', { file_path: `${s.cwd}/b.ts` }), rec.result('r2', 'y'), rec.use('r3', 'Read', { file_path: `${s.cwd}/c.ts` }));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  const group = view.locator('.tool[data-running]').first(); // the group row: its open rows come after it in the DOM
  await group.locator('> .tl').click();
  const inner = view.locator('.tool .tx .tool');
  await expect(inner).toHaveCount(3);
  const accent = WANT['Catppuccin Latte'].accent;
  const muted = (await token(page, '--muted')).toLowerCase();
  expect((await read([group.locator('> .tl .toolname')])).color).toBe(accent);
  expect((await read([inner.nth(0).locator('.toolname')])).color).toBe(muted);
  expect((await read([inner.nth(1).locator('.toolname')])).color).toBe(muted);
  expect((await read([inner.nth(2).locator('.toolname')])).color).toBe(accent);
});

test('chat_colours_setting: Settings > Appearance has Chat colours, Theme accents by default; Plain is kept and Reset brings the accents back', async ({ page, chatCore }) => {
  await use(page, 'Catppuccin Latte');
  const view = await open(page, chatCore);
  const heading = async () => (await read([view.locator('.md h3')])).color;
  expect(await heading()).toBe(WANT['Catppuccin Latte'].accent);
  await openTheme(page, false);
  const group = page.getByRole('radiogroup', { name: 'Chat colours' });
  await expect(group.getByRole('radio', { name: 'Theme accents' })).toBeChecked();
  await group.getByRole('radio', { name: 'Plain' }).check();
  await expect.poll(heading).toBe(WANT['Catppuccin Latte'].text);
  expect(JSON.parse((await stored(page))!).chatColours).toBe('plain');
  await page.getByRole('button', { name: 'Reset Chat colours to default' }).click();
  await expect(group.getByRole('radio', { name: 'Theme accents' })).toBeChecked();
  await expect.poll(heading).toBe(WANT['Catppuccin Latte'].accent);
});
