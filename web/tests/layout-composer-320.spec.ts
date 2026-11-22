// ticket 192 (needs 171): at a 320 px window the composer's controls stay inside the `.cbox`. The left chip cluster
// wraps or the project chip truncates with an ellipsis; the context ring and Send never leave the box.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { REPO } from './fixtures';
import { icon } from './d5b';
import { append, expect, openChat, rec, test, type ChatCore } from './fixtures/chat/harness';

const LONG = 'a-rather-long-project-name-for-the-chip';

async function open(page: Page, core: ChatCore, width: number) {
  const s = core.chat(LONG);
  append(s.file, rec.user('hi'), rec.assistant('ok'));
  await openChat(page, s.id); // opened at the default size (the tab strip is reachable), then the window narrows
  // The tree sidebar keeps its own width (a window this narrow leaves the centre 22 to 68 px, sidebar widths are not this
  // ticket); the user at 320 px has it collapsed, so the composer gets the whole window.
  await icon(page, 'left', 'Tree').click();
  await expect(page.locator('aside.sbar[data-side="left"]')).toHaveCount(0);
  await page.setViewportSize({ width, height: 800 });
  await expect(page.locator('.cbox .chips .send')).toBeVisible();
}

/** Every visible control inside the `.cbox`: a bounding box outside the `.cbox` box, as `name: box`, or none. */
const escapes = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector('.cbox')!.getBoundingClientRect();
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('.cbox button, .cbox .chip, .cbox .context-ring, .cbox textarea, .cbox [role="button"]'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5)
        out.push(`${el.className || el.tagName} ${JSON.stringify({ l: r.left, r: r.right, t: r.top, b: r.bottom })} vs cbox ${JSON.stringify({ l: box.left, r: box.right, t: box.top, b: box.bottom })}`);
    }
    return out;
  });

for (const width of [320, 480, 1440]) {
  test(`composer_chips_fit_at_${width === 320 ? '320' : width}: every .cbox control lies within the .cbox box at ${width} px`, async ({ page, chatCore }, info) => {
    await open(page, chatCore, width);
    expect(await escapes(page)).toEqual([]);
    await page.screenshot({ path: path.join(REPO, `.scratch/shots/composer-${width}-${process.env.SHOT_TAG ?? 'after'}-${info.project.name}.png`), fullPage: false });
  });
}
