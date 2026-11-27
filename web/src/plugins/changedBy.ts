// The chat tag's matcher, apart from the window's components so a plain test can load it.
import type { SendRow } from '../types';

/** The plugin whose check changed the delivered message `text`, read from the session's send rows. A chat line names no
 *  row, so it is told by its words: only when every row with those words is a changed one from another sender. The
 *  owner's own line, or an agent's unchanged line with the same words, leaves it untagged (a tag missed, never a wrong
 *  one). */
export function changedBy(log: SendRow[], text: string): string | null {
  const words = text.trim();
  const same = words ? log.filter((r) => r.content.trim() === words) : [];
  if (!same.length || same.some((r) => r.sender === 'user' || !r.replaced)) return null;
  return same[0].replaced!.plugin;
}
