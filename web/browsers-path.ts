import path from 'node:path';

/** Where Playwright finds its browsers: an exported PLAYWRIGHT_BROWSERS_PATH, else the user cache (macOS). */
export const browsersPath = (env: Record<string, string | undefined>, home: string) =>
  env.PLAYWRIGHT_BROWSERS_PATH || path.join(home, 'Library/Caches/ms-playwright');
