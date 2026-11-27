// What the window really paints for a theme's colours (themes/apply.ts): the two bundled Nunchiro themes paint tokens.css
// itself, so a spec that puts a theme's tokens on <html> by hand reads their role values from the file; any other theme
// goes through deriveTokens. Ticket 293: deriveTokens no longer stands in for tokens.css. book-tokens.css wins over tokens.css,
// as the window loads it second.
import fs from 'node:fs';
import { deriveTokens } from '../src/themes/derive';
import type { ThemeColors } from '../src/themes/ghostty';
import { DARK_PICK, LIGHT_PICK } from '../src/themes/nunchiro';

// Comments out: a comment that names a token (`… --glass-hi …;`) hid the declaration after it from the pattern below
// (ticket 1041 lane 6: --glass-bg read as unset in Nunchiro Light).
const read = (f: string) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const css = read('tokens.css');
const book = read('book-tokens.css');
const blockOf = (css: string, head: string) => {
  const start = css.indexOf(head);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])) as Record<string, string>;
};
export const cssBlock = (head: string) => blockOf(css, head);
// The design book's tokens (book-tokens.css, loaded after tokens.css): its scheme block, then block 4's old names.
const BOOK_OLD = ":root,\n:root[data-theme='light'],\n:root[data-theme='dark'],";
const bookTokens = (head: string, dark: boolean) => ({
  ...blockOf(book, head),
  ...blockOf(book, BOOK_OLD),
  '--run': dark ? 'var(--tide-300)' : 'var(--tide-650)',
});
export const LIGHT_CSS = ":root,\n:root[data-theme='light']";
export const DARK_CSS = ":root[data-theme='dark']";
const same = (a: ThemeColors, b: ThemeColors) => JSON.stringify(a) === JSON.stringify(b);

export function windowTokens(c: ThemeColors): Record<string, string> {
  if (same(c, LIGHT_PICK.colors)) return { ...cssBlock(LIGHT_CSS), ...bookTokens(LIGHT_CSS, false) };
  if (same(c, DARK_PICK.colors)) return { ...cssBlock(DARK_CSS), ...bookTokens(DARK_CSS, true) };
  return deriveTokens(c);
}
