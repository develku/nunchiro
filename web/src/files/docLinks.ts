// Ticket 375: links and images inside a Markdown file shown from Files. Pure: the core confines every read again.
// The idea (resolve a relative href against the file's own folder) after Orca's markdown-preview-links.ts and T3 Code's
// FileMarkdownPreview.tsx; written here for root-relative `/`-paths, with no file:// URLs or Windows paths.

/** `href` (already without `#`/`?`) against `dir`, both relative to the root; a leading `/` starts at the root.
 *  null when it climbs out of the root or names nothing. */
export function docPath(dir: string, href: string): string | null {
  const out = href.startsWith('/') ? [] : dir.split('/').filter(Boolean);
  for (const part of href.split('/')) {
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else if (part && part !== '.') out.push(part);
  }
  return out.length ? out.join('/') : null;
}

/** A heading's anchor as GitHub writes it: lower case, punctuation dropped, each space a hyphen.
 *  shortcut: a repeated heading gets no `-1` suffix, so a link to the second one reaches the first. */
export const slug = (text: string) => text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
