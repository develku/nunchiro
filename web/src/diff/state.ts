// Diff's list states in the window language (ticket 222 review SHOULD, V2.5-63). Kept out of Diff.tsx, which imports
// its stylesheet, so a node-side spec can read it.
import { tEn, type T } from '../i18n';
import type { DiffList } from './Diff';
import { plainError } from '../errors';

/** Why the file list shows no files, in Diff's words (also the Artifacts widget's, v1b-13); null when it has some.
 *  `t` defaults to English for a caller that does not pass the window's language yet. */
export function listState(session: string | null, list: DiffList | null, error: string, t: T = tEn): string | null {
  const base = list?.base;
  if (!session) return t('diff.state.noSession');
  if (error) return t('diff.state.error', { error: plainError(t, error) }); // ticket 480: callers put the raw text under Details
  if (!list) return t('diff.state.loading');
  if (!base) return t('diff.state.baseUnknown');
  if (list.base_missing) return t('diff.state.baseMissing');
  if (base.kind === 'not_git') return t('diff.state.notGit');
  if (!list.files.length) return t('diff.state.noChanges');
  return null;
}
export const truncatedNote = (n: number, t: T = tEn) => t('diff.truncated', { n });
