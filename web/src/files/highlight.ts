// shiki tokens for the read-only viewer and the Diff pane, loaded on demand: this module, the engine and each grammar
// are separate chunks fetched only when a file of that language first opens.
//
// Ticket 482 (owner 2026-11-12): syntax colours follow the window's theme. One shiki CSS-variables theme
// (createCssVariablesTheme) colours each span `var(--syn-<role>)`; tokens.css defines the roles for the two Nunchiro
// themes and themes/derive.ts maps a catalog or imported theme's ANSI palette onto them, the way bat's `ansi` theme
// and delta colour code from the terminal palette.
//
// Adapted from MonoCode `src/features/files/editor/codeHighlightEngine.ts` (commit 26465c6, MIT, Copyright (c)
// 2026 Nick): one highlighter (here one CSS-variables theme) with the forgiving JavaScript regex engine (no WASM),
// grammars loaded into it as files of that language open. Its streaming checkpoint, LRU and worker are not lifted.
//
// MIT License. Copyright (c) 2026 Nick. Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the "Software"), to deal in the Software without
// restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do
// so, subject to the following conditions: The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
// WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
// LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { bundledLanguages, bundledLanguagesAlias } from 'shiki/langs';

/** shiki's CSS-variables roles -> the window's syntax tokens (keep the set small; foreground and parameters stay --text). */
const ROLE: Record<string, string> = {
  'token-keyword': 'keyword',
  'token-string': 'string',
  'token-string-expression': 'string',
  'token-function': 'func',
  'token-link': 'func',
  'token-constant': 'const',
  'token-comment': 'comment',
  'token-punctuation': 'punct',
};
const SYNTAX = ['keyword', 'string', 'func', 'const', 'type', 'comment', 'punct'] as const;
const PREFIX = '--syn-';
const BASE = createCssVariablesTheme({ name: 'nunchiro-syntax', variablePrefix: PREFIX, fontStyle: false });
const role = (fg?: string) => {
  const m = /^var\(--syn-([\w-]+)\)$/.exec(fg ?? '');
  return m && ROLE[m[1]] ? `var(${PREFIX}${ROLE[m[1]]})` : fg; // the rest stay --text (no span)
};
const THEME = {
  ...BASE,
  tokenColors: [
    ...(BASE.tokenColors ?? []).map((r) => ({ ...r, settings: { ...r.settings, foreground: role(r.settings.foreground) } })),
    // Two roles the CSS-variables theme folds into others: types (GitHub's orange) and markup tags and their brackets.
    { scope: ['entity.name.type', 'entity.other.inherited-class', 'support.type', 'support.class', 'storage.type.primitive'], settings: { foreground: `var(${PREFIX}type)` } },
    { scope: ['entity.name.tag'], settings: { foreground: `var(${PREFIX}keyword)` } },
    { scope: ['punctuation.definition.tag'], settings: { foreground: `var(${PREFIX}punct)` } },
    // Review r1: code the CSS-variables theme leaves plain or splits. A number with its unit (CSS `22px`) is one constant;
    // Markdown headings and bold markers, Rust namespaces and CSS custom properties (GitHub's `variable` orange) get colour.
    { scope: ['keyword.other.unit', 'constant.numeric'], settings: { foreground: `var(${PREFIX}const)` } },
    { scope: ['markup.heading', 'punctuation.definition.heading.markdown', 'punctuation.definition.bold.markdown'], settings: { foreground: `var(${PREFIX}keyword)` } },
    { scope: ['entity.name.namespace', 'variable.css', 'variable.argument.css', 'support.type.custom-property'], settings: { foreground: `var(${PREFIX}type)` } },
  ],
};
const TOKEN = new Set(SYNTAX.map((k) => `var(${PREFIX}${k})`));
/** Tokenising runs on the UI thread; past this a file shows as plain text so the window stays responsive. */
export const MAX_HIGHLIGHT = 256 * 1024;

export interface Span {
  from: number;
  to: number;
  /** `var(--syn-<role>)`; the theme decides the colour. */
  color: string;
}

const BY_NAME: Record<string, string> = { dockerfile: 'docker', makefile: 'make', 'cmakelists.txt': 'cmake' };

/** Grammar id for a file name, or null when shiki has none (plain text). */
export function languageOf(name: string): string | null {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  const ext = lower.includes('.') ? lower.split('.').pop()! : '';
  if (ext in bundledLanguages) return ext;
  const alias = (bundledLanguagesAlias as Record<string, unknown>)[ext];
  return alias ? ext : null;
}

let highlighter: Promise<HighlighterCore> | null = null;
const get = () =>
  (highlighter ??= createHighlighterCore({
    themes: [THEME],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }));

/** Coloured spans with offsets into `text`, or [] when the language is unknown or the file is too big. */
export async function highlight(text: string, name: string): Promise<Span[]> {
  const lang = languageOf(name);
  if (!lang || text.length > MAX_HIGHLIGHT) return [];
  const h = await get();
  if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage((bundledLanguages as Record<string, never>)[lang] ?? (bundledLanguagesAlias as Record<string, never>)[lang]);
  const { tokens } = h.codeToTokens(text, { lang, theme: THEME.name! });
  const out: Span[] = [];
  for (const line of tokens)
    for (const t of line) if (t.content.trim() && t.color && TOKEN.has(t.color)) out.push({ from: t.offset, to: t.offset + t.content.length, color: t.color });
  return out;
}
