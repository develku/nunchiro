// Q5 scorecard (look v20, looker d): at the smallest windows the app allows (900x700, 987x703) no text is cut or split inside
// a word in ko, ja and es: composer chips keep whole labels (the row wraps), Providers rows wrap, CJK labels are not split.
import { append, expect, rec, test } from './fixtures/chat/harness';
import fs from 'node:fs';
import path from 'node:path';
import { expect as fx, test as appTest } from './fixtures';

const SIZES = [{ width: 900, height: 700 }, { width: 987, height: 703 }];

/** Every text element in `root` whose own box cuts its content: overflow hidden with scrollWidth past clientWidth, or an ellipsis drawn. */
const CUT = `(root) => {
  const out = [];
  for (const el of root.querySelectorAll('*')) {
    if (!el.checkVisibility() || el.closest('svg, .sr')) continue;
    const cs = getComputedStyle(el);
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    if (el.scrollWidth > el.clientWidth + 0.5 && cs.overflowX !== 'visible') out.push('cut: ' + el.className + ' / ' + el.textContent.trim().slice(0, 40));
    if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 0.5) out.push('ellipsis: ' + el.className + ' / ' + el.textContent.trim().slice(0, 40));
  }
  return out;
}`;

for (const language of ['ko', 'ja', 'es'])
  for (const size of SIZES)
    test(`composer_chips_whole_${language}_${size.width}`, async ({ page, chatCore }) => {
      // The widest words a chip carries: the model and effort of a Claude session, and the mode "auto" ("자동" was cut to "자").
      await page.routeWebSocket(/\/ws$/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((m) => server.send(m));
        server.onMessage((m) => {
          const frame = typeof m === 'string' ? JSON.parse(m) : null;
          if (frame?.event !== 'snapshot') return ws.send(m);
          for (const x of frame.sessions) Object.assign(x, { model: 'opus', effort: 'xhigh', permission_mode: 'auto', attention: { ...x.attention, working: false } });
          ws.send(JSON.stringify(frame));
        });
      });
      await page.addInitScript((l) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: l })), language);
      await page.setViewportSize(size);
      const s = chatCore.chat('demo');
      append(s.file, rec.user('hi'), rec.assistant('ok'));
      await page.goto('/'); // openChat waits for the English "Connected" line
      await page.locator(`.tab[data-tab="${s.id}"]`).click();
      await expect(page.locator('.cbox .chips .send')).toBeVisible();
      const row = page.locator('.cbox .chips');
      const cut = await row.evaluate(eval(CUT) as never);
      expect(cut).toEqual([]);
    });

/** Words of `root` that one line box holds, but that the browser splits over two lines: `{text}` per CJK/Latin run. */
const SPLIT = `(root) => {
  const out = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const el = n.parentElement;
    if (!el || !el.checkVisibility() || el.closest('input, textarea, .xterm, .sr, code')) continue;
    // A label, not a sentence: running text may wrap between any two characters in ja and ko.
    if ((n.textContent ?? '').trim().length > 16) continue;
    for (const m of (n.textContent ?? '').matchAll(/[\\p{Script=Hangul}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Han}ー]{2,}|[\\p{L}]{4,}/gu)) {
      const r = document.createRange();
      r.setStart(n, m.index);
      r.setEnd(n, m.index + m[0].length);
      if (new Set([...r.getClientRects()].map((c) => Math.round(c.top))).size > 1) out.push(m[0] + ' / ' + el.className);
    }
  }
  return out;
}`;

for (const language of ['ko', 'ja', 'es'])
  for (const size of SIZES)
    appTest(`providers_rows_whole_${language}_${size.width}`, async ({ app, core }) => {
      core.shell(core.project('demo'), 'alpha');
      await app.setViewportSize(size);
      await app.addInitScript((l) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: l })), language);
      await app.goto('/');
      await fx(app.locator('.tab[data-tab]')).toHaveCount(1);
      await app.keyboard.press('Meta+Comma');
      await app.locator('.settings > nav button[data-page="providers"]').click();
      await fx(app.locator('#s-accounts .prv-hd').first()).toBeVisible();
      // The look's Antigravity tile (this core finds none): its long status is drawn into the first tile, as text-fit-languages does.
      const status = { ko: '설치됨', ja: 'インストール済み', es: 'Instalado' }[language]!;
      await app.evaluate((t) => {
        const tile = document.querySelector('#s-accounts .prv-slot > .prv-tile.go');
        if (!tile?.querySelector('.prv-st')) throw new Error('no tile with a status');
        tile.querySelector('.prv-tname')!.textContent = 'Antigravity';
        tile.querySelector('.prv-st')!.textContent = t;
        (tile.parentElement as HTMLElement).style.width = '215px'; // the look's font drew wider than this one: the tile at its narrowest
      }, status);
      const root = app.locator('#s-accounts');
      const cut = await root.evaluate(eval(CUT) as never);
      const split = await root.evaluate(eval(SPLIT) as never);
      fx(cut).toEqual([]);
      fx(split).toEqual([]);
    });

// Look v22 d (Q5 round 2): Settings > Onboarding keeps an agent's name and version whole (the Login button goes to a second
// line, it never covers them) and Settings > Usage never squeezes the token composition card (the cards wrap).
const BIG = [{ width: 1000, height: 700 }, { width: 1440, height: 900 }];

for (const language of ['ko', 'ja', 'es'])
  for (const size of BIG)
    appTest(`onboarding_agent_names_whole_${language}_${size.width}`, async ({ app, core }) => {
      core.shell(core.project('demo'), 'alpha');
      await app.setViewportSize(size);
      await app.addInitScript((l) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: l })), language);
      await app.goto('/');
      await fx(app.locator('.tab[data-tab]')).toHaveCount(1);
      await app.keyboard.press('Meta+Comma');
      await app.locator('.settings > nav button[data-page="onboarding"]').click();
      await app.locator('.ob-step[data-step="providers"]').click();
      const rows = app.locator('.ob-panel .ob-cards .prv-hd');
      await fx(rows.first()).toBeVisible();
      const bad = await rows.evaluateAll((els) =>
        els.flatMap((row) => {
          const name = row.querySelector('.prv-name')!;
          const ver = row.querySelector('.prv-sub');
          const out: string[] = [];
          if (name.scrollWidth > name.clientWidth + 0.5) out.push('name cut: ' + name.textContent);
          if (ver && ver.scrollWidth > ver.clientWidth + 0.5) out.push('version cut: ' + name.textContent);
          const nm = row.querySelector('.prv-nm')!.getBoundingClientRect();
          for (const b of row.querySelectorAll('.prv-meta button')) {
            const r = b.getBoundingClientRect();
            if (r.left < nm.right - 0.5 && nm.left < r.right - 0.5 && r.top < nm.bottom - 0.5 && nm.top < r.bottom - 0.5) out.push('button over name: ' + name.textContent);
          }
          return out;
        }),
      );
      if (process.env.SHOTS_TAG) await app.screenshot({ path: `../.scratch/shots/${process.env.SHOTS_TAG}-onb-${language}-${size.width}.png` });
      fx(bad).toEqual([]);
    });

for (const language of ['ko', 'ja', 'es'])
  for (const size of BIG)
    appTest(`usage_cards_have_a_floor_${language}_${size.width}`, async ({ app, core }) => {
      const demo = core.project('demo');
      core.shell(demo, 'alpha');
      const dir = path.join(core.home, 'claude-home/projects/p');
      fs.mkdirSync(dir, { recursive: true });
      const at = new Date(Date.now() - 3_600_000).toISOString();
      fs.writeFileSync(path.join(dir, 's1.jsonl'), JSON.stringify({ type: 'assistant', timestamp: at, cwd: demo, sessionId: 's1', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 8000 } } }) + '\n');
      await app.setViewportSize(size);
      await app.addInitScript((l) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: l })), language);
      await app.goto('/');
      await fx(app.locator('.tab[data-tab]')).toHaveCount(1);
      await app.keyboard.press('Meta+Comma');
      await app.locator('.settings > nav button[data-page="usage"]').click();
      const cards = app.locator('#s-usage .u4-r3 > .u4-card');
      await fx(cards).toHaveCount(3);
      const widths = await cards.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
      if (process.env.SHOTS_TAG) await app.screenshot({ path: `../.scratch/shots/${process.env.SHOTS_TAG}-usage-${language}-${size.width}.png` });
      fx(Math.min(...widths)).toBeGreaterThanOrEqual(200);
    });

// Look v22 d: the Tree head names itself in every language (ja "プロジェクト" was drawn at zero width).
for (const language of ['ko', 'ja', 'es', 'zh', 'fr', 'pt'])
  appTest(`tree_head_title_shown_${language}`, async ({ app, core }) => {
    core.shell(core.project('demo'), 'alpha');
    await app.addInitScript((l) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: l })), language);
    await app.goto('/');
    await fx(app.locator('.tab[data-tab]')).toHaveCount(1);
    const title = app.locator('.dock.l > .ph .pht > span');
    await fx(title).toBeVisible();
    // It sits inside its box (the old rule left it on a hidden second line of a one-line box) and beside the grip, not cut.
    const got = await title.evaluate((e) => {
      const r = e.getBoundingClientRect();
      const box = e.parentElement!.getBoundingClientRect();
      return r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 && r.right <= box.right + 0.5 && r.width > 20;
    });
    fx(got).toBe(true);
    if (process.env.SHOTS_TAG) await app.screenshot({ path: `../.scratch/shots/${process.env.SHOTS_TAG}-tree-${language}.png`, clip: { x: 0, y: 0, width: 320, height: 140 } });
  });

// Look v22 d (es): the new-session card's sentence hints (Leader, Reopen closed tab) take the card's width under their name.
for (const language of ['ko', 'ja', 'es'])
  appTest(`newsession_hints_take_the_card_width_${language}`, async ({ app, core }) => {
    core.shell(core.project('demo'), 'alpha');
    await app.addInitScript((l) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: l })), language);
    await app.goto('/');
    await fx(app.locator('.tab[data-tab]')).toHaveCount(1);
    await app.keyboard.press('Meta+T');
    const rows = app.locator('.newtab .nt-row[data-wrap]');
    await fx(rows.first()).toBeVisible();
    const bad = await rows.evaluateAll((els) =>
      els.flatMap((row) => {
        const name = row.querySelector('.nt-name')!.getBoundingClientRect();
        const d = row.querySelector('.nt-detail')?.getBoundingClientRect();
        if (!d) return [];
        const out: string[] = [];
        if (d.top < name.bottom - 0.5) out.push('hint beside the name: ' + row.textContent);
        if (d.width < row.getBoundingClientRect().width * 0.6) out.push('hint narrow: ' + Math.round(d.width) + ' ' + row.textContent);
        return out;
      }),
    );
    if (process.env.SHOTS_TAG) await app.screenshot({ path: `../.scratch/shots/${process.env.SHOTS_TAG}-newsession-${language}.png`, clip: { x: 300, y: 0, width: 500, height: 480 } });
    fx(bad).toEqual([]);
  });

// Look v22 d: the "Recommended" chip reads. Look v35 c S3-4 moved it beside the Mode row's name: the tag shows whole, not cut.
for (const language of ['ko', 'ja', 'es'])
  appTest(`assistants_recommended_chip_readable_${language}`, async ({ app, core }) => {
    core.shell(core.project('demo'), 'alpha');
    await app.addInitScript((l) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: l })), language);
    await app.goto('/');
    await fx(app.locator('.tab[data-tab]')).toHaveCount(1);
    await app.keyboard.press('Meta+Comma');
    await app.locator('.settings > nav button[data-page="assistants"]').click();
    const chip = app.locator('.srow .snm .chip[data-recommended]');
    await fx(chip).toBeVisible();
    const whole = await chip.evaluate((c) => c.scrollWidth <= c.clientWidth + 1);
    if (process.env.SHOTS_TAG) await chip.screenshot({ path: `../.scratch/shots/${process.env.SHOTS_TAG}-rec-${language}.png` });
    fx(whole).toBe(true);
  });
