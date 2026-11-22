// Ticket 525: the themes sweep's contrast scan (contrast-scan.ts) on two cases it misread: an oklch() text colour and a
// translucent parent. Each page holds one line of text; the scan reports it when it is below AA.
import { expect, test } from '@playwright/test';
import { lowContrast } from './contrast-scan';

const scan = async (page: import('@playwright/test').Page, body: string) => {
  await page.setContent(`<body style="margin:0;background:#fff">${body}</body>`);
  return page.evaluate(lowContrast);
};

test('an oklch() white is read as white, not as near black', async ({ page }) => {
  // oklch(1 0 0) on #747474 is 4.67:1 (passes); read as rgb(1, 0, 0) it was a false 4.49:1 failure.
  expect(await scan(page, '<p style="background:#747474;color:oklch(1 0 0);font-size:14px">badge</p>')).toEqual([]);
  const low = await scan(page, '<p style="background:#888;color:oklch(1 0 0);font-size:14px">badge</p>');
  expect(low).toHaveLength(1);
  expect(low[0]).toContain('rgb(255, 255, 255) on rgb(136, 136, 136)');
});

test('a 0.5-opacity parent fades the text into what is behind it', async ({ page }) => {
  // Black on white is 21:1; at opacity 0.5 over white the text is rgb(128, 128, 128): 3.94:1, below AA.
  const low = await scan(page, '<div style="opacity:0.5"><p style="color:#000;font-size:14px">answered</p></div>');
  expect(low).toHaveLength(1);
  expect(low[0]).toMatch(/^3\.9\d\trgb\(128, 128, 128\) on rgb\(255, 255, 255\)/);
  // An opacity-0 ancestor (a row's hover-only buttons) draws nothing, so its text is not measured.
  expect(await scan(page, '<div style="opacity:0"><p style="color:#fff;font-size:14px">Copy</p></div>')).toEqual([]);
});
