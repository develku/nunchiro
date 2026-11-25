// Ticket 609 (first-use walks 579, 603, 605, 608): the palette answers the plain words a new user types, not only the
// words a title happens to use. Every query below is written from that user's point of view (the verb and the thing, a
// peer app's name for it) and must put one of the commands it names in the first 3 rows. The queries were written before
// the word lists (areas/palette-words.ts, settings-search-words.ts) were extended; palette-names.spec.ts keeps the
// plain words of tickets 577, 605 and 608 and the whole-name walk.
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';

const NEW = ['session.new', 'session.new.claude', 'session.new.codex'];
const PATH = ['path.copy', 'worktree.copy-path', 'session.copy-path'];
const REVEAL = ['path.reveal', 'worktree.reveal'];
const FONT = ['font.bigger', 'font.smaller', 'font.reset', 'settings.terminal.termFontSize'];
const SIDEBAR = ['sidebar.left.toggle', 'sidebar.right.toggle'];
const SOUND = ['settings.alerts.soundDone', 'settings.alerts.soundWaiting', 'settings.alerts.soundVolume'];
const WEB = ['tab.new.browser', 'browser.tab.new'];
const THEME = ['settings.appearance.themeMode', 'settings.appearance.themes'];
const SWITCH = ['session.next', 'session.prev', 'session.last'];
const FILES = ['files.show', 'focus.tree'];
const SPLIT = ['split.right', 'split.down', 'split.left', 'split.up'];
const FONTS = ['settings.terminal.termFont', 'settings.appearance.uiFont', 'settings.appearance.chatFont', 'settings.appearance.codeFont'];

/** A query and the commands that answer it: any one of them in the first 3 rows passes. */
const QUERIES: Record<'en' | 'ko', [string, string[]][]> = {
  en: [
    ['new chat', NEW],
    ['start agent', NEW],
    ['open terminal', ['session.new.terminal', 'focus.terminal']],
    ['close session', ['session.close', 'session.stop', 'tab.close']],
    ['restart agent', ['session.restart']],
    ['copy path', PATH],
    ['show in finder', REVEAL],
    ['search files', ['search.open']],
    ['search chats', ['search.sessions']],
    ['clear screen', ['terminal.clear']],
    ['bigger text', ['font.bigger']],
    ['text size', FONT],
    ['reset layout', ['layout.reset']],
    ['rearrange panels', ['layout.edit']],
    ['what changed', ['diff.open']],
    ['review changes', ['diff.open']],
    ['update app', ['rc.update.check']],
    ['open folder', ['project.add']],
    ['new branch', ['worktree.create']],
    ['delete project', ['project.remove']],
    ['hide sidebar', SIDEBAR],
    ['kanban', ['board.toggle']],
    ['maximize', ['pane.maximize', 'zone.zoom']],
    ['switch tab', SWITCH],
    ['file tree', FILES],
    ['side panel', ['pane.toggle']],
    ['switch to codex', ['handoff.codex']],
    ['quick question', ['session.side-chat']],
    ['keybindings', ['keys.help', 'settings.keys.bindings']],
    ['sound', SOUND],
    ['favorite project', ['project.pin']],
    ['debug info', ['about.copy', 'settings.about.buildInfo']],
    ['needs my attention', ['waiting.next']],
    ['github', ['pr.list']],
    ['undo close', ['tab.reopen']],
    ['run in background', ['window.detach']],
    ['open website', WEB],
    ['change font', FONTS],
    ['default model', ['settings.providers.newDefaultModel']],
    ['launch at startup', ['settings.general.startAtLogin']],
    ['prevent sleep', ['settings.general.keepAwake']],
    ['color theme', THEME],
    ['split terminal', SPLIT], // walk 10 (ticket 810): only the split setting was listed
  ],
  ko: [
    ['새 채팅', NEW],
    ['에이전트 시작', NEW],
    ['터미널 열기', ['session.new.terminal', 'focus.terminal']],
    ['세션 닫기', ['session.close', 'session.stop', 'tab.close']],
    ['에이전트 재시작', ['session.restart']],
    ['경로 복사', PATH],
    ['파인더에서 보기', REVEAL],
    ['파일 검색', ['search.open']],
    ['채팅 검색', ['search.sessions']],
    ['화면 지우기', ['terminal.clear']],
    ['글자 키우기', ['font.bigger']],
    ['폰트 크기', FONT],
    ['배치 초기화', ['layout.reset']],
    ['패널 재배치', ['layout.edit']],
    ['변경 사항', ['diff.open']],
    ['코드 리뷰', ['diff.open']],
    ['업데이트 확인', ['rc.update.check']],
    ['폴더 열기', ['project.add']],
    ['새 브랜치', ['worktree.create']],
    ['프로젝트 삭제', ['project.remove']],
    ['사이드바 숨기기', SIDEBAR],
    ['칸반', ['board.toggle']],
    ['최대화', ['pane.maximize', 'zone.zoom']],
    ['탭 전환', SWITCH],
    ['파일 트리', FILES],
    ['옆 패널', ['pane.toggle']],
    ['코덱스로 넘기기', ['handoff.codex']],
    ['간단한 질문', ['session.side-chat']],
    ['단축키 설정', ['keys.help', 'settings.keys.bindings']],
    ['알림 소리', SOUND],
    ['즐겨찾기', ['project.pin']],
    ['디버그 정보', ['about.copy', 'settings.about.buildInfo']],
    ['승인 대기', ['waiting.next']],
    ['깃허브', ['pr.list']],
    ['닫은 탭 복구', ['tab.reopen']],
    ['백그라운드 실행', ['window.detach']],
    ['웹사이트 열기', WEB],
    ['폰트 바꾸기', FONTS],
    ['기본 모델', ['settings.providers.newDefaultModel']],
    ['부팅 시 실행', ['settings.general.startAtLogin']],
    ['절전 방지', ['settings.general.keepAwake']],
    ['색상 테마', THEME],
    ['실행 취소', ['undo.last']],
    ['터미널 분할', SPLIT],
  ],
};

const LOCALES = { en: 'en-US', ko: 'ko-KR', ja: 'ja-JP', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', es: 'es-ES', fr: 'fr-FR', pt: 'pt-BR' };

/** For each query: the first 3 command ids the palette lists, typed through the input as a person does. */
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

/** The window with a shell and a running agent session (so the rows that appear only then are listed), palette open. Returns every row id. */
async function openPalette(app: Page, core: Core) {
  const project = core.project('demo');
  core.shell(project, 'alpha');
  const agent = core.agent(project, 'beta', 'x');
  await app.addInitScript(() => Object.assign(window.__NUNCHIRO__ ?? {}, { rcUpdates: true }));
  await app.goto('/'); // not openWindow: its Connected check is English
  await app.locator(`.tab[data-tab="${agent.id}"]`).click();
  await app.locator('.tab[data-tab]').first().waitFor();
  await app.keyboard.press('Meta+KeyK');
  await app.locator('#palette-list [data-command]').first().waitFor();
  return app.locator('#palette-list [data-command]').evaluateAll((els) => els.map((e) => e.getAttribute('data-command')!));
}

for (const lang of ['en', 'ko'] as const) {
  test.describe(lang, () => {
    test.use({ locale: LOCALES[lang] });
    test(`palette_everyday_queries_${lang}`, async ({ app, core }) => {
      await openPalette(app, core);
      const list = QUERIES[lang];
      expect(list.length).toBeGreaterThanOrEqual(30);
      const tops = await ask(app, list.map(([q]) => q));
      const misses = list.flatMap(([q, ids], i) => (ids.some((id) => tops[i].includes(id)) ? [] : [`"${q}" wants ${ids.join(' | ')} -> ${tops[i].join(', ')}`]));
      expect(misses).toEqual([]);
    });
  });
}

// Review r1: a word that is the platform's name for a harmless command (Undo, Cancel, Redo) must not also sit on a command that
// stops, closes, deletes or quits: a Korean user typing macOS's "실행 취소" (Undo) stopped the running agent. Per language, the
// Undo name puts undo.last first, and no command that ends something is among the first 3 for any of these names.
const UNDO: Record<string, string[]> = {
  en: ['undo'], ko: ['실행 취소', '되돌리기'], ja: ['元に戻す', '取り消し'], 'zh-Hans': ['撤销'], 'zh-Hant': ['復原'], es: ['deshacer'], fr: ['annuler'], pt: ['desfazer'],
};
const HARMFUL = /^(session\.(stop|close|restart)|tab\.close(\..+)?|quit\.all|window\.detach|project\.remove|group\.dissolve|worktree\.(remove|tidy)|board\.card\.delete)$/;
for (const [lang, names] of Object.entries(UNDO)) {
  test.describe(`undo ${lang}`, () => {
    test.use({ locale: LOCALES[lang as keyof typeof LOCALES] });
    test(`palette_undo_name_never_reaches_a_destructive_command_${lang}`, async ({ app, core }) => {
      await openPalette(app, core);
      const tops = await ask(app, names);
      expect(tops.map((t) => t[0])).toEqual(names.map(() => 'undo.last'));
      expect(tops.flat().filter((id) => HARMFUL.test(id))).toEqual([]);
    });
  });
}

// Ticket 991 A4: a greyed row says why, and Enter on it says so again instead of doing nothing (the palette stays open).
test('A4 palette_disabled_row_says_why', async ({ app, core }) => {
  const project = core.project('demo');
  const alpha = core.shell(project, 'alpha');
  // Look 1117 v4f (A q10b-2): an idle session can be closed; only a working one needs Stop first. Here it works.
  let working = true;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m !== 'string' || !m.includes('"event":"snapshot"')) return ws.send(m);
      const f = JSON.parse(m);
      for (const x of f.sessions ?? []) if (x.id === alpha.id) x.attention.working = working;
      ws.send(JSON.stringify(f));
    });
  });
  await app.goto('/');
  await app.locator('.tab[data-tab]').first().click();
  await app.keyboard.press('Meta+KeyK');
  // Eighth look (A): with no browser open "Close browser tab" was the first row for "close" and looked usable. It is
  // drawn off with its reason, below the rows that can run.
  await app.keyboard.type('close');
  const web = app.locator('#palette-list [data-command="browser.tab.close"]');
  await expect(web).toHaveAttribute('aria-disabled', 'true');
  await expect(web).toContainText('The browser is not open');
  await expect(app.locator('#palette-list [role="option"]').first()).not.toHaveAttribute('aria-disabled', 'true');
  await app.locator('.palette input').fill('Close session');
  const close = app.locator('#palette-list [data-command="session.close"]');
  await expect(close).toHaveAttribute('aria-disabled', 'true');
  await expect(close).toContainText('Still running: stop it first, or use Close tab');
  await close.hover(); // the pointer selects the row (a click on an aria-disabled row is refused by Playwright)
  await app.keyboard.press('Enter');
  await expect(app.locator('.palette .psaid')).toHaveText('Still running: stop it first, or use Close tab');
  // Eighth look (A): the reason is drawn once, on the row; the line Enter fills is read out, not drawn a second time.
  expect(await app.locator('.palette .psaid').evaluate((e) => e.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
  await expect(app.locator('.palette')).toBeVisible();
  await app.keyboard.press('Escape');
  // Idle: Close session is offered (the core's close keeps its Undo).
  working = false;
  core.shell(project, 'beta'); // a new snapshot carries alpha idle
  await expect.poll(() => app.evaluate(() => document.querySelector('.tab[data-tab][aria-selected="true"]') !== null)).toBe(true);
  await app.locator('.tab[data-tab]').first().click();
  await app.keyboard.press('Meta+KeyK');
  await app.keyboard.type('Close session');
  await expect(close).not.toHaveAttribute('aria-disabled', 'true');
  // Ticket 991 A10 (06cac7df) took the row-only commands out of the palette: the card rows that A4 greyed are not listed.
  await app.locator('.palette input').fill('Delete card');
  await expect(app.locator('#palette-list [data-command="board.card.delete"]')).toHaveCount(0);
});

// Look 1117 v5 (A new S2): Stop on an idle shell closed it at once (a shell has no turn to stop) while the tab kept its idle
// circle. A shell's menus offer one action under one name, Close session; the tab's mark follows the session at once.
test('idle_shell_closes_under_one_name_and_its_tab_says_done', async ({ app, core }) => {
  const project = core.project('demo');
  const t02 = core.shell(project, 't02');
  await openWindow(app);
  const tab = app.locator(`.tab[data-tab="${t02.id}"]`);
  await tab.click();
  await tab.click({ button: 'right' });
  const items = app.locator('[role="menu"] [role="menuitem"]');
  await expect(items.filter({ hasText: 'Close session' })).toHaveCount(1);
  await expect(items.filter({ hasText: /^Stop/ })).toHaveCount(0);
  await items.filter({ hasText: 'Close session' }).click();
  const dot = app.locator(`.tabw:has(.tab[data-tab="${t02.id}"]) .tdot`);
  await expect(dot).toHaveAttribute('data-s', 'done');
  // Look 1117 v6r (A S3-3): the header above the session says done with the tab's mark (it drew the idle ring beside the
  // tab's filled dot): one look for one state.
  const head = app.locator('.shead .st');
  await expect(head).toHaveAttribute('data-s', 'done');
  const fill = (l: typeof dot) => l.evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(await fill(head)).toBe(await fill(dot));
  // Past the Undo window the core drops the row: the tab still reads done, never idle.
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((s) => s.id === t02.id)?.state ?? 'gone', { timeout: 20_000 }).toMatch(/closed|gone/);
  await app.waitForTimeout(1500);
  await expect(dot).toHaveAttribute('data-s', 'done');
  // And it looks ended: not the idle ring a live idle tab draws. Ticket 1025 item 4: the mark is the tree's hollow bar
  // (3px wide), no longer the filled done dot.
  expect(await dot.evaluate((e) => getComputedStyle(e).width)).toBe('3px');
});
