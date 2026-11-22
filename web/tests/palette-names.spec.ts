// Ticket 577 (F3): every command is found by its plain name. Each language walks the whole palette: the name a row shows,
// typed in full, brings that row into the first 3. English and Korean also type the plain words a new user would try.
import type { Page } from '@playwright/test';
import { expect, test, type Core } from './fixtures';

const LOCALES = { en: 'en-US', ko: 'ko-KR', ja: 'ja-JP', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', es: 'es-ES', fr: 'fr-FR', pt: 'pt-BR' };

/** For each query: the first 3 command ids the palette lists. One page round trip, typing through the input as a person does. */
const ask = (app: Page, queries: string[]) =>
  app.evaluate((qs) => {
    const input = document.querySelector<HTMLInputElement>('.palette input')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    return qs.map((q) => {
      set.call(input, q);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return [...document.querySelectorAll('#palette-list [data-command]')].slice(0, 3).map((e) => e.getAttribute('data-command')!);
    });
  }, queries);

/** Opens the window in the language, with a shell and a running agent session (two tabs) and the RC flag, so the rows that
 *  appear only then are walked too: session.side-chat, tab.close.others, rc.update.check (ticket 577, verifier gap F3).
 *  Returns the rows with no query: [id, shown name]. */
async function openPalette(app: Page, core: Core) {
  const project = core.project('demo');
  core.shell(project, 'alpha');
  const agent = core.agent(project, 'beta', 'x');
  await app.addInitScript(() => Object.assign(window.__NUNCHIRO__ ?? {}, { rcUpdates: true }));
  await app.goto('/'); // not openWindow: its Connected check is English
  await app.locator(`.tab[data-tab="${agent.id}"]`).click(); // side chat needs the running agent to be the current tab
  await app.locator('.tab[data-tab]').first().waitFor();
  await app.keyboard.press('Meta+KeyK');
  await app.locator('#palette-list [data-command]').first().waitFor();
  return app.locator('#palette-list [data-command]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-command')!, e.querySelector('span')!.textContent!] as const));
}

for (const [lang, locale] of Object.entries(LOCALES)) {
  test.describe(lang, () => {
    test.use({ locale });
    test(`palette_finds_every_command_by_its_name_${lang}`, async ({ app, core }) => {
      const rows = (await openPalette(app, core)).filter(([id]) => !id.startsWith('session.open.'));
      expect(rows.length).toBeGreaterThan(200);
      expect(rows.map(([id]) => id)).toEqual(expect.arrayContaining(['session.side-chat', 'tab.close.others', 'rc.update.check']));
      const tops = await ask(app, rows.map(([, name]) => name));
      const misses = rows.flatMap(([id, name], i) => (tops[i].includes(id) ? [] : [`${id} "${name}" -> ${tops[i].join(', ')}`]));
      expect(misses).toEqual([]);
    });
    // Ticket 991 A10: a row names its object, so no two rows share a title ("Copy path" was listed three times).
    test(`palette_rows_have_distinct_titles_${lang}`, async ({ app, core }) => {
      const rows = (await openPalette(app, core)).filter(([id]) => !id.startsWith('session.open.'));
      const seen = new Map<string, string>();
      const dups = rows.flatMap(([id, name]) => (seen.has(name) ? [`"${name}": ${seen.get(name)} and ${id}`] : (seen.set(name, id), [])));
      expect(dups).toEqual([]);
    });
  });
}

// A plain word and the commands that answer it: any one of them in the first 3 rows passes.
const PLAIN: Record<string, [string, string[]][]> = {
  en: [
    ['settings', ['settings.open']],
    ['preferences', ['settings.open']],
    ['new session', ['session.new']],
    ['new tab', ['session.new', 'session.new.terminal', 'browser.tab.new', 'tab.new.browser']],
    ['close tab', ['tab.close']],
    ['split', ['split.right', 'split.down', 'split.left', 'split.up']],
    ['theme', ['settings.appearance.themeMode', 'settings.appearance.themes']],
    ['dark mode', ['settings.appearance.themeMode']],
    ['keys', ['keys.help']],
    ['shortcuts', ['keys.help']],
    ['font size', ['font.bigger', 'font.smaller', 'font.reset']],
    ['zoom', ['zone.zoom']],
    ['search', ['search.open', 'search.sessions', 'settings.search']],
    ['find', ['terminal.find', 'search.open']],
    ['quit', ['quit.all']],
    ['exit', ['quit.all']],
    ['stop', ['session.stop']],
    ['stop agent', ['session.stop']], // ticket 605: listed only "Quit and stop all agents"
    ['end session', ['session.stop', 'session.close']],
    ['rename', ['tab.rename', 'session.rename']],
    ['restart', ['session.restart']],
    ['undo', ['undo.last']],
    ['reopen', ['tab.reopen']],
    ['sidebar', ['sidebar.left.toggle', 'sidebar.right.toggle']],
    ['layout', ['layout.edit']],
    ['language', ['settings.general.language']],
    ['files', ['files.show']],
    ['changes', ['diff.open']],
    ['pull request', ['pr.list']],
    ['browser', ['tab.new.browser', 'browser.tab.new']],
    ['terminal', ['session.new.terminal', 'focus.terminal']],
    ['worktree', ['worktree.create']],
    ['next tab', ['session.next']],
    ['add project', ['project.add']],
    ['version', ['about.copy']],
    ['help', ['keys.help']],
    // Ticket 608 (first-use walk 4): each found nothing.
    ['split screen', ['split.right', 'split.down', 'split.left', 'split.up']],
    ['mute notifications', ['settings.alerts.notifyDefault']],
    ['turn off notifications', ['settings.alerts.notifyDefault']],
    ['onboarding', ['settings.onboarding.onboarding']],
    ['get started', ['settings.onboarding.onboarding']],
  ],
  ko: [
    ['설정', ['settings.open']],
    ['새 세션', ['session.new']],
    ['탭 닫기', ['tab.close']],
    ['분할', ['split.right', 'split.down', 'split.left', 'split.up']],
    ['나누기', ['split.right', 'split.down', 'split.left', 'split.up']],
    ['테마', ['settings.appearance.themeMode', 'settings.appearance.themes']],
    ['다크 모드', ['settings.appearance.themeMode']],
    ['키', ['keys.help']],
    ['단축키', ['keys.help']],
    ['글자 크기', ['font.bigger', 'font.smaller', 'font.reset']],
    ['검색', ['search.open', 'search.sessions', 'settings.search']],
    ['찾기', ['terminal.find', 'search.open']],
    ['종료', ['quit.all']],
    ['중지', ['session.stop']],
    ['에이전트 중지', ['session.stop']], // ticket 605
    ['세션 종료', ['session.stop', 'session.close']],
    ['이름 바꾸기', ['tab.rename', 'session.rename']],
    ['다시 시작', ['session.restart']],
    ['되돌리기', ['undo.last']],
    ['사이드바', ['sidebar.left.toggle', 'sidebar.right.toggle']],
    ['배치', ['layout.edit']],
    ['언어', ['settings.general.language']],
    ['파일', ['files.show']],
    ['변경 내용', ['diff.open']],
    ['풀 리퀘스트', ['pr.list']],
    ['브라우저', ['tab.new.browser', 'browser.tab.new']],
    ['터미널', ['session.new.terminal', 'focus.terminal']],
    ['워크트리', ['worktree.create']],
    ['다음 탭', ['session.next']],
    ['프로젝트 추가', ['project.add']],
    ['도움말', ['keys.help']],
    // Ticket 608 (first-use walk 4): each found nothing.
    ['화면 분할', ['split.right', 'split.down', 'split.left', 'split.up']],
    ['에이전트 멈추기', ['session.stop']],
    ['세션 이름 바꾸기', ['session.rename', 'tab.rename']],
    ['음소거', ['settings.alerts.notifyDefault']],
    ['알림 끄기', ['settings.alerts.notifyDefault']],
    ['온보딩', ['settings.onboarding.onboarding']],
  ],
};

// The other six languages: the words their keywords add (settings, shortcuts, dark mode, browser, terminal, pull request).
const OTHER: Record<string, string[]> = {
  ja: ['設定', 'ショートカット', 'ダークモード', 'ブラウザ', 'ターミナル', 'プルリクエスト'],
  'zh-Hans': ['设置', '快捷键', '深色模式', '浏览器', '终端', '拉取请求'],
  'zh-Hant': ['設定', '快速鍵', '深色模式', '瀏覽器', '終端', '拉取請求'],
  es: ['ajustes', 'atajos', 'modo oscuro', 'navegador', 'terminal', 'pull request'],
  fr: ['réglages', 'raccourcis', 'mode sombre', 'navigateur', 'terminal', 'pull request'],
  pt: ['configurações', 'atalhos', 'modo escuro', 'navegador', 'terminal', 'pull request'],
};
const WANT = [['settings.open'], ['keys.help'], ['settings.appearance.themeMode'], ['tab.new.browser', 'browser.tab.new'], ['session.new.terminal', 'focus.terminal'], ['pr.list']];
for (const [lang, words] of Object.entries(OTHER)) PLAIN[lang] = words.map((w, i) => [w, WANT[i]]);

for (const lang of Object.keys(PLAIN)) {
  test.describe(`plain ${lang}`, () => {
    test.use({ locale: LOCALES[lang as keyof typeof LOCALES] });
    test(`palette_finds_plain_words_${lang}`, async ({ app, core }) => {
      await openPalette(app, core);
      const tops = await ask(app, PLAIN[lang].map(([word]) => word));
      const misses = PLAIN[lang].flatMap(([word, want], i) => (want.some((id) => tops[i].includes(id)) ? [] : [`"${word}" wants ${want.join('|')} -> ${tops[i].join(', ')}`]));
      expect(misses).toEqual([]);
    });
  });
}

// Ticket 991 A10: no bare verb ("Hide", "Copy", "Pin") and no "to the down": a row's title says what it acts on.
test('palette_rows_name_their_object_en', async ({ app, core }) => {
  const rows = (await openPalette(app, core)).filter(([id]) => !id.startsWith('session.open.'));
  const bare = rows.filter(([, name]) => name.trim().split(/\s+/).length < 2 || /to the (down|up)\b/.test(name)).map(([id, name]) => `${id} "${name}"`);
  expect(bare).toEqual([]);
});

// Ticket 991 A10: "Delete card" with no card on screen offers no unrelated destructive command (Remove worktree…).
test('palette_delete_card_offers_no_other_removal', async ({ app, core }) => {
  await openPalette(app, core);
  const [top] = await ask(app, ['delete card']);
  expect(top.filter((id) => /remove|delete/.test(id) && !id.startsWith('board.card.'))).toEqual([]);
});

// Look 1117 v6r (A S3-1): a session row's hover showed its raw id ("session.open.ab03f88b-5459-…"). A command's name under
// the pointer stays (V1A-58: files.show); a session row has no name of that kind, only the session's internal id.
test('palette_session_row_shows_no_internal_id', async ({ app, core }) => {
  const sessions = (await openPalette(app, core)).filter(([id]) => id.startsWith('session.open.'));
  expect(sessions.length).toBeGreaterThan(0);
  for (const [id] of sessions) {
    const row = app.locator(`#palette-list [data-command="${id}"]`);
    await row.hover();
    await expect(row).toHaveAttribute('aria-selected', 'true');
    expect(await row.innerText()).not.toMatch(/session\.open|[0-9a-f]{8}-[0-9a-f]{4}-/);
  }
  const command = app.locator('#palette-list [data-command="files.show"]');
  await command.hover();
  await expect(command.locator('.id')).toBeVisible();
});
