// Terminal links (v1a-35): Cmd+click opens an http(s) URL in the user's browser (ADR: links) or a path in the Files
// viewer for the session's root. Terminal output is untrusted: the window never resolves or reads a path itself.
// `logicalLine` (ticket 371: the walk over soft-wrapped rows and its two caps) is adapted from Orca
// `src/renderer/src/components/terminal-pane/wrapped-terminal-link-ranges.ts` (1.4.214, source copy, no commit recorded).
// MIT License, Copyright (c) 2026 Lovecast Inc.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import type { IBuffer, IBufferLine, ILink, ILinkHandler, ILinkProvider, Terminal } from '@xterm/xterm';
import { openFileAt, openInEditor, reveal } from '../files/open';
import { imageScope } from '../images/Thumbnail'; // ticket 375: the core and the session folders the window knows
import { makeT, type Lang } from '../i18n';
import { errorNote, plainError, type Note } from '../errors';
import { showPathActions } from './path-actions';
import { copyText } from './clipboard';
import { openRouted } from '../features/link-routing'; // ticket 256: the user's browser or, when set, the session's in-app browser

export const URL_RE = /https?:\/\/[^\s'"<>()]+[^\s'"<>().,;:!?]/g;
export const PATH_RE = /(?:~|\.{1,2})?\/?(?:[\w.-]+\/)+[\w.-]+\.\w+(?::\d+)?/g;

/** Links from terminal output open in the user's browser, never inside the window (ADR: links). */
export async function openLink(url: string) {
  if (!/^https?:\/\//.test(url)) return;
  if ('__TAURI_INTERNALS__' in window) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else window.open(url, '_blank', 'noopener');
}

/** A URL the user clicked in a session's terminal: routed by Settings › In-app browser › Links (ticket 256). */
const openClicked = (url: string, session: string | null | undefined, e: MouseEvent) =>
  /^https?:\/\//.test(url) && openRouted(url, { session, shift: e.shiftKey, origin: 'terminal' }, openLink);

/** `path` or `path:line`; the Files viewer (core) confines it to the root. */
export function openPath(root: string, text: string) {
  const { path, line } = splitPath(text);
  openFileAt(root, path, line);
}
const splitPath = (text: string) => {
  const m = /^(.*?)(?::(\d+))?$/.exec(text)!;
  return { path: m[1], line: m[2] ? Number(m[2]) : undefined };
};

/** Ticket 375: a refused Open in editor says why on the window's status line, as the tree rows do (App sets it). */
let say: (n: Note) => void = () => {};
export const setLinkNote = (f: (n: Note) => void) => void (say = f);

// The window's language is App state; App sets <html lang> from it (htmlLang), which this file reads when it needs words.
const words = () => makeT((document.documentElement.lang || 'en') as Lang, navigator.language);

/** A plain click on a path (ticket 216, needs 178 B2): open, copy or reveal, never the default app (path-actions.ts). */
function pathPopover(term: Terminal, root: string, text: string, e: MouseEvent) {
  const t = words();
  const { path, line } = splitPath(text);
  const abs = editorPath(root, path);
  showPathActions(
    e.clientX,
    e.clientY,
    [
      { label: t('chat.termPath.open'), run: () => openPath(root, text), leaves: true },
      // Ticket 375: the file from this session's folder (its worktree), at the printed line; the core confines it again.
      { label: t('files.openEditor'), run: () => abs && imageScope.core && void openInEditor(imageScope.core, abs, line).catch((e) => say(errorNote(t('files.editorFailed', { error: plainError(t, e) }), e))), leaves: true, disabled: !abs },
      { label: t('chat.termPath.copy'), run: () => void copyText(path) },
      // The session folder is not known here, so only an absolute path can be revealed.
      { label: t('chat.termPath.reveal'), run: () => void reveal('/', path.slice(1)), disabled: !path.startsWith('/') },
    ],
    () => term.focus(),
  );
}

/** Ticket 375: the absolute path the editor gets, or null: a `~` path, a session on another machine, or no folder known. */
export function editorPath(root: string, path: string): string | null {
  const s = imageScope.sessions.find((x) => x.id === root);
  if (!s || s.machine || path.startsWith('~')) return null;
  if (path.startsWith('/')) return path;
  const dir = s.cwd.replace(/\/+$/, '');
  return dir ? `${dir}/${path.replace(/^(\.\/)+/, '')}` : null;
}

/** OSC 8 hyperlinks. Replaces xterm's default, which asks with confirm() and then opens inside the window. */
export const linkHandler: ILinkHandler = {
  activate: (e, uri) => void (e.metaKey && openClicked(uri, (e.target as HTMLElement | null)?.closest<HTMLElement>('.term[data-session]')?.dataset.session, e)),
  // The label can say anything: hovering shows the real target.
  hover: (e, uri) => ((e.target as HTMLElement).title = uri),
  leave: (e) => ((e.target as HTMLElement).title = ''),
};

/** A line's text with the cell column of each UTF-16 index (a wide Hangul cell is one character, two columns). */
function cells(line: IBufferLine) {
  let text = '';
  const col: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const c = line.getCell(x);
    if (!c || c.getWidth() === 0) continue;
    const ch = c.getChars() || ' ';
    for (let i = 0; i < ch.length; i++) col.push(x);
    text += ch;
  }
  return { text, col };
}

// Why the caps: this runs on hover, and an enormous no-newline blob is no useful link but can freeze the window.
const MAX_WRAPPED_ROWS = 200;
const MAX_WRAPPED_CHARS = 20_000;
/** No path is longer; PATH_RE is quadratic in a token's length, and one token of 20,000 characters takes a second. */
const MAX_PATH_TOKEN = 2048;

/** The soft-wrapped line through 1-based row `y`, with the row and column of each UTF-16 index; null past the caps. */
function logicalLine(buffer: IBuffer, y: number) {
  let first = y - 1;
  let last = y - 1;
  let count = 1;
  while (first > 0 && buffer.getLine(first)?.isWrapped) {
    if (count++ >= MAX_WRAPPED_ROWS) return null;
    first--;
  }
  while (buffer.getLine(last + 1)?.isWrapped) {
    if (count++ >= MAX_WRAPPED_ROWS) return null;
    last++;
  }
  let text = '';
  const row: number[] = [];
  const col: number[] = [];
  for (let r = first; r <= last; r++) {
    const line = buffer.getLine(r);
    if (!line) return null;
    const c = cells(line);
    if (text.length + c.text.length > MAX_WRAPPED_CHARS) return null;
    text += c.text;
    for (const x of c.col) {
      row.push(r + 1);
      col.push(x);
    }
  }
  return { text, row, col };
}

export function linkProvider(term: Terminal, root: string): ILinkProvider {
  return {
    provideLinks(y, done) {
      const logical = logicalLine(term.buffer.active, y);
      if (!logical) return done(undefined);
      const { text, row, col } = logical;
      const pathText = text.replace(/\S+/g, (t) => (t.length > MAX_PATH_TOKEN ? ' '.repeat(t.length) : t));
      const links: ILink[] = [];
      const seen: [number, number][] = [];
      for (const [re, isPath] of [
        [URL_RE, false],
        [PATH_RE, true],
      ] as const) {
        for (const m of (isPath ? pathText : text).matchAll(re)) {
          const a = m.index;
          const b = a + m[0].length;
          if (seen.some(([s, e]) => a < e && b > s)) continue;
          seen.push([a, b]);
          if (row[a] > y || row[b - 1] < y) continue; // on another row of this line: that row's own call returns it
          links.push({
            text: m[0],
            range: { start: { x: col[a] + 1, y: row[a] }, end: { x: col[b - 1] + 1, y: row[b - 1] } },
            // Cmd+click opens; a plain click on a path shows its actions, on a URL nothing.
            activate: (e) => (e.metaKey ? (isPath ? openPath(root, m[0]) : void openClicked(m[0], root, e)) : isPath && pathPopover(term, root, m[0], e)),
            ...(isPath && {
              hover: (e: MouseEvent) => ((e.target as HTMLElement).title = words()('chat.termPath.hint')),
              leave: (e: MouseEvent) => ((e.target as HTMLElement).title = ''),
            }),
          });
        }
      }
      done(links);
    },
  };
}
