import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import { browsersPath } from './browsers-path';

// Browsers live in the user cache; from the external SSD headless Chromium renders no frames (web/README.md).
process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath(process.env, os.homedir());
// Another checkout's preview may hold 4173: NUNCHIRO_WEB_PORT moves this run (tests read it through fixtures.ts).
const port = process.env.NUNCHIRO_WEB_PORT ?? '4173';
// Ticket 262: the test build's known sha (about-page.spec.ts `about_page_shows_build_sha`); an outer value is kept.
process.env.NUNCHIRO_BUILD_SHA ??= '5ca1ab1e0d15ea5e';
// A run started with these set points every fixture's `git init` and commit at the caller's repository (11-10: a lane's
// run wrote 44 commits and a core.worktree line into the shared clone). The specs make their own repositories.
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']) delete process.env[k];

export default defineConfig({
  testDir: 'tests',
  globalSetup: './tests/global-setup.ts',
  timeout: 45_000,
  workers: 4,
  reporter: [['list']],
  outputDir: '../.scratch/pw-results',
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'off' },
  webServer: {
    command: `VITE_FEATURE_FIXTURES=1 pnpm exec vite build --logLevel error && pnpm exec vite preview --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } } },
  ],
});
