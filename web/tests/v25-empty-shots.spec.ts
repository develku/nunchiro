// v25-empty side-by-side shots (not part of the gate): the empty state and an answer with headings at 1440x900,
// light and dark, beside the approved mockup's own crops. Run with V25_SHOTS=1, chromium only.
// Writes the PNGs and compare.html under .scratch/v25-empty/.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { REPO } from './fixtures';
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';

test.skip(({ browserName }) => !process.env.V25_SHOTS || browserName !== 'chromium', 'run with V25_SHOTS=1, chromium only');
test.describe.configure({ mode: 'serial' });

const OUT = path.join(REPO, '.scratch/v25-empty');
const MOCK = path.join(REPO, '.scratch/review-1028/v25-mock-a/index.html');
const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

test.beforeAll(() => {
  test.skip(!fs.existsSync(MOCK), `mockup missing: ${MOCK}`);
  fs.mkdirSync(OUT, { recursive: true });
});

const theme = async (app: Page, scheme: Scheme) => {
  await app.emulateMedia({ colorScheme: scheme });
  await expect(app.locator('html')).toHaveAttribute('data-theme', scheme);
};

test('the empty state, light and dark, and the mockup draft A', async ({ page, chatCore }) => {
  const s = chatCore.chat('nunchiro', false);
  await openChat(page, s.id);
  await page.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: 'ko' })));
  await page.reload();
  const block = chat(page, s.id).locator('.cscroll .empty');
  await expect(block.getByRole('heading')).toHaveText('nunchiro에서 무엇을 만들까요?');
  for (const scheme of SCHEMES) {
    await theme(page, scheme);
    await page.screenshot({ path: path.join(OUT, `empty-${scheme}.png`) });
    await block.screenshot({ path: path.join(OUT, `empty-block-${scheme}.png`) });
  }
  // The mockup's own draft A panel, at the same width as the app shot's centre column.
  const golden = await page.context().newPage();
  await golden.setViewportSize({ width: 1440, height: 900 });
  await golden.goto(`file://${MOCK}`);
  for (const scheme of SCHEMES) {
    await golden.evaluate((v) => (document.documentElement.dataset.theme = v), scheme);
    await golden.locator('.panel').filter({ hasText: '초안 A' }).first().screenshot({ path: path.join(OUT, `mock-draftA-${scheme}.png`) });
  }
  await golden.close();
});

test('an answer with headings, light and dark, and the mockup type panel', async ({ page, chatCore }) => {
  const s = chatCore.chat('type', true);
  append(
    s.file,
    rec.user('타입 위계를 보여줘'),
    rec.assistant(
      [
        '## 바뀐 트리 모습입니다',
        '',
        '행 높이를 30px로 맞췄습니다. 이제 트리 행은 30px, 프로젝트 헤드는 25px입니다.',
        '',
        '### 무엇이 달라졌나',
        '',
        '제목이 크기로 구분되어 긴 답에서도 위치를 잡을 수 있습니다.',
        '',
        '# 가장 큰 제목',
        '',
        '본문은 그대로 14.5px입니다.',
      ].join('\n'),
    ),
  );
  await page.addInitScript(() => localStorage.setItem('nunchiro.chatView.v2', 'verbose'));
  await openChat(page, s.id);
  const md = chat(page, s.id).locator('.md').first();
  await expect(md.locator('h2')).toHaveText('바뀐 트리 모습입니다');
  for (const scheme of SCHEMES) {
    await theme(page, scheme);
    await page.screenshot({ path: path.join(OUT, `answer-${scheme}.png`) });
    await md.screenshot({ path: path.join(OUT, `answer-md-${scheme}.png`) });
  }
  const golden = await page.context().newPage();
  await golden.setViewportSize({ width: 1440, height: 900 });
  await golden.goto(`file://${MOCK}`);
  for (const scheme of SCHEMES) {
    await golden.evaluate((v) => (document.documentElement.dataset.theme = v), scheme);
    await golden.locator('.panel').filter({ hasText: '한 단계 위로' }).screenshot({ path: path.join(OUT, `mock-typeA-${scheme}.png`) });
  }
  await golden.close();
});

test('write compare.html: each app shot beside its mockup crop, with the score line', async () => {
  const rows: [string, string, string, string][] = [
    ['empty', 'empty-block', 'mock-draftA', '같음'],
    ['answer', 'answer', 'mock-typeA', '같음'],
  ];
  const cell = (f: string) => (fs.existsSync(path.join(OUT, `${f}.png`)) ? `<img src="${f}.png">` : '<i>missing</i>');
  const body = rows
    .map(
      ([name, app, mock]) => `<h2>${name}</h2><div class="pair">
      <figure><figcaption>app</figcaption>${cell(`${app}-light`)}${cell(`${app}-dark`)}</figure>
      <figure><figcaption>mockup</figcaption>${cell(`${mock}-light`)}${cell(`${mock}-dark`)}</figure></div>`,
    )
    .join('\n');
  fs.writeFileSync(
    path.join(OUT, 'compare.html'),
    `<!doctype html><meta charset="utf-8"><title>v25-empty · mockup vs app</title>
<style>body{font:13px -apple-system,sans-serif;margin:20px;background:#fff;color:#111}
.pair{display:flex;gap:16px;align-items:flex-start}figure{margin:0;flex:1}
figure img{width:100%;border:1px solid #888;display:block;margin-bottom:8px}figcaption{font-weight:600;margin-bottom:6px}
h2{font-size:15px;margin:22px 0 8px}</style>
<h1>v25-empty · 1440x900 · light then dark</h1>${body}`,
  );
});
