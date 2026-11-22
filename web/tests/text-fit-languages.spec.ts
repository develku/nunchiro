// Q5 (look 11-17): the main window holds its text in Korean, Japanese and Spanish: no label breaks inside a word and no
// control spills out of its row, at the default window and at 1100x800.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

async function open(app: Page, language: string, viewport: { width: number; height: number }) {
  await app.setViewportSize(viewport);
  await app.addInitScript((l) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: l })), language);
  await app.goto('/');
  await expect(app.locator('.tab[data-tab]')).toHaveCount(1);
}

for (const language of ['ko', 'ja', 'es'])
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1100, height: 800 }])
    test(`tree_head_holds_its_buttons_${language}_${viewport.width}`, async ({ app, core }) => {
      core.shell(core.project('demo'), 'alpha');
      await open(app, language, viewport);
      const head = app.locator('.dock.l > .ph');
      await expect(head.locator('.addproj')).toBeVisible();
      const got = await head.evaluate((ph) => {
        const box = ph.getBoundingClientRect();
        const out: string[] = [];
        if (ph.scrollWidth > ph.clientWidth + 0.5) out.push('head overflows');
        for (const b of ph.querySelectorAll<HTMLElement>('.addproj, .xall')) {
          const r = b.getBoundingClientRect();
          const line = parseFloat(getComputedStyle(b).lineHeight) || parseFloat(getComputedStyle(b).fontSize) * 1.5;
          if (r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) out.push(`${b.textContent} outside the head`);
          if (b.scrollWidth > b.clientWidth + 0.5 || r.height > 2 * line) out.push(`${b.textContent} wraps or is cut`);
        }
        return out;
      });
      expect(got).toEqual([]);
    });

// Q5: Korean Settings lines wrap at spaces ("고릅니/다", "정/합니다" broke inside the word), and no particle placeholder
// follows an inserted word. Every page's text, word by word.
test('settings_korean_wraps_at_spaces', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await open(app, 'ko', { width: 1100, height: 800 });
  await app.keyboard.press('Meta+Comma');
  const region = app.getByRole('region', { name: '설정' });
  await expect(region).toBeVisible();
  const pages = await region.getByRole('navigation').getByRole('button').allTextContents();
  const broken: string[] = [];
  for (const page of pages) {
    await region.getByRole('navigation').getByRole('button', { name: page, exact: true }).click();
    await app.waitForTimeout(150);
    broken.push(
      ...(await region.evaluate((root) => {
        const out: string[] = [];
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const text = n.textContent ?? '';
          if (!n.parentElement?.checkVisibility() || n.parentElement.closest('input, textarea, .xterm, .sr')) continue;
          // Q5: no particle placeholder after an inserted word ("glab이(가)", "nunchiro(으)로").
          // Look 1117 (S3 ko): a node that starts with one follows a key chip or a code word ("F을(를)", "add-search이(가)"),
          // and a lone particle after a space follows one too ("Shift+t 를").
          const particle = text.match(/(?:[^\s]+|^\s*)(이\(가\)|을\(를\)|은\(는\)|와\(과\)|\(으\)로)/) ?? text.match(/^\s+[을를이가로]\s/);
          if (particle) out.push(`particle ${particle[0]}`);
          for (const m of text.matchAll(/[가-힣]{2,}/g)) {
            const r = document.createRange();
            r.setStart(n, m.index);
            r.setEnd(n, m.index + m[0].length);
            const tops = new Set([...r.getClientRects()].map((c) => Math.round(c.top)));
            if (tops.size > 1) out.push(`${m[0]} in ${n.parentElement.className} / ${text.slice(0, 60)} / ${Math.round(n.parentElement.getBoundingClientRect().width)}`);
          }
        }
        return out;
      })).map((w) => `${page}: ${w}`),
    );
  }
  expect(broken).toEqual([]);
  // Q5: Notes' empty line sits inside its card's padding, as Team's does (it touched the card's edge).
  await region.getByRole('navigation').getByRole('button', { name: '노트', exact: true }).click();
  const none = region.locator('.notes-none');
  await expect(none).toBeVisible();
  expect(await none.evaluate((e) => parseFloat(getComputedStyle(e).paddingLeft))).toBeGreaterThan(0);
});

// Q5: a Providers tile keeps the agent's name whole beside a long status (ja "Antigravi…" beside "インストール済み"). The look's
// tile is drawn into the first tile, since this core finds no Antigravity.
test('provider_tile_keeps_the_name_ja', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await open(app, 'ja', { width: 1440, height: 900 });
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('region', { name: '設定' }).getByRole('navigation').getByRole('button', { name: 'プロバイダー', exact: true }).click();
  const tile = app.locator('#s-accounts .prv-slot > .prv-tile.go').filter({ has: app.locator('.prv-st') }).first();
  await expect(tile).toBeVisible();
  const got = await tile.evaluate((t) => {
    t.querySelector('.prv-tname')!.textContent = 'Antigravity AI'; // this font draws narrower than the app's: a longer name makes the look's squeeze
    t.querySelector('.prv-st')!.textContent = 'インストール済み';
    const name = t.querySelector<HTMLElement>('.prv-tname')!;
    const st = t.querySelector<HTMLElement>('.prv-st')!.getBoundingClientRect();
    const box = t.getBoundingClientRect();
    return { cut: name.scrollWidth > name.clientWidth + 0.5, inside: st.top >= box.top && st.bottom <= box.bottom };
  });
  expect(got).toEqual({ cut: false, inside: true });
});

// c-es-term (look 1117): a wide control (the scrollback segments and field) squeezed the Spanish description into a narrow
// column. A row's text keeps at least 320 px; a control that would leave less moves below it.
test('settings_row_text_keeps_its_width_es', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await open(app, 'es', { width: 1100, height: 800 });
  await app.keyboard.press('Meta+Comma');
  await app.locator('.settings > nav button[data-page="terminal"]').click();
  const rows = app.locator('.settings .srow:has(> .sctl)');
  await expect(rows.first()).toBeVisible();
  const narrow = await rows.evaluateAll((rs) => rs.filter((r) => (r as HTMLElement).offsetParent).map((r) => [r.querySelector('.slab')!.getBoundingClientRect().width, r.textContent!.slice(0, 30)] as const).filter(([w]) => w < 319));
  expect(narrow).toEqual([]);
});
