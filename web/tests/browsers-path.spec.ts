// v1a-31: Playwright browsers default to the user cache (the external SSD path stalls rendering, see web/README.md).
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { browsersPath } from '../browsers-path';

test('browsers path: the user cache by default, an exported PLAYWRIGHT_BROWSERS_PATH wins', () => {
  expect(browsersPath({}, '/home/me')).toBe('/home/me/Library/Caches/ms-playwright');
  expect(browsersPath({ PLAYWRIGHT_BROWSERS_PATH: '/x/pw' }, '/home/me')).toBe('/x/pw');
  expect(browsersPath({ PLAYWRIGHT_BROWSERS_PATH: '' }, '/home/me')).toBe('/home/me/Library/Caches/ms-playwright');
  expect(browsersPath({}, os.homedir())).toBe(path.join(os.homedir(), 'Library/Caches/ms-playwright'));
});
