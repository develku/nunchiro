import fs from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, REPO } from './fixtures';
import { bookControls, bookPalette, bookSurface, repo, show, expectMatchesMockup, outDir } from './visual/compare';
import { openQuiet } from './tree-seed';
import { WTDIALOG as data } from './fixtures/wtdialog';

test.use({ viewport: data.viewport, deviceScaleFactor: 2 });
const out = path.join(REPO, '.scratch/v2-8f');

for (const scheme of ['light', 'dark'] as const) {
  test(`same_data_side_by_side ${scheme}`, { tag: '@chromium' }, async ({ app, core }) => {
    core.shell(repo(core, data.project), 'main');
    openQuiet(core);
    await show(app, scheme);
    await app.locator('.grp[data-project="nunchiro"] .row.head').hover();
    await app.getByRole('button', { name: 'New worktree in nunchiro', exact: true }).click();
    const d = app.getByRole('dialog', { name: 'New worktree', exact: true });
    outDir('v2-8f');
    await d.getByRole('textbox').fill(data.words);
    await app.mouse.move(900, 600);
    await expectMatchesMockup(app, 'v2-8a-compare-r3.html', 'section[aria-labelledby="h-d1"] .dlg[aria-label="new worktree"]', d, {
      name: 'default',
      prepare: async m => {
        await m.addStyleTag({ content: '.cols{display:block!important}' });
        await bookPalette(d, m);
        const golden = m.locator('section[aria-labelledby="h-d1"] .dlg[aria-label="new worktree"]').first();
        await golden.locator('input').fill(data.words);
        await bookControls(d, 'input', golden, 'input');
        await bookSurface(d, golden);
        // The same copy-only translation used by the existing fidelity-wtdialog gate.
        await golden.locator('.hint').nth(0).evaluate((e, branch) => {
          e.replaceChildren(document.createTextNode('Creates '), Object.assign(document.createElement('code'), { textContent: branch }), document.createTextNode(' from current branch'));
        }, data.branch);
        await golden.locator('.hint').nth(1).evaluate(e => { e.childNodes[1].textContent = ' Advanced: base and branch'; e.lastElementChild!.textContent = 'Cancel'; });
      },
    });
    await d.getByRole('button', { name: '⌥↵ Advanced: base and branch' }).click();
    await expect(d.getByRole('checkbox', { name: 'Start an agent here' })).toBeVisible({ timeout: 2000 });
    const choice = d.getByRole('checkbox', { name: 'Start an agent here' });
    await choice.check();
    expect((await choice.boundingBox())!.width).toBeLessThanOrEqual(20);
    await choice.focus();
    await app.keyboard.press('Tab');
    await expect(d.getByRole('radio', { name: 'Claude', exact: true })).toBeFocused();
    expect(await d.getByRole('radio', { name: 'Claude', exact: true }).evaluate(e => getComputedStyle(e).outlineStyle)).not.toBe('none');
    await d.getByRole('textbox', { name: 'First prompt (optional)' }).fill('Fix the login redirect.');
    await app.mouse.move(900, 600);
    await d.screenshot({ path: path.join(out, `start-${scheme}.png`) });
    await app.screenshot({ path: path.join(out, `window-${scheme}.png`) });
    await d.getByRole('button', { name: 'Model', exact: true }).click();
    await d.screenshot({ path: path.join(out, `model-${scheme}.png`) });
    await d.getByRole('option', { name: 'Haiku' }).focus();
    await app.keyboard.press('Escape');
    await expect(d.getByRole('button', { name: 'Model', exact: true })).toBeFocused();
    expect((await new AxeBuilder({ page: app }).include('[role="dialog"]').analyze()).violations).toEqual([]);
    for (const width of [320, 768, 1024, 1440]) {
      await app.setViewportSize({ width, height: 900 });
      const box = (await d.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(16);
      expect(box.x + box.width).toBeLessThanOrEqual(width - 16);
      await expect(d.getByRole('button', { name: 'Create and start', exact: true })).toBeInViewport();
    }
    fs.unlinkSync(path.join(core.home, 'bin/claude'));
    await d.getByRole('button', { name: 'Create and start', exact: true }).click();
    await expect(d.getByRole('alert')).toContainText('Could not start the agent');
    await expect(d.getByRole('button', { name: 'Retry start', exact: true })).toBeEnabled();
    await d.screenshot({ path: path.join(out, `retry-${scheme}.png`) });
    await app.screenshot({ path: path.join(out, `retry-window-${scheme}.png`) });
    fs.writeFileSync(path.join(out, 'side-by-side.html'), `<!doctype html><meta charset="utf-8"><title>V2-8f · Draft 1 One-click+</title><style>body{font:14px system-ui;margin:24px;background:#f6f6f4;color:#222}section{margin:24px 0}.pair{display:flex;gap:24px;flex-wrap:wrap}figure{margin:0}img{width:420px;max-width:100%}li{margin:6px}</style><h1>V2-8f · Draft 1 One-click+</h1><p>Same fixture: fix login redirect → fix-login-redirect, 1440 × 900, 2× scale. Approved WTDIALOGS frame: v2-8a-compare-r3.html, Draft 1 card in Draft 3. English translation only, as in the existing fidelity gate. Default comparison keeps the original pixel threshold (2%). The optional agent controls live in Advanced; the mockup has no corresponding start or error frame.</p>${['light','dark'].map(s => `<section><h2>${s}</h2><div class="pair"><figure><figcaption>Approved Draft 1 · default</figcaption><img src="default-${s}-mock.png"></figure><figure><figcaption>App · default OFF</figcaption><img src="default-${s}-app.png"></figure></div><h3>요소별 판정</h3><ul><li>기본 카드 크기·테두리·배경·입력칸·여백: 같음</li><li>미리보기·보조 글자·고급 키 표시: 같음</li><li>원클릭 생성·기본 OFF: 같음</li><li>키보드 접근·작은 창 대응: 같음 — 기존 동작 유지, 검사 결과는 REPORT 참조</li></ul><p>추가 기능: 고급 옵션의 에이전트·모델·첫 프롬프트는 기존 토큰을 사용합니다. 직접 비교할 승인 시안은 없으며, 새 컨트롤의 소유자 승인을 주장하지 않습니다.</p><ul></ul><div class="pair"><figure><figcaption>App · optional start</figcaption><img src="start-${s}.png"></figure><figure><figcaption>App · model choice</figcaption><img src="model-${s}.png"></figure></div><figure><figcaption>App · failed start, worktree kept</figcaption><img src="retry-${s}.png"></figure><p><a href="window-${s}.png">Full window</a> · <a href="retry-window-${s}.png">Failure window</a></p></section>`).join('')}`);
  });
}
