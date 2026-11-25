import { expect, test, showComposer } from './fixtures';
import { mockupTree } from './fixtures/fid-tree';
import { foldingFrame, treeObservations } from './fixtures/fid-tree2';
import fs from 'node:fs';
import path from 'node:path';
import { mockup } from './visual/mockups';
import { seed } from './tree-seed';
import { repo, show, trading, worktree } from './visual/compare';

/** Ticket 388: a head's colour strip as "tone+count" per colour (one bar per session; red, orange, yellow, blue, grey). */
const strip = (head: import('@playwright/test').Locator) => head.locator(':scope > .cstrip > .sg').evaluateAll((es) => es.map((e) => `${(e as HTMLElement).dataset.tone}${(e as HTMLElement).dataset.n}`).join(' '));

test('cleanup_row_one_line', async ({ app, core }) => {
  await mockupTree(app, core, 'light', true, true);
  await show(app, 'light');
  const project = app.locator('.grp[data-project="nunchiro"]');
  const summary = project.locator('.cleanup > summary');
  await expect(summary).toContainText('Ready to clean up (2)');
  await expect(summary.getByRole('button', { name: 'Clean up…' })).toBeVisible();
  const metrics = await summary.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { height: r.height, scroll: e.scrollWidth, width: e.clientWidth };
  });
  expect(metrics.height).toBeLessThanOrEqual(30);
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.width + 1);
  await expect(project.locator('.wtmerged')).toHaveCount(0);
  await expect(project.locator('.cleanup ~ .row.wt2')).toHaveCount(0);
});

test('folded_group_shows_waiting_only', async ({ app, core }) => {
  const group = await trading(app, core, 'light', false);
  await app.getByRole('button', { name: 'Collapse group Trading' }).click();
  await expect(app.getByRole('button', { name: 'Expand group Trading' })).toHaveAttribute('aria-expanded', 'false');
  await expect(group.locator('.row.head')).toHaveCount(0);
  await expect(group.locator('.row.quiet')).toHaveCount(0);
  await expect(group.locator('.row.wt2')).toHaveCount(2);
  await expect(group.locator('.more')).toHaveText('+2 waiting');
  await expect(group.locator('> .ghead .d')).toHaveText('3 projects');
  // lumen rehfix, tide sealed-read and review wait; lumen broke failed; tests and post work; four idle.
  await expect.poll(() => strip(group.locator('> .ghead'))).toBe('r1 o3 b2 g4');
  await expect(group.locator('.row.wt2 .n').first()).toHaveText('lumen · broke');
  await expect(group.locator('.row.wt2 .n').nth(1)).toHaveText('lumen · rehfix');
  await expect(group.locator('.qib.al, .qib.no')).toHaveCount(0);
});

test('waiting_row_names_whole', async ({ app, core }) => {
  const group = await mockupTree(app, core, 'light');
  for (const width of [300, 240, 180]) {
    await app.locator('.sbar.l').evaluate((e, w) => { (e as HTMLElement).style.width = `${w}px`; }, width);
    const names = group.locator('.row.wt2 .n');
    await expect(names.nth(1)).toHaveText('tide · sealed-read-backend');
    const sizes = await names.nth(1).evaluate((e) => {
      const pre = e.querySelector('.pre') as HTMLElement;
      const nm = e.querySelector('.nm') as HTMLElement;
      return { prefixScroll: pre.scrollWidth, prefixWidth: pre.clientWidth, nameCut: nm.scrollWidth > nm.clientWidth + 1 || nm.scrollHeight > nm.clientHeight + 1, textOverflow: getComputedStyle(nm).textOverflow };
    });
    expect(sizes.prefixScroll).toBeLessThanOrEqual(sizes.prefixWidth + 1);
    expect(sizes.textOverflow).toBe('ellipsis');
    // Look 1117 v11 (A6): a name cut at a word is clamped to one line, so a cut one overflows downwards.
    if (width === 300) expect(sizes.nameCut).toBe(false);
    if (width === 180) expect(sizes.nameCut).toBe(true);
  }
});

test('folded_group_main_session_names', async ({ app, core }) => {
  const project = repo(core, 'tide');
  core.shell(project, 'sealed-read');
  seed(core, { op: 'group_create', name: 'Trading', project });
  await treeObservations(app, { 'sealed-read': { waiting: 'question' } });
  await show(app, 'light');
  await app.getByRole('button', { name: 'Collapse group Trading' }).click();
  await expect(app.locator('.pgrp .row.wt2 .n')).toHaveText('tide · sealed-read');
});

test('folded_group_keeps_broken_and_waiting', async ({ app, core }) => {
  const a = repo(core, 'alpha');
  core.shell(a, 'screen-wait');
  core.shell(a, 'question');
  const b = repo(core, 'beta');
  worktree(core, b, 'broken');
  seed(core, { op: 'group_create', name: 'Trading', project: a }, { op: 'project_move', project: b, group: 'Trading' });
  await treeObservations(app, { 'screen-wait': { waiting: true }, question: { waiting: 'question' }, broken: { failed: true } });
  await show(app, 'light');
  await app.getByRole('button', { name: 'Collapse group Trading' }).click();
  const group = app.locator('.pgrp[data-group="Trading"]');
  await expect(group.locator('.row.wt2 .n')).toHaveText(['beta · broken', 'alpha · screen-wait']);
  await expect(group.locator('.row.wt2').first()).toHaveAttribute('data-kind', 'fail');
  await expect(group.locator('.row.wt2').nth(1)).toHaveAttribute('data-kind', 'ask');
  await expect(group.locator('.more')).toHaveText('+1 waiting');
  await expect(group.locator('.head')).toHaveCount(0);
  await expect(group.locator('> .ghead .cstrip > .sg[data-tone="o"]')).toHaveAttribute('data-n', '2');
  await expect(group.locator('> .ghead .cstrip > .sg[data-tone="r"]')).toHaveAttribute('data-n', '1');
});

test('folded_group_main_broken_and_worktree_waiting', async ({ app, core }) => {
  const project = repo(core, 'alpha');
  core.shell(project, 'broken');
  worktree(core, project, 'screen-wait');
  seed(core, { op: 'group_create', name: 'Trading', project });
  await treeObservations(app, { broken: { failed: true }, 'screen-wait': { waiting: true } });
  await show(app, 'light');
  await app.getByRole('button', { name: 'Collapse group Trading' }).click();
  const group = app.locator('.pgrp[data-group="Trading"]');
  await expect(group.locator('.row.wt2 .n')).toHaveText(['alpha · broken', 'alpha · screen-wait']);
  await expect(group.locator('.q, .more')).toHaveCount(0);
});

test('waiting_count_excludes_background', async ({ app, core }) => {
  const project = repo(core, 'alpha');
  for (const name of ['background-a', 'background-b', 'background-c', 'question']) core.shell(project, name);
  seed(core, { op: 'group_create', name: 'Trading', project });
  await treeObservations(app, { 'background-a': { kind: 'background' }, 'background-b': { kind: 'background' }, 'background-c': { kind: 'background' }, question: { waiting: 'question' } });
  await show(app, 'light');
  await app.getByRole('button', { name: 'Collapse group Trading' }).click();
  const group = app.locator('.pgrp[data-group="Trading"]');
  await expect(group.locator('.row.wt2 .n')).toHaveText(['alpha · question']);
  await expect(group.locator('.more')).toHaveCount(0);
  await expect(group.locator('> .ghead .cstrip > .sg[data-tone="o"]')).toHaveAttribute('data-n', '1');
});

test('background_only_has_no_waiting_rows', async ({ app, core }) => {
  const project = repo(core, 'alpha');
  for (const name of ['a', 'b', 'c']) core.shell(project, name);
  seed(core, { op: 'group_create', name: 'Trading', project });
  await treeObservations(app, { a: { kind: 'background' }, b: { kind: 'background' }, c: { kind: 'background' } });
  await show(app, 'light');
  await app.getByRole('button', { name: 'Collapse group Trading' }).click();
  const group = app.locator('.pgrp[data-group="Trading"]');
  await expect(group.locator('.row.wt2, .q, .more, .cstrip > .sg[data-tone="o"]')).toHaveCount(0);
  await expect(group.locator('.cstrip [data-tone="o"]')).toHaveCount(0);
});

test('background_does_not_hide_failed_state', async ({ app, core }) => {
  const project = repo(core, 'alpha');
  core.shell(project, 'broken');
  seed(core, { op: 'group_create', name: 'Trading', project });
  await treeObservations(app, { broken: { failed: true, kind: 'background' } });
  await show(app, 'light');
  await app.getByRole('button', { name: 'Collapse group Trading' }).click();
  const group = app.locator('.pgrp[data-group="Trading"]');
  await expect(group.locator('.row.wt2 .n')).toHaveText('alpha · broken');
  await expect(group.locator('.cstrip > .sg[data-tone="o"]')).toHaveCount(0);
  await expect(group.locator('.cstrip > .sg[data-tone="r"]')).toHaveAttribute('data-n', '1');
});

test('broken_overflow_is_not_counted_as_waiting', async ({ app, core }) => {
  const project = repo(core, 'alpha');
  for (const name of ['a', 'b', 'c']) core.shell(project, name);
  seed(core, { op: 'group_create', name: 'Trading', project });
  await treeObservations(app, { a: { failed: true }, b: { failed: true }, c: { failed: true } });
  await show(app, 'light');
  await app.getByRole('button', { name: 'Collapse group Trading' }).click();
  const group = app.locator('.pgrp[data-group="Trading"]');
  await expect(group.locator('.row.wt2 .n')).toHaveText(['alpha · a', 'alpha · b']);
  await expect(group.locator('.more')).toHaveText('+1');
  await expect(group.locator('.cstrip > .sg[data-tone="o"]')).toHaveCount(0);
  await expect(group.locator('.cstrip > .sg[data-tone="r"]')).toHaveAttribute('data-n', '3');
});

test('cleanup_opens_tidy', async ({ app, core, browserName }) => {
  const project = repo(core, 'nunchiro');
  worktree(core, project, 'merged');
  const requests = await treeObservations(app, { merged: { pr: { number: 53, state: 'merged' } } });
  await show(app, 'light');
  const cleanup = app.getByRole('button', { name: 'Clean up…', exact: true });
  await expect(cleanup).toBeVisible();
  await cleanup.click();
  await expect(app.getByRole('dialog', { name: /^Tidy ·/ })).toBeVisible();
  expect(requests.filter((r) => r.op === 'worktree' && r.operation === 'remove')).toEqual([]);
  expect(core.cli('worktree', 'list').worktrees).toHaveLength(1);
  fs.mkdirSync(path.join(evidence, 'r2'), { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    await app.screenshot({ path: path.join(evidence, 'r2', `tidy-${browserName}-${scheme}.png`), animations: 'disabled' });
  }
});

test('no_stray_rows', async ({ app, core }) => {
  const group = await mockupTree(app, core, 'light');
  await app.locator('.tab[data-tab]', { hasText: 'backtest-runner' }).click();
  await expect(group.locator('button[data-session-row]')).toHaveCount(0);
  await expect(group.locator('.row.wt2')).toHaveCount(2);
  // A quiet current session must not add a third row either.
  await app.locator('.tab[data-tab]', { hasText: 'main' }).first().click();
  await expect(group.locator('button[data-session-row]')).toHaveCount(0);
});

test('expanded_project_pills_and_pr', async ({ app, core }) => {
  const project = repo(core, 'nunchiro');
  core.shell(project, 'main');
  for (const name of ['v2-undo', 'v2-theme', 'v2-spaces', 'v2-palette']) worktree(core, project, name);
  await treeObservations(app, {
    'v2-undo': { waiting: 'permission' },
    'v2-theme': { waiting: 'question', pr: { number: 55, state: 'open' } },
    'v2-spaces': { failed: true, pr: { number: 54, state: 'checks_fail' } },
    'v2-palette': { working: true, pr: { number: 53, state: 'open' } },
  });
  await show(app, 'light');
  const group = app.locator('.grp[data-project="nunchiro"]');
  await expect(group.locator('> .head .cstrip > .sg[data-tone="o"]')).toHaveAttribute('data-n', '2');
  await expect(group.locator('> .head .cstrip > .sg[data-tone="r"]')).toHaveAttribute('data-n', '1');
  await expect(group.locator('> .head .d')).toHaveText('main');
  for (const [name, pr] of [['v2-palette', 53], ['v2-spaces', 54], ['v2-theme', 55]] as const) {
    await expect(group.locator('.row.wt2', { hasText: name }).locator('.prn')).toHaveText(`#${pr}`);
  }
  await expect(group.locator('.row.wt2', { hasText: 'v2-undo' }).locator('.prn')).toHaveCount(0);
});

const evidence = path.resolve(import.meta.dirname, '../../.scratch/fid-tree2');
const verdicts = [
  '같음: 프로젝트 이름·대기 2·오류 1·main, 행 순서·상태 아이콘, #53, 한 줄 정리 링크. 더 나음: HIDEROWS 결정 줄과 키보드 버튼(요구 95).',
  '같음: 접힌 lumen·대기 1·main, 다섯 색 막대, lcfollow. 더 나음: 결정 내용과 패널 열기(요구 95, 128).',
  '같음: Trading·대기 3·오류 1·3 projects, 여덟 막대·+2, 프로젝트·세션 이름. R2 요구에 따른 차이: 오류 먼저 두 행·+2 waiting. 더 나음: 패널로 이동하는 접근 가능한 버튼(요구 128).',
  '', // section 4 was the Other projects line, gone by ticket 370 item 361
  '같음: blog·main, 작업 중·유휴 두 색 막대, 새 항목 배지. 배지 문구는 지속 live region에 주입한 시각 fixture이며 실제 도착 수명주기 검증이 아니다.',
];

for (const section of [1, 2, 3, 5]) test(`same_data_side_by_side  section ${section}`, { tag: '@chromium' }, async ({ app, core }) => {
  const patches = foldingFrame(core, section);
  await treeObservations(app, patches);
  fs.mkdirSync(evidence, { recursive: true });
  const golden = await app.context().newPage();
  await golden.setViewportSize({ width: 1440, height: 900 });
  await golden.goto(`file://${mockup('v2-8a-a-folds.html')}`);
  for (const scheme of ['light', 'dark'] as const) {
    await show(app, scheme);
    if (section !== 1) {
      // Ticket 521: `count()` does not wait, so a check before the tree rendered skipped the fold (1 run in 3). Wait for the
      // toggle in either state (the dark pass finds it already folded), then fold.
      const name = section === 3 ? 'group Trading' : section === 2 ? 'lumen' : 'blog';
      const toggle = app.getByRole('button', { name: new RegExp(`^(Collapse|Expand) ${name}$`) });
      await expect(toggle).toBeVisible();
      const collapse = app.getByRole('button', { name: `Collapse ${name}`, exact: true });
      if (await collapse.count()) await collapse.click();
      await expect(app.getByRole('button', { name: `Expand ${name}`, exact: true })).toBeVisible();
    }
    await showComposer(app); // V2.5-34: a shell's composer is asked for
    await app.locator('.cbox textarea').focus();
    await app.mouse.move(900, 600);
    const target = section === 3 ? app.locator('.pgrp[data-group="Trading"]') : app.locator(`.grp[data-project="${section === 1 ? 'nunchiro' : section === 2 ? 'lumen' : 'blog'}"]`);
    await expect(target).toBeVisible();
    // Each original mockup frame has a 300px content area. Match it by resizing the real sidebar.
    const width = (await target.boundingBox())!.width;
    await app.locator('.sbar.l').evaluate((e, delta) => { (e as HTMLElement).style.width = `${e.getBoundingClientRect().width + delta}px`; }, 300 - width);
    if (section === 1) {
      await expect(target.locator('.cleanup')).toBeVisible();
      await expect(target.locator('.wtmerged')).toHaveCount(0);
      await expect(target.locator('.row.wt2 .prn')).toHaveText('#53');
    }
    if (section === 2) {
      await expect.poll(() => strip(target.locator('> .head'))).toBe('o1 b1 g3'); // one bar per session: the merged folder's session is idle
    }
    if (section === 3) {
      await expect(target.locator('.head')).toHaveCount(0);
      await expect(target.locator('.more')).toHaveText('+2 waiting');
      await expect.poll(() => strip(target.locator('> .ghead'))).toBe('r1 o3 b2 g4');
    }
    if (section === 5) {
      // Same transient badge-style fixture as fidelity-tree's popped-out project test; no arrival behavior is claimed.
      await target.locator('> .head .chip').evaluate((e) => { e.textContent = '1 new'; });
      await expect(target.locator('> .head .chip')).toHaveText('1 new');
      await expect.poll(() => strip(target.locator('> .head'))).toBe('b1 g1');
    }
    await target.screenshot({ path: path.join(evidence, `s${section}-${scheme}-app.png`), animations: 'disabled' });
    const pane = golden.locator(scheme === 'dark' ? '.pane.dk' : '.pane.lt');
    // Ticket 462 (owner 11-12): the row icon's size is the approved 388 mockup's 14px, compared in tree-bars-462.spec.ts.
    const pairs: [string, string, string[]][] = section === 1
      ? [['.row.run .n', '.row.run .nm', ['fontSize', 'fontWeight']]]
      : section === 2 || section === 3
        ? [['.bar .s', '.cstrip i', ['width', 'borderRadius']], ...(section === 3 ? [['.more', '.more', ['fontSize', 'fontWeight']] as [string, string, string[]]] : [])]
        : [['.new', '.chip', ['fontSize', 'fontWeight']]]; // ticket 1041 (N118): "new N" is a quiet word, no pill (no radius, no padding)
    const measurements = [];
    for (const [mockSelector, appSelector, props] of pairs) {
      const read = (e: Element, keys: string[]) => Object.fromEntries(keys.map((k) => [k, (getComputedStyle(e) as unknown as Record<string, string>)[k]]));
      const expected = await pane.locator(mockSelector).first().evaluate(read, props);
      // Ticket 515 (owner pick 11-12): the app snaps the mockup's off-scale radii to the scale, 1.5px to --r-2 and 9px to --r-8.
      if (expected.borderRadius) expected.borderRadius = ({ '1.5px': '2px', '9px': '8px' } as Record<string, string>)[expected.borderRadius] ?? expected.borderRadius;
      // Ticket 1041 (A): the type scale is 11 / 13 / 15, so the mockup's 12px "+N" and 10.5px badge are the 11px step.
      if (appSelector === '.more' || appSelector === '.chip') expected.fontSize = '11px';
      // Ticket 1041 (mockup polish-1121 .row .n, coordinator round 2): row names are regular weight.
      if (appSelector === '.row.run .nm') expected.fontWeight = '400';
      const actual = await target.locator(appSelector).first().evaluate(read, props);
      measurements.push({ mockSelector, appSelector, expected, actual });
      expect(actual).toEqual(expected);
    }
    fs.writeFileSync(path.join(evidence, `s${section}-${scheme}-metrics.json`), JSON.stringify(measurements, null, 2));
    const clip = await pane.evaluate((p, n) => {
      const tags = [...p.querySelectorAll('.tag')];
      const start = tags[n - 1].nextElementSibling!.getBoundingClientRect();
      const bottom = n < tags.length ? tags[n].getBoundingClientRect().top - 8 : p.getBoundingClientRect().bottom - 9;
      return { x: start.x, y: start.y, width: start.width, height: bottom - start.y };
    }, section);
    expect(Math.abs((await target.boundingBox())!.width - clip.width)).toBeLessThanOrEqual(1);
    await golden.screenshot({ path: path.join(evidence, `s${section}-${scheme}-mock.png`), clip, animations: 'disabled' });
    await app.screenshot({ path: path.join(evidence, `s${section}-${scheme}-window.png`), animations: 'disabled' });
  }
  await golden.close();
  fs.writeFileSync(path.join(evidence, 'side-by-side.html'), `<!doctype html><meta charset="utf-8"><title>fid-tree2 · 요소별 판정</title><style>body{font:14px system-ui;max-width:1000px;margin:24px auto}section{margin:24px 0}.pair{display:flex;gap:24px}figure{margin:0;width:320px}img{max-width:100%;border:1px solid #888}p{max-width:800px}</style><h1>fid-tree2 · 요소별 판정</h1><p>왼쪽: 승인 목업. 오른쪽: 실제 앱, 같은 300px 프레임. HIDEROWS 결정 줄은 요구 95·128에 따른 차이.</p>${[1,2,3,5].map((n) => `<section><h2>${'①②③④⑤'[n-1]}</h2>${['light','dark'].map((s) => `<h3>${s}</h3><div class="pair"><figure><figcaption>목업</figcaption><img src="s${n}-${s}-mock.png"></figure><figure><figcaption>앱</figcaption><img src="s${n}-${s}-app.png"></figure></div>`).join('')}<h3>요소별 판정</h3><p>${verdicts[n-1]}</p><p>측정한 스타일 차이: 0. <a href="s${n}-light-metrics.json">light 수치</a> · <a href="s${n}-dark-metrics.json">dark 수치</a></p></section>`).join('')}`);
});
