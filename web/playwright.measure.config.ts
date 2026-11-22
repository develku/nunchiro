// V1A-44 paint figures only (scripts/measure/paint.sh); the default suite (playwright.config.ts, testDir tests) never
// loads web/measure. paint.py builds the bundle and the measure page once, starts the core and the fake agents, and
// runs one project per job with PAINT_JOB naming the job file.
import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import { browsersPath } from './browsers-path';

// Same rule as playwright.config.ts: an exported path wins, else the user cache.
process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath(process.env, os.homedir());
const port = process.env.NUNCHIRO_WEB_PORT ?? '4183';
const pagePort = process.env.PAINT_PAGE_PORT ?? '4184';
// The owner's window is on a Retina display; xterm's DOM rows and the WebGL canvas both cost more at 2x.
const view = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };

export default defineConfig({
  testDir: 'measure',
  timeout: 40 * 60_000,
  workers: 1,
  reporter: [['list']],
  outputDir: '../.scratch/pw-measure-results',
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'off' },
  webServer: [
    { command: `pnpm exec vite preview --port ${port}`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 60_000 },
    { command: `pnpm exec vite preview -c measure/vite.config.ts --port ${pagePort}`, url: `http://127.0.0.1:${pagePort}`, reuseExistingServer: false, timeout: 60_000 },
  ],
  projects: [
    // WebKit is the Tauri window's engine family; headless it still draws at the display rate (58 fps idle, probed).
    { name: 'webkit', use: { ...devices['Desktop Safari'], ...view } },
    // Headless Chromium throttles rAF to about 10 fps, so this row runs headed; occlusion throttling is turned off.
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...view,
        headless: false,
        launchOptions: { args: ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] },
      },
    },
  ],
});
