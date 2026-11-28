import { expect, test, type Core } from './fixtures';
import type { Page } from '@playwright/test';
import { bookControls, bookPalette, bookSurface, repo, show, expectMatchesMockup, outDir } from './visual/compare';
import fs from 'node:fs';
import path from 'node:path';
import { openQuiet } from './tree-seed';
import { WTDIALOG as data } from './fixtures/wtdialog';

test.use({ viewport: data.viewport, deviceScaleFactor: 2 });

async function open(app: Page, core: Core, keyboard = false, cmdN = false) {
  core.shell(repo(core, data.project), 'main');
  openQuiet(core);
  await show(app, 'light');
  await app.locator('.grp[data-project="nunchiro"] .row.head').hover();
  const trigger = app.getByRole('button', { name: 'New worktree in nunchiro', exact: true });
  // V2.5-61 B8: from the button the card is anchored under it; Cmd+N keeps the centred card this file measures.
  if (cmdN) await app.keyboard.press('Meta+KeyN');
  else if (keyboard) await trigger.press('Enter');
  else await trigger.click();
  return app.getByRole('dialog', { name: 'New worktree', exact: true });
}

test('preview_line', async ({ app, core }) => {
  const d = await open(app, core);
  const field = d.getByRole('textbox');
  const preview = d.getByRole('status');
  await field.fill(data.words);
  await expect(preview).toHaveText('Creates fix-login-redirect from current branch');
  await expect(d.getByText('Advanced: base and branch')).toBeVisible();
  await field.fill(data.url);
  await expect(preview).toHaveText('Creates issue-412 from current branch');
  await field.fill('https://github.com/acme/app/pull/7');
  await expect(preview).toContainText('pr-7');
  await expect(preview).toContainText("fetches the PR's code from GitHub"); // ticket 374
  await field.fill('  Fix THE login!!!  ');
  await expect(preview).toHaveText('Creates fix-the-login from current branch');
  await field.fill('');
  await expect(preview).toHaveText('Creates an auto name');
  await field.fill('한글만'); // eighth look (A): text in another script names the branch, as a first message does
  await expect(preview).toHaveText('Creates 한글만 from current branch');
  await field.fill('🎉 !!');
  await expect(preview).toHaveText('Creates an auto name');
  await field.fill('a'.repeat(49));
  await expect(preview.locator('code')).toHaveText('a'.repeat(48));
  await field.fill(data.words);
  await field.press('Alt+Enter');
  await expect(d.getByRole('textbox', { name: 'Base branch' })).toBeFocused();
  await d.getByRole('textbox', { name: 'Base branch' }).fill('main');
  await expect(preview).toHaveText('Creates fix-login-redirect from main');
  await d.getByRole('textbox', { name: 'Base branch' }).fill('develop');
  await d.getByRole('textbox', { name: 'Branch name' }).fill('chosen');
  await expect(preview).toHaveText('Creates chosen from develop');
  await app.keyboard.press('Escape');
  await expect(d).toHaveCount(0);
  expect(core.cli('worktree', 'list').worktrees).toHaveLength(0);
});

test('preview_trim_matches_core', async ({ app, core }) => {
  let d = await open(app, core);
  for (const [space, branch] of [['\uFEFF', 'https-github-com-acme-app-issues-412'], ['\u0085', 'issue-412']]) {
    await d.getByRole('textbox').fill(space + data.url);
    await expect.soft(d.getByRole('status').locator('code')).toHaveText(branch);
    await d.getByRole('textbox').press('Enter');
    await expect(d).toHaveCount(0);
    await expect.poll(() => (core.cli('worktree', 'list').worktrees as { branch: string }[]).map(w => w.branch)).toContain(branch);
    await app.locator('.grp[data-project="nunchiro"] .row.head').hover();
    await app.getByRole('button', { name: 'New worktree in nunchiro', exact: true }).click();
    d = app.getByRole('dialog', { name: 'New worktree', exact: true });
  }
  await app.keyboard.press('Escape');
});

// Eighth look (A): a Korean task typed into "New worktree" gave "wt-f3cd"; the same words as a first message named the branch.
test('korean_task_names_the_worktree (v8 A)', async ({ app, core }) => {
  const d = await open(app, core);
  await d.getByRole('textbox').fill('Fix 로그인 버튼 색!');
  await expect(d.getByRole('status').locator('code')).toHaveText('fix-로그인-버튼-색');
  await d.getByRole('textbox').press('Enter');
  await expect(d).toHaveCount(0);
  await expect.poll(() => (core.cli('worktree', 'list').worktrees as { branch: string }[]).map((w) => w.branch)).toEqual(['fix-로그인-버튼-색']);
});

test('advanced_keyboard_and_focus', async ({ app, core }) => {
  const d = await open(app, core, true);
  const advanced = d.getByRole('button', { name: '⌥↵ Advanced: base and branch' });
  await expect(advanced).toHaveAttribute('aria-expanded', 'false');
  await app.keyboard.press('Tab');
  await expect(advanced).toBeFocused();
  // v25-new-tab (ticket 294 item 1): Cancel follows Advanced on the same line, then the cycle returns to the field.
  await app.keyboard.press('Tab');
  await expect(d.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await app.keyboard.press('Tab');
  await expect(d.getByRole('textbox')).toBeFocused();
  await app.keyboard.press('Shift+Tab');
  await expect(d.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await app.keyboard.press('Shift+Tab');
  await expect(advanced).toBeFocused();
  await app.keyboard.press('Enter');
  await expect(d.getByRole('textbox', { name: 'Base branch' })).toBeFocused();
  await expect(advanced).toHaveAttribute('aria-expanded', 'true');
  expect(core.cli('worktree', 'list').worktrees).toHaveLength(0);
  await app.keyboard.press('Escape');
  await expect(app.getByRole('button', { name: 'New worktree in nunchiro', exact: true })).toBeFocused();
});

test('dialog_size_and_place', async ({ app, core }) => {
  const d = await open(app, core, false, true);
  await d.getByRole('textbox').fill(data.words);
  const box = (await d.boundingBox())!;
  expect(box.width).toBe(420); // Golden .dlg card width, before its comparison-page .sc wrapper.
  expect(Math.abs(box.x + box.width / 2 - data.viewport.width / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y + box.height / 2 - data.viewport.height / 2)).toBeLessThanOrEqual(1);
  for (const width of [320, 768, 1024]) {
    await app.setViewportSize({ width, height: 900 });
    const small = (await d.boundingBox())!;
    expect(small.x).toBeGreaterThanOrEqual(16);
    expect(small.x + small.width).toBeLessThanOrEqual(width - 16);
  }
});

for (const scheme of ['light', 'dark'] as const) {
  test(`same_data_side_by_side ${scheme}`, { tag: '@chromium' }, async ({ app, core }) => {
    const d = await open(app, core);
    await app.emulateMedia({ colorScheme: scheme });
    outDir('fid-wtdialog');
    for (const [state, input, branch] of [['words', data.words, data.branch], ['url', data.url, data.issue]]) {
      await d.getByRole('textbox').fill(input);
      await app.mouse.move(900, 600);
      await expectMatchesMockup(app, 'v2-8a-compare-r3.html', 'section[aria-labelledby="h-d1"] .dlg[aria-label="new worktree"]', d, {
        name: state,
        prepare: async (m) => {
          // Isolate the card from the comparison grid, as the existing fidelity gate does.
          await m.addStyleTag({ content: '.cols{display:block!important}' });
          // The design book (#69 controls, #71 dialogs) replaced the mockup's palette, field and dialog surface, as
          // v2-8f-fidelity and fidelity-worktree take it: the frame still compares layout, words and the hint lines.
          await bookPalette(d, m);
          const golden = m.locator('section[aria-labelledby="h-d1"] .dlg[aria-label="new worktree"]').first();
          await golden.locator('input').fill(input);
          await bookControls(d, 'input', golden, 'input');
          await bookSurface(d, golden);
          // Translate copy only; retain both golden hint elements, styles and geometry.
          await golden.locator('.hint').nth(0).evaluate((e, branch) => {
            e.replaceChildren(document.createTextNode('Creates '), Object.assign(document.createElement('code'), { textContent: branch }), document.createTextNode(' from current branch'));
          }, branch);
          await golden.locator('.hint').nth(1).evaluate((e) => {
            e.childNodes[1].textContent = ' Advanced: base and branch';
            e.lastElementChild!.textContent = 'Cancel';
          });
        },
      });
    }
    await app.screenshot({ path: path.resolve('../.scratch/fid-wtdialog', `${scheme}-window.png`) });
    const out = path.resolve('../.scratch/fid-wtdialog');
    fs.writeFileSync(path.join(out, 'side-by-side.html'), `<!doctype html><meta charset="utf-8"><title>WTDIALOGS fidelity</title><style>body{font:14px system-ui;margin:24px;background:#f6f6f4}section{margin:24px 0}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}.pair figure{margin:0}img{width:420px;max-width:100%}li{margin:6px}</style><h1>WTDIALOGS Draft 3 · mockup left / app right</h1><p>Same data, 1440 × 900, 2× scale. Both pairs use the golden typing-preview card with English copy. The URL pair verifies URL typing in that card, not the separate gh-unavailable error state. The actual HEAD default is labelled current branch. The Advanced summary is also a clickable button.</p>${['light', 'dark'].flatMap(s => ['words', 'url'].map(state => `<section><h2>${s} · ${state}</h2><div class="pair"><figure><figcaption>Mockup</figcaption><img src="${state}-${s}-mock.png"></figure><figure><figcaption>App</figcaption><img src="${state}-${s}-app.png"></figure></div><h3>요소별 판정</h3><ul><li>카드 크기·테두리·모서리·배경·여백: 같음</li><li>입력칸·값·글꼴·포커스 표시: 같음</li><li>브랜치 미리보기·보조 글자·고급 키 표시: 같음</li><li>기준 브랜치 설명: 더 나음 — 실제 HEAD 기본값을 정확히 표시</li><li>배치·작은 창 대응: 더 나음 — 중앙 배치, 창 안에 유지</li></ul></section>`)).join('')}`);
  });
}
