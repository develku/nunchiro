// Shared setup for the Files specs: a project folder with these fixtures, a `cat` shell session in it, the HTML
// sandbox stand-in (V1B-04's test server behind a same-origin route) and the window open on the Files sidebar.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, ORIGIN, type Core } from '../../fixtures';
import { artifactServer } from '../../sandbox-server';

export const FIX = import.meta.dirname;
export const KINDS = ['hello.ts', 'README.md', 'dot.png', 'logo.svg', 'page.html', 'blob.bin', 'latin1.txt'];

export type Key = { code: string; key: string; ctrlKey?: boolean; keyCode?: number };
export const physical = (page: Page, init: Key) =>
  page.evaluate((i) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...i })), init);

/** A project folder with the fixtures, a shell session in it, and the window open on the Files sidebar. */
// S2-1: `artifactOrigin` serves the sandbox from another origin, as the app's scheme is, so the window's own CSP applies.
export async function setup(page: Page, core: Core, opts: { name?: string; extra?: (dir: string) => void; artifactOrigin?: string } = {}) {
  const dir = core.project(opts.name ?? 'files');
  for (const f of KINDS) fs.copyFileSync(path.join(FIX, f), path.join(dir, f));
  opts.extra?.(dir);
  const s = core.shell(dir, opts.name ?? 'files');
  const art = await artifactServer({});
  let n = 0;
  await page.exposeFunction('__artifactOpen', (_root: string, _path: string, text: string) => art.setText(`f${n++}`, text));
  await page.exposeFunction('__reveal', (p: string) => revealed.push(p));
  const revealed: string[] = [];
  const origin = opts.artifactOrigin ?? '';
  await page.addInitScript((origin) => {
    const w = window as unknown as Record<string, (...a: unknown[]) => unknown>;
    (window as { __NUNCHIRO_FILES__?: unknown }).__NUNCHIRO_FILES__ = {
      src: (id: string) => `${origin}/__artifact/${id}`,
      artifact: (root: string, p: string, text: string) => w.__artifactOpen(root, p, text),
      reveal: (p: string) => w.__reveal(p),
    };
  }, origin);
  await page.route(`${origin || ORIGIN}/__artifact/**`, async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop();
    await route.fulfill({ response: await route.fetch({ url: `${art.origin}/${id}` }) });
  });
  await openWindow(page, {}, core);
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(tree(page)).toBeVisible();
  await expect(row(page, 'hello.ts')).toBeVisible();
  return { dir, s, art, revealed };
}

export const tree = (page: Page) => page.getByRole('tree');
export const row = (page: Page, p: string) => page.locator(`.frow[data-path="${p}"]`);
export const view = (page: Page, p: string) => page.locator(`.fview[data-file="${p}"]`);
export async function openFile(page: Page, p: string) {
  await row(page, p).click();
  await expect(view(page, p)).toBeVisible();
  await expect(view(page, p)).not.toHaveAttribute('data-view', 'loading');
}
export const openAt = (page: Page, root: string, p: string, line?: number) =>
  page.evaluate(([r, f, l]) => window.dispatchEvent(new CustomEvent('nunchiro:files.open', { detail: { root: r, path: f, line: l } })), [root, p, line] as const);

