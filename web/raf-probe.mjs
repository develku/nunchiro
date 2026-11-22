// Host check (v1a-31): headless Chromium from the default browsers path renders frames and takes a click.
// Run from web/: `node raf-probe.mjs`. Exit 1 when it renders 0 frames in 1 s or the click times out.
import os from 'node:os';
import path from 'node:path';
// Same default as browsers-path.ts (a .mjs cannot import the .ts); keep the two in step.
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(os.homedir(), 'Library/Caches/ms-playwright');
const { chromium } = await import('@playwright/test');

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<button onclick="window.clicked=1">go</button>');
  const frames = await page.evaluate(() => new Promise((done) => {
    let n = 0;
    const tick = () => (n++, requestAnimationFrame(tick));
    requestAnimationFrame(tick);
    setTimeout(() => done(n), 1000);
  }));
  await page.click('button', { timeout: 5000 });
  const clicked = await page.evaluate(() => window.clicked === 1);
  console.log(`browsers ${process.env.PLAYWRIGHT_BROWSERS_PATH}: ${frames} frames, click ${clicked ? 'ok' : 'missed'}`);
  process.exitCode = frames > 0 && clicked ? 0 : 1;
} catch (e) {
  console.log(`probe failed: ${e.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
