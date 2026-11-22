// What the window really paints for a theme's colours (themes/apply.ts): the two bundled Nunchiro themes paint tokens.css
// itself, so a spec that puts a theme's tokens on <html> by hand reads their role values from the file; any other theme
// goes through deriveTokens. Ticket 293: deriveTokens no longer stands in for tokens.css.
import fs from 'node:fs';
import { deriveTokens } from '../src/themes/derive';
import type { ThemeColors } from '../src/themes/ghostty';
import { DARK_PICK, LIGHT_PICK } from '../src/themes/nunchiro';

// Comments out: a comment that names a token (`… --glass-hi …;`) hid the declaration after it from the pattern below
// (ticket 1041 lane 6: --glass-bg read as unset in Nunchiro Light).
const css = fs.readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
export const cssBlock = (head: string) => {
  const start = css.indexOf(head);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])) as Record<string, string>;
};
export const LIGHT_CSS = ":root,\n:root[data-theme='light']";
export const DARK_CSS = ":root[data-theme='dark']";
const same = (a: ThemeColors, b: ThemeColors) => JSON.stringify(a) === JSON.stringify(b);

export function windowTokens(c: ThemeColors): Record<string, string> {
  if (same(c, LIGHT_PICK.colors)) return cssBlock(LIGHT_CSS);
  if (same(c, DARK_PICK.colors)) return cssBlock(DARK_CSS);
  return deriveTokens(c);
}
