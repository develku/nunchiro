import claudeRecorded from './fixtures/fidelity-chat/claude-recorded.json' with { type: 'json' };
import codexRecorded from './fixtures/fidelity-chat/codex-recorded.json' with { type: 'json' };
import { buildRows, shownOutput, summaryLabel, toolLine, viewRows, type Row, type Tool } from '../src/chat/model';
import { makeT } from './i18n-tables';
import type { Data } from '../src/chat/feed';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator } from '@playwright/test';
import { REPO } from './fixtures';
import { patchSnapshots } from './visual/compare';
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';
import { mockupTurn } from './fixtures/fidelity-chat/turn';

async function rowsDoNotOverlap(view: Locator) {
  await expect.poll(() => view.locator('.crow').evaluateAll((rows) => rows.slice(1).every((row, i) =>
    row.getBoundingClientRect().top >= rows[i].querySelector('.cin')!.getBoundingClientRect().bottom - 1,
  ))).toBe(true);
}

test('tool_run_one_line_summary', async ({ page, chatCore }) => {
  const s = chatCore.chat('layout-b');
  mockupTurn(s.file, s.cwd);
  await openChat(page, s.id);
  const view = chat(page, s.id);
  const summary = view.getByRole('button', { name: /Read 3 files, edited 1 file/ });
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('18 passed');
  await expect(summary).toContainText('42s');
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await expect(view.locator('.tool')).toHaveCount(0);
  await summary.click();
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  await expect(view.getByRole('button', { name: /Read tree.css/ })).toBeVisible();
  await rowsDoNotOverlap(view);
});

test('no_empty_gaps', async ({ page, chatCore }) => {
  const s = chatCore.chat('spacing');
  mockupTurn(s.file, s.cwd);
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.locator('.ut')).toBeVisible();
  const band = await view.locator('.message-user').evaluate((bubble) => {
    const text = bubble.querySelector('.ut')!;
    return bubble.getBoundingClientRect().bottom - text.getBoundingClientRect().bottom;
  });
  expect(band, 'user bubble ends at its text plus padding').toBeLessThanOrEqual(11);
  const gaps = await view.locator('.crow').evaluateAll((rows) => rows.slice(1).map((row, i) => {
    const prev = rows[i].querySelector('.cin')!.getBoundingClientRect();
    return row.querySelector('.cin')!.getBoundingClientRect().top - prev.bottom;
  }));
  for (const gap of gaps) expect(gap).toBeLessThanOrEqual(16);
  await view.locator('.message-user').hover();
  await expect(view.getByRole('button', { name: 'Fork from here' }).first()).toBeVisible();
});

test('change_card_header', async ({ page, chatCore }) => {
  const s = chatCore.chat('changes');
  mockupTurn(s.file, s.cwd);
  await openChat(page, s.id);
  const card = chat(page, s.id).locator('.chcard');
  await expect(card.locator('.h')).toContainText('1 file changed');
  await expect(card.locator('.h')).toContainText('+4 −2');
  await expect(card.locator('.h .scope')).toHaveText('this turn'); // B18 (ticket 991): the count names its scope, as the header pill and Diff do
  await expect(card.locator('li')).toHaveCount(1);
  await expect(card.locator('li')).toContainText('web/src/tree/tree.css');
  await card.getByRole('button', { name: 'View in Diff' }).click();
  await expect(page.locator('.sbar[data-widget="diff"]')).toBeVisible();
});

test('permission_line_in_chat', async ({ page, chatCore }) => {
  await page.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ strip: 'off' })));
  const s = chatCore.chat('permission');
  mockupTurn(s.file, s.cwd);
  await patchSnapshots(page, { permission: { waiting: 'permission', text: 'Bash: pnpm install' } });
  await openChat(page, s.id);
  const view = chat(page, s.id);
  // needs 205 (v25-quiet-chat): no line in the chat any more.
  await expect(view.locator('.dline')).toHaveCount(0);
  await expect(view.getByRole('button', { name: /^(Allow|Deny|Accept|Reject)|Answer in Decisions/ })).toHaveCount(0);
  // Ticket 1030: the session in front answers its permission request on the card above its composer, and Decisions no
  // longer lists it (tree/decisions.ts `withoutFront`). Before 1030 the Decisions widget held it.
  await expect(page.locator(`.composer .deccard.docked[data-session="${s.id}"]`)).toContainText('pnpm install');
  await page.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Decisions' }).click();
  await expect(page.locator('.sbar[data-widget="decisions"], .wg[data-widget="decisions"]').first()).toContainText('Nothing waiting');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`same_data_side_by_side (${scheme})`, async ({ page, chatCore }) => {
    const out = path.join(REPO, '.scratch/fid-chat', test.info().project.name === 'chromium' ? '' : test.info().project.name);
    fs.mkdirSync(out, { recursive: true });
    await page.setViewportSize({ width: 1180, height: 900 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ strip: 'off' })));
    const s = chatCore.chat('layout-b');
    mockupTurn(s.file, s.cwd);
    await patchSnapshots(page, { 'layout-b': { waiting: 'permission', text: 'Bash: pnpm install' } });
    await openChat(page, s.id);
    const view = chat(page, s.id);
    await expect(view.locator('.sum')).toHaveText('Read 3 files, edited 1 file· tests 18 passed42s');
    await expect(view.locator('.dline')).toHaveCount(0); // needs 205: the decision line left the chat
    await expect(view.locator('.thumb img')).toBeVisible();
    await page.mouse.move(10, 10);
    await page.screenshot({ path: path.join(out, `window-${scheme}.png`) });
    const mock = await page.context().newPage();
    await mock.setViewportSize({ width: 1180, height: 900 });
    await mock.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await mock.goto(`file://${path.join(REPO, 'web/tests/visual/mockups/claude-feel-2.html')}`);
    // Needs 121 explicitly makes the product's theme configurable. Use one theme for both views;
    // translate only UI labels, keeping the mockup's data and all component geometry intact.
    const roles = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return Object.fromEntries(['panel', 'hover', 'line', 'text', 'muted', 'faint', 'ok', 'bad', 'you'].map((k) => [k, s.getPropertyValue(`--${k}`)]));
    });
    const attachment = fs.readFileSync(path.join(REPO, 'web/tests/fixtures/fidelity-chat/attachment.png')).toString('base64');
    await mock.evaluate(({ roles, attachment }) => {
      const root = document.documentElement.style;
      for (const [k, v] of Object.entries(roles)) root.setProperty(`--${k}`, v);
      root.setProperty('--page', roles.panel);
      root.setProperty('--panel', roles.hover);
      root.setProperty('--card', roles.panel);
      const set = (selector: string, text: string) => { document.querySelector(selector)!.textContent = text; };
      set('.sum .n', 'Read 3 files, edited 1 file');
      set('.sum .ok', '18 passed');
      set('.sum .t', '42s');
      // Same English catalogue labels in both; the Korean user and assistant data stay unchanged.
      const sum = document.querySelector('.sum')!;
      for (const node of sum.childNodes) if (node.nodeType === Node.TEXT_NODE && node.textContent?.includes('테스트')) node.textContent = '· tests ';
      set('.card .h b', '1 file changed');
      set('.card .btn', 'View in Diff');
      const wait = document.querySelector('.wait')!;
      for (const node of wait.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        if (node.textContent?.includes('권한 요청')) node.textContent = '1 permission request · ';
        if (node.textContent?.includes('결정 위젯')) node.textContent = 'Answer in Decisions ';
      }
      const img = document.createElement('img');
      img.src = `data:image/png;base64,${attachment}`;
      img.style.cssText = 'width:100%;height:100%;display:block';
      document.querySelector('.user .att span')!.append(img);
    }, { roles, attachment });
    // The mockup uses an image placeholder; both now display the same real attachment.
    await mock.locator('.user .att img').evaluate((img) => (img as HTMLImageElement).decode());
    const first = (await view.locator('.cin').first().boundingBox())!;
    const last = (await view.locator('.cin').last().boundingBox())!;
    const clip = { x: first.x + 22, y: first.y, width: first.width - 44, height: last.y + last.height - first.y };
    await page.screenshot({ path: path.join(out, `app-${scheme}.png`), clip });
    await mock.locator('#win .col').screenshot({ path: path.join(out, `mockup-${scheme}.png`) });
    const props = ['fontWeight', 'fontSize', 'lineHeight', 'borderRadius', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const;
    const styles = async (locator: Locator) => locator.evaluate((el, props) => {
      const s = getComputedStyle(el);
      return Object.fromEntries(props.map((p) => [p, s[p as keyof CSSStyleDeclaration]]));
    }, [...props]);
    const pairs = [['.user', '.message-user'], ['.sum', '.sum'], ['.asst', '.md'], ['.card', '.chcard']]; // the mockup's .wait row (decision line) is retired by needs 205
    const measurements = [];
    for (const [golden, actual] of pairs) {
      const expected = await styles(mock.locator(`#win ${golden}`).first());
      const observed = await styles(view.locator(actual).first());
      measurements.push({ golden, actual, expected, observed, differingProperties: props.filter((p) => expected[p] !== observed[p]) });
    }
    fs.writeFileSync(path.join(out, `styles-${scheme}.json`), JSON.stringify(measurements, null, 2));
    for (const m of measurements) expect(m.differingProperties, `${m.actual}: computed styles match the approved mockup`).toEqual([]);
    await mock.close();
    const control = view.getByRole('button', { name: /^Transcript view/ });
    await control.click(); // Thinking
    await rowsDoNotOverlap(view);
    await page.screenshot({ path: path.join(out, `thinking-${scheme}.png`) });
    await control.click(); // Verbose
    await rowsDoNotOverlap(view);
    await page.screenshot({ path: path.join(out, `verbose-${scheme}.png`) });
    await control.click(); // Normal, expanded steps
    await view.locator('.sum').click();
    await view.locator('.cscroll').evaluate((el) => { el.scrollTop = 0; });
    await expect(view.getByRole('button', { name: /Read tree.css/ })).toBeVisible();
    await rowsDoNotOverlap(view);
    await page.screenshot({ path: path.join(out, `steps-${scheme}.png`) });
    const pairsHtml = ['light', 'dark'].filter((s) => fs.existsSync(path.join(out, `app-${s}.png`))).map((s) => `
      <h2>${s}</h2><div class="pair"><figure><figcaption>승인 목업 · 같은 데이터</figcaption><img src="mockup-${s}.png"></figure><figure><figcaption>앱 · 같은 데이터</figcaption><img src="app-${s}.png"></figure></div>
      <h3>요소별 판정</h3><ul><li>사용자 말풍선: 같음 — 부드러운 배경, 오른쪽 정렬, 빈 하단 띠 없음</li><li>첨부 이미지: 더 나음 — 실제 이미지 미리보기와 열기, 기존 62×42 슬롯 유지</li><li>도구 요약: 같음 — 파일 3개 읽음·1개 수정·테스트 18 통과·42초</li><li>펼치기: 더 나음 — 버튼으로 단계를 열고 입력·출력까지 확인</li><li>에이전트 본문: 같음 — 박스 없는 두 문단과 강조·링크</li><li>변경 카드: 같음 — 파일 1개, +4 −2, 파일 목록과 Diff 버튼</li><li>권한 요청: 같음 — 점선 한 줄, Decisions로 이동, 채팅에서 답하지 않음</li><li>단축키 배지: 더 나음 — ⌘⇧D는 아래로 분할(needs 114). Decisions의 실제 바인딩이 없어 배지를 생략하고 버튼 유지 (coordinator ROUND 3)</li><li>메시지 작업: 더 나음 — Fork는 호버·키보드 포커스로 접근하며 빈 공간 없음 (needs 124); Rewind 없음 (needs 129)</li></ul>`).join('');
    fs.writeFileSync(path.join(out, 'side-by-side.html'), `<!doctype html><html lang="ko"><meta charset="utf-8"><title>fid-chat ROUND 5</title><style>body{font:14px/1.6 system-ui;margin:24px;background:#f6f6f4;color:#1f2328}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0;min-width:0}img{display:block;width:100%;border:1px solid #d1d9e0}li{margin:4px 0}</style><h1>채팅 본문 · ROUND 5</h1><p>1180×900, 같은 사용자·에이전트 텍스트, 도구 호출, 첨부 이미지, 변경 파일 및 권한 요청. 목업은 왼쪽, 앱은 오른쪽. 색은 같은 앱 테마, UI 라벨은 영어로 통일 (needs 121). 입력창과 창 프레임은 이 작업 범위 밖.</p>${pairsHtml}</html>`);
    expect(fs.existsSync(path.join(out, `mockup-${scheme}.png`))).toBe(true);
  });
}

test('edit_only_turn_keeps_one_summary_and_one_card_after_live_append', async ({ page, chatCore }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const s = chatCore.chat('edit-only');
  append(s.file, rec.user('edit'), rec.edit('e1', `${s.cwd}/one.txt`, ['-old', '+new']));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.locator('.sum')).toHaveCount(1);
  await expect(view.locator('.chcard')).toHaveCount(1);
  const keys = await view.locator('.crow').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-key')));
  expect(new Set(keys).size, 'each visible row has its own stable anchor').toBe(keys.length);
  append(s.file, rec.assistant('Done.'), rec.user('read'), rec.use('r2', 'Read', { file_path: `${s.cwd}/two.txt` }), rec.result('r2', 'two'), rec.assistant('Read.'));
  await expect(view.locator('.sum')).toHaveCount(2);
  await expect(view.locator('.chcard')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('search_targets_text_above_the_turn_changes_card', async ({ page, chatCore }) => {
  const s = chatCore.chat('search-turn');
  append(s.file, rec.user('edit'), rec.edit('e1', `${s.cwd}/one.txt`, ['-old', '+new']), rec.assistant('uniquely searchable completion'));
  await openChat(page, s.id);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('radio', { name: 'Sessions', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Search sessions', exact: true });
  await search.fill('uniquely searchable completion');
  await search.press('Enter');
  await page.locator(`.sgrp[data-session="${s.id}"]`).getByRole('option').click();
  await expect(chat(page, s.id).locator('.crow[data-hit]')).toContainText('uniquely searchable completion');
});

test('test_only_turn_always_has_a_named_summary', async ({ page, chatCore }) => {
  const s = chatCore.chat('test-only');
  append(s.file, rec.user('test'), rec.use('t1', 'Bash', { command: 'pnpm test' }));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByRole('button', { name: /^Ran 1 command/ })).toBeVisible();
  append(s.file, rec.result('t1', 'pnpm: command not found'));
  await view.locator('.sum').click();
  await expect(view.getByRole('button', { name: /Ran pnpm test/ })).toContainText('command not found');
  await view.locator('.sum').click();
  append(s.file, rec.user('try again'), rec.use('t2', 'Bash', { command: 'pnpm test' }), rec.result('t2', '18 passed'));
  await expect(view.getByRole('button', { name: /^Ran 1 command/ })).toHaveCount(2);
  await expect(view.locator('.sum').last()).toContainText('18 passed');
});

test('pending_edit_is_not_reported_as_completed', async ({ page, chatCore }) => {
  const s = chatCore.chat('pending-edit');
  const [use, result] = rec.edit('e1', `${s.cwd}/one.txt`, ['-old', '+new']);
  append(s.file, rec.user('edit'), use);
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByRole('button', { name: /^1 edit/ })).toBeVisible();
  await expect(view.locator('.chcard')).toHaveCount(0);
  append(s.file, result);
  await expect(view.getByRole('button', { name: /^Edited 1 file/ })).toBeVisible();
  await expect(view.locator('.chcard')).toHaveCount(1);
});

// These checks use the public projection -> display-row seam, including the Codex adapter's false error flag.
const rowsOf = (data: Data[]) => viewRows(buildRows(data.map((data, cursor) => ({ schema_version: 1, cursor, data }))), 'normal');
const summaryOf = (data: Data[]) => {
  const row = rowsOf(data).find((r): r is Extract<Row, { kind: 'summary' }> => r.kind === 'summary')!;
  return { ...row, label: summaryLabel(row.parts, makeT('en', 'en')) };
};
const resultReceipt = (output: string, exit_code: number | null, extra = {}) => JSON.stringify({ output, metadata: { exit_code }, ...extra });

test('failed_edit_not_counted', () => {
  const use: Data = { kind: 'tool_use', tool_id: 'patch', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch' };
  const edit: Data = { kind: 'edit', tool_id: 'patch', path: 'a.txt', added: 1, removed: 1, hunks: ['-old', '+new'] };
  for (const output of ['Failed to find expected lines', 'unknown result', resultReceipt('Failed to find expected lines', 0), resultReceipt('Success', 1)]) {
    const summary = summaryOf([use, edit, { kind: 'tool_result', tool_id: 'patch', output, is_error: false }]);
    expect(summary.label, output).toBe('1 edit');
    expect(summary.label).not.toMatch(/edited/i);
    expect(rowsOf([use, edit, { kind: 'tool_result', tool_id: 'patch', output, is_error: false }]).some((row) => row.kind === 'changes')).toBe(false);
  }
  for (const output of ['Success', 'Success. Updated the following files:\nM a.txt', resultReceipt('Success', 0)]) {
    expect(summaryOf([use, edit, { kind: 'tool_result', tool_id: 'patch', output, is_error: false }]).label).toBe('Edited 1 file'); // look 1117 v4: says what it edited
  }
});

test('N9: a Codex exec script that runs one read command reads as Claude\'s read; a search as a search', () => {
  const script = (id: string, input: string): Data[] => [
    { kind: 'tool_use', tool_id: id, name: 'exec', input },
    { kind: 'tool_result', tool_id: id, output: 'Script completed', is_error: false },
  ];
  expect(summaryOf(script('r', 'const r = await tools.exec_command({cmd:"cat app.py",max_output_tokens:4000}); text(r.output);\n')).label).toBe('Read 1 file');
  expect(summaryOf(script('s', 'text(await tools.exec_command({cmd:"rg -n total app.py"}));')).label).toMatch(/^Searched 1/);
  // Two calls in one script say nothing for sure: still another tool.
  expect(summaryOf(script('t', 'await tools.exec_command({cmd:"cat a"}); await tools.exec_command({cmd:"rm a"});')).label).toBe('Used 1 other tool');
});

test('N18: a denied command reads as denied, never as run', () => {
  const bash = (output: string, is_error: boolean): Data[] => [
    { kind: 'tool_use', tool_id: 'b', name: 'Bash', input: { command: "python3 -c 'print(42)'" } },
    { kind: 'tool_result', tool_id: 'b', output, is_error },
  ];
  const no = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";
  expect(summaryOf(bash(no, true)).label).toBe('Denied 1 command');
  expect(summaryOf(bash('The user denied this. Do not retry it; their instruction follows as their next message.', true)).label).toBe('Denied 1 command');
  // A command that ran and failed on a file's permission did run.
  expect(summaryOf(bash('bash: ./x: Permission denied', true)).label).toBe('Ran 1 command');
  // W10 core 11: Codex's Deny is Esc; the turn ends interrupted and the asking calls get no result. They never ran.
  const asked = (id: string): Data => ({ kind: 'tool_use', tool_id: id, name: 'exec_command', input: { cmd: 'rm -rf build' } });
  expect(summaryOf([asked('c1'), asked('c2'), { kind: 'turn', turn_id: 't', state: 'interrupted' }]).label).toBe('Denied 2 commands');
  // Look 1117 v5: Codex gives the denied call a result, "aborted by user after 37.5s"; the call before it ran and failed.
  const done = (id: string, output: string): Data => ({ kind: 'tool_result', tool_id: id, output, is_error: false });
  expect(summaryOf([asked('c1'), done('c1', '{"exit_code":128,"output":"fatal: x"}'), asked('c2'), done('c2', 'aborted by user after 37.5s'), { kind: 'turn', turn_id: 't', state: 'interrupted' }]).label).toBe('Ran 1 command, denied 1 command');
  // Without the interrupt, a call still waiting for its result is running, as before.
  expect(summaryOf([asked('c1')]).label).toBe('Ran 1 command');
});

// Sixth look (B6-S3-2): while a command's request waits for the user (the card is up, or Deny's note box is open), the
// turn's line read "Ran 1 command". It has not run: the line says it waits, in every language.
test('asked_command_waits_never_ran', () => {
  const t = makeT('en', 'en');
  const label = (data: Data[], asking: number) => {
    const rows = viewRows(buildRows(data.map((data, cursor) => ({ schema_version: 1, cursor, data }))), 'normal', asking);
    return rows.filter((r): r is Extract<Row, { kind: 'summary' }> => r.kind === 'summary').map((r) => summaryLabel(r.parts, t));
  };
  const say = (text: string): Data => ({ kind: 'message', role: 'user', text });
  const bash = (id: string): Data => ({ kind: 'tool_use', tool_id: id, name: 'Bash', input: { command: 'touch note.txt' } });
  const codex = (id: string): Data => ({ kind: 'tool_use', tool_id: id, name: 'exec_command', input: { cmd: 'git tag v6 HEAD' } });
  const ok = (id: string): Data => ({ kind: 'tool_result', tool_id: id, output: 'ok', is_error: false });
  for (const asked of [bash, codex]) {
    expect(label([say('go'), asked('a')], 1)).toEqual(['1 command waiting for your answer']);
    expect(label([say('go'), asked('a'), asked('b')], 2)).toEqual(['2 commands waiting for your answer']);
    // Look v36 (S3-4): never more than the requests that wait.
    expect(label([say('go'), asked('a'), asked('b')], 1)).toEqual(['1 command waiting for your answer']);
    // A command that already has its result ran; only the one with no result waits.
    expect(label([say('go'), asked('a'), ok('a'), asked('b')], 1)).toEqual(['Ran 1 command, 1 command waiting for your answer']);
    // An earlier turn is not the one that asks; once answered, the command has run.
    expect(label([say('one'), asked('a'), ok('a'), say('two'), asked('b')], 1)).toEqual(['Ran 1 command', '1 command waiting for your answer']);
    expect(label([say('go'), asked('a'), ok('a')], 0)).toEqual(['Ran 1 command']);
  }
  for (const lang of ['ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt'] as const) for (const n of ['one', 'other'] as const) expect(makeT(lang, lang)(`turnsum.asking.${n}`, { n: 2 }), lang).not.toBe(t(`turnsum.asking.${n}`, { n: 2 }));
});

// Seventh look (B S2-2), the records of the look's Codex session: Codex tries `git tag` in its sandbox (exit 128), then
// asks for the same command with `require_escalated`. One command: the line read "Ran 1 command, 1 command waiting for
// your answer" while it waited, "Ran 1 command, denied 1 command" after Deny, "Ran 2 commands" after Allow.
test('codex_sandbox_try_and_its_ask_are_one_command', () => {
  const t = makeT('en', 'en');
  const label = (data: Data[], asking = 0) => {
    const rows = viewRows(buildRows(data.map((data, cursor) => ({ schema_version: 1, cursor, data }))), 'normal', asking);
    return rows.filter((r): r is Extract<Row, { kind: 'summary' }> => r.kind === 'summary').map((r) => summaryLabel(r.parts, t));
  };
  const say: Data = { kind: 'message', role: 'user', text: 'tag it' };
  const use = (id: string, input: string): Data => ({ kind: 'tool_use', tool_id: id, name: 'exec', input });
  const result = (id: string, output: string): Data => ({ kind: 'tool_result', tool_id: id, output, is_error: false });
  const tried = [use('c1', 'text(await tools.exec_command({cmd:"git tag v7probe2 HEAD",max_output_tokens:1000}));\n'), result('c1', 'Script completed\nWall time 0.1 seconds\nOutput:\n{"chunk_id":"cd9f79","wall_time_seconds":0,"exit_code":128,"output":"fatal: cannot lock ref \'refs/tags/v7probe2\': Operation not permitted"}')];
  const ask = use('c2', 'text(await tools.exec_command({cmd:"git tag v7probe2 HEAD",sandbox_permissions:"require_escalated",justification:"Allow creating the requested v7probe2 Git tag? The sandbox blocked writing to .git.",max_output_tokens:1000}));\n');
  expect(label([say, ...tried, ask], 1)).toEqual(['1 command waiting for your answer']);
  expect(label([say, ...tried, ask, result('c2', 'aborted by user after 12.9s'), { kind: 'turn', turn_id: 't', state: 'interrupted' }])).toEqual(['Denied 1 command']);
  expect(label([say, ...tried, ask, result('c2', 'Script completed\nWall time 11.5 seconds\nOutput:\n{"chunk_id":"083c2b","exit_code":0,"output":""}')])).toEqual(['Ran 1 command']);
  // Another command before the ask did run; and a failed command asked again without the sandbox mark is two runs, as before.
  const other = [use('c0', 'text(await tools.exec_command({cmd:"git status --short"}));\n'), result('c0', 'Script completed')];
  expect(label([say, ...other, ...tried, ask], 1)).toEqual(['Ran 1 command, 1 command waiting for your answer']);
  expect(label([say, ...tried, use('c2', 'text(await tools.exec_command({cmd:"git tag v7probe2 HEAD"}));\n'), result('c2', 'Script completed')])).toEqual(['Ran 2 commands']);
  // A first try that succeeded did run (Codex look on wave 14): the same command asked again with the mark is a second run.
  expect(label([say, use('c1', 'text(await tools.exec_command({cmd:"git tag v7probe2 HEAD"}));\n'), result('c1', 'Script completed\nOutput:\n{"exit_code":0,"output":""}'), ask, result('c2', 'Script completed\nOutput:\n{"exit_code":0,"output":""}')])).toEqual(['Ran 2 commands']);
});

// Follow-up to B6-S3-2: the same for every kind the line counts. A read, a search, an edit or another tool whose request
// still waits read "Read 1 file", "1 edit", "Used 1 other tool" before it ran.
test('asked_call_of_any_kind_waits_never_done', () => {
  const t = makeT('en', 'en');
  const label = (data: Data[], asking = 1) => {
    const rows = viewRows(buildRows(data.map((data, cursor) => ({ schema_version: 1, cursor, data }))), 'normal', asking);
    return rows.filter((r): r is Extract<Row, { kind: 'summary' }> => r.kind === 'summary').map((r) => summaryLabel(r.parts, t));
  };
  const say: Data = { kind: 'message', role: 'user', text: 'go' };
  const use = (id: string, name: string, input: unknown): Data => ({ kind: 'tool_use', tool_id: id, name, input });
  const ok = (id: string): Data => ({ kind: 'tool_result', tool_id: id, output: 'ok', is_error: false });
  const read = (id: string) => use(id, 'Read', { file_path: '/p/app.py' });
  const calls: [string, Data][] = [
    ['Read 1 file', read('a')],
    ['Searched 1 pattern', use('a', 'Grep', { pattern: 'total' })],
    ['1 edit', use('a', 'Edit', { file_path: '/p/app.py', old_string: 'a', new_string: 'b' })],
    ['1 edit', use('a', 'Write', { file_path: '/p/tax.py', content: 'x = 1\n' })],
    ['Used 1 other tool', use('a', 'WebFetch', { url: 'https://example.com' })],
  ];
  for (const [before, call] of calls) {
    expect(label([say, call], 0), before).toEqual([before]); // with no request waiting: as before
    expect(label([say, call]), before).toEqual(['1 request waiting for your answer']);
  }
  // A command that reads is still a command: it waits as one.
  expect(label([say, use('a', 'exec_command', { cmd: 'cat app.py' })])).toEqual(['1 command waiting for your answer']);
  expect(label([say, use('a', 'Bash', { command: 'rg -n total app.py' })])).toEqual(['1 command waiting for your answer']);
  // What already has its result is done; only the call with none waits. Two kinds waiting say both.
  expect(label([say, read('a'), ok('a'), use('b', 'Edit', { file_path: '/p/app.py', old_string: 'a', new_string: 'b' })])).toEqual(['Read 1 file, 1 request waiting for your answer']);
  expect(label([say, read('a'), use('b', 'WebFetch', { url: 'https://example.com' })], 2)).toEqual(['2 requests waiting for your answer']);
  expect(label([say, use('a', 'Bash', { command: 'touch x' }), read('b')], 2)).toEqual(['1 command waiting for your answer, 1 request waiting for your answer']);
  // Look v36 (S3-4), the look's Claude records: REPL runs Edit inside its script and Poll waits on it. One Edit request left
  // both with no result; the line said "2 requests waiting" above one card.
  expect(label([say, use('a', 'REPL', { code: 'await tools.Edit({})' }), use('b', 'Poll', {})])).toEqual(['1 request waiting for your answer']);
  // A task is not a call that asks: it stays a task while a call inside it waits.
  expect(label([say, use('a', 'Task', { description: 'look', prompt: 'look' })])).toEqual(['1 task']);
  // An earlier turn is not the one that asks.
  expect(label([say, read('a'), ok('a'), { kind: 'message', role: 'user', text: 'again' }, read('b')])).toEqual(['Read 1 file', '1 request waiting for your answer']);
  for (const lang of ['ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt'] as const) for (const n of ['one', 'other'] as const) expect(makeT(lang, lang)(`turnsum.askingCall.${n}`, { n: 2 }), lang).not.toBe(t(`turnsum.askingCall.${n}`, { n: 2 }));
});

test('test_count_needs_completed_test_run', () => {
  const run = (command: string, output: unknown, is_error = false): Data[] => [
    { kind: 'tool_use', tool_id: 'tests', name: 'exec_command', input: { cmd: command } },
    { kind: 'tool_result', tool_id: 'tests', output, is_error },
  ];
  for (const [command, output, is_error] of [
    ['cat test.log', resultReceipt('18 passed', 0), false],
    ['pytest -q', resultReceipt('18 passed\n1 failed', 1), false],
    ['pytest -q', resultReceipt('18 passed', null, { session_id: 42 }), false],
    ['pytest -q &', resultReceipt('18 passed', 0), false],
    ['pytest -q', '18 passed', false],
    ['pytest -q', resultReceipt('18 passed', 0), true],
    ['pytest -q', resultReceipt('18 passed\n1 failed', 0), false],
  ] as const) {
    expect(summaryOf(run(command, output, is_error)).tests, `${command}: ${output}`).toBeNull();
  }
  expect(summaryOf(run('pnpm exec playwright test', resultReceipt('18 passed', 0))).tests).toBe('18 passed');
  expect(summaryOf(run('pytest -q', 'Wall time: 0.1 seconds\nProcess exited with code 0\nFinal output:\n18 passed')).tests).toBe('18 passed');
  // A newer failed/incomplete run must not leave an earlier success attached to the turn.
  const prior = run('pytest -q', resultReceipt('18 passed', 0));
  const next: Data[] = [{ kind: 'tool_use', tool_id: 'next', name: 'Bash', input: { command: 'pytest -q' } }];
  expect(summaryOf([...prior, ...next]).tests).toBeNull();
  const use = codexRecorded.use.payload;
  const result = codexRecorded.result.payload;
  expect(summaryOf([
    { kind: 'tool_use', tool_id: use.call_id, name: use.name, input: JSON.parse(use.arguments) },
    { kind: 'tool_result', tool_id: result.call_id, output: result.output, is_error: false },
  ]).tests).toBeNull();
  // Mutate only the command: the recorded completion output itself supplies the exit-0 evidence.
  expect(summaryOf([
    { kind: 'tool_use', tool_id: use.call_id, name: use.name, input: { cmd: 'pytest -q' } },
    { kind: 'tool_result', tool_id: result.call_id, output: result.output, is_error: false },
  ]).tests).toBe('2 passed');
});

test('last_test_run_decides', () => {
  for (const name of ['Bash', 'exec_command']) {
    const prior: Data[] = [
      { kind: 'tool_use', tool_id: 'first', name, input: { command: 'pytest -q' } },
      { kind: 'tool_result', tool_id: 'first', output: name === 'Bash' ? '18 passed' : resultReceipt('18 passed', 0), is_error: false },
    ];
    expect(summaryOf(prior).tests).toBe('18 passed');
    for (const command of ['pytest -q', 'pytest -q &', 'pytest&']) {
      const next: Data = { kind: 'tool_use', tool_id: 'last', name, input: { command } };
      expect(summaryOf([...prior, next]).tests, command).toBeNull();
      expect(summaryOf([...prior, next, { kind: 'tool_result', tool_id: 'last', output: name === 'Bash' ? '1 failed, 18 passed' : resultReceipt('1 failed, 18 passed', 1), is_error: name === 'Bash' }]).tests).toBeNull();
    }
    const background: Data[] = [
      { kind: 'tool_use', tool_id: 'last', name, input: { command: 'pytest -q', run_in_background: true } },
      { kind: 'tool_result', tool_id: 'last', output: 'Command running in background with ID: tests', is_error: false },
    ];
    expect(summaryOf([...prior, ...background]).tests).toBeNull();
  }
});

test('claude_write_success_counts', async ({ page, chatCore }) => {
  const s = chatCore.chat('recorded-write');
  append(s.file, rec.user('write'), ...claudeRecorded.write);
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByRole('button', { name: /^Edited 1 file/ })).toBeVisible();
  await expect(view.locator('.chcard')).toHaveCount(1);
});

test('claude_bash_pass_count', async ({ page, chatCore }) => {
  const s = chatCore.chat('recorded-bash');
  append(s.file, rec.user('test'), rec.use('tests', 'Bash', { command: 'pnpm exec playwright test' }), claudeRecorded.bashResult);
  await openChat(page, s.id);
  await expect(chat(page, s.id).locator('.sum')).toContainText('tests 10 passed');
});

// Look 1117 (N8): a session named from its first prompt ends in "..." and the placeholder added its own "…" ("sentence......").
test('placeholder_has_one_ellipsis (N8)', async ({ page, chatCore }) => {
  const s = chatCore.chat('Read app.py and tell me...');
  await openChat(page, s.id);
  await expect(page.locator('.composer textarea')).toHaveAttribute('placeholder', 'Message Read app.py and tell me… (@ files, / commands)');
});

// vb-5 (look 1117): with Decisions, Terminal and Side chat open the chat is narrow and "View in Diff" wrapped to three lines.
test('view_in_diff_stays_one_line_when_narrow (vb-5)', async ({ page, chatCore }) => {
  const s = chatCore.chat('changes');
  mockupTurn(s.file, s.cwd);
  await openChat(page, s.id);
  const btn = chat(page, s.id).locator('.chcard').getByRole('button', { name: 'View in Diff' });
  await expect(btn).toBeVisible();
  await chat(page, s.id).locator('.chcard').evaluate((e) => (e.style.width = '220px'));
  const { h, line } = await btn.evaluate((b) => ({ h: b.getBoundingClientRect().height, line: parseFloat(getComputedStyle(b).lineHeight) || 18 }));
  expect(h).toBeLessThan(line * 1.5 + 8);
});

// N19 (look 1117 v3 B): the composer turned 'print(42)' into ‘print(42)’ and "alpha" into "Alpha". A field that sends text to
// an agent or a shell turns the system's substitutions off; typed quotes and dashes stay plain (the browser engine here has
// no macOS substitutions, so the attributes are what this check can prove).
test('plain_text_fields_turn_substitutions_off (N19)', async ({ page, chatCore }) => {
  const s = chatCore.chat('plain');
  await openChat(page, s.id);
  const box = page.locator('.composer textarea');
  for (const [k, v] of [['autocorrect', 'off'], ['autocapitalize', 'off'], ['spellcheck', 'false'], ['autocomplete', 'off']]) await expect(box).toHaveAttribute(k, v);
  await box.fill('');
  await box.pressSequentially(`'a' "b" -- alpha`);
  await expect(box).toHaveValue(`'a' "b" -- alpha`);
});

// N19, the rule for every field (eighth look: the question card's "Type something" box had been missed): each text
// <input> and <textarea> under web/src spreads PLAIN (src/plainText.ts), so a new field cannot miss the props. Boxes
// that take no typed words (checkbox, radio, range, colour, file, number, time, date) are not text fields.
test('every_text_field_is_plain (N19)', () => {
  const NOT_TEXT = /\btype="(checkbox|radio|range|color|file|number|time|date|hidden|password)"/;
  const missing: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file);
      if (!e.name.endsWith('.tsx')) continue;
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<(input|textarea)\b/g)) {
        // The opening tag ends at the first ">" outside a {…} expression (an arrow's "=>" is inside one, or follows "=").
        let i = m.index + m[0].length;
        for (let depth = 0; i < src.length && !(src[i] === '>' && depth === 0 && src[i - 1] !== '='); i++) depth += src[i] === '{' ? 1 : src[i] === '}' ? -1 : 0;
        const tag = src.slice(m.index, i);
        if (!NOT_TEXT.test(tag) && !tag.includes('{...PLAIN}')) missing.push(`${path.relative(REPO, file)}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
  };
  walk(path.join(REPO, 'web/src'));
  expect(missing).toEqual([]);
});

// N23 (look 1117 v3 B): the lone "Normal" view chip sat at the window's edge after a wide blank gap; it sits at the right
// edge of the chat's own column, above the messages it changes.
test('view_chip_sits_on_the_chat_column (N23)', async ({ page, chatCore }) => {
  const s = chatCore.chat('viewchip');
  append(s.file, rec.user('hi'), rec.assistant('ok'));
  await page.setViewportSize({ width: 1600, height: 900 });
  await openChat(page, s.id);
  const chip = chat(page, s.id).locator('.cview .btn').first();
  await expect(chip).toBeVisible();
  const [c, box] = [(await chip.boundingBox())!, (await page.locator('.composer .cbox').boundingBox())!];
  expect(c.x + c.width).toBeLessThanOrEqual(box.x + box.width + 2);
});

// b2-S3-2 (look 1117 v4f): on a Codex session (no permission chip) the lone "Normal" pill read like a permission mode. The
// transcript view control carries a list mark, and its name says what it is.
test('view_control_reads_as_a_view (b2-S3-2)', async ({ page, chatCore }) => {
  const s = chatCore.chat('viewmark');
  append(s.file, rec.user('hi'), rec.assistant('ok'));
  await openChat(page, s.id);
  const control = chat(page, s.id).getByRole('button', { name: 'Transcript view: Normal' });
  await expect(control).toHaveText('Normal');
  await expect(control.locator('svg')).toHaveCount(1);
});

// Look 1117 v5 (B S3): an expanded Codex command row showed its raw JSON receipt ({"chunk_id":…,"exit_code":128,…}).
test('codex_exec_receipt_shows_its_output', () => {
  const receipt = JSON.stringify({ chunk_id: 'e548fc', wall_time_seconds: 0, exit_code: 128, original_token_count: 9, output: 'fatal: tag exists\n' });
  expect(shownOutput(receipt)).toBe('fatal: tag exists\nexit code 128');
  const tool = { key: 1, use: { name: 'exec_command', input: { cmd: 'git tag v5probe1 HEAD' } }, result: { output: receipt, is_error: false } } as unknown as Tool;
  expect(toolLine(tool)).toEqual(['Ran git tag v5probe1 HEAD', 'exit code 128']);
  // Any other result is shown as it is.
  expect(shownOutput('{"a":1}')).toBe('{"a":1}');
});

// Sixth look (B6-S3-1): Codex 0.161 runs a command through its exec script. The script's result is its own three lines and
// then the command's receipt as one line of JSON, and the row's line was that JSON ({"chunk_id":"106641",…).
test('codex_exec_script_receipt_shows_the_command_output', () => {
  const script = (receipt: object) => [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'input_text', text: JSON.stringify(receipt) }];
  const tool = (receipt: object) => ({ key: 1, use: { name: 'exec', input: 'text(await tools.exec_command({"cmd":"cat test_app.py"}));' }, result: { output: script(receipt), is_error: false } }) as unknown as Tool;
  const cat = { chunk_id: '106641', wall_time_seconds: 0.000005833, exit_code: 0, original_token_count: 12, output: 'import app\n\ndef test_total():\n    assert app.total([1, 2]) == 3\n' };
  expect(shownOutput(script(cat))).toBe('import app\n\ndef test_total():\n    assert app.total([1, 2]) == 3');
  expect(toolLine(tool(cat))).toEqual(['Ran cat test_app.py', '    assert app.total([1, 2]) == 3']);
  // No output: the line is empty, never the receipt or the script's own frame; a failing command says its exit code.
  expect(toolLine(tool({ ...cat, output: '' }))).toEqual(['Ran cat test_app.py', '']);
  expect(toolLine(tool({ chunk_id: '1', wall_time_seconds: 0, exit_code: 0 }))).toEqual(['Ran cat test_app.py', '']);
  expect(toolLine(tool({ ...cat, exit_code: 1, output: 'cat: test_app.py: No such file or directory\n' }))).toEqual(['Ran cat test_app.py', 'exit code 1']);
  for (const receipt of [cat, { ...cat, output: '' }, { chunk_id: '1', wall_time_seconds: 0, exit_code: 0 }]) expect(shownOutput(script(receipt))).not.toMatch(/chunk_id|wall_time|Script completed/);
  // A script that printed its own text keeps it.
  expect(shownOutput([{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'input_text', text: 'hello' }])).toBe('Script completed\nWall time 0.1 seconds\nOutput:\n\nhello');
});
