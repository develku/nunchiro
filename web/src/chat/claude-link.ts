// Needs 117: which text counts as a claude.ai published-artifact link. Pure (no CSS import) so a model spec can load it.
import { webUrl } from '../sandbox/link';

const MAX = 5;
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
// Exact scheme and host, then one of two path shapes, then the end of the link: `?`/`#` start a dropped query.
const LINK = new RegExp(`\\bhttps://claude\\.ai/(artifact/[A-Za-z0-9_-]{1,64}|code/artifact/${UUID})(?=$|[\\s)\\]>"',.;:!?#])`, 'g');

/** Up to 5 distinct claude.ai artifact links in `text`, in order, as `https://claude.ai/<path>` with no query or fragment. */
export function claudeArtifactLinks(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(LINK)) {
    const url = webUrl(`https://claude.ai/${m[1]}`);
    if (!url) continue;
    const u = new URL(url);
    if (u.protocol === 'https:' && u.hostname === 'claude.ai' && !u.port && !u.username && !u.password) found.add(`https://claude.ai${u.pathname}`);
    if (found.size === MAX) break;
  }
  return [...found];
}
