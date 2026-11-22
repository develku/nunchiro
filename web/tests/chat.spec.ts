// Ticket v1b-03: chat view in the window. Real core, fake agent, transcript records written by the test.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { conflicts, DEFAULT_BINDINGS } from '../src/keys';
import { agentsZone, stripOnTop } from './fixtures';
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';

/** Boxes of everything visible that must not move: chat rows in view, the switch, strip and composer. */
async function boxes(page: Page, session: string) {
  return page.evaluate((id) => {
    const out: Record<string, string> = {};
    const scroller = document.querySelector(`.chat[data-session="${id}"] .cscroll`)!.getBoundingClientRect();
    const box = (k: string, e: Element) => {
      const r = e.getBoundingClientRect();
      out[k] = [r.x, r.y, r.width, r.height].map(Math.round).join(',');
    };
    for (const e of document.querySelectorAll(`.chat[data-session="${id}"] .crow`)) {
      const r = e.getBoundingClientRect();
      if (r.bottom > scroller.top && r.top < scroller.bottom) box(`row-${(e as HTMLElement).dataset.key}`, e);
    }
    for (const sel of ['.cbox', '#waiting-strip', '.shead', '.tabs']) box(sel, document.querySelector(sel)!);
    return out;
  }, session);
}

const qa = (n: number) => Array.from({ length: n }, (_, i) => [rec.user(`질문 ${i}`), rec.assistant(`답 ${i}\n\n둘째 문단 ${i}`)]).flat();

test('acceptance 2 (window): a turn reading 3 files and editing one shows within 1 s as one read row and one diff card', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  await openChat(page, s.id);
  const view = chat(page, s.id);
  const t0 = Date.now();
  append(
    s.file,
    rec.user('세션 정리 순서 확인해줘'),
    rec.assistant('종료 경로를 확인하겠습니다.'),
    rec.use('r1', 'Read', { file_path: '/p/src/session.rs' }),
    rec.result('r1', 'fn a() {}'),
    rec.use('r2', 'Read', { file_path: '/p/src/reap.rs' }),
    rec.result('r2', 'fn b() {}'),
    rec.use('r3', 'Read', { file_path: '/p/src/pty.rs' }),
    rec.result('r3', 'fn c() {}'),
    rec.edit('e1', '/p/src/session.rs', ['-  self.reap(pid)?;', '+  self.retire_group(pgid)?;', '+  self.reap(pid)?;']),
    rec.assistant('완료.'),
  );
  await expect(view.getByText('완료.')).toBeVisible({ timeout: 1000 });
  const latency = Date.now() - t0;
  console.log(`chat latency ${latency} ms`);
  expect(latency).toBeLessThan(1000);
  const reads = view.locator('.tool .tl', { hasText: 'Read 3 files' });
  await expect(reads).toHaveCount(1);
  await expect(reads).toContainText('session.rs, reap.rs, pty.rs');
  const cards = view.locator('.dcard');
  await expect(cards).toHaveCount(1);
  await expect(cards.locator('.counts')).toHaveText('+2 −1');
  await expect(cards.locator('.dl .a')).toHaveCount(2);
  await expect(cards.locator('.dl .d')).toHaveText('-  self.reap(pid)?;');
  await expect(view.locator('.msg.user')).toHaveText('세션 정리 순서 확인해줘');
});

test('acceptance 3: scrolled up and mid-Hangul composition, 20 incoming events move nothing and keep focus and composition', async ({ page, chatCore, browserName }) => {
  stripOnTop(chatCore); // needs 107 (ticket 180): the strip is not drawn above the composer; boxes() reads it
  const s = chatCore.chat();
  append(s.file, qa(40));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('답 39')).toBeVisible();
  await view.locator('.cscroll').hover();
  await page.mouse.wheel(0, -900);
  await expect.poll(() => view.locator('.cscroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(400);
  const box = page.locator('.cbox textarea');
  await box.focus();
  const typed = '로그를 남기';
  let cdp;
  if (browserName === 'chromium') {
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.insertText', { text: '로그를 남' });
    // Mid-composition: 기 is still in the IME.
    await cdp.send('Input.imeSetComposition', { text: '기', selectionStart: 1, selectionEnd: 1 });
  } else await page.keyboard.insertText(typed);
  await page.evaluate(() => {
    (window as { __ended?: number }).__ended = 0;
    document.addEventListener('compositionend', () => ((window as { __ended?: number }).__ended! += 1), true);
  });
  await page.waitForTimeout(300);
  const before = await boxes(page, s.id);
  expect(Object.keys(before).filter((k) => k.startsWith('row-')).length).toBeGreaterThan(3);
  // 20 events: ten user and ten assistant messages.
  append(s.file, Array.from({ length: 10 }, (_, i) => [rec.user(`새 질문 ${i}`), rec.assistant(`새 답 ${i}`)]).flat());
  await expect(view.locator('.newchip')).toBeVisible();
  await page.waitForTimeout(400);
  const after = await boxes(page, s.id);
  expect(after).toEqual(before);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('composer');
  expect(await page.evaluate(() => (window as { __ended?: number }).__ended)).toBe(0);
  await expect(box).toHaveValue(typed);
  // The chip goes back down; the new events are there.
  await view.locator('.newchip').click();
  await expect(view.getByText('새 답 9')).toBeVisible();
  await expect(view.locator('.newchip')).toHaveCount(0);
  if (cdp) await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
});

test('acceptance 4 (window): untested version shows the banner and Stop-hook final texts; one click opens the terminal', async ({ page, chatCore }) => {
  chatCore.version('2.2.0 (Claude Code)');
  const s = chatCore.chat();
  append(s.file, rec.user('parsed content is not shown'), rec.assistant('nor this'), 'not json at all');
  chatCore.cli('session', 'send-text', s.id, 'STOP 최종 답변: **완료**했습니다\r');
  await openChat(page, s.id);
  const view = chat(page, s.id);
  const banner = view.locator('.vbanner');
  await expect(banner).toContainText('2.2.0');
  await expect(banner).toContainText('untested');
  await expect(view.locator('.md strong')).toHaveText('완료');
  await expect(view.getByText('최종 답변:')).toBeVisible();
  await expect(view.getByText('nor this')).toHaveCount(0);
  await expect(banner).toContainText('Some lines could not be shown');
  expect(await view.innerText()).not.toContain('not json');
  // A second Stop arrives live.
  chatCore.cli('session', 'send-text', s.id, 'STOP 두 번째 턴\r');
  await expect(view.getByText('두 번째 턴')).toBeVisible();
  await banner.getByRole('button', { name: 'Open terminal' }).click();
  // AGENTVIEW: the terminal opens in the side pane beside the chat, on its PTY tab, focused.
  await expect(page.locator(`[data-side-pane] .term[data-session="${s.id}"]`)).toBeVisible();
  await expect(view).toBeVisible();
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('must not break: opening and closing the side pane never writes to or restarts the PTY, and is remembered per session', async ({ page, chatCore }) => {
  const a = chatCore.chat('alpha', true, false, 'pair'); // ticket 570: one project, so the two tabs share a strip
  const b = chatCore.chat('beta', true, false, 'pair');
  append(a.file, rec.assistant('alpha 채팅'));
  const sent: string[] = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => typeof f.payload === 'string' && sent.push(f.payload)));
  await openChat(page, a.id);
  const term = page.locator(`.term[data-session="${a.id}"]`);
  await expect(chat(page, a.id).getByText('alpha 채팅')).toBeVisible();
  const pid = chatCore.cli('snapshot', '--json').sessions.find((x: { id: string }) => x.id === a.id).pid;
  await page.waitForTimeout(300);
  sent.length = 0;
  const toggle = page.getByRole('button', { name: 'Terminal', exact: true });
  await toggle.click();
  await expect(term).toBeVisible();
  await toggle.click();
  await expect(term).toHaveCount(0);
  await toggle.click();
  await page.waitForTimeout(300);
  // Attaching the terminal watches and fits it; nothing is typed, and the agent is never restarted.
  expect(sent.filter((f) => /send_text|send_keys/.test(f))).toEqual([]);
  expect(chatCore.cli('snapshot', '--json').sessions.find((x: { id: string }) => x.id === a.id).pid).toBe(pid);
  // Remembered per session, across a window reopen.
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await page.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(term).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.locator(`.tab[data-tab="${b.id}"]`).click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator(`.term[data-session="${b.id}"]`)).toHaveCount(0);
});

test('rows: user image slots reserve height, thinking is one collapsed row, tool rows expand with output capped at 200 lines', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  const long = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join('\n');
  append(
    s.file,
    rec.userImage('이 화면 봐줘'),
    rec.thinking('secret plan'),
    rec.use('b1', 'Bash', { command: 'seq 450' }),
    rec.result('b1', long),
    rec.use('g1', 'Grep', { pattern: 'reap' }),
    rec.result('g1', 'a.rs'),
    rec.use('r1', 'Read', { file_path: '/p/a.rs' }),
    rec.result('r1', 'x'),
  );
  await openChat(page, s.id);
  const view = chat(page, s.id);
  const thumb = view.locator('.msg.user .thumb');
  await expect(thumb).toHaveCount(1);
  expect((await thumb.boundingBox())!.height).toBe(42);
  const thinking = view.locator('.tool .tl', { hasText: 'Thinking' });
  await expect(thinking).toHaveAttribute('aria-expanded', 'false');
  await expect(view.getByText('secret plan')).toHaveCount(0);
  await thinking.click();
  await expect(view.getByText('secret plan')).toBeVisible();
  await expect(view.locator('.tool .tl', { hasText: 'Read 1 file, searched 1 pattern' })).toHaveCount(1);
  const ran = view.locator('.tool .tl', { hasText: 'Ran seq 450' });
  await expect(ran).toContainText('line 450');
  await ran.click();
  const out = ran.locator('xpath=..').locator('pre').nth(1);
  expect((await out.innerText()).split('\n')).toHaveLength(200);
  await ran.locator('xpath=..').getByRole('button', { name: 'Show all 450 lines' }).click();
  expect((await out.innerText()).split('\n')).toHaveLength(450);
});

test('rows: a Task row expands to the sub-agent final result only', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.use('t1', 'Task', { description: 'Check the result', prompt: 'internal prompt text' }), rec.result('t1', 'Sub-agent says **done**'));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  const task = view.locator('.tool .tl', { hasText: 'Task Check the result' });
  await expect(task).toHaveCount(1);
  await task.click();
  await expect(view.locator('.tx .md strong')).toHaveText('done');
  await expect(view.getByText('internal prompt text')).toHaveCount(0);
});

test('safety: hostile message text renders as text, links leave only through the external path, nothing remote loads', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  const remote: string[] = [];
  page.on('request', (r) => !r.url().startsWith('http://127.0.0.1') && !r.url().startsWith('data:') && remote.push(r.url()));
  const long = 'x'.repeat(6000);
  append(
    s.file,
    rec.user('<b>bold?</b> \x1b[31mred\x1b[0m'),
    rec.assistant(
      [
        '<script>window.__pwned = 1</script>',
        '<img src="https://example.com/a.png" onerror="window.__pwned = 2">',
        '[bad](javascript:window.__pwned=3) [local](http://127.0.0.1:1/x) [web](https://example.com/page)',
        '![remote](https://example.com/b.png)',
        '\x1b[32mgreen\x1b[0m',
        long,
      ].join('\n\n'),
    ),
    rec.use('b1', 'Bash', { command: 'printf color' }),
    rec.result('b1', '\x1b[1;33mwarning\x1b[0m done'),
  );
  await page.addInitScript(() => {
    (window as { __opened?: string[] }).__opened = [];
    window.open = (u) => ((window as { __opened?: string[] }).__opened!.push(String(u)), null);
  });
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('<script>window.__pwned = 1</script>')).toBeVisible();
  await expect(view.locator('script, img, iframe')).toHaveCount(0);
  await expect(view.locator('.msg.user')).toHaveText('<b>bold?</b> red');
  await expect(view.getByText('green')).toBeVisible();
  await expect(view.locator('.tool .tl', { hasText: 'Ran printf color' })).toContainText('warning done');
  expect(await view.innerText()).not.toContain('\x1b');
  const url = page.url();
  await view.getByRole('link', { name: 'bad' }).click();
  await view.getByRole('link', { name: 'local' }).click();
  await view.getByRole('link', { name: 'web' }).click();
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await page.evaluate(() => (window as { __opened?: string[] }).__opened)).toEqual(['https://example.com/page']);
  await expect(view.locator('.mdimg')).toHaveText('remote'); // V2-10a: a link chip, the image never loaded
  // A 6000-character word wraps inside the column: no sideways scroll.
  expect(await view.locator('.cscroll').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(remote).toEqual([]);
});

test('history: 10k messages page in from the core as the user scrolls up, without a jump or a growing DOM', async ({ page, chatCore }) => {
  test.setTimeout(120_000);
  const s = chatCore.chat();
  append(s.file, Array.from({ length: 10_000 }, (_, i) => rec.assistant(`메시지 ${i}`)));
  // The first page waits for the core to index all 10k records (0.8-1.4 s at load 14, past the default 5 s on a starved
  // gate host); this test checks paging, not that first read, so that one wait has the room the test timeout gives.
  await openChat(page, s.id, 60_000);
  const view = chat(page, s.id);
  await expect(view.getByText('메시지 9999', { exact: true })).toBeVisible();
  const scroller = view.locator('.cscroll');
  const firstRow = () =>
    page.evaluate((id) => {
      const sc = document.querySelector(`.chat[data-session="${id}"] .cscroll`)!;
      const rows = [...sc.querySelectorAll('.crow')] as HTMLElement[];
      const r = rows.filter((e) => e.getBoundingClientRect().bottom > sc.getBoundingClientRect().top + 1).sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)[0];
      return { key: r.dataset.key!, y: Math.round(r.getBoundingClientRect().y) };
    }, s.id);
  // The top is reached when 메시지 0 is there with the view near it, read in one task. 메시지 0 in the DOM alone is not:
  // the commit that prepends the last page draws rows for the old offset (메시지 0 among them) and its anchor then moves
  // the view down, so a read in between saw a row about to be dropped, left the loop, and found no 메시지 0 after.
  const atTop = () =>
    scroller.evaluate(
      (el) => el.scrollTop < 400 && [...el.querySelectorAll<HTMLElement>('.crow')].some((r) => r.innerText.split('\n').some((l) => l.trim() === '메시지 0')),
    );
  let pages = 0;
  await scroller.hover();
  while (!(await atTop())) {
    expect(pages++).toBeLessThan(60);
    await scroller.evaluate((el) => (el.scrollTop = 500));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const top = await firstRow();
    // Wheel 400 px up (V2.5-34: message rows are 16px taller, so 200 no longer reaches the zone that asks for an older page
    // past the list's own corrections), into that zone: the row may move by the wheel, never more.
    await page.mouse.wheel(0, -400);
    // Wait for the page's commit (scrollTop back above 1000) and for the row itself to show the wheel's 400 px, or for the
    // top. The commit alone is not enough: it is also true when a page landed before the wheel's scroll reached the main
    // thread (a loaded host), and the row read then had not moved yet: Received 400. A row that never gets there still
    // fails, with the y it had.
    let reachedTop = false;
    await expect
      .poll(async () => {
        if ((reachedTop = await atTop())) return 'top';
        const got = await page.evaluate(
          ([id, key]) => {
            const sc = document.querySelector(`.chat[data-session="${id}"] .cscroll`)!;
            const r = sc.querySelector(`.crow[data-key="${key}"]`);
            return { st: sc.scrollTop, y: r ? Math.round(r.getBoundingClientRect().y) : null };
          },
          [s.id, top.key],
        );
        return got.st > 1000 && got.y !== null && Math.abs(got.y - (top.y + 400)) <= 1 ? 'moved' : `scrollTop ${got.st}, row y ${got.y}, wanted ${top.y + 400}`;
      })
      .toMatch(/^(top|moved)$/);
    if (reachedTop) break;
    expect(await view.locator('.crow').count()).toBeLessThan(80);
  }
  expect(pages).toBeGreaterThanOrEqual(49);
  await expect(view.getByText('메시지 0', { exact: true })).toBeVisible();
});

// V1A-50: the 10k test's "Received 200" on a loaded host. A scroll event fires a frame after the scroll; when a commit
// lands in between (a page or a live event), the place kept from the last scroll event put the view back and undid
// the user's scroll. Here the scroll event is held until the arrival has committed, so the order is certain.
test('a scroll whose event has not fired yet is kept when an arrival commits first', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, Array.from({ length: 300 }, (_, i) => rec.assistant(`메시지 ${i}`)));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('메시지 299', { exact: true })).toBeVisible();
  const scroller = view.locator('.cscroll');
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight - el.clientHeight - 2000));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  // A row in view and its place on screen: what the user sees, so re-measured rows above may shift scrollTop.
  const row = await scroller.evaluate((el) => {
    const r = [...el.querySelectorAll<HTMLElement>('.crow')].find((e) => e.getBoundingClientRect().top >= el.getBoundingClientRect().top)!;
    return { key: r.dataset.key!, y: Math.round(r.getBoundingClientRect().y) };
  });
  await page.evaluate(() => {
    const w = window as unknown as { __hold: (e: Event) => void };
    w.__hold = (e) => e.isTrusted && e.stopPropagation(); // the browser's own scroll events only
    window.addEventListener('scroll', w.__hold, true);
  });
  await scroller.evaluate((el) => (el.scrollTop -= 200));
  append(s.file, rec.assistant('live arrival'));
  await expect(view.locator('.newchip')).toBeVisible();
  await page.evaluate(() => window.removeEventListener('scroll', (window as unknown as { __hold: (e: Event) => void }).__hold, true));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const y = await view.locator(`.crow[data-key="${row.key}"]`).evaluate((e) => Math.round(e.getBoundingClientRect().y));
  expect(Math.abs(y - (row.y + 200))).toBeLessThanOrEqual(1);
});

// Ticket 409: bookkeeping records (attachment, api-request, ai-title, file-history-snapshot, a new type with no message)
// are not drawn and not counted; only a line the chat could not read shows a plain note, never a count or raw JSON.
test('skipped: a normal session shows no note; an unreadable line shows a plain note, never raw JSON', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(
    s.file,
    rec.assistant('before'),
    { type: 'attachment', attachment: { type: 'hook_success' } },
    { type: 'api-request', requestId: 'r' },
    { type: 'ai-title', aiTitle: 'RAWJSON' },
    { type: 'file-history-snapshot', snapshot: {} },
    { type: 'nope', secret: 'RAWJSON' },
    rec.assistant('after'),
  );
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('after')).toBeVisible();
  await expect(view.locator('.skipped')).toHaveCount(0);
  append(s.file, 'garbage line');
  await expect(view.locator('.skipped')).toHaveText('Some lines could not be shown');
  append(s.file, 'more garbage');
  await expect(view.locator('.skipped')).toHaveText('Some lines could not be shown');
  expect(await view.innerText()).not.toContain('RAWJSON');
});

test('fresh session: no transcript yet shows an empty chat, then fills in live', async ({ page, chatCore }) => {
  const s = chatCore.chat('fresh', false);
  await page.goto('/');
  await page.locator(`.tab[data-tab="${s.id}"]`).click();
  const view = chat(page, s.id);
  // v25-empty (needs 140): the empty state invites the first message instead of describing it.
  await expect(view.locator('.empty')).toContainText('What should we build in');
  await expect(view.locator('.chaterr')).toHaveCount(0);
  fs.mkdirSync(s.file.replace(/\/[^/]+$/, ''), { recursive: true });
  append(s.file, rec.user('첫 메시지'));
  await expect(view.getByText('첫 메시지')).toBeVisible();
  await expect(view.locator('.empty')).toHaveCount(0);
});

test('chat_error: a failed read says so, offers retry and the terminal, and never moves the list', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.assistant('still here'));
  const routes: { send: (m: string) => void }[] = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    routes.push(ws);
    ws.onMessage((m) => {
      if (typeof m === 'string' && m.includes('"FAIL_NOW"')) {
        for (const r of routes) r.send(JSON.stringify({ event: 'chat_error', session: s.id, error: 'transcript read failed' }));
        return;
      }
      server.send(m);
    });
  });
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('still here')).toBeVisible();
  const row = await view.locator('.crow').first().boundingBox();
  // The test's own trigger frame; the core is never sent it.
  await page.evaluate(() => {
    const ws = new WebSocket(`ws://127.0.0.1:${window.__NUNCHIRO__!.port}/ws`, ['nunchiro.v1', `nunchiro.token.${window.__NUNCHIRO__!.token}`]);
    ws.onopen = () => ws.send('"FAIL_NOW"');
  });
  const alert = view.getByRole('alert');
  await expect(alert).toContainText('transcript read failed');
  expect(await view.locator('.crow').first().boundingBox()).toEqual(row);
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(alert).toHaveCount(0);
  await expect(view.getByText('still here')).toBeVisible();
});

test('commands: pane.toggle is bindable and works after the prefix with a Korean input source', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  // A key no default holds (V1A-38b gave prefix KeyV to terminal.edit, V1A-48 KeyB to the left sidebar).
  expect(conflicts(DEFAULT_BINDINGS, 'prefix KeyU', 'pane.toggle')).toEqual([]);
  await page.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ bindings: { 'pane.toggle': ['prefix KeyU'] } })));
  await openChat(page, s.id);
  await page.locator('.cbox textarea').focus();
  const key = (init: Record<string, unknown>) =>
    page.evaluate((i) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...i })), init);
  await key({ code: 'Space', key: 'Process', ctrlKey: true, keyCode: 229 });
  // ㅕ is what KeyU types under the Korean 2-set layout.
  await key({ code: 'KeyU', key: 'ㅕ' });
  await expect(page.locator(`[data-side-pane] .term[data-session="${s.id}"]`)).toBeVisible();
  await expect(page.locator('.cbox textarea')).toHaveValue('');
  await page.keyboard.press('Meta+KeyK');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  for (const id of ['pane.toggle', 'pane.maximize', 'pane.shell.new']) await expect(palette.locator(`[data-command="${id}"]`)).toBeVisible();
  await expect(palette.locator('[data-command^="view."]')).toHaveCount(0);
  await palette.locator('[data-command="pane.toggle"]').click();
  await expect(page.locator('[data-side-pane]')).toHaveCount(0);
});

test('generation reset: a replaced transcript starts the chat over, without the old rows', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.assistant('old generation text'));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('old generation text')).toBeVisible();
  // A new inode is a new generation (crates/nunchiro-core/README.md): the core sends chat_reset.
  fs.rmSync(s.file);
  append(s.file, rec.assistant('new generation text'));
  await expect(view.getByText('new generation text')).toBeVisible();
  await expect(view.getByText('old generation text')).toHaveCount(0);
});

test('fail closed: a page with an unknown schema version is not rendered', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.assistant('schema one text'));
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => ws.send(typeof m === 'string' ? m.replaceAll('"schema_version":1', '"schema_version":2') : m));
  });
  await page.goto('/');
  await page.locator(`.tab[data-tab="${s.id}"]`).click();
  const view = chat(page, s.id);
  await expect(view.getByRole('alert')).toContainText('chat schema 2 is not supported');
  await expect(view.getByText('schema one text')).toHaveCount(0);
});

test('the removed view store: a stored nunchiro.chatView.v1 of any shape is ignored without an error', async ({ page, chatCore }) => {
  const a = chatCore.chat('alpha');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const raw of [JSON.stringify({ [a.id]: 'terminal', constructor: 'chat' }), '[1,2', 'null']) {
    await page.addInitScript((r) => sessionStorage.getItem('seeded') || (localStorage.setItem('nunchiro.chatView.v1', r), sessionStorage.setItem('seeded', '1')), raw);
    await openChat(page, a.id);
    await expect(chat(page, a.id)).toBeVisible();
    await expect(page.locator('[data-side-pane]')).toHaveCount(0); // 'terminal' no longer opens anything
    await page.evaluate(() => sessionStorage.clear());
  }
  expect(errors).toEqual([]);
});

test('older page failure: a failed load says so instead of stopping silently, and retry pages on', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, Array.from({ length: 400 }, (_, i) => rec.assistant(`메시지 ${i}`)));
  let fail = true;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = typeof m === 'string' && m.includes('"before"') ? JSON.parse(m) : null;
      if (f && fail) return ws.send(JSON.stringify({ id: f.id, response: { Err: 'older page unavailable' } }));
      server.send(m);
    });
  });
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('메시지 399', { exact: true })).toBeVisible();
  await view.locator('.cscroll').evaluate((el) => (el.scrollTop = 0));
  const alert = view.getByRole('alert');
  await expect(alert).toContainText('older page unavailable');
  fail = false;
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(alert).toHaveCount(0);
  // Still at the top, so scroll a little to ask again: the older page lands above and the view keeps its row.
  await view.locator('.cscroll').evaluate((el) => (el.scrollTop = 5));
  await expect.poll(() => view.locator('.cscroll').evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  await view.locator('.cscroll').evaluate((el) => (el.scrollTop = 0));
  await expect(view.getByText('메시지 0', { exact: true })).toBeVisible();
});

test('ended session: an exited agent keeps its chat, read-only, with no switch and a disabled composer', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.user('끝나기 전 질문'), rec.assistant('끝나기 전 답'));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('끝나기 전 답')).toBeVisible();
  chatCore.cli('session', 'send-text', s.id, 'EXIT\r');
  await expect(page.locator(`.tab[data-tab="${s.id}"] .tdot`)).toHaveAttribute('data-s', 'done');
  await expect(view.getByText('끝나기 전 질문')).toBeVisible();
  await expect(view.getByText('끝나기 전 답')).toBeVisible();
  await expect(page.locator('.vseg')).toHaveCount(0);
  await expect(page.locator('.composer textarea')).toBeVisible();
  await expect(page.locator('.composer textarea')).toBeDisabled();
  await expect(page.getByText('Its terminal is not live')).toHaveCount(0);
  // Reopened later, the history is still there (D5b: from the AGENTS rows of a layout that has them).
  agentsZone(chatCore);
  await page.reload();
  await page.locator(`.ar`, { hasText: 'chat' }).first().click();
  await expect(view.getByText('끝나기 전 답')).toBeVisible();
  await expect(page.locator('.composer textarea')).toBeVisible();
  await expect(page.locator('.composer textarea')).toBeDisabled();
});

test('need 26: a tab cold for 30 s comes back with its expanded rows and the place the reader was', async ({ page, chatCore }) => {
  const a = chatCore.chat('alpha', true, false, 'pair'); // ticket 570: one project, so the two tabs share a strip
  const b = chatCore.chat('beta', true, false, 'pair');
  append(a.file, qa(30), rec.use('b1', 'Bash', { command: 'seq 5' }), rec.result('b1', '1\n2\n3\n4\n5'), qa(3));
  append(b.file, qa(2));
  await page.clock.install();
  await openChat(page, a.id);
  const view = chat(page, a.id);
  await expect(view.getByText('답 2', { exact: true })).toBeVisible();
  await view.locator('.cscroll').hover();
  // Far enough up to leave the bottom, near enough that the row stays in view: a click on a row out of view scrolls
  // it in first, and WebKit centres it, which lands at the bottom again (692 px chat since V1A-60b).
  await page.mouse.wheel(0, -300);
  const ran = view.locator('.tool .tl', { hasText: 'Ran seq 5' });
  await expect(ran).toBeInViewport();
  await ran.click();
  await expect(ran).toHaveAttribute('aria-expanded', 'true');
  await page.mouse.wheel(0, -300);
  const top = () => view.locator('.cscroll').evaluate((el) => el.scrollTop);
  // Wheel scrolling may still be animating: wait for two equal reads.
  let at = -1;
  await expect.poll(async () => ((at = await top()), await page.waitForTimeout(250), at === (await top()))).toBe(true);
  expect(await view.locator('.cscroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(100);
  await page.locator(`.tab[data-tab="${b.id}"]`).click();
  await page.clock.fastForward(31_000);
  await expect(view).toHaveCount(0);
  await page.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(view.locator('.tool .tl', { hasText: 'Ran seq 5' })).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(async () => Math.abs((await top()) - at)).toBeLessThan(60);
  expect(await view.locator('.cscroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(100);
});

// Detailed-row coverage explicitly selects Verbose; the window now starts in Normal.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nunchiro.chatView.v2', 'verbose'));
});

// Ticket 212 (needs 178, lane L3): chat display bugs of the peer-comparison absorb.
/** The core cannot hold a decision open on demand: the snapshot is patched so the session works AND waits, as the
 * queue does while a PermissionRequest is pending (attention.working stays true until the Stop hook). */
async function pending(page: Page, label: string, text: string, kind: 'permission' | 'question' = 'question') {
  await page.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ strip: 'off' })));
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => server.send(msg));
    server.onMessage((raw) => {
      if (typeof raw !== 'string' || JSON.parse(raw).event !== 'snapshot') return ws.send(raw);
      const msg = JSON.parse(raw);
      for (const s of msg.sessions ?? [])
        if (s.label === label) {
          Object.assign(s.attention, { working: true, waiting: true, stale: false, failed: false });
          s.pending = [{ id: `d-${label}`, session_id: s.id, scope: s.project, kind, text, choices: [], observed_at: Date.now() - 5_000, actionable: true, risky: false }];
        }
      ws.send(JSON.stringify(msg));
    });
  });
}

// v25-quiet-chat (needs 205, ticket 282 item 4): the in-chat decision line and its "Waiting for you" row are gone; the decision
// shows in the tree row, the header status and the Decisions widget. These four tests followed the line's old promises
// (timer-free row, first line, hidden characters, bare CR); the setups stay and each now holds that nothing of the question is in the chat.
test('chat_pending_decision_shows_waiting_for_you_not_timer', async ({ page, chatCore }) => {
  const s = chatCore.chat('asks');
  append(s.file, rec.user('go'), rec.assistant('Let me ask.'));
  await pending(page, 'asks', 'Which database?');
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.locator('.dline')).toHaveCount(0);
  await expect(view.locator('.wlive .wline')).toHaveCount(0);
  await expect(view.getByText('Which database?')).toHaveCount(0);
  await page.waitForTimeout(1500); // a timer would have ticked to "Working for 1s" by now
  await expect(view.locator('.wlive')).not.toContainText('Working');
});

test('chat_decision_line_shows_question_first_line', async ({ page, chatCore }) => {
  const s = chatCore.chat('firstline');
  append(s.file, rec.user('go'), rec.assistant('Let me ask.'));
  await pending(page, 'firstline', '\n  Which database should we use?\nPostgres, or SQLite for now\nlast line');
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.locator('.dline')).toHaveCount(0);
  await expect(view.getByText('Which database should we use?')).toHaveCount(0);
  await expect(view.getByRole('button', { name: /Answer in Decisions|^(Allow|Deny|Accept|Reject|Approve)/ })).toHaveCount(0);
});

// The hidden-character rule (V2.5-49) now lives on the surface that shows the text: decisions-hidden-chars.spec.ts.
test('chat_decision_line_hides_hidden_characters', async ({ page, chatCore }) => {
  const s = chatCore.chat('hidden');
  append(s.file, rec.user('go'), rec.assistant('Let me ask.'));
  await pending(page, 'hidden', 'Run rm\u202e -rf\u200b /tmp/x\u2028 now?\u{e0041}\nsecond');
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.locator('.dline')).toHaveCount(0);
  await expect(view.locator('.crow').last()).toBeVisible();
  expect(await view.innerText()).not.toContain('rm -rf');
});

test('chat_decision_tooltip_keeps_bare_cr_as_break', async ({ page, chatCore }) => {
  const s = chatCore.chat('barecr');
  append(s.file, rec.user('go'), rec.assistant('Let me ask.'));
  await pending(page, 'barecr', 'first\rsecond');
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.locator('.dline')).toHaveCount(0);
  await expect(view.locator('[data-tip*="first"]')).toHaveCount(0);
});

test('chat_running_without_transcript_shows_reason', async ({ page, chatCore }) => {
  const s = chatCore.chat('silent', false);
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => server.send(msg));
    server.onMessage((raw) => {
      if (typeof raw !== 'string' || JSON.parse(raw).event !== 'snapshot') return ws.send(raw);
      const msg = JSON.parse(raw);
      for (const x of msg.sessions ?? []) if (x.label === 'silent') Object.assign(x.attention, { working: true, waiting: false, stale: false, failed: false });
      ws.send(JSON.stringify(msg));
    });
  });
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.locator('.notrans')).toHaveText('no transcript: the agent has not written its transcript file yet');
  await expect(view.locator('.notrans')).toHaveAttribute('role', 'status');
  await expect(view.locator('.cscroll .empty')).toHaveCount(0);
  // The file appears: the line goes.
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  append(s.file, rec.user('hello'));
  await expect(view.getByText('hello')).toBeVisible();
  await expect(view.locator('.notrans')).toHaveCount(0);
});
